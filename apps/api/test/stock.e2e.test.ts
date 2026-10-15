import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, enrollDevice, passwordLogin, pinLogin, startApp, testDb, userIdByName } from './helpers.js';

type Who = { token: string; device?: string };

let app: INestApplication;
let db: PrismaClient;
let manager: Who;
let accountant: Who;
let waiter: Who;
let kitchen: Who;
let storekeeper: Who;
let managerId: string;
let categoryId: string;
const loc: Record<'reserve' | 'bar' | 'kitchen' | 'grill', string> = {
  reserve: '',
  bar: '',
  kitchen: '',
  grill: '',
};

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 6);
const approval = () => ({ userId: managerId, pin: DEMO.manager.pin });

interface Item {
  id: string;
  version: number;
  total: number;
  alert: boolean;
  avgCostXaf?: number;
  packagings: { id: string; name: string; factor: number }[];
  levels: { locationId: string; quantity: number }[];
}

async function newItem(
  name: string,
  location: keyof typeof loc,
  extra: { unit?: string; packagings?: { name: string; factor: number }[]; alertThreshold?: number } = {},
): Promise<Item> {
  const { body } = await as(manager, http().post('/api/stock/items'))
    .send({ name: `${name} ${tag()}`, unit: 'bottle', locationId: loc[location], ...extra })
    .expect(201);
  return body;
}

const item = async (id: string): Promise<Item> =>
  (await as(manager, http().get(`/api/stock/items/${id}`)).expect(200)).body;
const level = async (id: string, location: keyof typeof loc) =>
  (await item(id)).levels.find((l) => l.locationId === loc[location])?.quantity ?? 0;

/** Réception simple au magasin indiqué : quantités en conditionnement, prix par conditionnement. */
const receive = (
  who: Who,
  lines: {
    itemId: string;
    packagingId?: string | null;
    quantity: number;
    unitPriceXaf: number;
    purchaseOrderLineId?: string;
  }[],
  extra: object = {},
) =>
  as(who, http().post('/api/stock/receipts')).send({
    idempotencyKey: randomUUID(),
    locationId: loc.reserve,
    lines,
    ...extra,
  });

async function newProduct(name: string, station: string, modifierGroupIds: string[] = []) {
  const { body } = await as(manager, http().post('/api/catalog/products'))
    .send({ categoryId, name: { fr: `${name} ${tag()}` }, priceXaf: 1000, station, modifierGroupIds })
    .expect(201);
  return body.id as string;
}

async function orderOnNewTable(lines: { productId: string; quantity: number; modifierIds?: string[] }[]) {
  const { body: zone } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `S${tag()}` })
    .expect(201);
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `S${tag()}` })
    .expect(201);
  const { body: order } = await as(waiter, http().post('/api/orders/send'))
    .send({ tableId: table.id, idempotencyKey: randomUUID(), lines })
    .expect(200);
  return order as { id: string; lines: { id: string; productId: string }[] };
}

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  accountant = { token: (await passwordLogin(app, DEMO.accountant)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Tablette magasin');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };
  kitchen = { token: (await pinLogin(app, deviceToken, DEMO.kitchenPin)).accessToken, device: deviceToken };
  storekeeper = {
    token: (await pinLogin(app, deviceToken, { displayName: 'Brice (magasin)', pin: '8642' })).accessToken,
    device: deviceToken,
  };
  managerId = await userIdByName(app, deviceToken, 'Paul (gérant)');

  const { body: locations } = await as(manager, http().get('/api/stock/locations')).expect(200);
  const byName = new Map((locations as { id: string; name: string }[]).map((l) => [l.name, l.id]));
  loc.reserve = byName.get('Réserve')!;
  loc.bar = byName.get('Bar')!;
  loc.kitchen = byName.get('Cuisine')!;
  loc.grill = byName.get('Grill')!;

  const { body: category } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `Stock ${tag()}` } })
    .expect(201);
  categoryId = category.id;
});

afterAll(async () => {
  await db.user.updateMany({
    where: { username: 'gerant' },
    data: { pinFailedCount: 0, pinLockedUntil: null },
  });
  await db.$disconnect();
  await app.close();
});

