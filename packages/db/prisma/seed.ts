/**
 * Données de démonstration : un client, un site, le personnel, la salle, le catalogue des maquettes,
 * et les stocks (articles, conditionnements, stock d'ouverture, recettes, fournisseurs).
 * Les identifiants de connexion de démo sont listés dans docs/developpement.md.
 * Lancement : pnpm db:seed (ou automatiquement après pnpm db:reset).
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { DEFAULT_ROLES, ROLE_CODES, type RoleCode } from '@tchop/shared';
import { config } from 'dotenv';
import { createPrismaClient, type PrismaClient, type StockUnit, type Station } from '../src/index.js';

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

type Opening = Partial<Record<'Réserve' | 'Bar' | 'Cuisine' | 'Grill', number>>;
/** Articles : nom, unité, magasin de sortie, seuil d'alerte, coût d'une unité (FCFA), conditionnements, stock d'ouverture. */
const STOCK_ITEMS: [string, StockUnit, keyof Opening, number, number, [string, number][], Opening][] = [
  ['Castel 65 cl', 'bottle', 'Bar', 24, 500, [['Casier', 12]], { Bar: 24, Réserve: 48 }],
  ['33 Export 65 cl', 'bottle', 'Bar', 24, 500, [['Casier', 12]], { Bar: 24, Réserve: 36 }],
  ['Guinness 65 cl', 'bottle', 'Bar', 12, 750, [['Casier', 12]], { Bar: 12, Réserve: 24 }],
  ['Mützig 65 cl', 'bottle', 'Bar', 12, 580, [['Casier', 12]], { Bar: 10 }],
  ['Top Ananas 35 cl', 'bottle', 'Bar', 12, 300, [['Casier', 24]], { Bar: 24 }],
  ['Eau minérale 1,5 L', 'bottle', 'Bar', 12, 350, [['Pack', 6]], { Bar: 18 }],
  ['Johnnie Walker Red 70 cl', 'bottle', 'Bar', 2, 9000, [['Carton', 12]], { Bar: 4 }],
  ['Jameson 70 cl', 'bottle', 'Bar', 2, 11000, [['Carton', 12]], { Bar: 3 }],
  ['Chivas Regal 12 ans 70 cl', 'bottle', 'Bar', 1, 20000, [['Carton', 12]], { Bar: 2 }],
  ['Poulet entier', 'piece', 'Grill', 5, 3000, [], { Grill: 12 }],
  ['Poisson bar', 'piece', 'Grill', 5, 2500, [], { Grill: 10 }],
  ['Viande de bœuf', 'kg', 'Grill', 3, 3500, [], { Grill: 8 }],
  ['Viande de porc', 'kg', 'Grill', 2, 3000, [], { Grill: 5 }],
  ['Charbon', 'kg', 'Grill', 10, 150, [['Sac 25 kg', 25]], { Grill: 50 }],
  ['Plantain', 'piece', 'Cuisine', 20, 100, [['Régime', 30]], { Cuisine: 60 }],
  ['Pommes de terre', 'kg', 'Cuisine', 5, 400, [['Sac 25 kg', 25]], { Cuisine: 20 }],
  ['Huile de friture', 'l', 'Cuisine', 5, 1300, [['Bidon 20 L', 20]], { Cuisine: 20 }],
  ['Miondo', 'piece', 'Cuisine', 10, 50, [], { Cuisine: 40 }],
  ['Bâton de manioc', 'piece', 'Cuisine', 10, 100, [], { Cuisine: 20 }],
  ['Crevettes', 'kg', 'Cuisine', 1, 6000, [], { Cuisine: 3 }],
  ['Feuilles de ndolé', 'kg', 'Cuisine', 1, 1500, [], { Cuisine: 4 }],
];

/** Recettes : produit (nom français) → [article, quantité, option éventuelle]. */
const RECIPES: Record<string, [string, number, string?][]> = {
  'Castel 65 cl': [['Castel 65 cl', 1]],
  '33 Export 65 cl': [['33 Export 65 cl', 1]],
  'Guinness 65 cl': [['Guinness 65 cl', 1]],
  'Mützig 65 cl': [['Mützig 65 cl', 1]],
  'Top Ananas': [['Top Ananas 35 cl', 1]],
  'Eau minérale 1,5 L': [['Eau minérale 1,5 L', 1]],
  'Johnnie Walker Red 70 cl': [['Johnnie Walker Red 70 cl', 1]],
  'Jameson 70 cl': [['Jameson 70 cl', 1]],
  'Chivas Regal 12 ans 70 cl': [['Chivas Regal 12 ans 70 cl', 1]],
  'Poisson braisé': [['Poisson bar', 1]],
  'Poulet braisé (½)': [['Poulet entier', 0.5]],
  'Soya de bœuf': [['Viande de bœuf', 0.15]],
  'Brochettes de porc (x3)': [['Viande de porc', 0.2]],
  'Poulet DG': [
    ['Poulet entier', 0.5],
    ['Plantain', 2],
    ['Huile de friture', 0.05],
  ],
  'Ndolé crevettes': [
    ['Feuilles de ndolé', 0.15],
    ['Crevettes', 0.1],
    ['Huile de friture', 0.03],
  ],
  'Plantain frit': [
    ['Plantain', 2],
    ['Huile de friture', 0.05],
  ],
  Frites: [
    ['Pommes de terre', 0.3],
    ['Huile de friture', 0.05],
  ],
};

