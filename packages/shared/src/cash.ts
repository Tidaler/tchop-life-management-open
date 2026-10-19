import { z } from 'zod';
import { PAYMENT_METHODS, REFERENCE_REQUIRED, REFUND_METHODS, SETTLEMENT_METHODS } from './constants.js';
import { approvalSchema } from './orders.js';

const amount = z.number().int().min(0).max(10_000_000);
const reason = z.string().trim().min(3).max(200);
/** Référence de transaction : lettres, chiffres et séparateurs courants, rien d'autre. */
const reference = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .regex(/^[A-Za-z0-9._/-]+$/, 'Référence invalide');

export const openSessionSchema = z.object({
  registerId: z.uuid(),
  openingFloatXaf: amount,
});
export type OpenSessionInput = z.infer<typeof openSessionSchema>;

export const closeSessionSchema = z.object({
  countedCashXaf: amount,
  comment: z.string().trim().min(3).max(300).optional(),
  approval: approvalSchema.optional(),
});
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;

const discountSchema = z
  .object({
    type: z.enum(['percent', 'amount']),
    value: z.number().min(0).max(10_000_000),
    reason,
  })
  .refine((d) => d.type !== 'percent' || d.value <= 100, {
    message: 'Pourcentage invalide',
    path: ['value'],
  });

/** Remise sur une addition sans paiement (valeur 0 : retire la remise). */
export const applyDiscountSchema = z.object({
  discount: discountSchema,
  approval: approvalSchema.optional(),
});
export type ApplyDiscountInput = z.infer<typeof applyDiscountSchema>;

export const createBillSchema = z.object({
  /** Lignes et quantités à facturer ; absent : tout ce qui reste à facturer. */
  lines: z
    .array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(100)
    .optional(),
  discount: discountSchema.optional(),
  approval: approvalSchema.optional(),
});
export type CreateBillInput = z.infer<typeof createBillSchema>;

export const paymentSchema = z
  .object({
    idempotencyKey: z.uuid(),
    method: z.enum(PAYMENT_METHODS),
    /** Montant imputé (tous moyens sauf espèces). */
    amountXaf: amount.optional(),
    /** Espèces remises par le client (la monnaie est calculée par le serveur). */
    tenderedXaf: amount.optional(),
    reference: reference.optional(),
    customerId: z.uuid().optional(),
    approval: approvalSchema.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.method === 'cash' && !p.tenderedXaf) {
      ctx.addIssue({ code: 'custom', message: 'Montant remis obligatoire', path: ['tenderedXaf'] });
    }
    if (p.method !== 'cash' && !p.amountXaf) {
      ctx.addIssue({ code: 'custom', message: 'Montant obligatoire', path: ['amountXaf'] });
    }
    if (p.method !== 'cash' && p.tenderedXaf !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Montant remis réservé aux espèces', path: ['tenderedXaf'] });
    }
    if (REFERENCE_REQUIRED.includes(p.method) && !p.reference) {
      ctx.addIssue({ code: 'custom', message: 'Référence de transaction obligatoire', path: ['reference'] });
    }
    if ((p.method === 'customer_credit') !== !!p.customerId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Client requis pour une ardoise, et seulement pour elle',
        path: ['customerId'],
      });
    }
  });
export type PaymentInput = z.infer<typeof paymentSchema>;

export const voidPaymentSchema = z.object({ reason, approval: approvalSchema.optional() });
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ]{6,20}$/, 'Numéro de téléphone invalide');

export const customerCreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  phone: phone.optional(),
  creditLimitXaf: z.number().int().min(0).max(5_000_000),
  note: z.string().trim().max(200).optional(),
});
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

export const customerUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(2).max(60).optional(),
  phone: phone.nullable().optional(),
  creditLimitXaf: z.number().int().min(0).max(5_000_000).optional(),
  note: z.string().trim().max(200).nullable().optional(),
  active: z.boolean().optional(),
});
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

/** Règlement (total ou partiel) d'une ardoise, encaissé dans la session de caisse ouverte. */
export const settlementSchema = z
  .object({
    idempotencyKey: z.uuid(),
    method: z.enum(SETTLEMENT_METHODS),
    amountXaf: z.number().int().min(1).max(10_000_000),
    reference: reference.optional(),
  })
  .refine((s) => !REFERENCE_REQUIRED.includes(s.method) || !!s.reference, {
    message: 'Référence de transaction obligatoire',
    path: ['reference'],
  });
export type SettlementInput = z.infer<typeof settlementSchema>;

/**
 * Remboursement d'une addition payée : des lignes (avec remise en stock possible) ou un montant libre,
 * jamais les deux. Un avoir sur ardoise désigne le client ; MoMo et Orange Money portent une référence.
 */
export const refundSchema = z
  .object({
    idempotencyKey: z.uuid(),
    method: z.enum(REFUND_METHODS),
    reason,
    lines: z
      .array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1).max(99) }))
      .min(1)
      .max(100)
      .optional(),
    amountXaf: z.number().int().min(1).max(10_000_000).optional(),
    restock: z.boolean().default(false),
    reference: reference.optional(),
    customerId: z.uuid().optional(),
    approval: approvalSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (!!r.lines === (r.amountXaf !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Des lignes ou un montant, pas les deux', path: ['lines'] });
    }
    if (r.restock && !r.lines) {
      ctx.addIssue({ code: 'custom', message: 'La remise en stock porte sur des lignes', path: ['restock'] });
    }
    if ((r.method === 'customer_credit') !== !!r.customerId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Client requis pour un avoir, et seulement pour lui',
        path: ['customerId'],
      });
    }
    if ((r.method === 'mtn_momo' || r.method === 'orange_money') && !r.reference) {
      ctx.addIssue({ code: 'custom', message: 'Référence de transaction obligatoire', path: ['reference'] });
    }
  });
export type RefundInput = z.infer<typeof refundSchema>;
