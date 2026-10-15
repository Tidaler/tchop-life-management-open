import { z } from 'zod';
import { QR_LIMITS } from './constants.js';
import { sendLineSchema } from './orders.js';

export const qrSubmitSchema = z
  .object({
    idempotencyKey: z.uuid(),
    lines: z.array(sendLineSchema).min(1).max(QR_LIMITS.maxItems),
  })
  .refine((d) => d.lines.reduce((n, l) => n + l.quantity, 0) <= QR_LIMITS.maxItems, {
    message: `${QR_LIMITS.maxItems} articles au maximum par commande`,
    path: ['lines'],
  });
export type QrSubmitInput = z.infer<typeof qrSubmitSchema>;

export const qrRejectSchema = z.object({ reason: z.string().trim().min(3).max(200) });
export type QrRejectInput = z.infer<typeof qrRejectSchema>;
