import { z } from 'zod';
import { STATIONS } from './constants.js';
import { VIP_SURCHARGE_MAX_XAF } from './vip.js';

/** Texte affiché aux clients en français et en anglais ; l'anglais retombe sur le français s'il est vide. */
export const translatedSchema = z.object({
  fr: z.string().trim().min(1).max(120),
  en: z.string().trim().max(120).default(''),
});

const longTranslatedSchema = z.object({
  fr: z.string().trim().max(400).default(''),
  en: z.string().trim().max(400).default(''),
});

/** Verrou optimiste : la version vue par l'utilisateur au moment de la modification. */
const versioned = { version: z.number().int().positive() };

const priceXaf = z.number().int().min(0).max(10_000_000);

const vipSurchargeXaf = z.number().int().min(0).max(VIP_SURCHARGE_MAX_XAF);

export const categoryCreateSchema = z.object({
  name: translatedSchema,
  visibleOnQr: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
  vipOffered: z.boolean().default(true),
  vipSurchargeXaf: vipSurchargeXaf.default(0),
});
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

export const categoryUpdateSchema = z.object({
  ...versioned,
  name: translatedSchema.optional(),
  visibleOnQr: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  vipOffered: z.boolean().optional(),
  vipSurchargeXaf: vipSurchargeXaf.optional(),
});
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

export const productCreateSchema = z.object({
  categoryId: z.uuid(),
  name: translatedSchema,
  description: longTranslatedSchema.optional(),
  priceXaf,
  /** Points de base : 1925 = 19,25 %. */
  taxRateBp: z.number().int().min(0).max(10_000).default(0),
  station: z.enum(STATIONS),
  /** Supplément Salon VIP propre au produit ; null ou absent : celui de sa catégorie. */
  vipSurchargeXaf: vipSurchargeXaf.nullable().default(null),
  available: z.boolean().default(true),
  visibleOnQr: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
  modifierGroupIds: z.array(z.uuid()).max(10).default([]),
});
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = z.object({
  ...versioned,
  categoryId: z.uuid().optional(),
  name: translatedSchema.optional(),
  description: longTranslatedSchema.optional(),
  priceXaf: priceXaf.optional(),
  taxRateBp: z.number().int().min(0).max(10_000).optional(),
  station: z.enum(STATIONS).optional(),
  vipSurchargeXaf: vipSurchargeXaf.nullable().optional(),
  available: z.boolean().optional(),
  visibleOnQr: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  modifierGroupIds: z.array(z.uuid()).max(10).optional(),
});
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const availabilitySchema = z.object({ available: z.boolean() });
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

const modifierSchema = z.object({
  /** Absent : nouvelle option. Présent : option existante à modifier. */
  id: z.uuid().optional(),
  name: translatedSchema,
  priceDeltaXaf: z.number().int().min(0).max(1_000_000).default(0),
  available: z.boolean().default(true),
});

const modifierGroupFields = {
  name: translatedSchema,
  minSelect: z.number().int().min(0).max(20),
  maxSelect: z.number().int().min(1).max(20),
  /** Liste complète des options : celles qui n'y figurent plus sont archivées. */
  modifiers: z.array(modifierSchema).min(1).max(30),
};

const selectRange = (g: { minSelect: number; maxSelect: number; modifiers: unknown[] }) =>
  g.minSelect <= g.maxSelect && g.minSelect <= g.modifiers.length;

export const modifierGroupCreateSchema = z
  .object(modifierGroupFields)
  .refine(selectRange, { message: 'Choix minimum incohérent', path: ['minSelect'] });
export type ModifierGroupCreateInput = z.infer<typeof modifierGroupCreateSchema>;

export const modifierGroupUpdateSchema = z
  .object({ ...versioned, ...modifierGroupFields })
  .refine(selectRange, { message: 'Choix minimum incohérent', path: ['minSelect'] });
export type ModifierGroupUpdateInput = z.infer<typeof modifierGroupUpdateSchema>;
