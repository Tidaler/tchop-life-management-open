import { describe, expect, it } from 'vitest';
import { menuForZone, zonePriceXaf } from './vip.js';

const beers = { id: 'b', vipOffered: false, vipSurchargeXaf: 0 };
const wines = { id: 'w', vipOffered: true, vipSurchargeXaf: 5000 };
const menu = {
  site: { name: 'TCHOP LIFE' },
  categories: [beers, wines],
  products: [
    { id: 'castel', categoryId: 'b', priceXaf: 1000 },
    { id: 'cantelou', categoryId: 'w', priceXaf: 8000 },
  ],
};

describe('salon VIP', () => {
  it('prix normal hors VIP, supplément en VIP, rien si la catégorie n’y est pas proposée', () => {
    expect(zonePriceXaf(8000, wines, false)).toBe(8000);
    expect(zonePriceXaf(8000, wines, true)).toBe(13000);
    expect(zonePriceXaf(1000, beers, true)).toBeNull();
    expect(zonePriceXaf(1000, beers, false)).toBe(1000);
  });

  it('menu d’une table VIP : catégories retirées, prix majorés, règles jamais exposées', () => {
    const vip = menuForZone(menu, true);
    expect(vip.categories).toEqual([{ id: 'w' }]);
    expect(vip.products).toEqual([{ id: 'cantelou', categoryId: 'w', priceXaf: 13000 }]);
    expect(vip.site).toEqual({ name: 'TCHOP LIFE' });

    const standard = menuForZone(menu, false);
    expect(standard.categories).toEqual([{ id: 'b' }, { id: 'w' }]);
    expect(standard.products.map((p) => p.priceXaf)).toEqual([1000, 8000]);
  });
});