/** Accompagnements des grillades (options) : ce qu'ils sortent du stock. */
const MODIFIER_RECIPES: Record<string, [string, number][]> = {
  Miondo: [['Miondo', 3]],
  'Plantain frit': [
    ['Plantain', 1.5],
    ['Huile de friture', 0.03],
  ],
  'Bâton de manioc': [['Bâton de manioc', 1]],
  Frites: [
    ['Pommes de terre', 0.25],
    ['Huile de friture', 0.03],
  ],
};

/**
 * Stocks de démonstration, ajoutés aussi à une base déjà initialisée (sans rien toucher si des articles
 * existent déjà). Le stock d'ouverture est enregistré comme un ajustement, en mouvements normaux.
 */
async function seedStock(db: PrismaClient): Promise<void> {
  if (await db.stockItem.count({ where: { siteId: DEMO_SITE_ID } })) return;
  const owner = await db.user.findFirstOrThrow({
    where: { tenantId: DEMO_TENANT_ID, username: 'proprietaire' },
  });

  await db.$transaction(
    async (tx) => {
      if (!(await tx.stockLocation.count({ where: { siteId: DEMO_SITE_ID } }))) {
        await tx.stockLocation.createMany({
          data: ['Réserve', 'Bar', 'Cuisine', 'Grill'].map((name, sortOrder) => ({
            siteId: DEMO_SITE_ID,
            name,
            sortOrder,
          })),
        });
      }
      const locations = new Map(
        (await tx.stockLocation.findMany({ where: { siteId: DEMO_SITE_ID } })).map((l) => [l.name, l.id]),
      );
      const items = new Map<string, string>();
      for (const [name, unit, location, alertThreshold, cost, packagings, opening] of STOCK_ITEMS) {
        const item = await tx.stockItem.create({
          data: {
            siteId: DEMO_SITE_ID,
            name,
            unit,
            locationId: locations.get(location)!,
            alertThreshold,
            avgCostXaf: cost,
            packagings: { create: packagings.map(([pname, factor]) => ({ name: pname, factor })) },
          },
        });
        items.set(name, item.id);
        for (const [where, quantity] of Object.entries(opening)) {
          const locationId = locations.get(where)!;
          await tx.stockMovement.create({
            data: {
              siteId: DEMO_SITE_ID,
              itemId: item.id,
              locationId,
              type: 'inventory_adjustment',
              quantity,
              unitCostXaf: cost,
              reason: "Stock d'ouverture (démo)",
              createdById: owner.id,
            },
          });
          await tx.stockLevel.create({ data: { itemId: item.id, locationId, quantity } });
        }
      }

      const products = await tx.product.findMany({
        where: { siteId: DEMO_SITE_ID },
        select: { id: true, name: true },
      });
      for (const product of products) {
        const recipe = RECIPES[(product.name as { fr: string }).fr];
        if (!recipe) continue;
        await tx.recipeLine.createMany({
          data: recipe.map(([item, quantity]) => ({
            productId: product.id,
            itemId: items.get(item)!,
            quantity,
          })),
        });
      }
      // Recette d'une option : seulement pour les produits qui proposent cette option.
      const offers = await tx.productModifierGroup.findMany({
        where: { product: { siteId: DEMO_SITE_ID } },
        include: { group: { include: { modifiers: { select: { id: true, name: true } } } } },
      });
      for (const offer of offers) {
        for (const side of offer.group.modifiers) {
          const recipe = MODIFIER_RECIPES[(side.name as { fr: string }).fr];
          if (!recipe) continue;
          await tx.recipeLine.createMany({
            data: recipe.map(([item, quantity]) => ({
              productId: offer.productId,
              itemId: items.get(item)!,
              modifierId: side.id,
              quantity,
            })),
          });
        }
      }

      await tx.supplier.createMany({
        data: [
          { siteId: DEMO_SITE_ID, name: 'Dépôt de boissons Central', contact: 'Service commandes' },
          { siteId: DEMO_SITE_ID, name: 'Ferme avicole du Littoral', contact: 'Livraison le mardi' },
          { siteId: DEMO_SITE_ID, name: 'Marché central — vivres frais' },
        ],
      });
    },
    { timeout: 60_000 },
  );
  console.log(`Stocks de démo créés : ${STOCK_ITEMS.length} articles et leurs recettes.`);
}

/** Catégories de dépenses du cahier des charges (ajoutées aussi à une base déjà initialisée). */
async function seedExpenseCategories(db: PrismaClient): Promise<void> {
  if (await db.expenseCategory.count({ where: { siteId: DEMO_SITE_ID } })) return;
  await db.expenseCategory.createMany({
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
    ).map(([name, kind], sortOrder) => ({ siteId: DEMO_SITE_ID, name, kind, sortOrder })),
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  const db = createPrismaClient(url);

  try {
    if (await db.tenant.findUnique({ where: { id: DEMO_TENANT_ID } })) {
      console.log('Données de démo déjà présentes (pnpm db:reset pour repartir de zéro).');
      await seedStock(db);
      await seedExpenseCategories(db);
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
            settings: {
              autoLockSeconds: { cashier: 60, waiter: 180, backOffice: 600 },
              // Seuils d'approbation (docs/architecture/05-roles-permissions.md).
              thresholds: { discountPercent: 10, discountXaf: 2000 },
            },
          },
        });
        await tx.cashRegister.create({ data: { siteId: DEMO_SITE_ID, name: 'Caisse principale' } });

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
    await seedStock(db);
    await seedExpenseCategories(db);
  } finally {
    await db.$disconnect();
  }
}

await main();
