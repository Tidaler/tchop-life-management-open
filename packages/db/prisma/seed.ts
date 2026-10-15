/**
 * Données de démonstration : un client, un site, le personnel, la salle et le catalogue des maquettes.
 * Les identifiants de connexion de démo sont listés dans docs/developpement.md.
 * Lancement : pnpm db:seed (ou automatiquement après pnpm db:reset).
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { DEFAULT_ROLES, ROLE_CODES, type RoleCode } from '@tchop/shared';
import { config } from 'dotenv';
import { createPrismaClient, type Station } from '../src/index.js';

config({ path: new URL('../../../.env', import.meta.url), quiet: true });

/** Identifiants fixes : SITE_ID du fichier .env pointe sur ce site. */
export const DEMO_TENANT_ID = '0199f000-0000-7000-8000-000000000000';
export const DEMO_SITE_ID = '0199f000-0000-7000-8000-000000000001';

interface DemoUser {
  username: string;
  displayName: string;
  role: RoleCode;
  password?: string;
  pin?: string;
}

export const DEMO_USERS: DemoUser[] = [
  {
    username: 'proprietaire',
    displayName: 'Ilorson (propriétaire)',
    role: 'owner',
    password: 'Demo-Proprio-2026!',
  },
  {
    username: 'gerant',
    displayName: 'Paul (gérant)',
    role: 'manager',
    password: 'Demo-Gerant-2026!',
    pin: '4826',
  },
  { username: 'mireille', displayName: 'Mireille', role: 'cashier', pin: '2468' },
  { username: 'joel', displayName: 'Joël', role: 'waiter', pin: '1357' },
  { username: 'aicha', displayName: 'Aïcha', role: 'waiter', pin: '3579' },
  { username: 'cuisine', displayName: 'Poste cuisine', role: 'kitchen', pin: '9753' },
  { username: 'magasin', displayName: 'Brice (magasin)', role: 'storekeeper', pin: '8642' },
  {
    username: 'comptable',
    displayName: 'Cabinet comptable',
    role: 'accountant',
    password: 'Demo-Compta-2026!',
  },
];

const ZONES: { name: string; tables: string[] }[] = [
  { name: 'Salle', tables: Array.from({ length: 12 }, (_, i) => `T${i + 1}`) },
  { name: 'Terrasse', tables: Array.from({ length: 8 }, (_, i) => `T${i + 13}`) },
  { name: 'Salon VIP', tables: ['VIP1', 'VIP2', 'VIP3', 'VIP4'] },
  { name: 'Comptoir', tables: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] },
];

