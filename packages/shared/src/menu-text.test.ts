import { describe, expect, it } from 'vitest';
import { textMenuParts } from './menu-text.js';

const cat = (id: string, fr: string) => ({ id, name: { fr } });
const prod = (categoryId: string, fr: string, priceXaf: number) => ({ categoryId, name: { fr }, priceXaf });
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('menu texte des QR codes', () => {
  it('liste les catégories et les prix, lisibles sans connexion', () => {
    const [part] = textMenuParts(
      {
        categories: [cat('p', 'Plats'), cat('v', 'Vide'), cat('b', 'Bières')],
        products: [prod('p', 'Poulet pané frites', 2500), prod('b', 'Castel', 1000)],
      },
      { title: 'TCHOP LIFE - Menu' },
    );
    expect(part!.text).toBe(
      'TCHOP LIFE - Menu\n\nPLATS\nPoulet pané frites : 2 500\n\nBIÈRES\nCastel : 1 000\n\nPrix en FCFA. Commande auprès du personnel.',
    );
    expect(part!.categories).toEqual(['Plats', 'Bières']);
  });

  it('découpe une grande carte en plusieurs QR codes, sans couper une catégorie ni dépasser la limite', () => {
    const categories = Array.from({ length: 12 }, (_, i) => cat(`c${i}`, `Catégorie ${i}`));
    const products = categories.flatMap((c) =>
      Array.from({ length: 8 }, (_, j) => prod(c.id, `Produit élégant numéro ${j}`, 12500 + j)),
    );
    const parts = textMenuParts({ categories, products }, { title: 'TCHOP LIFE - Menu', maxBytes: 900 });
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, p] of parts.entries()) {
      expect(bytes(p.text)).toBeLessThanOrEqual(900);
      expect(p.text.startsWith(`TCHOP LIFE - Menu (${i + 1}/${parts.length})`)).toBe(true);
    }
    expect(parts.flatMap((p) => p.categories)).toEqual(categories.map((c) => c.name.fr));
  });
});
