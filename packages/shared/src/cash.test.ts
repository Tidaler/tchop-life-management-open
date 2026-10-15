import { describe, expect, it } from 'vitest';
import { paymentSchema } from './cash.js';
import { discountAmount, discountOverThreshold } from './constants.js';

const key = '0199f000-0000-7000-8000-000000000200';

describe('caisse', () => {
  it('calcule la remise et la plafonne au sous-total', () => {
    expect(discountAmount(10_000, { type: 'percent', value: 10 })).toBe(1000);
    expect(discountAmount(10_000, { type: 'amount', value: 15_000 })).toBe(10_000);
  });

  it('demande une approbation au-delà de 10 % ou de 2 000 FCFA', () => {
    expect(discountOverThreshold(10_000, 1000)).toBe(false);
    expect(discountOverThreshold(10_000, 1001)).toBe(true);
    expect(discountOverThreshold(100_000, 2500)).toBe(true);
  });

  it('exige la référence pour MoMo et Orange Money, le montant remis pour les espèces', () => {
    expect(
      paymentSchema.safeParse({ idempotencyKey: key, method: 'mtn_momo', amountXaf: 1000 }).success,
    ).toBe(false);
    expect(
      paymentSchema.safeParse({
        idempotencyKey: key,
        method: 'mtn_momo',
        amountXaf: 1000,
        reference: 'MP241015.1830',
      }).success,
    ).toBe(true);
    expect(paymentSchema.safeParse({ idempotencyKey: key, method: 'cash', amountXaf: 1000 }).success).toBe(
      false,
    );
    expect(paymentSchema.safeParse({ idempotencyKey: key, method: 'cash', tenderedXaf: 5000 }).success).toBe(
      true,
    );
  });

  it('refuse une référence contenant des caractères inattendus', () => {
    const r = paymentSchema.safeParse({
      idempotencyKey: key,
      method: 'orange_money',
      amountXaf: 1000,
      reference: "x'; DROP TABLE",
    });
    expect(r.success).toBe(false);
  });

  it('associe un client uniquement à une ardoise', () => {
    const customerId = '0199f000-0000-7000-8000-000000000201';
    expect(
      paymentSchema.safeParse({ idempotencyKey: key, method: 'customer_credit', amountXaf: 500 }).success,
    ).toBe(false);
    expect(
      paymentSchema.safeParse({ idempotencyKey: key, method: 'card', amountXaf: 500, customerId }).success,
    ).toBe(false);
    expect(
      paymentSchema.safeParse({ idempotencyKey: key, method: 'customer_credit', amountXaf: 500, customerId })
        .success,
    ).toBe(true);
  });
});
