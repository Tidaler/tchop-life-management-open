import { z } from 'zod';
import { EXPENSE_KINDS, EXPENSE_METHODS } from './constants.js';
import { approvalSchema } from './orders.js';

const reason = z.string().trim().min(3).max(200);
const versioned = { version: z.number().int().positive() };

// ---------------------------------------------------------------- Dépenses

export const expenseCategoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(EXPENSE_KINDS).default('operating'),
});
export type ExpenseCategoryCreateInput = z.infer<typeof expenseCategoryCreateSchema>;

export const expenseCategoryUpdateSchema = z.object({
  ...versioned,
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(EXPENSE_KINDS).optional(),
  archived: z.boolean().optional(),
});
export type ExpenseCategoryUpdateInput = z.infer<typeof expenseCategoryUpdateSchema>;

export const expenseCreateSchema = z
  .object({
    idempotencyKey: z.uuid(),
    categoryId: z.uuid(),
    /** Jour d'exploitation ; par défaut, aujourd'hui. Jamais dans le futur. */
    date: z.iso.date().optional(),
    amountXaf: z.number().int().min(1).max(100_000_000),
    method: z.enum(EXPENSE_METHODS),
    /** Espèces sorties de la caisse ouverte de l'utilisateur : elles réduisent le théorique de clôture. */
    fromCashSession: z.boolean().default(false),
    supplierId: z.uuid().optional(),
    description: z.string().trim().min(3).max(200),
    reference: z.string().trim().min(1).max(40).optional(),
    approval: approvalSchema.optional(),
  })
  .refine((e) => !e.fromCashSession || e.method === 'cash', {
    message: 'Une dépense payée depuis la caisse est en espèces',
    path: ['method'],
  });
export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>;

export const expenseVoidSchema = z.object({ reason, approval: approvalSchema.optional() });
export type ExpenseVoidInput = z.infer<typeof expenseVoidSchema>;

// ---------------------------------------------------------------- Périodes et journaux

const MAX_DAYS = 366;

/** Période de rapport (jours d'exploitation inclus), un an au plus. */
export const periodSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((p) => p.from <= p.to, { message: 'Période invalide', path: ['to'] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= MAX_DAYS * 86_400_000, {
    message: 'Période limitée à un an',
    path: ['to'],
  });
export type Period = z.infer<typeof periodSchema>;

export const expensesQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  categoryId: z.uuid().optional(),
});
export type ExpensesQuery = z.infer<typeof expensesQuerySchema>;

export const auditQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Début d'action, ex. « payment. » ou « stock.loss ». */
  action: z
    .string()
    .trim()
    .max(60)
    .regex(/^[a-z_.]*$/)
    .optional(),
  actorId: z.uuid().optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const EXPORT_KINDS = ['sales', 'payments', 'expenses', 'stock-movements'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
