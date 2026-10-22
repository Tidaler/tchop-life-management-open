/**
 * Import des cartes (catalogue/*.json) dans le catalogue d'un site, sans rien effacer.
 *   pnpm --filter @tchop/api catalog:import                      (boissons et menu, site de SITE_ID)
 *   pnpm --filter @tchop/api catalog:import -- --file <carte.json> --site <identifiant> [--dry-run]
 *
 * Rejouable : une catégorie ou un produit déjà présent (même nom, ou un ancien nom listé dans « aliases »)
 * est mis à jour (nom, prix, catégorie, poste), sinon il est créé. Les produits listés dans « archiveProducts »
 * et les catégories vides listées dans « archiveCategories » sont archivés (jamais supprimés : l'historique
 * des ventes reste intact). Chaque boisson reçoit un article de stock et une recette d'une bouteille si elle
 * n'en a pas. Une photo (« image », chemin relatif à la carte) est ajoutée au produit qui n'en a pas ;
 * --replace-images remplace aussi les photos existantes. Le tout est tracé dans le journal d'audit.
 * --dry-run affiche ce qui serait fait, puis annule tout.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPrismaClient, type Prisma, type Station } from '@tchop/db';
import { STATIONS, VIP_SURCHARGE_MAX_XAF } from '@tchop/shared';
import sharp from 'sharp';
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
        /** Poste de préparation de la catégorie, s'il diffère de celui de la carte (ex. grillades). */
        station: z.enum(STATIONS).optional(),
        /** Salon VIP : catégorie proposée ou non, supplément par produit. Absent : réglage laissé tel quel. */
        vip: z
          .object({
            offered: z.boolean(),
            surchargeXaf: z.number().int().min(0).max(VIP_SURCHARGE_MAX_XAF).default(0),
          })
          .optional(),
        products: z
          .array(
            z.object({
              name: translated,
              priceXaf: z.number().int().min(0).max(10_000_000),
              aliases: z.array(z.string()).default([]),
              stock: z.boolean().default(true),
              /** Photo du produit, rangée à côté de la carte (ex. images/heineken.webp). */
              image: z
                .string()
                .regex(/^images\/[a-z0-9-]+\.(webp|png|jpe?g)$/)
                .optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  archiveProducts: z.array(z.string()).default([]),
  archiveCategories: z.array(z.string()).default([]),
});

const MEDIA_ROUTE = '/api/media/';
const MEDIA_NAME = /^[0-9a-f-]{36}\.webp$/;
const DEFAULT_FILES = ['boissons.json', 'menu.json'].map((name) =>
  fileURLToPath(new URL(`../../../../catalogue/${name}`, import.meta.url)),
);

// pnpm transmet le séparateur « -- » tel quel : on l'ignore.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    file: { type: 'string' },
    site: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'replace-images': { type: 'boolean', default: false },
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

/** Même traitement que les photos envoyées depuis l'application : WebP, 800 px au plus. */
async function storeImage(path: string, mediaDir: string): Promise<{ url: string; file: string }> {
  const output = await sharp(await readFile(path), { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const name = `${randomUUID()}.webp`;
  await mkdir(mediaDir, { recursive: true });
  const file = join(mediaDir, name);
  await writeFile(file, output);
  return { url: `${MEDIA_ROUTE}${name}`, file };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  const siteId = values.site ?? process.env.SITE_ID;
  if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
    throw new Error('--site <identifiant du site> (ou SITE_ID) obligatoire');
  for (const file of values.file ? [resolve(values.file)] : DEFAULT_FILES) {
    await importFile(url, siteId, file);
  }
}

async function importFile(url: string, siteId: string, file: string): Promise<void> {
  const catalog = catalogSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const mediaDir = resolve(process.env.MEDIA_DIR ?? 'data/media');
  const dryRun = values['dry-run'];
  // Photos écrites pendant l'import : effacées s'il échoue. Photos remplacées : effacées après l'import.
  const written: string[] = [];
  const replaced: string[] = [];

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
    images: 0,
    archivedCategories: [] as string[],
    keptCategories: [] as string[],
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
            const station = (cat.station ?? catalog.station) as Station;
            let categoryId = await findByName(tx, 'category', siteId, [cat.name.fr, ...cat.aliases]);
            const sortOrder = catalog.firstSortOrder + ci;
            const vip = cat.vip
              ? { vipOffered: cat.vip.offered, vipSurchargeXaf: cat.vip.offered ? cat.vip.surchargeXaf : 0 }
              : {};
            if (categoryId) {
              const before = await tx.category.findUniqueOrThrow({ where: { id: categoryId } });
              const name = before.name as { fr: string; en?: string };
              const vipChanged =
                !!cat.vip &&
                (before.vipOffered !== vip.vipOffered || before.vipSurchargeXaf !== vip.vipSurchargeXaf);
              if (
                name.fr !== cat.name.fr ||
                name.en !== cat.name.en ||
                before.sortOrder !== sortOrder ||
                vipChanged
              ) {
                await tx.category.update({
                  where: { id: categoryId },
                  data: { name: cat.name, sortOrder, ...vip, version: { increment: 1 } },
                });
                report.categoriesUpdated += 1;
              }
            } else {
              categoryId = (await tx.category.create({ data: { siteId, name: cat.name, sortOrder, ...vip } }))
                .id;
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

              if (item.image) {
                const current = await tx.product.findUniqueOrThrow({ where: { id: productId } });
                if (!current.imageUrl || values['replace-images']) {
                  report.images += 1;
                  if (!dryRun) {
                    const stored = await storeImage(join(dirname(file), item.image), mediaDir);
                    written.push(stored.file);
                    await tx.product.update({ where: { id: productId }, data: { imageUrl: stored.url } });
                    if (current.imageUrl) replaced.push(current.imageUrl);
                  }
                }
              }

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

          // Une catégorie n'est archivée que vide : un produit encore actif la garde visible.
          for (const name of catalog.archiveCategories) {
            const id = await findByName(tx, 'category', siteId, [name]);
            if (!id) continue;
            if (await tx.product.count({ where: { categoryId: id, archivedAt: null } })) {
              report.keptCategories.push(name);
              continue;
            }
            await tx.category.update({
              where: { id },
              data: { archivedAt: new Date(), version: { increment: 1 } },
            });
            report.archivedCategories.push(name);
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
                archivedCategories: report.archivedCategories,
                stockItems: report.stockItems,
                images: report.images,
              },
            },
          });
          if (dryRun) throw new DryRun();
        },
        { timeout: 120_000 },
      )
      .catch(async (error: unknown) => {
        await Promise.all(written.map((path) => rm(path, { force: true })));
        if (!(error instanceof DryRun)) throw error;
      });
    for (const old of replaced) {
      const name = old.slice(MEDIA_ROUTE.length);
      if (old.startsWith(MEDIA_ROUTE) && MEDIA_NAME.test(name)) {
        await rm(join(mediaDir, name), { force: true });
      }
    }
  } finally {
    await db.$disconnect();
  }

  const title = dryRun ? 'Simulation (rien n’a été enregistré)' : 'Import terminé';
  console.log(`\n== ${file.split(/[\\/]/).pop()} ==`);
  console.log(
    `${title} : ${report.created.length} créés, ${report.updated.length} mis à jour, ${report.unchanged} inchangés, ${report.archived.length} archivés.`,
  );
  console.log(
    `Catégories : ${report.categoriesCreated} créées, ${report.categoriesUpdated} mises à jour, ${report.archivedCategories.length} archivées. Stock : ${report.stockItems} articles, ${report.recipes} recettes. Photos : ${report.images}.`,
  );
  if (report.keptCategories.length)
    console.log(`Catégories gardées (produits encore actifs) : ${report.keptCategories.join(', ')}`);
  if (report.updated.length) console.log(`\nMis à jour :\n  ${report.updated.join('\n  ')}`);
  if (report.created.length) console.log(`\nCréés :\n  ${report.created.join('\n  ')}`);
  if (report.archived.length) console.log(`\nArchivés :\n  ${report.archived.join('\n  ')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
