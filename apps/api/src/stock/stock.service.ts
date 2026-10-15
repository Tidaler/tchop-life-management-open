import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@tchop/db';
import {
  type AdjustmentInput,
  can,
  type LocationCreateInput,
  type LocationUpdateInput,
  type LossInput,
  type MovementsQuery,
  needsApproval,
  type PackagingCreateInput,
  type StockItemCreateInput,
  type StockItemUpdateInput,
  type StockMovementType,
  type TransferInput,
} from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import { remember, replayed } from '../common/idempotency.js';
import { type AuthContext } from '../common/request-context.js';
import { siteThresholds, zonedMidnight } from '../common/site-settings.js';
import { EventsService } from '../events/events.gateway.js';
import { PrismaService } from '../prisma.service.js';
import { StockLedger } from './stock-ledger.js';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
const num = (d: Prisma.Decimal | number | null | undefined): number | null => (d == null ? null : Number(d));

/** Les coûts et valeurs ne sont montrés qu'aux rôles qui suivent les achats ou les rapports de stock. */
export const canSeeCosts = (auth: AuthContext): boolean =>
  can(auth.grants, 'report.stock', 'read') || can(auth.grants, 'purchase.manage', 'read');

export const nameTaken = () =>
  new ConflictException({ code: 'NAME_TAKEN', message: 'Ce nom est déjà utilisé' });

const itemInclude = {
  packagings: { where: { archivedAt: null }, orderBy: { factor: 'asc' } },
  levels: true,
  location: { select: { id: true, name: true } },
} satisfies Prisma.StockItemInclude;
type ItemRow = Prisma.StockItemGetPayload<{ include: typeof itemInclude }>;

