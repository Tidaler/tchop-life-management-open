import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@tchop/db';
import { type InventoryCloseInput, type InventoryCountInput, type InventoryStartInput } from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { nextCounter } from '../common/counters.js';
import { isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { siteThresholds } from '../common/site-settings.js';
import { PrismaService } from '../prisma.service.js';
import { type MovementInput, StockLedger } from './stock-ledger.js';
import { canSeeCosts, StockService } from './stock.service.js';

const Decimal = Prisma.Decimal;

const countInclude = {
  location: { select: { id: true, name: true } },
  lines: {
    include: { item: { select: { name: true, unit: true, avgCostXaf: true } } },
    orderBy: { item: { name: 'asc' } },
  },
} satisfies Prisma.InventoryCountInclude;
type CountRow = Prisma.InventoryCountGetPayload<{ include: typeof countInclude }>;

const inventoryClosed = () =>
  new ConflictException({ code: 'INVENTORY_CLOSED', message: "L'inventaire est déjà clos" });

/**
 * Inventaires : comptage « à l'aveugle » (le théorique n'est montré qu'après la clôture), puis les écarts
 * deviennent des mouvements d'ajustement. Au-delà du seuil d'écart du site, la clôture demande
 * l'approbation d'un gérant, sauf pour qui peut corriger le stock sans approbation.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly ledger: StockLedger,
    private readonly approval: ApprovalService,
  ) {}

  async list(auth: AuthContext) {
    const rows = await this.prisma.inventoryCount.findMany({
      where: { siteId: auth.siteId },
      include: { location: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: { number: 'desc' },
      take: 50,
    });
    const showCost = canSeeCosts(auth);
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      location: r.location,
      lines: r._count.lines,
      createdAt: r.createdAt,
      closedAt: r.closedAt,
      ...(showCost ? { varianceXaf: r.varianceXaf } : {}),
    }));
  }

  async get(auth: AuthContext, id: string) {
    const row = await this.prisma.inventoryCount.findFirst({
      where: { id, siteId: auth.siteId },
      include: countInclude,
    });
    if (!row) throw notFound('Inventaire');
    return this.toCount(row, canSeeCosts(auth));
  }

  /** Ouvre l'inventaire d'un magasin avec les articles qui y sont rangés ou qui y ont du stock. */
  async start(auth: AuthContext, input: InventoryStartInput) {
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await this.stock.activeLocation(tx, auth, input.locationId);
        const items = await tx.stockItem.findMany({
          where: {
            siteId: auth.siteId,
            archivedAt: null,
            OR: [{ locationId: input.locationId }, { levels: { some: { locationId: input.locationId } } }],
          },
          select: { id: true },
        });
        const count = await tx.inventoryCount.create({
          data: {
            siteId: auth.siteId,
            number: await nextCounter(tx, auth.siteId, 'inventory'),
            locationId: input.locationId,
            note: input.note,
            createdById: auth.userId,
            lines: { create: items.map((i) => ({ itemId: i.id })) },
          },
        });
        await this.stock.log(tx, auth, 'inventory.started', 'inventory_count', count.id, {
          after: { number: count.number, locationId: input.locationId, items: items.length },
        });
        return count.id;
      });
      return this.get(auth, id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'INVENTORY_IN_PROGRESS',
          message: 'Un inventaire est déjà en cours pour ce magasin',
        });
      }
      throw error;
    }
  }

  /** Saisie des quantités comptées (un article absent de la liste peut y être ajouté). */
  async count(auth: AuthContext, id: string, input: InventoryCountInput) {
    await this.prisma.$transaction(async (tx) => {
      const count = await tx.inventoryCount.findFirst({ where: { id, siteId: auth.siteId } });
      if (!count) throw notFound('Inventaire');
      if (count.status !== 'open') throw inventoryClosed();
      const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
      const known = await tx.stockItem.count({
        where: { id: { in: itemIds }, siteId: auth.siteId, archivedAt: null },
      });
      if (known !== itemIds.length) throw notFound('Article');
      for (const line of input.lines) {
        await tx.inventoryCountLine.upsert({
          where: { countId_itemId: { countId: id, itemId: line.itemId } },
          create: { countId: id, itemId: line.itemId, countedQty: line.countedQty, countedById: auth.userId },
          update: { countedQty: line.countedQty, countedById: auth.userId },
        });
      }
    });
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string, version: number) {
    await this.prisma.$transaction(async (tx) => {
      const count = await tx.inventoryCount.findFirst({ where: { id, siteId: auth.siteId } });
      if (!count) throw notFound('Inventaire');
      if (count.status !== 'open') throw inventoryClosed();
      const { count: updated } = await tx.inventoryCount.updateMany({
        where: { id, version, status: 'open' },
        data: {
          status: 'cancelled',
          closedAt: new Date(),
          closedById: auth.userId,
          version: { increment: 1 },
        },
      });
      if (updated === 0) throw versionConflict();
      await this.stock.log(tx, auth, 'inventory.cancelled', 'inventory_count', id, {
        after: { number: count.number },
      });
    });
    return this.get(auth, id);
  }

  /** Clôture : théorique figé, écarts passés en ajustements, approbation au-delà du seuil. */
  async close(auth: AuthContext, id: string, input: InventoryCloseInput) {
    await this.prisma.$transaction(async (tx) => {
      const count = await tx.inventoryCount.findFirst({
        where: { id, siteId: auth.siteId },
        include: { lines: { include: { item: true } } },
      });
      if (!count) throw notFound('Inventaire');
      if (count.status !== 'open') throw inventoryClosed();
      if (count.version !== input.version) throw versionConflict();
      const counted = count.lines.filter((l) => l.countedQty !== null);
      if (counted.length === 0) {
        throw new BadRequestException({ code: 'NOTHING_COUNTED', message: "Aucun article n'a été compté" });
      }

      const levels = await tx.stockLevel.findMany({
        where: { locationId: count.locationId, itemId: { in: counted.map((l) => l.itemId) } },
      });
      const onHand = new Map(levels.map((l) => [l.itemId, l.quantity]));
      const results = counted.map((line) => {
        const expected = onHand.get(line.itemId) ?? new Decimal(0);
        const variance = line.countedQty!.minus(expected);
        return { line, expected, variance, value: Number(variance.times(line.item.avgCostXaf)) };
      });
      const grossXaf = results.reduce((s, r) => s + Math.abs(r.value), 0);
      const netXaf = Math.round(results.reduce((s, r) => s + r.value, 0));

      const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
      const needsApprover =
        grossXaf > siteThresholds(site.settings).inventoryVarianceXaf &&
        auth.grants['stock.adjust'] !== 'full';
      const approvedById = needsApprover
        ? await this.approval.requireApprover(auth, input.approval, tx)
        : null;

      const reason = `Inventaire n° ${count.number}`;
      const movements: MovementInput[] = results
        .filter((r) => !r.variance.isZero())
        .map((r) => ({
          itemId: r.line.itemId,
          locationId: count.locationId,
          type: 'inventory_adjustment',
          quantity: r.variance,
          reason,
          inventoryCountId: count.id,
          approvedById,
        }));
      await this.ledger.record(tx, auth.siteId, auth.userId, movements);
      for (const r of results) {
        await tx.inventoryCountLine.update({
          where: { id: r.line.id },
          data: { expectedQty: r.expected, varianceQty: r.variance },
        });
      }
      const { count: updated } = await tx.inventoryCount.updateMany({
        where: { id, version: input.version, status: 'open' },
        data: {
          status: 'closed',
          varianceXaf: netXaf,
          closedById: auth.userId,
          approvedById,
          closedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (updated === 0) throw versionConflict();
      await this.stock.log(tx, auth, 'inventory.closed', 'inventory_count', id, {
        after: {
          number: count.number,
          counted: counted.length,
          adjusted: movements.length,
          netXaf,
          grossXaf: Math.round(grossXaf),
        },
        approverId: approvedById,
      });
    });
    this.stock.changed(auth);
    return this.get(auth, id);
  }

  private toCount(row: CountRow, showCost: boolean) {
    const closed = row.status === 'closed';
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      location: row.location,
      note: row.note,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      version: row.version,
      ...(showCost && closed ? { varianceXaf: row.varianceXaf } : {}),
      lines: row.lines.map((l) => ({
        itemId: l.itemId,
        itemName: l.item.name,
        unit: l.item.unit,
        countedQty: l.countedQty === null ? null : Number(l.countedQty),
        // Comptage à l'aveugle : le théorique et l'écart n'apparaissent qu'une fois l'inventaire clos.
        ...(closed
          ? {
              expectedQty: l.expectedQty === null ? null : Number(l.expectedQty),
              varianceQty: l.varianceQty === null ? null : Number(l.varianceQty),
              ...(showCost && l.varianceQty !== null
                ? { varianceXaf: Math.round(Number(l.varianceQty.times(l.item.avgCostXaf))) }
                : {}),
            }
          : {}),
      })),
    };
  }
}
