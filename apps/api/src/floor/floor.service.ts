import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import {
  qrUrl,
  type QrModeInput,
  type TableCreateInput,
  type TableUpdateInput,
  type ZoneCreateInput,
  type ZoneUpdateInput,
} from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

/** Jeton du QR code : 128 bits aléatoires, ne révèle ni la table ni le site (docs/architecture/04). */
const newQrToken = () => randomBytes(16).toString('base64url');

const labelTaken = () =>
  new ConflictException({ code: 'TABLE_LABEL_TAKEN', message: 'Une autre table porte déjà ce nom' });

@Injectable()
export class FloorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Plan de salle : zones et tables actives. Les jetons QR n'y figurent pas. */
  async get(auth: AuthContext) {
    const zones = await this.prisma.zone.findMany({
      where: { siteId: auth.siteId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        tables: {
          where: { archivedAt: null },
          orderBy: [{ posY: 'asc' }, { posX: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    return zones.map((z) => ({
      id: z.id,
      name: z.name,
      sortOrder: z.sortOrder,
      version: z.version,
      tables: z.tables.map((t) => ({
        id: t.id,
        label: t.label,
        seats: t.seats,
        posX: t.posX,
        posY: t.posY,
        version: t.version,
      })),
    }));
  }

  /** QR codes actifs, avec l'adresse à imprimer (réservé à la gestion de la salle). */
  async qrCodes(auth: AuthContext) {
    const codes = await this.prisma.qrCode.findMany({
      where: { siteId: auth.siteId, active: true, table: { archivedAt: null } },
      include: { table: { include: { zone: true } } },
    });
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    return {
      siteName: site.name,
      codes: codes
        .map((q) => ({
          tableId: q.tableId,
          tableLabel: q.table.label,
          zoneName: q.table.zone.name,
          zoneOrder: q.table.zone.sortOrder,
          mode: q.mode,
          url: qrUrl(this.config.PUBLIC_MENU_URL, q.token),
          createdAt: q.createdAt,
        }))
        .sort(
          (a, b) =>
            a.zoneOrder - b.zoneOrder || a.tableLabel.localeCompare(b.tableLabel, 'fr', { numeric: true }),
        ),
    };
  }

  // ------------------------------------------------------------------ zones

  async createZone(auth: AuthContext, input: ZoneCreateInput) {
    return this.prisma.$transaction(async (tx) => {
      const zone = await tx.zone.create({ data: { siteId: auth.siteId, ...input } });
      await this.log(tx, auth, 'floor.zone_created', 'zone', zone.id, undefined, input);
      return zone;
    });
  }

  async updateZone(auth: AuthContext, id: string, input: ZoneUpdateInput) {
    const { version, ...data } = input;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.zone.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!before) throw notFound('Zone');
      const res = await tx.zone.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count !== 1) throw versionConflict();
      await this.log(tx, auth, 'floor.zone_updated', 'zone', id, { name: before.name }, data);
      return tx.zone.findUniqueOrThrow({ where: { id } });
    });
  }

  async archiveZone(auth: AuthContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const zone = await tx.zone.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!zone) throw notFound('Zone');
      if (await tx.diningTable.count({ where: { zoneId: id, archivedAt: null } })) {
        throw new BadRequestException({
          code: 'ZONE_NOT_EMPTY',
          message: 'La zone contient encore des tables',
        });
      }
      await tx.zone.update({ where: { id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
      await this.log(tx, auth, 'floor.zone_archived', 'zone', id, { name: zone.name });
    });
  }

  // ------------------------------------------------------------------ tables

  /** Ajoute une table et génère son QR code. */
  async createTable(auth: AuthContext, input: TableCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertZone(tx, auth, input.zoneId);
        const last = await tx.diningTable.findFirst({
          where: { zoneId: input.zoneId, archivedAt: null },
          orderBy: [{ posY: 'desc' }, { posX: 'desc' }],
        });
        // Placement par défaut : à la suite, 6 tables par rangée.
        const next = last ? last.posY * 6 + last.posX + 1 : 0;
        const table = await tx.diningTable.create({
          data: {
            siteId: auth.siteId,
            ...input,
            posX: next % 6,
            posY: Math.floor(next / 6),
            qrCodes: { create: { siteId: auth.siteId, token: newQrToken() } },
          },
        });
        await this.log(tx, auth, 'floor.table_created', 'dining_table', table.id, undefined, input);
        return table;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw labelTaken();
      throw error;
    }
  }

  async updateTable(auth: AuthContext, id: string, input: TableUpdateInput) {
    const { version, ...data } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.diningTable.findFirst({
          where: { id, siteId: auth.siteId, archivedAt: null },
        });
        if (!before) throw notFound('Table');
        if (data.zoneId) await this.assertZone(tx, auth, data.zoneId);
        const res = await tx.diningTable.updateMany({
          where: { id, version },
          data: { ...data, version: { increment: 1 } },
        });
        if (res.count !== 1) throw versionConflict();
        await this.log(
          tx,
          auth,
          'floor.table_updated',
          'dining_table',
          id,
          { label: before.label, zoneId: before.zoneId, seats: before.seats },
          data,
        );
        return tx.diningTable.findUniqueOrThrow({ where: { id } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw labelTaken();
      throw error;
    }
  }

  /**
   * Supprime une table du plan (archivage) et désactive son QR code.
   * À partir de la Phase 2 : refuser si une commande est ouverte sur la table.
   */
  async archiveTable(auth: AuthContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!table) throw notFound('Table');
      const now = new Date();
      await tx.diningTable.update({ where: { id }, data: { archivedAt: now, version: { increment: 1 } } });
      await tx.qrCode.updateMany({
        where: { tableId: id, active: true },
        data: { active: false, replacedAt: now },
      });
      await this.log(tx, auth, 'floor.table_archived', 'dining_table', id, { label: table.label });
    });
  }

  // ------------------------------------------------------------------ QR codes

  /** Remplace le QR code d'une table (perdu, abîmé, photographié) : l'ancien cesse aussitôt de fonctionner. */
  async replaceQr(auth: AuthContext, tableId: string) {
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({
        where: { id: tableId, siteId: auth.siteId, archivedAt: null },
      });
      if (!table) throw notFound('Table');
      const previous = await tx.qrCode.findFirst({ where: { tableId, active: true } });
      if (previous) {
        await tx.qrCode.update({
          where: { id: previous.id },
          data: { active: false, replacedAt: new Date() },
        });
      }
      const qr = await tx.qrCode.create({
        data: { siteId: auth.siteId, tableId, token: newQrToken(), mode: previous?.mode ?? 'order' },
      });
      await this.log(
        tx,
        auth,
        'floor.qr_replaced',
        'dining_table',
        tableId,
        { qrCodeId: previous?.id },
        { qrCodeId: qr.id },
      );
      return { tableId, mode: qr.mode, url: qrUrl(this.config.PUBLIC_MENU_URL, qr.token) };
    });
  }

  /** Mode du QR code : consultation du menu seule, ou commande. */
  async setQrMode(auth: AuthContext, tableId: string, input: QrModeInput) {
    return this.prisma.$transaction(async (tx) => {
      const qr = await tx.qrCode.findFirst({
        where: { tableId, active: true, siteId: auth.siteId, table: { archivedAt: null } },
      });
      if (!qr) throw notFound('QR code');
      await tx.qrCode.update({ where: { id: qr.id }, data: { mode: input.mode } });
      await this.log(tx, auth, 'floor.qr_mode_changed', 'dining_table', tableId, { mode: qr.mode }, input);
      return { tableId, mode: input.mode };
    });
  }

  // ------------------------------------------------------------------ outils

  private async assertZone(tx: Tx, auth: AuthContext, zoneId: string) {
    if (!(await tx.zone.count({ where: { id: zoneId, siteId: auth.siteId, archivedAt: null } }))) {
      throw notFound('Zone');
    }
  }

  private log(
    tx: Tx,
    auth: AuthContext,
    action: string,
    entity: string,
    entityId: string,
    before?: unknown,
    after?: unknown,
  ) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity,
        entityId,
        before: before as Prisma.InputJsonValue | undefined,
        after: after as Prisma.InputJsonValue | undefined,
      },
      tx,
    );
  }
}