/** Jour suivant (AAAA-MM-JJ). */
const nextDay = (day: string): string =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approval: ApprovalService,
    private readonly events: EventsService,
    private readonly ledger: StockLedger,
  ) {}

  // ------------------------------------------------------------------ magasins

  async locations(auth: AuthContext) {
    return await this.prisma.stockLocation.findMany({
      where: { siteId: auth.siteId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, sortOrder: true, version: true },
    });
  }

  async createLocation(auth: AuthContext, input: LocationCreateInput) {
    try {
      const location = await this.prisma.$transaction(async (tx) => {
        const created = await tx.stockLocation.create({ data: { siteId: auth.siteId, ...input } });
        await this.log(tx, auth, 'stock.location_created', 'stock_location', created.id, { after: input });
        return created;
      });
      this.changed(auth);
      return location;
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async updateLocation(auth: AuthContext, id: string, input: LocationUpdateInput) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const location = await tx.stockLocation.findFirst({ where: { id, siteId: auth.siteId } });
        if (!location) throw notFound('Magasin');
        if (input.archived && !location.archivedAt) {
          const [items, stocked] = [
            await tx.stockItem.count({ where: { locationId: id, archivedAt: null } }),
            await tx.stockLevel.count({ where: { locationId: id, quantity: { not: 0 } } }),
          ];
          if (items + stocked > 0) {
            throw new ConflictException({
              code: 'LOCATION_IN_USE',
              message: 'Ce magasin contient du stock ou sert de magasin de sortie à des articles',
            });
          }
        }
        const { count } = await tx.stockLocation.updateMany({
          where: { id, version: input.version },
          data: {
            name: input.name,
            sortOrder: input.sortOrder,
            archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
            version: { increment: 1 },
          },
        });
        if (count === 0) throw versionConflict();
        await this.log(tx, auth, 'stock.location_updated', 'stock_location', id, {
          before: { name: location.name, archived: !!location.archivedAt },
          after: { name: input.name, archived: input.archived },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    this.changed(auth);
    return this.locations(auth);
  }

  // ------------------------------------------------------------------ articles

  async items(auth: AuthContext, includeArchived = false) {
    const rows = await this.prisma.stockItem.findMany({
      where: { siteId: auth.siteId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: itemInclude,
      orderBy: { name: 'asc' },
    });
    const showCost = canSeeCosts(auth);
    return rows.map((row) => this.toItem(row, showCost));
  }

  async item(auth: AuthContext, id: string) {
    const row = await this.prisma.stockItem.findFirst({
      where: { id, siteId: auth.siteId },
      include: itemInclude,
    });
    if (!row) throw notFound('Article');
    return this.toItem(row, canSeeCosts(auth));
  }

  /** Articles sous leur seuil d'alerte (ou en stock négatif). */
  async alerts(auth: AuthContext) {
    return (await this.items(auth))
      .filter((i) => i.alert)
      .map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        total: i.total,
        alertThreshold: i.alertThreshold,
      }));
  }

  async createItem(auth: AuthContext, input: StockItemCreateInput) {
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await this.activeLocation(tx, auth, input.locationId);
        const created = await tx.stockItem.create({
          data: {
            siteId: auth.siteId,
            name: input.name,
            unit: input.unit,
            locationId: input.locationId,
            alertThreshold: input.alertThreshold,
            packagings: { create: input.packagings },
          },
        });
        await this.log(tx, auth, 'stock.item_created', 'stock_item', created.id, {
          after: { name: input.name, unit: input.unit, packagings: input.packagings },
        });
        return created.id;
      });
      this.changed(auth);
      return this.item(auth, id);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async updateItem(auth: AuthContext, id: string, input: StockItemUpdateInput) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const item = await tx.stockItem.findFirst({
          where: { id, siteId: auth.siteId },
          include: { levels: true },
        });
        if (!item) throw notFound('Article');
        if (input.locationId) await this.activeLocation(tx, auth, input.locationId);
        if (input.archived && !item.archivedAt) {
          if (item.levels.some((l) => !l.quantity.isZero())) {
            throw new ConflictException({
              code: 'ITEM_HAS_STOCK',
              message:
                "L'article a encore du stock : ramenez-le à zéro par un ajustement avant de l'archiver",
            });
          }
          const used = await tx.recipeLine.count({ where: { itemId: id, product: { archivedAt: null } } });
          if (used > 0) {
            throw new ConflictException({
              code: 'ITEM_IN_RECIPE',
              message: "L'article figure dans des recettes : retirez-le d'abord des recettes",
            });
          }
        }
        const { count } = await tx.stockItem.updateMany({
          where: { id, version: input.version },
          data: {
            name: input.name,
            locationId: input.locationId,
            alertThreshold: input.alertThreshold,
            archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
            version: { increment: 1 },
          },
        });
        if (count === 0) throw versionConflict();
        await this.log(tx, auth, 'stock.item_updated', 'stock_item', id, {
          before: {
            name: item.name,
            locationId: item.locationId,
            alertThreshold: Number(item.alertThreshold),
            archived: !!item.archivedAt,
          },
          after: {
            name: input.name,
            locationId: input.locationId,
            alertThreshold: input.alertThreshold,
            archived: input.archived,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    this.changed(auth);
    return this.item(auth, id);
  }

  async addPackaging(auth: AuthContext, itemId: string, input: PackagingCreateInput) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.activeItem(tx, auth, itemId);
        const created = await tx.stockPackaging.create({ data: { itemId, ...input } });
        await this.log(tx, auth, 'stock.packaging_created', 'stock_item', itemId, {
          after: { packagingId: created.id, ...input },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    this.changed(auth);
    return this.item(auth, itemId);
  }

  /** Un conditionnement n'est pas supprimé (les réceptions passées le citent) : il est archivé. */
  async archivePackaging(auth: AuthContext, itemId: string, packagingId: string) {
    await this.prisma.$transaction(async (tx) => {
      const packaging = await tx.stockPackaging.findFirst({
        where: { id: packagingId, itemId, item: { siteId: auth.siteId }, archivedAt: null },
      });
      if (!packaging) throw notFound('Conditionnement');
      await tx.stockPackaging.update({ where: { id: packagingId }, data: { archivedAt: new Date() } });
      await this.log(tx, auth, 'stock.packaging_archived', 'stock_item', itemId, {
        before: { packagingId, name: packaging.name, factor: Number(packaging.factor) },
      });
    });
    this.changed(auth);
    return this.item(auth, itemId);
  }

  // ------------------------------------------------------------------ journal des mouvements

  async movements(auth: AuthContext, q: MovementsQuery) {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = zonedMidnight(q.from, site.timezone);
    if (q.to) createdAt.lt = zonedMidnight(nextDay(q.to), site.timezone);

    const rows = await this.prisma.stockMovement.findMany({
      where: {
        siteId: auth.siteId,
        itemId: q.itemId,
        locationId: q.locationId,
        type: q.type,
        ...(q.from || q.to ? { createdAt } : {}),
        // Identifiants UUID v7 : leur ordre est celui de la création.
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
      include: { item: { select: { name: true, unit: true } }, location: { select: { name: true } } },
    });
    const names = await this.userNames(rows.flatMap((r) => [r.createdById, r.approvedById]));
    const showCost = canSeeCosts(auth);
    return {
      movements: rows.map((r) => ({
        id: r.id,
        type: r.type,
        itemId: r.itemId,
        itemName: r.item.name,
        unit: r.item.unit,
        locationName: r.location.name,
        quantity: num(r.quantity),
        reason: r.reason,
        orderLineId: r.orderLineId,
        goodsReceiptId: r.goodsReceiptId,
        inventoryCountId: r.inventoryCountId,
        createdBy: names.get(r.createdById) ?? null,
        approvedBy: r.approvedById ? (names.get(r.approvedById) ?? null) : null,
        createdAt: r.createdAt,
        ...(showCost ? { valueXaf: Math.round(Number(r.quantity.times(r.unitCostXaf))) } : {}),
      })),
      next: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  }

  // ------------------------------------------------------------------ mouvements déclarés

  /**
   * Perte, casse ou consommation interne. Approbation d'un gérant : toujours pour la cuisine,
   * au-delà du seuil de valeur du site pour le magasinier (matrice des permissions).
   */
  async declareLoss(auth: AuthContext, input: LossInput) {
    return this.once(auth, input.idempotencyKey, 'stock.loss', async (tx) => {
      const item = await this.activeItem(tx, auth, input.itemId);
      const locationId = input.locationId ?? item.locationId;
      await this.activeLocation(tx, auth, locationId);
      const valueXaf = Math.round(Number(item.avgCostXaf.times(input.quantity)));
      const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
      const level = needsApproval(auth.grants, 'stock.loss');
      const over =
        level === 'always' ||
        (level === 'over_threshold' && valueXaf > siteThresholds(site.settings).stockLossXaf);
      const approvedById = over ? await this.approval.requireApprover(auth, input.approval, tx) : null;

      const groupId = randomUUID();
      await this.ledger.record(tx, auth.siteId, auth.userId, [
        {
          itemId: item.id,
          locationId,
          type: input.type,
          quantity: -input.quantity,
          reason: input.reason,
          groupId,
          approvedById,
        },
      ]);
      await this.log(tx, auth, 'stock.loss_declared', 'stock_item', item.id, {
        after: { type: input.type, quantity: input.quantity, locationId, valueXaf },
        reason: input.reason,
        approverId: approvedById,
      });
      return { groupId };
    });
  }

  async transfer(auth: AuthContext, input: TransferInput) {
    return this.once(auth, input.idempotencyKey, 'stock.transfer', async (tx) => {
      const item = await this.activeItem(tx, auth, input.itemId);
      await this.activeLocation(tx, auth, input.fromLocationId);
      await this.activeLocation(tx, auth, input.toLocationId);
      const groupId = randomUUID();
      const reason = input.note ?? null;
      await this.ledger.record(tx, auth.siteId, auth.userId, [
        {
          itemId: item.id,
          locationId: input.fromLocationId,
          type: 'transfer_out',
          quantity: -input.quantity,
          reason,
          groupId,
        },
        {
          itemId: item.id,
          locationId: input.toLocationId,
          type: 'transfer_in',
          quantity: input.quantity,
          reason,
          groupId,
        },
      ]);
      await this.log(tx, auth, 'stock.transferred', 'stock_item', item.id, {
        after: { quantity: input.quantity, from: input.fromLocationId, to: input.toLocationId },
      });
      return { groupId };
    });
  }

  /** Correction manuelle hors inventaire : motif obligatoire, approbation selon le rôle. */
  async adjust(auth: AuthContext, input: AdjustmentInput) {
    return this.once(auth, input.idempotencyKey, 'stock.adjust', async (tx) => {
      const item = await this.activeItem(tx, auth, input.itemId);
      await this.activeLocation(tx, auth, input.locationId);
      const approvedById = await this.approval.require(auth, 'stock.adjust', input.approval, tx);
      const groupId = randomUUID();
      await this.ledger.record(tx, auth.siteId, auth.userId, [
        {
          itemId: item.id,
          locationId: input.locationId,
          type: 'inventory_adjustment',
          quantity: input.quantity,
          reason: input.reason,
          groupId,
          approvedById,
        },
      ]);
      await this.log(tx, auth, 'stock.adjusted', 'stock_item', item.id, {
        after: {
          quantity: input.quantity,
          locationId: input.locationId,
          valueXaf: Math.round(Number(item.avgCostXaf.times(input.quantity))),
        },
        reason: input.reason,
        approverId: approvedById,
      });
      return { groupId };
    });
  }

  // ------------------------------------------------------------------ rapports

  /** Valeur du stock au coût moyen, par magasin et par article. */
  async valuation(auth: AuthContext) {
    const [items, locations] = [
      await this.prisma.stockItem.findMany({
        where: { siteId: auth.siteId, archivedAt: null },
        include: { levels: true },
        orderBy: { name: 'asc' },
      }),
      await this.locations(auth),
    ];
    const byLocation = new Map(locations.map((l) => [l.id, 0]));
    let totalXaf = 0;
    const rows = items.map((item) => {
      const quantity = item.levels.reduce((s, l) => s.plus(l.quantity), new Decimal(0));
      for (const l of item.levels) {
        const value = Number(l.quantity.times(item.avgCostXaf));
        if (byLocation.has(l.locationId)) byLocation.set(l.locationId, byLocation.get(l.locationId)! + value);
      }
      const valueXaf = Math.round(Number(quantity.times(item.avgCostXaf)));
      totalXaf += valueXaf;
      return {
        id: item.id,
        name: item.name,
        unit: item.unit,
        quantity: num(quantity),
        avgCostXaf: num(item.avgCostXaf),
        valueXaf,
      };
    });
    return {
      totalXaf,
      locations: locations.map((l) => ({
        id: l.id,
        name: l.name,
        valueXaf: Math.round(byLocation.get(l.id)!),
      })),
      items: rows,
    };
  }

  /** Entrées, ventes, pertes et ajustements de la période, en quantités et en valeur (coût du mouvement). */
  async report(auth: AuthContext, from: string, to: string) {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const start = zonedMidnight(from, site.timezone);
    const end = zonedMidnight(nextDay(to), site.timezone);
    const rows = await this.prisma.$queryRaw<
      { item_id: string; type: StockMovementType; quantity: Prisma.Decimal; value: Prisma.Decimal }[]
    >`
      SELECT "item_id", "type", SUM("quantity") AS "quantity", SUM("quantity" * "unit_cost_xaf") AS "value"
      FROM "stock_movement"
      WHERE "site_id" = ${auth.siteId}::uuid AND "created_at" >= ${start} AND "created_at" < ${end}
      GROUP BY "item_id", "type"`;
    const items = await this.prisma.stockItem.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.item_id))] } },
      select: { id: true, name: true, unit: true },
    });
    const empty = () => ({ quantity: 0, valueXaf: 0 });
    const lines = new Map(
      items.map((i) => [
        i.id,
        { ...i, received: empty(), sold: empty(), losses: empty(), adjustments: empty() },
      ]),
    );
    const bucket: Partial<
      Record<StockMovementType, { key: 'received' | 'sold' | 'losses' | 'adjustments'; sign: 1 | -1 }>
    > = {
      receipt: { key: 'received', sign: 1 },
      sale: { key: 'sold', sign: -1 },
      sale_cancel: { key: 'sold', sign: -1 },
      loss: { key: 'losses', sign: -1 },
      breakage: { key: 'losses', sign: -1 },
      internal_use: { key: 'losses', sign: -1 },
      inventory_adjustment: { key: 'adjustments', sign: 1 },
    };
    for (const r of rows) {
      const target = bucket[r.type];
      const line = lines.get(r.item_id);
      if (!target || !line) continue;
      line[target.key].quantity += target.sign * Number(r.quantity);
      line[target.key].valueXaf += target.sign * Number(r.value);
    }
    const round = (v: { quantity: number; valueXaf: number }) => ({
      quantity: Math.round(v.quantity * 1000) / 1000,
      valueXaf: Math.round(v.valueXaf),
    });
    const result = [...lines.values()]
      .map((l) => ({
        ...l,
        received: round(l.received),
        sold: round(l.sold),
        losses: round(l.losses),
        adjustments: round(l.adjustments),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const total = (key: 'received' | 'sold' | 'losses' | 'adjustments') =>
      result.reduce((s, l) => s + l[key].valueXaf, 0);
    return {
      from,
      to,
      items: result,
      totals: {
        receivedXaf: total('received'),
        soldXaf: total('sold'),
        lossesXaf: total('losses'),
        adjustmentsXaf: total('adjustments'),
      },
    };
  }

  // ------------------------------------------------------------------ outils

  async activeItem(tx: Tx, auth: AuthContext, id: string) {
    const item = await tx.stockItem.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
    if (!item) throw notFound('Article');
    return item;
  }

  async activeLocation(tx: Tx, auth: AuthContext, id: string) {
    const location = await tx.stockLocation.findFirst({
      where: { id, siteId: auth.siteId, archivedAt: null },
    });
    if (!location) throw notFound('Magasin');
    return location;
  }

  /** Opération idempotente : un renvoi avec la même clé rend la première réponse sans rien refaire. */
  private async once<T extends Prisma.InputJsonObject>(
    auth: AuthContext,
    key: string,
    route: string,
    run: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const previous = await replayed<T>(this.prisma, auth, key, route);
    if (previous) return previous;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const response = await run(tx);
        await remember(tx, auth, key, route, response);
        return response;
      });
      this.changed(auth);
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await replayed<T>(this.prisma, auth, key, route);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  private toItem(row: ItemRow, showCost: boolean) {
    const total = row.levels.reduce((s, l) => s.plus(l.quantity), new Decimal(0));
    return {
      id: row.id,
      name: row.name,
      unit: row.unit,
      location: row.location,
      alertThreshold: num(row.alertThreshold)!,
      archived: !!row.archivedAt,
      version: row.version,
      packagings: row.packagings.map((p) => ({ id: p.id, name: p.name, factor: num(p.factor)! })),
      levels: row.levels.map((l) => ({ locationId: l.locationId, quantity: num(l.quantity)! })),
      total: num(total)!,
      alert: total.isNegative() || (row.alertThreshold.gt(0) && total.lte(row.alertThreshold)),
      ...(showCost
        ? {
            avgCostXaf: num(row.avgCostXaf)!,
            valueXaf: Math.round(Number(total.times(row.avgCostXaf))),
          }
        : {}),
    };
  }

  changed(auth: AuthContext): void {
    this.events.emit(auth.siteId, { type: 'stock.changed' });
  }

  async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  log(
    tx: Tx,
    auth: AuthContext,
    action: string,
    entity: string,
    entityId: string,
    extra: {
      before?: Prisma.InputJsonValue;
      after?: Prisma.InputJsonValue;
      reason?: string;
      approverId?: string | null;
    } = {},
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
        ...extra,
      },
      tx,
    );
  }
}