describe('articles', () => {
  it('crée un article avec ses conditionnements ; nom unique ; réservé aux rôles du magasin', async () => {
    const created = await newItem('Castel', 'bar', { packagings: [{ name: 'Casier', factor: 12 }] });
    expect(created.packagings).toEqual([expect.objectContaining({ name: 'Casier', factor: 12 })]);
    const { body: dup } = await as(manager, http().get(`/api/stock/items/${created.id}`)).expect(200);
    await as(manager, http().post('/api/stock/items'))
      .send({ name: dup.name.toUpperCase(), unit: 'bottle', locationId: loc.bar })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('NAME_TAKEN'));
    await as(waiter, http().post('/api/stock/items'))
      .send({ name: `Interdit ${tag()}`, unit: 'bottle', locationId: loc.bar })
      .expect(403);
    await as(waiter, http().get('/api/stock/items')).expect(403);
  });

  it('les coûts ne sont visibles que des rôles qui suivent les achats ou les rapports', async () => {
    const created = await newItem('Coût', 'bar');
    const asKitchen = (await as(kitchen, http().get(`/api/stock/items/${created.id}`)).expect(200)).body;
    expect(asKitchen).not.toHaveProperty('avgCostXaf');
    expect(asKitchen).not.toHaveProperty('valueXaf');
    const asStorekeeper = (await as(storekeeper, http().get(`/api/stock/items/${created.id}`)).expect(200))
      .body;
    expect(asStorekeeper).toHaveProperty('avgCostXaf');
  });

  it("refuse d'archiver un article qui a encore du stock", async () => {
    const created = await newItem('Archive', 'bar');
    await receive(manager, [{ itemId: created.id, quantity: 2, unitPriceXaf: 500 }]).expect(201);
    const current = await item(created.id);
    await as(manager, http().patch(`/api/stock/items/${created.id}`))
      .send({ version: current.version, archived: true })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('ITEM_HAS_STOCK'));
  });
});

describe('réceptions', () => {
  it('convertit les casiers en bouteilles et recalcule le coût moyen pondéré', async () => {
    const beer = await newItem('33 Export', 'bar', { packagings: [{ name: 'Casier', factor: 12 }] });
    const casier = beer.packagings[0]!.id;
    const { body: first } = await receive(storekeeper, [
      { itemId: beer.id, packagingId: casier, quantity: 2, unitPriceXaf: 6000 },
    ]).expect(201);
    expect(first.lines[0]).toMatchObject({ quantity: 2, baseQuantity: 24, totalXaf: 12000 });
    expect(first.totalXaf).toBe(12000);
    expect(await level(beer.id, 'reserve')).toBe(24);
    expect((await item(beer.id)).avgCostXaf).toBe(500);

    // 1 casier à 7 200 (600 la bouteille) : (24 × 500 + 12 × 600) / 36.
    await receive(storekeeper, [
      { itemId: beer.id, packagingId: casier, quantity: 1, unitPriceXaf: 7200 },
    ]).expect(201);
    expect(await level(beer.id, 'reserve')).toBe(36);
    expect((await item(beer.id)).avgCostXaf).toBeCloseTo(533.3333, 3);
  });

  it('une réception renvoyée avec la même clé n’est enregistrée qu’une fois', async () => {
    const water = await newItem('Eau', 'bar');
    const body = {
      idempotencyKey: randomUUID(),
      locationId: loc.reserve,
      lines: [{ itemId: water.id, quantity: 6, unitPriceXaf: 350 }],
    };
    const { body: a } = await as(storekeeper, http().post('/api/stock/receipts')).send(body).expect(201);
    const { body: b } = await as(storekeeper, http().post('/api/stock/receipts')).send(body).expect(201);
    expect(b.id).toBe(a.id);
    expect(await level(water.id, 'reserve')).toBe(6);
    await as(manager, http().post('/api/stock/receipts')).send(body).expect(409);
  });

  it('une réception est figée et la cuisine ne peut pas réceptionner', async () => {
    const it2 = await newItem('Figée', 'bar');
    const { body } = await receive(manager, [{ itemId: it2.id, quantity: 1, unitPriceXaf: 100 }]).expect(201);
    await expect(db.goodsReceipt.update({ where: { id: body.id }, data: { totalXaf: 0 } })).rejects.toThrow();
    await expect(db.goodsReceipt.delete({ where: { id: body.id } })).rejects.toThrow();
    await receive(kitchen, [{ itemId: it2.id, quantity: 1, unitPriceXaf: 100 }]).expect(403);
  });

  it('commande d’achat : réception partielle, puis complète, puis close', async () => {
    const whisky = await newItem('Whisky', 'bar', { packagings: [{ name: 'Carton', factor: 12 }] });
    const { body: supplier } = await as(manager, http().post('/api/stock/suppliers'))
      .send({ name: `Dépôt ${tag()}`, phone: '+237 690 00 00 00' })
      .expect(201);
    const { body: order } = await as(storekeeper, http().post('/api/stock/purchase-orders'))
      .send({
        supplierId: supplier.id,
        lines: [
          { itemId: whisky.id, packagingId: whisky.packagings[0]!.id, quantity: 2, unitPriceXaf: 108000 },
        ],
      })
      .expect(201);
    expect(order).toMatchObject({ status: 'open', totalXaf: 216000 });
    const line = order.lines[0];

    await receive(
      storekeeper,
      [
        {
          itemId: whisky.id,
          packagingId: whisky.packagings[0]!.id,
          quantity: 1,
          unitPriceXaf: 108000,
          purchaseOrderLineId: line.id,
        },
      ],
      { purchaseOrderId: order.id },
    ).expect(201);
    let current = (await as(manager, http().get(`/api/stock/purchase-orders/${order.id}`)).expect(200)).body;
    expect(current).toMatchObject({
      status: 'open',
      lines: [expect.objectContaining({ receivedQuantity: 1 })],
    });

    // Livraison du reste à l'unité (12 bouteilles = 1 carton).
    await receive(
      storekeeper,
      [{ itemId: whisky.id, quantity: 12, unitPriceXaf: 9000, purchaseOrderLineId: line.id }],
      { purchaseOrderId: order.id },
    ).expect(201);
    current = (await as(manager, http().get(`/api/stock/purchase-orders/${order.id}`)).expect(200)).body;
    expect(current.status).toBe('received');
    expect(await level(whisky.id, 'reserve')).toBe(24);

    await receive(storekeeper, [{ itemId: whisky.id, quantity: 1, unitPriceXaf: 9000 }], {
      purchaseOrderId: order.id,
    })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('ORDER_CLOSED'));
  });
});

