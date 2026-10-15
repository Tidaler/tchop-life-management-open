import { describe, expect, it } from 'vitest';
import { businessDay, canMoveTicket, linesTotal } from './constants.js';

describe('commandes', () => {
  it('rattache une vente de 2 h du matin à la journée de la veille (Douala)', () => {
    // 01:30 UTC = 02:30 à Douala (UTC+1)
    expect(businessDay(new Date('2026-10-16T01:30:00Z'), 'Africa/Douala')).toBe('2026-10-15');
    expect(businessDay(new Date('2026-10-16T06:30:00Z'), 'Africa/Douala')).toBe('2026-10-16');
  });

  it('ne fait jamais reculer un bon', () => {
    expect(canMoveTicket('new', 'preparing')).toBe(true);
    expect(canMoveTicket('new', 'ready')).toBe(true);
    expect(canMoveTicket('ready', 'preparing')).toBe(false);
    expect(canMoveTicket('served', 'served')).toBe(false);
  });

  it('exclut les lignes annulées du total', () => {
    expect(
      linesTotal([
        { unitPriceXaf: 3500, quantity: 2, status: 'sent' },
        { unitPriceXaf: 700, quantity: 3, status: 'cancelled' },
      ]),
    ).toBe(7000);
  });
});

describe('menu QR', () => {
  it('résume l’avancement pour le client', async () => {
    const { qrClientStatus } = await import('./constants.js');
    expect(qrClientStatus('pending', [])).toBe('pending');
    expect(qrClientStatus('accepted', ['sent', 'sent'])).toBe('accepted');
    expect(qrClientStatus('accepted', ['preparing', 'sent'])).toBe('preparing');
    expect(qrClientStatus('accepted', ['ready', 'served', 'cancelled'])).toBe('ready');
    expect(qrClientStatus('accepted', ['served'])).toBe('served');
    expect(qrClientStatus('accepted', ['cancelled'])).toBe('rejected');
  });

  it('plafonne le nombre d’articles par commande', async () => {
    const { qrSubmitSchema } = await import('./qr.js');
    const line = { productId: '0199f000-0000-7000-8000-000000000123', quantity: 20 };
    const key = '0199f000-0000-7000-8000-000000000124';
    expect(qrSubmitSchema.safeParse({ idempotencyKey: key, lines: [line] }).success).toBe(true);
    expect(qrSubmitSchema.safeParse({ idempotencyKey: key, lines: [line, line] }).success).toBe(false);
  });

  it('reconnaît un jeton de QR code valide', async () => {
    const { QR_TOKEN_PATTERN } = await import('./constants.js');
    expect(QR_TOKEN_PATTERN.test('AbCdEfGhIjKlMnOpQrSt_-')).toBe(true);
    expect(QR_TOKEN_PATTERN.test('../../etc/passwd')).toBe(false);
  });
});
