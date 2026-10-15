import { Injectable } from '@nestjs/common';
import { Prisma, type StockMovementType } from '@tchop/db';
import { notFound } from '../common/errors.js';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

export interface MovementInput {
  itemId: string;
  locationId: string;
  type: StockMovementType;
  /** Quantité signée en unité de base (sortie négative). */
  quantity: Prisma.Decimal | number;
  /** Coût unitaire retenu ; par défaut, le coût moyen actuel de l'article. */
  unitCostXaf?: Prisma.Decimal | number;
  reason?: string | null;
  orderLineId?: string;
  goodsReceiptId?: string;
  inventoryCountId?: string;
  groupId?: string;
  approvedById?: string | null;
}

/** Ligne vendue, telle qu'enregistrée sur la commande. */
export interface SoldLine {
  id: string;
  productId: string;
  quantity: number;
  modifiers: unknown;
}

/**
 * Journal des mouvements de stock : chaque mouvement est écrit en ajout seul et le niveau du magasin
 * est mis à jour dans la même transaction. Rien ne bloque une vente : un stock peut devenir négatif,
 * l'écart remonte à l'inventaire (docs/architecture/02, « Règles de calcul »).
 */
@Injectable()
export class StockLedger {
  async record(tx: Tx, siteId: string, userId: string, movements: MovementInput[]): Promise<void> {
    const kept = movements
      .map((m) => ({ ...m, quantity: new Decimal(m.quantity).toDecimalPlaces(3) }))
      .filter((m) => !m.quantity.isZero());
    if (kept.length === 0) return;

    const itemIds = [...new Set(kept.map((m) => m.itemId))];
    const locationIds = [...new Set(kept.map((m) => m.locationId))];
    const [items, locations] = [
      await tx.stockItem.findMany({
        where: { id: { in: itemIds }, siteId },
        select: { id: true, avgCostXaf: true },
      }),
      await tx.stockLocation.findMany({ where: { id: { in: locationIds }, siteId }, select: { id: true } }),
    ];
    if (items.length !== itemIds.length) throw notFound('Article');
    if (locations.length !== locationIds.length) throw notFound('Magasin');
    const cost = new Map(items.map((i) => [i.id, i.avgCostXaf]));

    await tx.stockMovement.createMany({
      data: kept.map((m) => ({
        siteId,
        itemId: m.itemId,
        locationId: m.locationId,
        type: m.type,
        quantity: m.quantity,
        unitCostXaf: new Decimal(m.unitCostXaf ?? cost.get(m.itemId)!).toDecimalPlaces(4),
        reason: m.reason ?? null,
        orderLineId: m.orderLineId,
        goodsReceiptId: m.goodsReceiptId,
        inventoryCountId: m.inventoryCountId,
        groupId: m.groupId,
        createdById: userId,
        approvedById: m.approvedById ?? null,
      })),
    });

    const deltas = new Map<string, { itemId: string; locationId: string; quantity: Prisma.Decimal }>();
    for (const m of kept) {
      const key = `${m.itemId}:${m.locationId}`;
      const current = deltas.get(key);
      if (current) current.quantity = current.quantity.plus(m.quantity);
      else deltas.set(key, { itemId: m.itemId, locationId: m.locationId, quantity: m.quantity });
    }
    for (const d of deltas.values()) {
      await tx.$executeRaw`
        INSERT INTO "stock_level" ("item_id", "location_id", "quantity", "updated_at")
        VALUES (${d.itemId}::uuid, ${d.locationId}::uuid, ${d.quantity.toString()}::numeric, now())
        ON CONFLICT ("item_id", "location_id")
        DO UPDATE SET "quantity" = "stock_level"."quantity" + EXCLUDED."quantity", "updated_at" = now()`;
    }
  }

  /**
   * Sortie de stock d'une vente : chaque ligne de recette du produit, et celles des options choisies,
   * sortent du magasin de l'article. Un produit sans recette ne déduit rien.
   */
  async deductSale(tx: Tx, siteId: string, userId: string, lines: SoldLine[]): Promise<void> {
    if (lines.length === 0) return;
    const recipes = await tx.recipeLine.findMany({
      where: { productId: { in: [...new Set(lines.map((l) => l.productId))] }, item: { siteId } },
      include: { item: { select: { locationId: true } } },
    });
    if (recipes.length === 0) return;

    const movements: MovementInput[] = [];
    for (const line of lines) {
      const chosen = new Set(
        (Array.isArray(line.modifiers) ? (line.modifiers as { modifierId?: string }[]) : []).map(
          (m) => m.modifierId,
        ),
      );
      for (const r of recipes) {
        if (r.productId !== line.productId || (r.modifierId && !chosen.has(r.modifierId))) continue;
        movements.push({
          itemId: r.itemId,
          locationId: r.item.locationId,
          type: 'sale',
          quantity: r.quantity.times(line.quantity).negated(),
          orderLineId: line.id,
        });
      }
    }
    await this.record(tx, siteId, userId, movements);
  }

  /**
   * Annulation d'une ligne vendue. `restock` : la marchandise revient en stock (bière non ouverte).
   * `loss` : elle est perdue (plat préparé) ; la sortie est requalifiée en perte, pour que les rapports
   * distinguent ventes et pertes. Les mouvements inverses reprennent le coût de la sortie d'origine.
   */
  async reverseSale(
    tx: Tx,
    siteId: string,
    userId: string,
    orderLineId: string,
    mode: 'restock' | 'loss',
    reason: string,
    approvedById: string | null,
  ): Promise<void> {
    const sales = await tx.stockMovement.findMany({ where: { siteId, orderLineId, type: 'sale' } });
    const movements: MovementInput[] = [];
    for (const s of sales) {
      const common = {
        itemId: s.itemId,
        locationId: s.locationId,
        unitCostXaf: s.unitCostXaf,
        orderLineId,
        approvedById,
      };
      movements.push({ ...common, type: 'sale_cancel', quantity: s.quantity.negated(), reason });
      if (mode === 'loss') movements.push({ ...common, type: 'loss', quantity: s.quantity, reason });
    }
    await this.record(tx, siteId, userId, movements);
  }
}