describe('ventes et recettes', () => {
  it('la vente sort le stock selon la recette, options comprises', async () => {
    const chicken = await newItem('Poulet', 'grill', { unit: 'piece' });
    const plantain = await newItem('Plantain', 'kitchen', { unit: 'piece' });
    await receive(manager, [{ itemId: chicken.id, quantity: 10, unitPriceXaf: 3000 }], {
      locationId: loc.grill,
    }).expect(201);
    await receive(manager, [{ itemId: plantain.id, quantity: 30, unitPriceXaf: 100 }], {
      locationId: loc.kitchen,
    }).expect(201);

    const { body: group } = await as(manager, http().post('/api/catalog/modifier-groups'))
      .send({
        name: { fr: `Accompagnement ${tag()}` },
        minSelect: 0,
        maxSelect: 1,
        modifiers: [{ name: { fr: 'Plantain' } }, { name: { fr: 'Rien' } }],
      })
      .expect(201);
    const { body: catalog } = await as(manager, http().get('/api/catalog')).expect(200);
    const modifiers = catalog.modifierGroups.find((g: { id: string }) => g.id === group.id).modifiers as {
      id: string;
      name: { fr: string };
    }[];
    const withPlantain = modifiers.find((m) => m.name.fr === 'Plantain')!.id;

    const dish = await newProduct('Poulet braisé', 'grill', [group.id]);
    const { body: recipe } = await as(manager, http().put(`/api/stock/recipes/${dish}`))
      .send({
        lines: [
          { itemId: chicken.id, quantity: 0.5 },
          { itemId: plantain.id, quantity: 2, modifierId: withPlantain },
        ],
      })
      .expect(200);
    expect(recipe.lines).toHaveLength(2);
    expect(recipe.costXaf).toBe(1500);

    await orderOnNewTable([
      { productId: dish, quantity: 2, modifierIds: [withPlantain] },
      { productId: dish, quantity: 1 },
    ]);
    expect(await level(chicken.id, 'grill')).toBe(8.5);
    expect(await level(plantain.id, 'kitchen')).toBe(26);
  });

  it('annulation : réintégré si la préparation n’a pas commencé, perte sinon', async () => {
    const beer = await newItem('Mützig', 'bar');
    await receive(manager, [{ itemId: beer.id, quantity: 12, unitPriceXaf: 580 }], {
      locationId: loc.bar,
    }).expect(201);
    const product = await newProduct('Mützig', 'bar');
    await as(manager, http().put(`/api/stock/recipes/${product}`))
      .send({ lines: [{ itemId: beer.id, quantity: 1 }] })
      .expect(200);

    const order = await orderOnNewTable([{ productId: product, quantity: 3 }]);
    expect(await level(beer.id, 'bar')).toBe(9);
    await as(manager, http().post(`/api/orders/${order.id}/lines/${order.lines[0]!.id}/cancel`))
      .send({ reason: 'Erreur de saisie' })
      .expect(200);
    expect(await level(beer.id, 'bar')).toBe(12);

    const served = await orderOnNewTable([{ productId: product, quantity: 2 }]);
    const line = await db.orderLine.findUniqueOrThrow({ where: { id: served.lines[0]!.id } });
    await as(kitchen, http().post(`/api/tickets/${line.ticketId}/status`))
      .send({ status: 'preparing' })
      .expect(200);
    await as(manager, http().post(`/api/orders/${served.id}/lines/${line.id}/cancel`))
      .send({ reason: 'Bouteilles ouvertes, client parti' })
      .expect(200);
    expect(await level(beer.id, 'bar')).toBe(10);
    const movements = await db.stockMovement.findMany({
      where: { orderLineId: line.id },
      orderBy: { id: 'asc' },
    });
    expect(movements.map((m) => [m.type, Number(m.quantity)])).toEqual([
      ['sale', -2],
      ['sale_cancel', 2],
      ['loss', -2],
    ]);
  });

  it('recette : articles du site et options du produit uniquement ; produits sans recette signalés', async () => {
    const product = await newProduct('Sans recette', 'kitchen');
    const { body: missing } = await as(manager, http().get('/api/stock/recipes/missing')).expect(200);
    expect(missing.map((p: { id: string }) => p.id)).toContain(product);

    const flour = await newItem('Farine', 'kitchen', { unit: 'kg' });
    await as(manager, http().put(`/api/stock/recipes/${product}`))
      .send({ lines: [{ itemId: flour.id, quantity: 0.2, modifierId: randomUUID() }] })
      .expect(400);
    await as(manager, http().put(`/api/stock/recipes/${product}`))
      .send({ lines: [{ itemId: randomUUID(), quantity: 1 }] })
      .expect(404);
    await as(manager, http().put(`/api/stock/recipes/${product}`))
      .send({ lines: [{ itemId: flour.id, quantity: 0.0001 }] })
      .expect(400);
    await as(waiter, http().put(`/api/stock/recipes/${product}`))
      .send({ lines: [{ itemId: flour.id, quantity: 1 }] })
      .expect(403);
    // Le magasinier consulte les recettes sans pouvoir les modifier.
    await as(storekeeper, http().get(`/api/stock/recipes/${product}`)).expect(200);
    await as(storekeeper, http().put(`/api/stock/recipes/${product}`))
      .send({ lines: [{ itemId: flour.id, quantity: 1 }] })
      .expect(403);
  });
});

