import { describe, expect, it } from 'vitest';
import { businessDay, canMoveTicket, linesTotal } from './orders.js';

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
