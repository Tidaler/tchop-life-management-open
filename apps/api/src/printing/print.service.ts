import { Socket } from 'node:net';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Prisma, type PrinterRole } from '@tchop/db';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { type PrintDoc, renderEscPos } from './escpos.js';

export const MAX_PRINT_ATTEMPTS = 5;
const SEND_TIMEOUT_MS = 5_000;

/** Envoie des octets bruts à une imprimante réseau (port 9100, protocole « RAW »). */
export function sendRaw(
  host: string,
  port: number,
  data: Buffer,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`Délai dépassé (${host}:${port})`)));
    socket.once('error', fail);
    socket.connect(port, host, () => {
      socket.end(data, () => resolve());
    });
  });
}

/**
 * File d'impression : chaque document est d'abord enregistré en base (print_job), puis envoyé.
 * En cas d'échec (imprimante éteinte, papier), nouvelles tentatives espacées ; le bon reste
 * visible à l'écran de préparation dans tous les cas.
 */
@Injectable()
export class PrintService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PrintService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.PRINT_POLL_MS > 0) {
      this.timer = setInterval(() => void this.processDue(), this.config.PRINT_POLL_MS);
      this.timer.unref();
    }
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Met un document en file pour chaque imprimante active du poste. Renvoie le nombre de travaux créés. */
  async enqueue(
    tx: Prisma.TransactionClient,
    siteId: string,
    role: PrinterRole,
    doc: PrintDoc,
  ): Promise<number> {
    const printers = await tx.printer.findMany({ where: { siteId, role, active: true, archivedAt: null } });
    for (const p of printers) {
      await tx.printJob.create({
        data: { siteId, printerId: p.id, kind: doc.kind, payload: doc as unknown as Prisma.InputJsonValue },
      });
    }
    return printers.length;
  }

  /** Traite les travaux en attente dont l'heure est venue. Un seul passage à la fois. */
  async processDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.prisma.printJob.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
        include: { printer: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const job of jobs) await this.attempt(job);
    } catch (error) {
      this.logger.error(`File d'impression : ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async attempt(job: Prisma.PrintJobGetPayload<{ include: { printer: true } }>): Promise<void> {
    const attempts = job.attempts + 1;
    try {
      const data = renderEscPos(job.payload as unknown as PrintDoc, job.printer.paperWidth);
      await sendRaw(job.printer.host, job.printer.port, data);
      await this.prisma.printJob.update({
        where: { id: job.id },
        data: { status: 'printed', attempts, printedAt: new Date(), lastError: null },
      });
    } catch (error) {
      const failed = attempts >= MAX_PRINT_ATTEMPTS;
      // Attente croissante : 2 s, 4 s, 8 s, 16 s…
      const delay = this.config.PRINT_RETRY_BASE_MS * 2 ** (attempts - 1);
      await this.prisma.printJob.update({
        where: { id: job.id },
        data: {
          attempts,
          status: failed ? 'failed' : 'pending',
          lastError: String(error instanceof Error ? error.message : error).slice(0, 300),
          nextAttemptAt: new Date(Date.now() + delay),
        },
      });
      this.logger.warn(
        `Impression ${job.id} sur ${job.printer.name} : échec ${attempts}/${MAX_PRINT_ATTEMPTS}`,
      );
    }
  }
}
