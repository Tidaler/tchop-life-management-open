import { z } from 'zod';

export const TICKET_STATUSES = ['new', 'preparing', 'ready', 'served'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const LINE_STATUSES = ['sent', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const PRINTER_ROLES = ['cashier', 'kitchen', 'grill', 'bar'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

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

/** PIN d'un gérant présent, pour les actions qui demandent une approbation. */
export const approvalSchema = z.object({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/),
});
export type ApprovalInput = z.infer<typeof approvalSchema>;

export const cancelLineSchema = z.object({
  reason: z.string().trim().min(3).max(200),
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

/** Passages autorisés d'un bon : on avance toujours, on peut sauter une étape, jamais revenir en arrière. */
export function canMoveTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUSES.indexOf(to) > TICKET_STATUSES.indexOf(from);
}

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

/** Total d'une liste de lignes, hors lignes annulées. */
export function linesTotal(lines: { unitPriceXaf: number; quantity: number; status: string }[]): number {
  return lines
    .filter((l) => l.status !== 'cancelled')
    .reduce((sum, l) => sum + l.unitPriceXaf * l.quantity, 0);
}

/**
 * Journée d'exploitation : un bar ferme après minuit, donc une vente à 2 h du matin appartient
 * à la journée de la veille. Renvoie la date (AAAA-MM-JJ) dans le fuseau du site.
 */
export function businessDay(at: Date, timeZone: string, cutoffHour = 6): string {
  const shifted = new Date(at.getTime() - cutoffHour * 3_600_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}
