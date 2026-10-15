import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import {
  printerCreateSchema,
  type PrinterCreateInput,
  printerUpdateSchema,
  type PrinterUpdateInput,
} from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../auth/decorators.js';
import { notFound, versionConflict } from '../common/errors.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PrismaService } from '../prisma.service.js';
import { type TestPageDoc } from './escpos.js';
import { PrintService } from './print.service.js';

const uuid = new ParseUUIDPipe();

const toPrinter = (p: Prisma.PrinterGetPayload<object>) => ({
  id: p.id,
  name: p.name,
  host: p.host,
  port: p.port,
  paperWidth: p.paperWidth,
  role: p.role,
  active: p.active,
  version: p.version,
});

/** Imprimantes du site et état de la file d'impression (paramètres du site, réservé au gérant). */
@Controller('printers')
export class PrintersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly print: PrintService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('site.settings', 'read')
  async list(@CurrentAuth() auth: AuthContext) {
    const [printers, failed] = await Promise.all([
      this.prisma.printer.findMany({
        where: { siteId: auth.siteId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.printJob.findMany({
        where: { siteId: auth.siteId, status: 'failed' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { printer: true },
      }),
    ]);
    return {
      printers: printers.map(toPrinter),
      failedJobs: failed.map((j) => ({
        id: j.id,
        printerName: j.printer.name,
        kind: j.kind,
        lastError: j.lastError,
        attempts: j.attempts,
        createdAt: j.createdAt,
      })),
    };
  }

  @Post()
  @RequirePermission('site.settings')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(printerCreateSchema)) body: PrinterCreateInput,
  ) {
    const printer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.printer.create({ data: { siteId: auth.siteId, ...body } });
      await this.log(tx, auth, 'printer.created', created.id, body);
      return created;
    });
    return toPrinter(printer);
  }

  @Patch(':id')
  @RequirePermission('site.settings')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(printerUpdateSchema)) body: PrinterUpdateInput,
  ) {
    const { version, ...data } = body;
    const printer = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.printer.count({ where: { id, siteId: auth.siteId, archivedAt: null } }))) {
        throw notFound('Imprimante');
      }
      const res = await tx.printer.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count !== 1) throw versionConflict();
      await this.log(tx, auth, 'printer.updated', id, data);
      return tx.printer.findUniqueOrThrow({ where: { id } });
    });
    return toPrinter(printer);
  }

  @Post(':id/archive')
  @HttpCode(204)
  @RequirePermission('site.settings')
  async archive(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.printer.count({ where: { id, siteId: auth.siteId, archivedAt: null } }))) {
        throw notFound('Imprimante');
      }
      await tx.printer.update({ where: { id }, data: { archivedAt: new Date(), active: false } });
      // Les travaux en attente ne partiront plus vers une imprimante retirée.
      await tx.printJob.updateMany({
        where: { printerId: id, status: 'pending' },
        data: { status: 'failed', lastError: 'Imprimante retirée' },
      });
      await this.log(tx, auth, 'printer.archived', id);
    });
  }

  /** Imprime une page de test (accents compris) et la traite immédiatement. */
  @Post(':id/test')
  @HttpCode(202)
  @RequirePermission('site.settings')
  async test(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    const printer = await this.prisma.printer.findFirst({
      where: { id, siteId: auth.siteId, archivedAt: null },
    });
    if (!printer) throw notFound('Imprimante');
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const doc: TestPageDoc = {
      kind: 'test_page',
      printerName: printer.name,
      role: printer.role,
      createdAt: new Date().toISOString(),
      timeZone: site.timezone,
    };
    const job = await this.prisma.printJob.create({
      data: {
        siteId: auth.siteId,
        printerId: id,
        kind: doc.kind,
        payload: doc as unknown as Prisma.InputJsonValue,
      },
    });
    await this.print.processDue();
    const done = await this.prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    return { status: done.status, lastError: done.lastError };
  }

  /** Relance un travail en échec (après avoir rallumé l'imprimante ou remis du papier). */
  @Post('jobs/:jobId/retry')
  @HttpCode(202)
  @RequirePermission('site.settings')
  async retry(@CurrentAuth() auth: AuthContext, @Param('jobId', uuid) jobId: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, siteId: auth.siteId },
      include: { printer: true },
    });
    if (!job) throw notFound("Travail d'impression");
    if (job.printer.archivedAt) {
      throw new BadRequestException({ code: 'PRINTER_ARCHIVED', message: 'Imprimante retirée' });
    }
    await this.prisma.printJob.update({
      where: { id: jobId },
      data: { status: 'pending', attempts: 0, nextAttemptAt: new Date() },
    });
    await this.print.processDue();
    const done = await this.prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });
    return { status: done.status, lastError: done.lastError };
  }

  private log(tx: Prisma.TransactionClient, auth: AuthContext, action: string, id: string, after?: object) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity: 'printer',
        entityId: id,
        after: after as Prisma.InputJsonValue | undefined,
      },
      tx,
    );
  }
}
