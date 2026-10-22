import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PrismaClient } from '@tchop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_SITE_ID, testDb } from './helpers.js';

const script = fileURLToPath(new URL('../dist/cli/import-catalog.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tchop-catalogue-'));
const tag = randomUUID().slice(0, 6);
let db: PrismaClient;

/** Écrit une carte de test et lance le script d'import sur la base de test. */
function importCatalog(products: object[], archiveProducts: string[] = [], dryRun = false): string {
  const file = join(dir, `${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      station: 'bar',
      stockLocation: 'Bar',
      firstSortOrder: 90,
      categories: [{ name: { fr: `Import ${tag}`, en: `Import ${tag}` }, products }],
      archiveProducts,
    }),
  );
  return execFileSync(
    process.execPath,
    [script, '--', '--file', file, '--site', DEMO_SITE_ID, ...(dryRun ? ['--dry-run'] : [])],
    {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      encoding: 'utf8',
    },
  );
}

const product = (fr: string) =>
  db.product.findFirst({
    where: { siteId: DEMO_SITE_ID, archivedAt: null, name: { path: ['fr'], equals: fr } },
    include: { recipeLines: { include: { item: true } } },
  });

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("import d'une carte", () => {
  const beer = `Bière ${tag}`;

  it('simulation : rien n’est enregistré', async () => {
    const out = importCatalog([{ name: { fr: beer, en: beer }, priceXaf: 1000 }], [], true);
    expect(out).toContain('Simulation');
    expect(await product(beer)).toBeNull();
  });

  it('crée la catégorie, le produit, son article de stock et sa recette d’une bouteille', async () => {
    const out = importCatalog([{ name: { fr: beer, en: beer }, priceXaf: 1000 }]);
    expect(out).toContain('1 créés');
    const created = await product(beer);
    expect(created).toMatchObject({ priceXaf: 1000, station: 'bar' });
    expect(created!.recipeLines).toHaveLength(1);
    expect(created!.recipeLines[0]).toMatchObject({ item: { name: beer, unit: 'bottle' } });
    expect(Number(created!.recipeLines[0]!.quantity)).toBe(1);
  });

  it('rejouable : un second import ne change rien', () => {
    expect(importCatalog([{ name: { fr: beer, en: beer }, priceXaf: 1000 }])).toContain(
      '0 créés, 0 mis à jour, 1 inchangés',
    );
  });

  it('renomme par ancien nom et met à jour le prix, sans perdre l’historique ni la recette', async () => {
    const before = await product(beer);
    const renamed = `${beer} 65 cl`;
    const out = importCatalog([{ name: { fr: renamed, en: renamed }, priceXaf: 1200, aliases: [beer] }]);
    expect(out).toContain('1 mis à jour');
    const after = await product(renamed);
    expect(after!.id).toBe(before!.id);
    expect(after!.priceXaf).toBe(1200);
    expect(after!.recipeLines).toHaveLength(1);
  });

  it('archive sans supprimer ; journal d’audit', async () => {
    const extra = `Ancienne ${tag}`;
    importCatalog([{ name: { fr: extra, en: extra }, priceXaf: 500, stock: false }]);
    expect((await product(extra))!.recipeLines).toHaveLength(0);
    importCatalog([{ name: { fr: `${beer} 65 cl`, en: `${beer} 65 cl` }, priceXaf: 1200 }], [extra]);
    expect(await product(extra)).toBeNull();
    expect(
      await db.product.count({ where: { siteId: DEMO_SITE_ID, name: { path: ['fr'], equals: extra } } }),
    ).toBe(1);
    const log = await db.auditLog.findFirst({
      where: { action: 'catalog.imported', siteId: DEMO_SITE_ID },
      orderBy: { id: 'desc' },
    });
    expect(log?.after).toMatchObject({ archived: [extra] });
  });

  it('poste par catégorie, photo ajoutée une seule fois, catégorie vide archivée', async () => {
    const media = mkdtempSync(join(tmpdir(), 'tchop-media-'));
    mkdirSync(join(dir, 'images'), { recursive: true });
    copyFileSync(
      new URL('../../../catalogue/images/heineken.webp', import.meta.url),
      join(dir, 'images', 'bouteille.webp'),
    );
    const grilled = `Brochette ${tag}`;
    const bottle = `Bouteille ${tag}`;
    const emptyCategory = `Vide ${tag}`;
    const write = (categories: object[], archiveCategories: string[] = []) => {
      const file = join(dir, `${randomUUID()}.json`);
      writeFileSync(
        file,
        JSON.stringify({ station: 'kitchen', stockLocation: 'Cuisine', categories, archiveCategories }),
      );
      return execFileSync(process.execPath, [script, '--', '--file', file, '--site', DEMO_SITE_ID], {
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, MEDIA_DIR: media },
        encoding: 'utf8',
      });
    };
    const categories = [
      {
        name: { fr: `Grill ${tag}`, en: 'Grill' },
        station: 'grill',
        vip: { offered: true, surchargeXaf: 100 },
        products: [{ name: { fr: grilled, en: grilled }, priceXaf: 200, stock: false }],
      },
      {
        name: { fr: emptyCategory, en: emptyCategory },
        products: [{ name: { fr: bottle, en: bottle }, priceXaf: 900, image: 'images/bouteille.webp' }],
      },
    ];
    expect(write(categories)).toContain('Photos : 1');
    const grill = await product(grilled);
    expect(grill).toMatchObject({ station: 'grill', recipeLines: [] });
    expect(await db.category.findUniqueOrThrow({ where: { id: grill!.categoryId } })).toMatchObject({
      vipOffered: true,
      vipSurchargeXaf: 100,
    });
    const withPhoto = await product(bottle);
    expect(withPhoto!.imageUrl).toMatch(/^\/api\/media\/[0-9a-f-]{36}\.webp$/);
    expect(readdirSync(media)).toEqual([withPhoto!.imageUrl!.split('/').pop()]);

    // Rejouable : la photo n'est pas réimportée. Une catégorie qui a encore des produits n'est pas archivée.
    expect(write(categories, [emptyCategory])).toContain('Photos : 0');
    expect((await product(bottle))!.imageUrl).toBe(withPhoto!.imageUrl);
    const category = () =>
      db.category.findFirstOrThrow({
        where: { siteId: DEMO_SITE_ID, name: { path: ['fr'], equals: emptyCategory } },
      });
    expect((await category()).archivedAt).toBeNull();

    await db.product.update({ where: { id: withPhoto!.id }, data: { archivedAt: new Date() } });
    write([categories[0]!], [emptyCategory]);
    expect((await category()).archivedAt).not.toBeNull();
  });

  it('les cartes du dépôt sont valides et leurs photos existent', () => {
    for (const name of ['boissons.json', 'menu.json']) {
      const out = execFileSync(
        process.execPath,
        [
          script,
          '--',
          '--file',
          fileURLToPath(new URL(`../../../catalogue/${name}`, import.meta.url)),
          '--site',
          DEMO_SITE_ID,
          '--dry-run',
        ],
        { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8' },
      );
      expect(out).toContain('Simulation');
    }
    const catalog = JSON.parse(
      readFileSync(new URL('../../../catalogue/boissons.json', import.meta.url), 'utf8'),
    ) as {
      categories: { products: { image?: string }[] }[];
    };
    for (const p of catalog.categories.flatMap((c) => c.products)) {
      if (p.image) expect(existsSync(new URL(`../../../catalogue/${p.image}`, import.meta.url))).toBe(true);
    }
  });
});