type Tr = { fr: string; en: string };
const CATALOG: { name: Tr; products: [Tr, number, Station, Tr?][] }[] = [
  {
    name: { fr: 'Grillades', en: 'Grill' },
    products: [
      [
        { fr: 'Poisson braisé', en: 'Grilled fish' },
        4500,
        'grill',
        { fr: 'Bar braisé, piment et miondo', en: 'Grilled sea bass, chili and miondo' },
      ],
      [{ fr: 'Poulet braisé (½)', en: 'Grilled chicken (½)' }, 3500, 'grill'],
      [{ fr: 'Soya de bœuf', en: 'Beef suya' }, 1500, 'grill'],
      [{ fr: 'Brochettes de porc (x3)', en: 'Pork skewers (x3)' }, 1500, 'grill'],
    ],
  },
  {
    name: { fr: 'Plats', en: 'Dishes' },
    products: [
      [{ fr: 'Poulet DG', en: 'Chicken DG' }, 4000, 'kitchen'],
      [{ fr: 'Ndolé crevettes', en: 'Ndolé with shrimp' }, 3500, 'kitchen'],
    ],
  },
  {
    name: { fr: 'Accompagnements', en: 'Sides' },
    products: [
      [{ fr: 'Plantain frit', en: 'Fried plantain' }, 1000, 'kitchen'],
      [{ fr: 'Frites', en: 'French fries' }, 1000, 'kitchen'],
    ],
  },
  {
    name: { fr: 'Bières', en: 'Beers' },
    products: [
      [{ fr: 'Castel 65 cl', en: 'Castel 65 cl' }, 700, 'bar'],
      [{ fr: '33 Export 65 cl', en: '33 Export 65 cl' }, 700, 'bar'],
      [{ fr: 'Guinness 65 cl', en: 'Guinness 65 cl' }, 1000, 'bar'],
      [{ fr: 'Mützig 65 cl', en: 'Mützig 65 cl' }, 800, 'bar'],
    ],
  },
  {
    name: { fr: 'Sucreries & eaux', en: 'Soft drinks & water' },
    products: [
      [{ fr: 'Top Ananas', en: 'Top Pineapple' }, 500, 'bar'],
      [{ fr: 'Eau minérale 1,5 L', en: 'Mineral water 1.5 L' }, 500, 'bar'],
    ],
  },
  {
    name: { fr: 'Spiritueux (bouteille)', en: 'Spirits (bottle)' },
    products: [
      [{ fr: 'Johnnie Walker Red 70 cl', en: 'Johnnie Walker Red 70 cl' }, 15000, 'bar'],
      [{ fr: 'Jameson 70 cl', en: 'Jameson 70 cl' }, 18000, 'bar'],
      [{ fr: 'Chivas Regal 12 ans 70 cl', en: 'Chivas Regal 12 yrs 70 cl' }, 30000, 'bar'],
    ],
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  const db = createPrismaClient(url);

  try {
    if (await db.tenant.findUnique({ where: { id: DEMO_TENANT_ID } })) {
      console.log('Données de démo déjà présentes : rien à faire (pnpm db:reset pour repartir de zéro).');
      return;
    }

    await db.$transaction(
      async (tx) => {
        await tx.tenant.create({ data: { id: DEMO_TENANT_ID, slug: 'tchop-life', name: 'TCHOP LIFE' } });
        await tx.site.create({
          data: {
            id: DEMO_SITE_ID,
            tenantId: DEMO_TENANT_ID,
            slug: 'principal',
            name: 'TCHOP LIFE',
            settings: { autoLockSeconds: { cashier: 60, waiter: 180, backOffice: 600 } },
          },
        });

        const roleIds = {} as Record<RoleCode, string>;
        for (const code of ROLE_CODES) {
          const def = DEFAULT_ROLES[code];
          const role = await tx.role.create({
            data: {
              tenantId: DEMO_TENANT_ID,
              code,
              name: def.name,
              permissions: {
                create: Object.entries(def.grants).map(([permission, level]) => ({ permission, level })),
              },
            },
          });
          roleIds[code] = role.id;
        }

        for (const u of DEMO_USERS) {
          await tx.user.create({
            data: {
              tenantId: DEMO_TENANT_ID,
              username: u.username,
              displayName: u.displayName,
              passwordHash: u.password ? await hash(u.password) : null,
              pinHash: u.pin ? await hash(u.pin) : null,
              siteRoles: {
                create: {
                  siteId: DEFAULT_ROLES[u.role].tenantWide ? null : DEMO_SITE_ID,
                  roleId: roleIds[u.role],
                },
              },
            },
          });
        }

        for (const [zi, z] of ZONES.entries()) {
          const zone = await tx.zone.create({ data: { siteId: DEMO_SITE_ID, name: z.name, sortOrder: zi } });
          for (const [ti, label] of z.tables.entries()) {
            await tx.diningTable.create({
              data: {
                siteId: DEMO_SITE_ID,
                zoneId: zone.id,
                label,
                posX: ti % 6,
                posY: Math.floor(ti / 6),
                qrCodes: { create: { siteId: DEMO_SITE_ID, token: randomBytes(16).toString('base64url') } },
              },
            });
          }
        }

        for (const [ci, c] of CATALOG.entries()) {
          await tx.category.create({
            data: {
              siteId: DEMO_SITE_ID,
              name: c.name,
              sortOrder: ci,
              products: {
                create: c.products.map(([name, priceXaf, station, description], pi) => ({
                  siteId: DEMO_SITE_ID,
                  name,
                  description,
                  priceXaf,
                  station,
                  sortOrder: pi,
                })),
              },
            },
          });
        }

        // Options des grillades : accompagnement obligatoire, piment facultatif.
        const side = await tx.modifierGroup.create({
          data: {
            siteId: DEMO_SITE_ID,
            name: { fr: 'Accompagnement', en: 'Side' },
            minSelect: 1,
            maxSelect: 1,
            modifiers: {
              create: [
                { name: { fr: 'Miondo', en: 'Miondo' }, sortOrder: 0 },
                { name: { fr: 'Plantain frit', en: 'Fried plantain' }, sortOrder: 1 },
                { name: { fr: 'Bâton de manioc', en: 'Cassava stick' }, sortOrder: 2 },
                { name: { fr: 'Frites', en: 'French fries' }, priceDeltaXaf: 300, sortOrder: 3 },
              ],
            },
          },
        });
        const chili = await tx.modifierGroup.create({
          data: {
            siteId: DEMO_SITE_ID,
            name: { fr: 'Piment', en: 'Chili' },
            minSelect: 0,
            maxSelect: 1,
            sortOrder: 1,
            modifiers: {
              create: [
                { name: { fr: 'Sans piment', en: 'No chili' }, sortOrder: 0 },
                { name: { fr: 'Piment fort', en: 'Hot chili' }, sortOrder: 1 },
              ],
            },
          },
        });
        const grilled = await tx.product.findMany({
          where: { siteId: DEMO_SITE_ID, station: 'grill' },
          select: { id: true },
        });
        await tx.productModifierGroup.createMany({
          data: grilled.flatMap((p) => [
            { productId: p.id, groupId: side.id, sortOrder: 0 },
            { productId: p.id, groupId: chili.id, sortOrder: 1 },
          ]),
        });
      },
      { timeout: 60_000 },
    );

    console.log(`Données de démo créées : ${DEMO_USERS.length} utilisateurs, site ${DEMO_SITE_ID}.`);
  } finally {
    await db.$disconnect();
  }
}

await main();