describe('pertes, transferts et ajustements', () => {
  it('la cuisine déclare une perte avec l’approbation d’un gérant', async () => {
    const fish = await newItem('Poisson', 'grill', { unit: 'piece' });
    await receive(manager, [{ itemId: fish.id, quantity: 10, unitPriceXaf: 2500 }], {
      locationId: loc.grill,
    }).expect(201);
    const loss = { type: 'loss', itemId: fish.id, quantity: 1, reason: 'Poisson avarié' };
    await as(kitchen, http().post('/api/stock/losses'))
      .send({ idempotencyKey: randomUUID(), ...loss })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));
    await as(kitchen, http().post('/api/stock/losses'))
      .send({ idempotencyKey: randomUUID(), ...loss, approval: approval() })
      .expect(201);
    expect(await level(fish.id, 'grill')).toBe(9);
    await as(waiter, http().post('/api/stock/losses'))
      .send({ idempotencyKey: randomUUID(), ...loss })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('FORBIDDEN'));
  });

  it('le magasinier déclare seul sous le seuil de valeur, avec approbation au-delà', async () => {
    const beer = await newItem('Guinness', 'bar');
    await receive(manager, [{ itemId: beer.id, quantity: 24, unitPriceXaf: 750 }], {
      locationId: loc.bar,
    }).expect(201);
    const key = randomUUID();
    const small = {
      idempotencyKey: key,
      type: 'breakage',
      itemId: beer.id,
      quantity: 2,
      reason: 'Casier tombé',
    };
    const { body: first } = await as(storekeeper, http().post('/api/stock/losses')).send(small).expect(201);
    // Renvoi après coupure : même réponse, une seule sortie.
    const { body: again } = await as(storekeeper, http().post('/api/stock/losses')).send(small).expect(201);
    expect(again.groupId).toBe(first.groupId);
    expect(await level(beer.id, 'bar')).toBe(22);

    // 15 bouteilles à 750 = 11 250 FCFA, au-delà du seuil par défaut (10 000).
    const big = { type: 'internal_use', itemId: beer.id, quantity: 15, reason: 'Fête du personnel' };
    await as(storekeeper, http().post('/api/stock/losses'))
      .send({ idempotencyKey: randomUUID(), ...big })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));
    await as(storekeeper, http().post('/api/stock/losses'))
      .send({ idempotencyKey: randomUUID(), ...big, approval: approval() })
      .expect(201);
    expect(await level(beer.id, 'bar')).toBe(7);
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { itemId: beer.id, type: 'internal_use' },
    });
    expect(movement.approvedById).toBe(managerId);
  });

  it('transfert de la réserve au bar', async () => {
    const top = await newItem('Top', 'bar');
    await receive(manager, [{ itemId: top.id, quantity: 24, unitPriceXaf: 300 }]).expect(201);
    await as(storekeeper, http().post('/api/stock/transfers'))
      .send({
        idempotencyKey: randomUUID(),
        itemId: top.id,
        fromLocationId: loc.reserve,
        toLocationId: loc.bar,
        quantity: 12,
      })
      .expect(201);
    expect(await level(top.id, 'reserve')).toBe(12);
    expect(await level(top.id, 'bar')).toBe(12);
    await as(storekeeper, http().post('/api/stock/transfers'))
      .send({
        idempotencyKey: randomUUID(),
        itemId: top.id,
        fromLocationId: loc.bar,
        toLocationId: loc.bar,
        quantity: 1,
      })
      .expect(400);
    await as(kitchen, http().post('/api/stock/transfers'))
      .send({
        idempotencyKey: randomUUID(),
        itemId: top.id,
        fromLocationId: loc.reserve,
        toLocationId: loc.bar,
        quantity: 1,
      })
      .expect(403);
  });

  it('correction manuelle : motif obligatoire, approbation pour le magasinier', async () => {
    const coal = await newItem('Charbon', 'grill', { unit: 'kg' });
    const body = {
      itemId: coal.id,
      locationId: loc.grill,
      quantity: 25,
      reason: 'Sac oublié à la réception',
    };
    await as(storekeeper, http().post('/api/stock/adjustments'))
      .send({ idempotencyKey: randomUUID(), ...body })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));
    await as(manager, http().post('/api/stock/adjustments'))
      .send({ idempotencyKey: randomUUID(), ...body, reason: '' })
      .expect(400);
    await as(manager, http().post('/api/stock/adjustments'))
      .send({ idempotencyKey: randomUUID(), ...body })
      .expect(201);
    expect(await level(coal.id, 'grill')).toBe(25);
  });
});

