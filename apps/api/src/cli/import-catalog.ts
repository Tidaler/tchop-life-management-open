/**
 * Import d'une carte (catalogue/*.json) dans le catalogue d'un site, sans rien effacer.
 *   pnpm --filter @tchop/api catalog:import                      (carte des boissons, site de SITE_ID)
 *   pnpm --filter @tchop/api catalog:import -- --file <carte.json> --site <identifiant> [--dry-run]
 *
 * Rejouable : une catégorie ou un produit déjà présent (même nom, ou un ancien nom listé dans « aliases »)
 * est mis à jour (nom, prix, catégorie), sinon il est créé. Les produits listés dans « archiveProducts »
 * sont archivés (jamais supprimés : l'historique des ventes reste intact). Chaque boisson reçoit un article
 * de stock et une recette d'une bouteille si elle n'en a pas. Le tout est tracé dans le journal d'audit.
 * --dry-run affiche ce qui serait fait, puis annule tout.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPrismaClient, type Prisma, type Station } from '@tchop/db';
import { STATIONS } from '@tchop/shared';
import { z } from 'zod';

const translated = z.object({ fr: z.string().trim().min(1).max(120), en: z.string().trim().max(120) });
const catalogSchema = z.object({
  description: z.string().optional(),
  station: z.enum(STATIONS),
  stockLocation: z.string().min(1),
  firstSortOrder: z.number().int().min(0).default(0),
  categories: z
    .array(
      z.object({
        name: translated,
        aliases: z.array(z.string()).default([]),
        products: z
          .array(
            z.object({
              name: translated,
              priceXaf: z.number().int().min(0).max(10_000_000),
              aliases: z.array(z.string()).default([]),
              stock: z.boolean().default(true),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  archiveProducts: z.array(z.string()).default([]),
});

// pnpm transmet le séparateur « -- » tel quel : on l'ignore.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    file: { type: 'string' },
    site: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

class DryRun extends Error {}
type Tx = Prisma.TransactionClient;
const lower = (names: string[]) => [...new Set(names.map((n) => n.trim().toLowerCase()))];

async function findByName(tx: Tx, table: 'product' | 'category', siteId: string, names: string[]) {
  const rows =
    table === 'product'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "product" WHERE "site_id" = ${siteId}::uuid AND "archived_at" IS NULL
            AND lower("name"->>'fr') = ANY(${lower(names)}) ORDER BY "created_at" LIMIT 1`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "category" WHERE "site_id" = ${siteId}::uuid AND "archived_at" IS NULL
            AND lower("name"->>'fr') = ANY(${lower(names)}) ORDER BY "created_at" LIMIT 1`;
  return rows[0]?.id ?? null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  const siteId = values.site ?? process.env.SITE_ID;
  if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
    throw new Error('--site <identifiant du site> (ou SITE_ID) obligatoire');
  const file = values.file ?? new URL('../../../../catalogue/boissons.json', import.meta.url);
  const catalog = catalogSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const station = catalog.station as Station;

  const db = createPrismaClient(url);
  const report = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    created: [] as string[],
    updated: [] as string[],
    unchanged: 0,
    archived: [] as string[],
    stockItems: 0,
    recipes: 0,
  };
  try {
    await db
      .$transaction(
        async (tx) => {
          const site = await tx.site.findUniqueOrThrow({ where: { id: siteId } });
          const location =
            (await tx.stockLocation.findFirst({
              where: {
                siteId,
                archivedAt: null,
                name: { equals: catalog.stockLocation, mode: 'insensitive' },
              },
            })) ??
            (await tx.stockLocation.findFirst({
              where: { siteId, archivedAt: null },
              orderBy: { sortOrder: 'asc' },
            }));
          const imported = new Set<string>();

          for (const [ci, cat] of catalog.categories.entries()) {
            let categoryId = await findByName(tx, 'category', siteId, [cat.name.fr, ...cat.aliases]);
            const sortOrder = catalog.firstSortOrder + ci;
            if (categoryId) {
              const before = await tx.category.findUniqueOrThrow({ where: { id: categoryId } });
              const name = before.name as { fr: string; en?: string };
              if (name.fr !== cat.name.fr || name.en !== cat.name.en || before.sortOrder !== sortOrder) {
                await tx.category.update({
                  where: { id: categoryId },
                  data: { name: cat.name, sortOrder, version: { increment: 1 } },
                });
                report.categoriesUpdated += 1;
              }
            } else {
              categoryId = (await tx.category.create({ data: { siteId, name: cat.name, sortOrder } })).id;
              report.categoriesCreated += 1;
            }

            for (const [pi, item] of cat.products.entries()) {
              const existingId = await findByName(tx, 'product', siteId, [item.name.fr, ...item.aliases]);
              let productId: string;
              if (existingId) {
                const before = await tx.product.findUniqueOrThrow({ where: { id: existingId } });
                const same =
                  (before.name as { fr: string; en?: string }).fr === item.name.fr &&
                  (before.name as { en?: string }).en === item.name.en &&
                  before.priceXaf === item.priceXaf &&
                  before.categoryId === categoryId &&
                  before.station === station &&
                  before.sortOrder === pi;
                if (same) report.unchanged += 1;
                else {
                  await tx.product.update({
                    where: { id: existingId },
                    data: {
                      name: item.name,
                      priceXaf: item.priceXaf,
                      categoryId,
                      station,
                      sortOrder: pi,
                      version: { increment: 1 },
                    },
                  });
                  const was = (before.name as { fr: string }).fr;
                  report.updated.push(
                    `${was === item.name.fr ? item.name.fr : `${was} → ${item.name.fr}`} (${before.priceXaf} → ${item.priceXaf} FCFA)`,
                  );
                }
                productId = existingId;
              } else {
                productId = (
                  await tx.product.create({
                    data: {
                      siteId,
                      categoryId,
                      name: item.name,
                      priceXaf: item.priceXaf,
                      station,
                      sortOrder: pi,
                    },
                  })
                ).id;
                report.created.push(`${item.name.fr} (${item.priceXaf} FCFA)`);
              }
              imported.add(productId);

              // Une boisson vendue à la bouteille sort une bouteille de son article de stock.
              if (item.stock && location && !(await tx.recipeLine.count({ where: { productId } }))) {
                let stockItem = await tx.stockItem.findFirst({
                  where: { siteId, archivedAt: null, name: { equals: item.name.fr, mode: 'insensitive' } },
                });
                if (!stockItem) {
                  stockItem = await tx.stockItem.create({
                    data: { siteId, name: item.name.fr, unit: 'bottle', locationId: location.id },
                  });
                  report.stockItems += 1;
                }
                await tx.recipeLine.create({ data: { productId, itemId: stockItem.id, quantity: 1 } });
                report.recipes += 1;
              }
            }
          }

          for (const name of catalog.archiveProducts) {
            const id = await findByName(tx, 'product', siteId, [name]);
            if (id && !imported.has(id)) {
              await tx.product.update({
                where: { id },
                data: { archivedAt: new Date(), version: { increment: 1 } },
              });
              report.archived.push(name);
            }
          }

          await tx.auditLog.create({
            data: {
              tenantId: site.tenantId,
              siteId,
              action: 'catalog.imported',
              entity: 'site',
              entityId: siteId,
              after: {
                file: String(file).split(/[\\/]/).pop() ?? '',
                created: report.created.length,
                updated: report.updated.length,
                unchanged: report.unchanged,
                archived: report.archived,
                stockItems: report.stockItems,
              },
            },
          });
          if (values['dry-run']) throw new DryRun();
        },
        { timeout: 120_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof DryRun)) throw error;
      });
  } finally {
    await db.$disconnect();
  }

  const title = values['dry-run'] ? 'Simulation (rien n’a été enregistré)' : 'Import terminé';
  console.log(
    `${title} : ${report.created.length} créés, ${report.updated.length} mis à jour, ${report.unchanged} inchangés, ${report.archived.length} archivés.`,
  );
  console.log(
    `Catégories : ${report.categoriesCreated} créées, ${report.categoriesUpdated} mises à jour. Stock : ${report.stockItems} articles, ${report.recipes} recettes.`,
  );
  if (report.updated.length) console.log(`\nMis à jour :\n  ${report.updated.join('\n  ')}`);
  if (report.created.length) console.log(`\nCréés :\n  ${report.created.join('\n  ')}`);
  if (report.archived.length) console.log(`\nArchivés :\n  ${report.archived.join('\n  ')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
