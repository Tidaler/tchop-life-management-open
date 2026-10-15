import { z } from 'zod';
import { LOSS_TYPES, STOCK_MOVEMENT_TYPES, STOCK_UNITS } from './constants.js';
import { approvalSchema } from './orders.js';

/** Au plus trois décimales : la base stocke les quantités en numeric(14,3). */
const thousandths = (v: number) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;
const quantity = z.number().positive().max(1_000_000).refine(thousandths, 'Trois décimales au plus');
const quantityOrZero = z.number().min(0).max(1_000_000).refine(thousandths, 'Trois décimales au plus');
const name = z.string().trim().min(1).max(80);
const reason = z.string().trim().min(3).max(200);
const note = z.string().trim().max(300).optional();
const priceXaf = z.number().int().min(0).max(100_000_000);
const versioned = { version: z.number().int().positive() };
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ]{6,20}$/, 'Numéro de téléphone invalide');

// ---------------------------------------------------------------- Magasins et articles

export const locationCreateSchema = z.object({
  name,
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type LocationCreateInput = z.infer<typeof locationCreateSchema>;

export const locationUpdateSchema = z.object({
  ...versioned,
  name: name.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
});
export type LocationUpdateInput = z.infer<typeof locationUpdateSchema>;

const packagingSchema = z.object({ name: z.string().trim().min(1).max(40), factor: quantity });

export const stockItemCreateSchema = z.object({
  name,
  unit: z.enum(STOCK_UNITS),
  locationId: z.uuid(),
  alertThreshold: quantityOrZero.default(0),
  packagings: z.array(packagingSchema).max(5).default([]),
});
export type StockItemCreateInput = z.infer<typeof stockItemCreateSchema>;

/** L'unité de base ne change pas : les quantités déjà enregistrées perdraient leur sens. */
export const stockItemUpdateSchema = z.object({
  ...versioned,
  name: name.optional(),
  locationId: z.uuid().optional(),
  alertThreshold: quantityOrZero.optional(),
  archived: z.boolean().optional(),
});
export type StockItemUpdateInput = z.infer<typeof stockItemUpdateSchema>;

export const packagingCreateSchema = packagingSchema;
export type PackagingCreateInput = z.infer<typeof packagingCreateSchema>;

// ---------------------------------------------------------------- Recettes

export const recipeSchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity,
        /** Option du produit : la ligne ne compte que si le client l'a choisie. */
        modifierId: z.uuid().nullable().default(null),
      }),
    )
    .max(30)
    .refine(
      (lines) => new Set(lines.map((l) => `${l.itemId}:${l.modifierId ?? ''}`)).size === lines.length,
      'Article en double dans la recette',
    ),
});
export type RecipeInput = z.infer<typeof recipeSchema>;

// ---------------------------------------------------------------- Mouvements déclarés

export const lossSchema = z.object({
  idempotencyKey: z.uuid(),
  type: z.enum(LOSS_TYPES),
  itemId: z.uuid(),
  /** Magasin concerné ; par défaut, le magasin de sortie de l'article. */
  locationId: z.uuid().optional(),
  quantity,
  reason,
  approval: approvalSchema.optional(),
});
export type LossInput = z.infer<typeof lossSchema>;

export const transferSchema = z
  .object({
    idempotencyKey: z.uuid(),
    itemId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    quantity,
    note,
  })
  .refine((t) => t.fromLocationId !== t.toLocationId, {
    message: 'Les deux magasins doivent être différents',
    path: ['toLocationId'],
  });
export type TransferInput = z.infer<typeof transferSchema>;

/** Correction manuelle d'un stock (hors inventaire) : quantité signée, jamais nulle. */
export const adjustmentSchema = z.object({
  idempotencyKey: z.uuid(),
  itemId: z.uuid(),
  locationId: z.uuid(),
  quantity: z
    .number()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'Quantité nulle')
    .refine(thousandths, 'Trois décimales au plus'),
  reason,
  approval: approvalSchema.optional(),
});
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const movementsQuerySchema = z.object({
  itemId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Pagination : identifiant du dernier mouvement déjà affiché. */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MovementsQuery = z.infer<typeof movementsQuerySchema>;

// ---------------------------------------------------------------- Fournisseurs et achats

export const supplierCreateSchema = z.object({
  name,
  phone: phone.optional(),
  contact: z.string().trim().max(80).optional(),
  note,
});
export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;

export const supplierUpdateSchema = z.object({
  ...versioned,
  name: name.optional(),
  phone: phone.nullable().optional(),
  contact: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  archived: z.boolean().optional(),
});
export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;

const purchaseLine = {
  itemId: z.uuid(),
  /** Conditionnement (casier, carton…) ; absent : unité de base. */
  packagingId: z.uuid().nullable().default(null),
  quantity,
  /** Prix par conditionnement (FCFA). */
  unitPriceXaf: priceXaf,
};

export const purchaseOrderCreateSchema = z.object({
  supplierId: z.uuid(),
  note,
  lines: z.array(z.object(purchaseLine)).min(1).max(50),
});
export type PurchaseOrderCreateInput = z.infer<typeof purchaseOrderCreateSchema>;

export const goodsReceiptSchema = z.object({
  idempotencyKey: z.uuid(),
  supplierId: z.uuid().optional(),
  purchaseOrderId: z.uuid().optional(),
  locationId: z.uuid(),
  /** N° du bon de livraison ou de la facture. */
  reference: z.string().trim().min(1).max(40).optional(),
  note,
  lines: z
    .array(z.object({ ...purchaseLine, purchaseOrderLineId: z.uuid().optional() }))
    .min(1)
    .max(80),
});
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>;

// ---------------------------------------------------------------- Inventaires

export const inventoryStartSchema = z.object({ locationId: z.uuid(), note });
export type InventoryStartInput = z.infer<typeof inventoryStartSchema>;

export const inventoryCountSchema = z.object({
  lines: z
    .array(z.object({ itemId: z.uuid(), countedQty: quantityOrZero.nullable() }))
    .min(1)
    .max(300),
});
export type InventoryCountInput = z.infer<typeof inventoryCountSchema>;

export const inventoryCloseSchema = z.object({ ...versioned, approval: approvalSchema.optional() });
export type InventoryCloseInput = z.infer<typeof inventoryCloseSchema>;