describe('inventaire', () => {
  it('comptage à l’aveugle, écarts ajustés à la clôture, approbation au-delà du seuil', async () => {
    const { body: shelf } = await as(manager, http().post('/api/stock/locations'))
      .send({ name: `Cave ${tag()}` })
      .expect(201);
    const wine = await as(manager, http().post('/api/stock/items'))
      .send({ name: `Vin ${tag()}`, unit: 'bottle', locationId: shelf.id })
      .expect(201)
      .then((r) => r.body as Item);
    await receive(manager, [{ itemId: wine.id, quantity: 20, unitPriceXaf: 4000 }], {
      locationId: shelf.id,
    }).expect(201);

    const { body: count } = await as(storekeeper, http().post('/api/stock/inventories'))
      .send({ locationId: shelf.id })
      .expect(201);
    expect(count.lines).toEqual([expect.objectContaining({ itemId: wine.id, countedQty: null })]);
    expect(count.lines[0]).not.toHaveProperty('expectedQty');
    await as(storekeeper, http().post('/api/stock/inventories'))
      .send({ locationId: shelf.id })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('INVENTORY_IN_PROGRESS'));

    const { body: counted } = await as(storekeeper, http().put(`/api/stock/inventories/${count.id}/counts`))
      .send({ lines: [{ itemId: wine.id, countedQty: 17 }] })
      .expect(200);
    expect(counted.lines[0]).not.toHaveProperty('expectedQty');

    // Écart de 3 bouteilles × 4 000 = 12 000 FCFA, au-delà du seuil par défaut (10 000).
    await as(storekeeper, http().post(`/api/stock/inventories/${count.id}/close`))
      .send({ version: counted.version })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));
    const { body: closed } = await as(storekeeper, http().post(`/api/stock/inventories/${count.id}/close`))
      .send({ version: counted.version, approval: approval() })
      .expect(200);
    expect(closed.status).toBe('closed');
    expect(closed.varianceXaf).toBe(-12000);
    expect(closed.lines[0]).toMatchObject({ expectedQty: 20, countedQty: 17, varianceQty: -3 });
    expect(await level(wine.id, 'reserve')).toBe(0);
    const levels = (await item(wine.id)).levels;
    expect(levels.find((l) => l.locationId === shelf.id)?.quantity).toBe(17);

    await as(storekeeper, http().put(`/api/stock/inventories/${count.id}/counts`))
      .send({ lines: [{ itemId: wine.id, countedQty: 1 }] })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('INVENTORY_CLOSED'));
  });
});

