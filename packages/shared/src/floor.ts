import { z } from 'zod';
import { QR_MODES } from './constants.js';

const versioned = { version: z.number().int().positive() };

export const zoneCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sortOrder: z.number().int().min(0).default(0),
});
export type ZoneCreateInput = z.infer<typeof zoneCreateSchema>;

export const zoneUpdateSchema = z.object({
  ...versioned,
  name: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export type ZoneUpdateInput = z.infer<typeof zoneUpdateSchema>;

const label = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .regex(/^[\p{L}\p{N} _-]+$/u, 'Lettres, chiffres, espaces et tirets uniquement');

export const tableCreateSchema = z.object({
  zoneId: z.uuid(),
  label,
  seats: z.number().int().min(1).max(50).default(4),
});
export type TableCreateInput = z.infer<typeof tableCreateSchema>;

export const tableUpdateSchema = z.object({
  ...versioned,
  zoneId: z.uuid().optional(),
  label: label.optional(),
  seats: z.number().int().min(1).max(50).optional(),
  posX: z.number().int().min(0).max(100).optional(),
  posY: z.number().int().min(0).max(100).optional(),
});
export type TableUpdateInput = z.infer<typeof tableUpdateSchema>;

export const qrModeSchema = z.object({ mode: z.enum(QR_MODES) });
export type QrModeInput = z.infer<typeof qrModeSchema>;

/** Adresse publique encodée dans le QR code d'une table. */
export const qrUrl = (publicMenuUrl: string, token: string): string =>
  `${publicMenuUrl.replace(/\/+$/, '')}/q/${token}`;
