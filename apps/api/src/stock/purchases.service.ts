import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@tchop/db';
import {
  type GoodsReceiptInput,
  type PurchaseOrderCreateInput,
  type SupplierCreateInput,
  type SupplierUpdateInput,
} from '@tchop/shared';
import { nextCounter } from '../common/counters.js';
import { isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';
import { StockLedger } from './stock-ledger.js';
import { nameTaken, StockService } from './stock.service.js';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

const orderInclude = {
  supplier: { select: { id: true, name: true } },
  lines: { include: { item: { select: { name: true, unit: true } } }, orderBy: { id: 'asc' } },
} satisfies Prisma.PurchaseOrderInclude;
type OrderRow = Prisma.PurchaseOrderGetPayload<{ include: typeof orderInclude }>;

const receiptInclude = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  purchaseOrder: { select: { id: true, number: true } },
  lines: { include: { item: { select: { name: true, unit: true } } }, orderBy: { id: 'asc' } },
} satisfies Prisma.GoodsReceiptInclude;
type ReceiptRow = Prisma.GoodsReceiptGetPayload<{ include: typeof receiptInclude }>;

/** Fournisseurs, commandes d'achat et réceptions de livraisons. */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly ledger: StockLedger,
  ) {}

  // ------------------------------------------------------------------ fournisseurs

  suppliers(auth: AuthContext, includeArchived = false) {
    return this.prisma.supplier
      .findMany({
        where: { siteId: auth.siteId, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: { name: 'asc' },
      })
      .then((rows) =>
        rows.map((s) => ({
          id: s.id,
          name: s.name,
          phone: s.phone,
          contact: s.contact,
          note: s.note,
          archived: !!s.archivedAt,
          version: s.version,
        })),
      );
  }

  async createSupplier(auth: AuthContext, input: SupplierCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.create({ data: { siteId: auth.siteId, ...input } });
        // Le téléphone n'est pas journalisé (donnée personnelle).
        await this.stock.log(tx, auth, 'supplier.created', 'supplier', supplier.id, {
          after: { name: input.name },
        });
        return supplier;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async updateSupplier(auth: AuthContext, id: string, input: SupplierUpdateInput) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findFirst({ where: { id, siteId: auth.siteId } });
        if (!supplier) throw notFound('Fournisseur');
        const { version, archived, ...fields } = input;
        const { count } = await tx.supplier.updateMany({
          where: { id, version },
          data: {
            ...fields,
            archivedAt: archived === undefined ? undefined : archived ? new Date() : null,
            version: { increment: 1 },
          },
        });
        if (count === 0) throw versionConflict();
        await this.stock.log(tx, auth, 'supplier.updated', 'supplier', id, {
          before: { name: supplier.name, archived: !!supplier.archivedAt },
          after: { name: input.name ?? supplier.name, archived: archived ?? !!supplier.archivedAt },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    return (await this.suppliers(auth, true)).find((s) => s.id === id);
  }

  // ------------------------------------------------------------------ commandes d'achat

  async orders(auth: AuthContext) {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { siteId: auth.siteId },
      include: orderInclude,
      orderBy: { number: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toOrder(r));
  }

  async order(auth: AuthContext, id: string) {
    const row = await this.prisma.purchaseOrder.findFirst({
      where: { id, siteId: auth.siteId },
      include: orderInclude,
    });
    if (!row) throw notFound("Commande d'achat");
    return this.toOrder(row);
  }

  async createOrder(auth: AuthContext, input: PurchaseOrderCreateInput) {
    const id = await this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { id: input.supplierId, siteId: auth.siteId, archivedAt: null },
      });
      if (!supplier) throw notFound('Fournisseur');
      const lines = await this.resolveLines(tx, auth, input.lines);
      const order = await tx.purchaseOrder.create({
        data: {
          siteId: auth.siteId,
          supplierId: supplier.id,
          number: await nextCounter(tx, auth.siteId, 'purchase_order'),
          note: input.note,
          createdById: auth.userId,
          lines: {
            create: lines.map((l) => ({
              itemId: l.itemId,
              unitName: l.unitName,
              factor: l.factor,
              quantity: l.quantity,
              unitPriceXaf: l.unitPriceXaf,
            })),
          },
        },
      });
      await this.stock.log(tx, auth, 'purchase_order.created', 'purchase_order', order.id, {
        after: {
          number: order.number,
          supplier: supplier.name,
          totalXaf: lines.reduce((s, l) => s + l.totalXaf, 0),
        },
      });
      return order.id;
    });
    return this.order(auth, id);
  }

  /** Clôt une commande : « reçue » si une partie a été livrée, « annulée » sinon. */
  async closeOrder(auth: AuthContext, id: string, version: number) {
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.purchaseOrder.findFirst({
        where: { id, siteId: auth.siteId },
        include: { lines: true },
      });
      if (!order) throw notFound("Commande d'achat");
      if (order.status !== 'open') {
        throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La commande est déjà close' });
      }
      const delivered = order.lines.some((l) => l.receivedQuantity.gt(0));
      const status = delivered ? 'received' : 'cancelled';
      const { count } = await tx.purchaseOrder.updateMany({
        where: { id, version, status: 'open' },
        data: { status, closedAt: new Date(), version: { increment: 1 } },
      });
      if (count === 0) throw versionConflict();
      await this.stock.log(tx, auth, `purchase_order.${status}`, 'purchase_order', id, {
        after: { number: order.number, status },
      });
    });
    return this.order(auth, id);
  }

  // ------------------------------------------------------------------ réceptions

  async receipts(auth: AuthContext) {
    const rows = await this.prisma.goodsReceipt.findMany({
      where: { siteId: auth.siteId },
      include: receiptInclude,
      orderBy: { number: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toReceipt(r));
  }

  async receipt(auth: AuthContext, id: string) {
    const row = await this.prisma.goodsReceipt.findFirst({
      where: { id, siteId: auth.siteId },
      include: receiptInclude,
    });
    if (!row) throw notFound('Réception');
    return this.toReceipt(row);
  }

  /**
   * Réception d'une livraison : conversion en unité de base (1 casier = 12 bouteilles), entrée en stock,
   * coût moyen pondéré recalculé, avancement de la commande d'achat. Figée une fois enregistrée.
   */
  async receive(auth: AuthContext, input: GoodsReceiptInput) {
    const replay = await this.findReplay(auth, input.idempotencyKey);
    if (replay) return replay;
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await this.stock.activeLocation(tx, auth, input.locationId);

        let order: Prisma.PurchaseOrderGetPayload<{ include: { lines: true } }> | null = null;
        if (input.purchaseOrderId) {
          order = await tx.purchaseOrder.findFirst({
            where: { id: input.purchaseOrderId, siteId: auth.siteId },
            include: { lines: true },
          });
          if (!order) throw notFound("Commande d'achat");
          if (order.status !== 'open') {
            throw new ConflictException({ code: 'ORDER_CLOSED', message: "La commande d'achat est close" });
          }
        }
        const supplierId = input.supplierId ?? order?.supplierId;
        if (supplierId) {
          const supplier = await tx.supplier.findFirst({
            where: { id: supplierId, siteId: auth.siteId, archivedAt: null },
          });
          if (!supplier) throw notFound('Fournisseur');
          if (order && order.supplierId !== supplier.id) {
            throw new BadRequestException({
              code: 'SUPPLIER_MISMATCH',
              message: "Le fournisseur ne correspond pas à la commande d'achat",
            });
          }
        }

        const lines = await this.resolveLines(tx, auth, input.lines);
        const orderLines = new Map((order?.lines ?? []).map((l) => [l.id, l]));
        for (const l of input.lines) {
          if (!l.purchaseOrderLineId) continue;
          const ordered = orderLines.get(l.purchaseOrderLineId);
          if (!ordered || ordered.itemId !== l.itemId) {
            throw new BadRequestException({
              code: 'ORDER_LINE_MISMATCH',
              message: "Ligne de commande d'achat inconnue pour cet article",
            });
          }
        }

        // Verrou des articles reçus : deux réceptions simultanées ne faussent pas le coût moyen.
        const itemIds = [...new Set(lines.map((l) => l.itemId))];
        await tx.$queryRaw`SELECT "id" FROM "stock_item" WHERE "id" = ANY(${itemIds}::uuid[]) FOR UPDATE`;

        const totalXaf = lines.reduce((s, l) => s + l.totalXaf, 0);
        const receipt = await tx.goodsReceipt.create({
          data: {
            siteId: auth.siteId,
            number: await nextCounter(tx, auth.siteId, 'goods_receipt'),
            supplierId,
            purchaseOrderId: order?.id,
            locationId: input.locationId,
            reference: input.reference,
            note: input.note,
            totalXaf,
            idempotencyKey: input.idempotencyKey,
            createdById: auth.userId,
            lines: {
              create: lines.map((l, i) => ({
                itemId: l.itemId,
                purchaseOrderLineId: input.lines[i]!.purchaseOrderLineId,
                unitName: l.unitName,
                factor: l.factor,
                quantity: l.quantity,
                baseQuantity: l.baseQuantity,
                unitPriceXaf: l.unitPriceXaf,
                totalXaf: l.totalXaf,
              })),
            },
          },
        });

        for (const line of lines) {
          const item = await tx.stockItem.findUniqueOrThrow({
            where: { id: line.itemId },
            include: { levels: true },
          });
          const onHand = Decimal.max(
            item.levels.reduce((s, l) => s.plus(l.quantity), new Decimal(0)),
            0,
          );
          // Coût d'une unité de base pour cette livraison (prix du casier ÷ 12).
          const unitCost = new Decimal(line.unitPriceXaf).dividedBy(line.factor);
          const avgCost = onHand.isZero()
            ? unitCost
            : onHand
                .times(item.avgCostXaf)
                .plus(line.baseQuantity.times(unitCost))
                .dividedBy(onHand.plus(line.baseQuantity));
          await tx.stockItem.update({
            where: { id: item.id },
            data: { avgCostXaf: avgCost.toDecimalPlaces(4) },
          });
          // Le niveau change à chaque ligne : le coût moyen d'une ligne suivante du même article en tient compte.
          await this.ledger.record(tx, auth.siteId, auth.userId, [
            {
              itemId: item.id,
              locationId: input.locationId,
              type: 'receipt',
              quantity: line.baseQuantity,
              unitCostXaf: unitCost,
              goodsReceiptId: receipt.id,
            },
          ]);
        }

        if (order) {
          for (const [i, l] of input.lines.entries()) {
            if (!l.purchaseOrderLineId) continue;
            const ordered = orderLines.get(l.purchaseOrderLineId)!;
            // Quantité reçue exprimée dans le conditionnement commandé.
            const received = lines[i]!.baseQuantity.dividedBy(ordered.factor).toDecimalPlaces(3);
            await tx.purchaseOrderLine.update({
              where: { id: ordered.id },
              data: { receivedQuantity: { increment: received } },
            });
          }
          const refreshed = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id } });
          if (refreshed.every((l) => l.receivedQuantity.gte(l.quantity))) {
            await tx.purchaseOrder.update({
              where: { id: order.id },
              data: { status: 'received', closedAt: new Date(), version: { increment: 1 } },
            });
          }
        }

        await this.stock.log(tx, auth, 'stock.received', 'goods_receipt', receipt.id, {
          after: {
            number: receipt.number,
            purchaseOrder: order?.number ?? null,
            lines: lines.length,
            totalXaf,
          },
        });
        return receipt.id;
      });
      this.stock.changed(auth);
      return this.receipt(auth, id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.findReplay(auth, input.idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ outils

  /** Lignes d'achat contrôlées : article actif du site, conditionnement de cet article, montants recalculés. */
  private async resolveLines(
    tx: Tx,
    auth: AuthContext,
    input: { itemId: string; packagingId: string | null; quantity: number; unitPriceXaf: number }[],
  ) {
    const items = await tx.stockItem.findMany({
      where: { id: { in: [...new Set(input.map((l) => l.itemId))] }, siteId: auth.siteId, archivedAt: null },
      include: { packagings: { where: { archivedAt: null } } },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    return input.map((l) => {
      const item = byId.get(l.itemId);
      if (!item) throw notFound('Article');
      let unitName: string = item.unit;
      let factor = new Decimal(1);
      if (l.packagingId) {
        const packaging = item.packagings.find((p) => p.id === l.packagingId);
        if (!packaging) throw notFound('Conditionnement');
        unitName = packaging.name;
        factor = packaging.factor;
      }
      const quantity = new Decimal(l.quantity);
      return {
        itemId: item.id,
        unitName,
        factor,
        quantity,
        baseQuantity: quantity.times(factor).toDecimalPlaces(3),
        unitPriceXaf: l.unitPriceXaf,
        totalXaf: Math.round(quantity.times(l.unitPriceXaf).toNumber()),
      };
    });
  }

  private async findReplay(auth: AuthContext, key: string) {
    const found = await this.prisma.goodsReceipt.findUnique({
      where: { siteId_idempotencyKey: { siteId: auth.siteId, idempotencyKey: key } },
    });
    if (!found) return null;
    if (found.createdById !== auth.userId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Clé de requête déjà utilisée',
      });
    }
    return this.receipt(auth, found.id);
  }

  private toOrder(row: OrderRow) {
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      supplier: row.supplier,
      note: row.note,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      version: row.version,
      totalXaf: row.lines.reduce((s, l) => s + Math.round(l.quantity.times(l.unitPriceXaf).toNumber()), 0),
      lines: row.lines.map((l) => ({
        id: l.id,
        itemId: l.itemId,
        itemName: l.item.name,
        unit: l.item.unit,
        unitName: l.unitName,
        factor: Number(l.factor),
        quantity: Number(l.quantity),
        receivedQuantity: Number(l.receivedQuantity),
        unitPriceXaf: l.unitPriceXaf,
      })),
    };
  }

  private toReceipt(row: ReceiptRow) {
    return {
      id: row.id,
      number: row.number,
      supplier: row.supplier,
      location: row.location,
      purchaseOrder: row.purchaseOrder,
      reference: row.reference,
      note: row.note,
      totalXaf: row.totalXaf,
      createdAt: row.createdAt,
      lines: row.lines.map((l) => ({
        itemId: l.itemId,
        itemName: l.item.name,
        unit: l.item.unit,
        unitName: l.unitName,
        factor: Number(l.factor),
        quantity: Number(l.quantity),
        baseQuantity: Number(l.baseQuantity),
        unitPriceXaf: l.unitPriceXaf,
        totalXaf: l.totalXaf,
      })),
    };
  }
}
