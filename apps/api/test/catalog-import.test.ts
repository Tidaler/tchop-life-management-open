import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
});
