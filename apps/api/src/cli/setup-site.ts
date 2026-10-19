/**
 * Création de l'établissement sur un serveur neuf (à la place des données de démonstration) :
 *   pnpm --filter @tchop/api site:setup -- --name "TCHOP LIFE"
 *
 * Crée, si besoin : le client, le site, les rôles prédéfinis et leurs permissions, la caisse principale,
 * les magasins (Réserve, Bar, Cuisine, Grill) et les catégories de dépenses. Rejouable : ce qui existe
 * déjà est conservé. Affiche l'identifiant du site, à recopier dans SITE_ID.
 */
import { parseArgs } from 'node:util';
import { createPrismaClient } from '@tchop/db';
import { DEFAULT_ROLES, ROLE_CODES } from '@tchop/shared';

// pnpm transmet le séparateur « -- » tel quel : on l'ignore.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    name: { type: 'string' },
    slug: { type: 'string', default: 'principal' },
    tenant: { type: 'string' },
    timezone: { type: 'string', default: 'Africa/Douala' },
  },
});

const slugify = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  const name = values.name?.trim();
  if (!name) throw new Error('--name "Nom de l\'établissement" obligatoire');
  const tenantName = values.tenant?.trim() || name;
  const tenantSlug = slugify(tenantName);
  const siteSlug = slugify(values.slug!);
  Intl.DateTimeFormat('fr-FR', { timeZone: values.timezone }); // fuseau invalide : erreur immédiate

  const db = createPrismaClient(url);
  try {
    const result = await db.$transaction(async (tx) => {
      const tenant =
        (await tx.tenant.findFirst({ where: { slug: tenantSlug } })) ??
        (await tx.tenant.create({ data: { slug: tenantSlug, name: tenantName } }));
      let site = await tx.site.findFirst({ where: { tenantId: tenant.id, slug: siteSlug } });
      const created = !site;
      site ??= await tx.site.create({
        data: {
          tenantId: tenant.id,
          slug: siteSlug,
          name,
          timezone: values.timezone,
          settings: {
            autoLockSeconds: { cashier: 60, waiter: 180, backOffice: 600 },
            thresholds: {
              discountPercent: 10,
              discountXaf: 2000,
              stockLossXaf: 10000,
              inventoryVarianceXaf: 10000,
              expenseXaf: 5000,
            },
          },
        },
      });

      for (const code of ROLE_CODES) {
        const def = DEFAULT_ROLES[code];
        const role = await tx.role.upsert({
          where: { tenantId_code: { tenantId: tenant.id, code } },
          create: { tenantId: tenant.id, code, name: def.name },
          update: {},
        });
        for (const [permission, level] of Object.entries(def.grants)) {
          await tx.rolePermission.upsert({
            where: { roleId_permission: { roleId: role.id, permission } },
            create: { roleId: role.id, permission, level },
            update: {},
          });
        }
      }

      if (!(await tx.cashRegister.count({ where: { siteId: site.id } }))) {
        await tx.cashRegister.create({ data: { siteId: site.id, name: 'Caisse principale' } });
      }
      if (!(await tx.stockLocation.count({ where: { siteId: site.id } }))) {
        await tx.stockLocation.createMany({
          data: ['Réserve', 'Bar', 'Cuisine', 'Grill'].map((n, sortOrder) => ({
            siteId: site.id,
            name: n,
            sortOrder,
          })),
        });
      }
      if (!(await tx.expenseCategory.count({ where: { siteId: site.id } }))) {
        await tx.expenseCategory.createMany({
          data: (
            [
              ['Approvisionnement', 'purchase'],
              ['Transport', 'operating'],
              ['Énergie', 'operating'],
              ['Entretien', 'operating'],
              ['Salaires', 'operating'],
              ['Loyer', 'operating'],
              ['Divers', 'operating'],
            ] as const
          ).map(([n, kind], sortOrder) => ({ siteId: site.id, name: n, kind, sortOrder })),
        });
      }
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          siteId: site.id,
          action: created ? 'site.created' : 'site.setup_checked',
          entity: 'site',
          entityId: site.id,
          after: { name: site.name, slug: site.slug, timezone: site.timezone },
        },
      });
      return { site, created };
    });

    console.log(
      result.created
        ? `Établissement créé : ${result.site.name}`
        : `Établissement déjà présent : ${result.site.name} (complété si besoin)`,
    );
    console.log('\nRecopiez cette ligne dans le fichier de configuration (/etc/tchop/tchop.env) :');
    console.log(`\n  SITE_ID=${result.site.id}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
