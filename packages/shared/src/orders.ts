import { z } from 'zod';
import { PRINTER_ROLES } from './constants.js';

export const sendLineSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(99),
  modifierIds: z.array(z.uuid()).max(20).default([]),
  note: z.string().trim().max(140).optional(),
});
export type SendLineInput = z.infer<typeof sendLineSchema>;

/** Envoi en préparation des articles saisis pour une table. */
export const sendOrderSchema = z.object({
  tableId: z.uuid(),
  /** Généré par la tablette : un renvoi après une coupure Wi-Fi ne crée pas de doublon. */
  idempotencyKey: z.uuid(),
  guests: z.number().int().min(1).max(100).optional(),
  lines: z.array(sendLineSchema).min(1).max(100),
});
export type SendOrderInput = z.infer<typeof sendOrderSchema>;

/** Vente directe à la caisse (comptoir, à emporter) : pas de table, addition préparée aussitôt. */
export const directSaleSchema = z.object({
  /** Généré par la caisse : un renvoi après une coupure ne crée pas de doublon. */
  idempotencyKey: z.uuid(),
  lines: z.array(sendLineSchema).min(1).max(100),
});
export type DirectSaleInput = z.infer<typeof directSaleSchema>;

/** PIN d'un gérant présent, pour les actions qui demandent une approbation. */
export const approvalSchema = z.object({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/),
});
export type ApprovalInput = z.infer<typeof approvalSchema>;

export const cancelLineSchema = z.object({
  reason: z.string().trim().min(3).max(200),
  /**
   * Stock de la ligne annulée : réintégré (marchandise intacte) ou compté en perte.
   * Absent : réintégré si la préparation n'avait pas commencé, perte sinon.
   */
  restock: z.boolean().optional(),
  approval: approvalSchema.optional(),
});
export type CancelLineInput = z.infer<typeof cancelLineSchema>;

export const transferOrderSchema = z.object({
  tableId: z.uuid(),
  version: z.number().int().positive(),
});
export type TransferOrderInput = z.infer<typeof transferOrderSchema>;

export const ticketStatusSchema = z.object({
  status: z.enum(['preparing', 'ready', 'served']),
});
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>;

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, 'Adresse IP ou nom d’hôte attendu');

export const printerCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  host,
  port: z.number().int().min(1).max(65535).default(9100),
  paperWidth: z.union([z.literal(58), z.literal(80)]).default(80),
  role: z.enum(PRINTER_ROLES),
  active: z.boolean().default(true),
});
export type PrinterCreateInput = z.infer<typeof printerCreateSchema>;

export const printerUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(40).optional(),
  host: host.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  paperWidth: z.union([z.literal(58), z.literal(80)]).optional(),
  role: z.enum(PRINTER_ROLES).optional(),
  active: z.boolean().optional(),
});
export type PrinterUpdateInput = z.infer<typeof printerUpdateSchema>;