describe('intégrité et rapports', () => {
  it('les mouvements sont en ajout seul et chaque niveau égale la somme de ses mouvements', async () => {
    const movement = await db.stockMovement.findFirstOrThrow();
    await expect(
      db.stockMovement.update({ where: { id: movement.id }, data: { reason: 'x' } }),
    ).rejects.toThrow();
    await expect(db.stockMovement.delete({ where: { id: movement.id } })).rejects.toThrow();
    const drift = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "stock_level" l
      LEFT JOIN (
        SELECT "item_id", "location_id", SUM("quantity") AS q FROM "stock_movement" GROUP BY 1, 2
      ) m ON m."item_id" = l."item_id" AND m."location_id" = l."location_id"
      WHERE l."quantity" <> COALESCE(m.q, 0)`;
    expect(Number(drift[0]!.n)).toBe(0);
  });

  it('un mouvement de sens contraire à son type est refusé par la base', async () => {
    const any = await db.stockMovement.findFirstOrThrow();
    await expect(
      db.stockMovement.create({
        data: { ...any, id: undefined, type: 'receipt', quantity: -1, createdAt: undefined },
      }),
    ).rejects.toThrow();
  });

  it('valorisation et rapport réservés aux rôles autorisés', async () => {
    await as(kitchen, http().get('/api/stock/valuation')).expect(403);
    const { body: valuation } = await as(accountant, http().get('/api/stock/valuation')).expect(200);
    expect(valuation.totalXaf).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const { body: report } = await as(
      accountant,
      http().get(`/api/stock/report?from=${today}&to=${today}`),
    ).expect(200);
    expect(report.totals.receivedXaf).toBeGreaterThan(0);
    await as(accountant, http().get('/api/stock/report?from=2026-12-01&to=2026-01-01')).expect(400);
    // Le comptable consulte, mais ne réceptionne pas.
    await as(accountant, http().post('/api/stock/receipts'))
      .send({ idempotencyKey: randomUUID(), locationId: loc.reserve, lines: [] })
      .expect(403);
  });

  it('la liste des gérants approbateurs est ouverte à tout le personnel connecté, et à lui seul', async () => {
    const { body } = await as(kitchen, http().get('/api/approvals/approvers')).expect(200);
    expect(body.map((u: { id: string }) => u.id)).toContain(managerId);
    expect(Object.keys(body[0]).sort()).toEqual(['displayName', 'id']);
    await http().get('/api/approvals/approvers').expect(401);
  });

  it('alertes : article sous son seuil', async () => {
    const low = await newItem('Alerte', 'bar', { alertThreshold: 5 });
    await receive(manager, [{ itemId: low.id, quantity: 3, unitPriceXaf: 100 }], {
      locationId: loc.bar,
    }).expect(201);
    const { body: alerts } = await as(kitchen, http().get('/api/stock/alerts')).expect(200);
    expect(alerts.map((a: { id: string }) => a.id)).toContain(low.id);
  });
});
