import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../dist/config.js';
import { DEMO, enrollDevice, passwordLogin, pinLogin, startApp, testDb } from './helpers.js';

type Who = { token: string; device?: string };

let app: INestApplication;
let db: PrismaClient;
let manager: Who;
let waiter: Who;
let kitchen: Who;
const product: Record<'grill' | 'beer' | 'hidden' | 'pricey', string> = {
  grill: '',
  beer: '',
  hidden: '',
  pricey: '',
};
let sideOption = '';

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 5);

/** Nouvelle table et jeton de son QR code (tel qu'imprimé). */
async function newTable() {
  const { body: zone } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `Q${tag()}` })
    .expect(201);
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `Q${tag()}` })
    .expect(201);
  const { body } = await as(manager, http().get('/api/floor/qr-codes')).expect(200);
  const url: string = body.codes.find((c: { tableId: string }) => c.tableId === table.id).url;
  return { id: table.id as string, label: table.label as string, token: url.split('/q/')[1]! };
}

/** Navigateur d'un client : garde son cookie anonyme d'une requête à l'autre. */
const client = () => request.agent(app.getHttpServer());

const order = (agent: ReturnType<typeof client>, token: string, lines: object[], key = randomUUID()) =>
  agent.post(`/api/public/menu/${token}/orders`).send({ idempotencyKey: key, lines });

const beers = (quantity = 1) => [{ productId: product.beer, quantity }];

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Tablette QR');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };
  kitchen = { token: (await pinLogin(app, deviceToken, DEMO.kitchenPin)).accessToken, device: deviceToken };

  const { body: category } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `QR ${tag()}` } })
    .expect(201);
  const { body: side } = await as(manager, http().post('/api/catalog/modifier-groups'))
    .send({
      name: { fr: 'Accompagnement QR' },
      minSelect: 1,
      maxSelect: 1,
      modifiers: [{ name: { fr: 'Miondo' } }],
    })
    .expect(201);
  const { body: catalog } = await as(manager, http().get('/api/catalog')).expect(200);
  sideOption = catalog.modifierGroups.find((g: { id: string }) => g.id === side.id).modifiers[0].id;
  const create = async (body: object) =>
    (
      await as(manager, http().post('/api/catalog/products'))
        .send({ categoryId: category.id, station: 'bar', ...body })
        .expect(201)
    ).body.id as string;
  product.grill = await create({
    name: { fr: 'Soya QR' },
    priceXaf: 1500,
    station: 'grill',
    modifierGroupIds: [side.id],
  });
  product.beer = await create({ name: { fr: 'Castel QR' }, priceXaf: 700 });
  product.hidden = await create({ name: { fr: 'Prix staff' }, priceXaf: 100, visibleOnQr: false });
  product.pricey = await create({ name: { fr: 'Champagne' }, priceXaf: 120_000 });
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

describe('menu public', () => {
  it('ne montre que les produits visibles, sans aucune donnée interne', async () => {
    const table = await newTable();
    const { body, headers } = await http().get(`/api/public/menu/${table.token}`).expect(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(body.table.label).toBe(table.label);
    expect(body.ordering).toBe(true);
    const ids = body.products.map((p: { id: string }) => p.id);
    expect(ids).toContain(product.beer);
    expect(ids).not.toContain(product.hidden);
    expect(Object.keys(body.products[0]).sort()).toEqual(
      [
        'available',
        'categoryId',
        'description',
        'id',
        'imageUrl',
        'modifierGroupIds',
        'name',
        'priceXaf',
      ].sort(),
    );
    const raw = JSON.stringify(body);
    for (const secret of ['token', 'version', 'taxRateBp', 'tenant', 'waiter', 'siteId', 'Prix staff']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('répond 404, toujours de la même façon, pour un jeton invalide, inconnu ou remplacé', async () => {
    const table = await newTable();
    const malformed = await http().get('/api/public/menu/..%2F..%2Fetc').expect(404);
    const unknown = await http().get('/api/public/menu/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    await as(manager, http().post(`/api/floor/tables/${table.id}/qr/replace`)).expect(201);
    const replaced = await http().get(`/api/public/menu/${table.token}`).expect(404);
    expect(unknown.body).toEqual(malformed.body);
    expect(replaced.body).toEqual(unknown.body);
  });

  it('en consultation seule, refuse les commandes', async () => {
    const table = await newTable();
    await as(manager, http().put(`/api/floor/tables/${table.id}/qr/mode`))
      .send({ mode: 'menu' })
      .expect(200);
    const { body } = await http().get(`/api/public/menu/${table.token}`).expect(200);
    expect(body.ordering).toBe(false);
    const res = await order(client(), table.token, beers()).expect(403);
    expect(res.body.code).toBe('ORDERING_DISABLED');
  });

  it('ignore les identifiants du personnel : la route reste publique et limitée au QR', async () => {
    const table = await newTable();
    const res = await as(waiter, http().get(`/api/public/menu/${table.token}`)).expect(200);
    expect(res.body.table.label).toBe(table.label);
  });
});

describe('demande du client', () => {
  it('pose un cookie anonyme protégé et recalcule les prix côté serveur', async () => {
    const table = await newTable();
    const agent = client();
    const res = await order(agent, table.token, [
      {
        productId: product.grill,
        quantity: 2,
        modifierIds: [sideOption],
        note: 'bien pimenté',
        unitPriceXaf: 1,
      },
    ]).expect(201);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/tchop_qr=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/public/);
    expect(res.body.status).toBe('pending');
    expect(res.body.totalXaf).toBe(3000); // le prix envoyé par le navigateur est ignoré
  });

  it('chaque client ne voit que ses propres demandes, et seulement pour cette table', async () => {
    const table = await newTable();
    const other = await newTable();
    const alice = client();
    await order(alice, table.token, beers()).expect(201);
    expect((await alice.get(`/api/public/menu/${table.token}/orders`).expect(200)).body).toHaveLength(1);
    expect((await client().get(`/api/public/menu/${table.token}/orders`).expect(200)).body).toHaveLength(0);
    expect((await alice.get(`/api/public/menu/${other.token}/orders`).expect(200)).body).toHaveLength(0);
  });

  it('un renvoi ne crée pas de doublon ; la même clé depuis un autre navigateur ne révèle rien', async () => {
    const table = await newTable();
    const agent = client();
    const key = randomUUID();
    const a = await order(agent, table.token, beers(), key).expect(201);
    const b = await order(agent, table.token, beers(), key).expect(201);
    expect(b.body.id).toBe(a.body.id);
    await order(client(), table.token, beers(), key).expect(404);
    expect(await db.qrOrderRequest.count({ where: { tableId: table.id } })).toBe(1);
  });

  it('refuse un produit masqué, une option manquante, un panier trop gros ou trop cher', async () => {
    const table = await newTable();
    await order(client(), table.token, [{ productId: product.hidden, quantity: 1 }]).expect(404);
    const options = await order(client(), table.token, [{ productId: product.grill, quantity: 1 }]).expect(
      400,
    );
    expect(options.body.code).toBe('INVALID_OPTIONS');
    await order(client(), table.token, [{ productId: product.beer, quantity: 31 }]).expect(400);
    const pricey = await order(client(), table.token, [{ productId: product.pricey, quantity: 5 }]).expect(
      422,
    );
    expect(pricey.body.code).toBe('ORDER_TOO_LARGE');
  });

  it('limite à 3 demandes en attente par table', async () => {
    const table = await newTable();
    for (let i = 0; i < 3; i++) await order(client(), table.token, beers()).expect(201);
    const res = await order(client(), table.token, beers()).expect(429);
    expect(res.body.code).toBe('TOO_MANY_PENDING');
  });
});

describe('validation par le personnel', () => {
  it('le serveur valide : la commande part en cuisine et le client suit l’avancement', async () => {
    const table = await newTable();
    const agent = client();
    const { body: submitted } = await order(agent, table.token, [
      { productId: product.grill, quantity: 1, modifierIds: [sideOption] },
    ]).expect(201);

    const { body: pending } = await as(waiter, http().get('/api/qr-requests')).expect(200);
    const req = pending.find((r: { id: string }) => r.id === submitted.id);
    expect(req.tableLabel).toBe(table.label);
    expect(req.totalXaf).toBe(1500);

    const { body: accepted } = await as(
      waiter,
      http().post(`/api/qr-requests/${submitted.id}/accept`),
    ).expect(200);
    const created = await db.order.findUniqueOrThrow({
      where: { id: accepted.orderId },
      include: { lines: true },
    });
    expect(created.source).toBe('qr');
    expect(created.lines[0]?.qrRequestId).toBe(submitted.id);

    const status = async () =>
      (await agent.get(`/api/public/menu/${table.token}/orders`).expect(200)).body[0].status;
    expect(await status()).toBe('accepted');
    const ticket = await db.kitchenTicket.findFirstOrThrow({ where: { orderId: accepted.orderId } });
    await as(kitchen, http().post(`/api/tickets/${ticket.id}/status`))
      .send({ status: 'ready' })
      .expect(200);
    expect(await status()).toBe('ready');

    const again = await as(waiter, http().post(`/api/qr-requests/${submitted.id}/accept`)).expect(409);
    expect(again.body.code).toBe('QR_REQUEST_CLOSED');
    await as(waiter, http().post(`/api/qr-requests/${submitted.id}/reject`))
      .send({ reason: 'trop tard' })
      .expect(409);
  });

  it('un refus est tracé ; le client ne voit pas le motif interne', async () => {
    const table = await newTable();
    const agent = client();
    const { body: submitted } = await order(agent, table.token, beers()).expect(201);
    await as(waiter, http().post(`/api/qr-requests/${submitted.id}/reject`))
      .send({ reason: 'Client déjà parti, motif interne' })
      .expect(204);
    const res = await agent.get(`/api/public/menu/${table.token}/orders`).expect(200);
    expect(res.body[0].status).toBe('rejected');
    expect(JSON.stringify(res.body)).not.toContain('motif interne');
    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: submitted.id, action: 'qr.request_rejected' },
    });
    expect(log.reason).toBe('Client déjà parti, motif interne');
  });

  it('une demande expirée ne peut plus être validée', async () => {
    const table = await newTable();
    const agent = client();
    const { body: submitted } = await order(agent, table.token, beers()).expect(201);
    await db.qrOrderRequest.update({
      where: { id: submitted.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await as(waiter, http().post(`/api/qr-requests/${submitted.id}/accept`)).expect(409);
    const res = await agent.get(`/api/public/menu/${table.token}/orders`).expect(200);
    expect(res.body[0].status).toBe('expired');
  });

  it('un produit épuisé entre-temps bloque la validation ; la demande reste à traiter', async () => {
    const table = await newTable();
    const { body: submitted } = await order(client(), table.token, beers()).expect(201);
    await as(kitchen, http().put(`/api/catalog/products/${product.beer}/availability`))
      .send({ available: false })
      .expect(200);
    try {
      const res = await as(waiter, http().post(`/api/qr-requests/${submitted.id}/accept`)).expect(409);
      expect(res.body.code).toBe('PRODUCT_UNAVAILABLE');
      const still = await db.qrOrderRequest.findUniqueOrThrow({ where: { id: submitted.id } });
      expect(still.status).toBe('pending');
    } finally {
      await as(kitchen, http().put(`/api/catalog/products/${product.beer}/availability`))
        .send({ available: true })
        .expect(200);
    }
  });

  it('la cuisine ne traite pas les demandes QR', async () => {
    await as(kitchen, http().get('/api/qr-requests')).expect(403);
  });
});

describe('protections', () => {
  it('limite le nombre de commandes par minute et par adresse IP', async () => {
    const limited = await startApp({ PUBLIC_ORDER_RATE_LIMIT: '2', PRINT_POLL_MS: '0' });
    try {
      const table = await newTable();
      const server = limited.getHttpServer();
      const post = () =>
        request(server)
          .post(`/api/public/menu/${table.token}/orders`)
          .send({ idempotencyKey: randomUUID(), lines: beers() });
      await post().expect(201);
      await post().expect(201);
      await post().expect(429);
      // La lecture du menu reste possible.
      await request(server).get(`/api/public/menu/${table.token}`).expect(200);
    } finally {
      await limited.close();
    }
  });

  it('refuse de démarrer en production avec une configuration de développement', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x',
      SITE_ID: '0199f000-0000-7000-8000-000000000001',
      PUBLIC_MENU_URL: 'https://menu.example.org',
      COOKIE_SECURE: 'true',
      JWT_SECRET: 'k'.repeat(64),
    };
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, JWT_SECRET: 'dev-only-secret-change-me-0123456789abcdef' })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => loadConfig({ ...base, PUBLIC_MENU_URL: 'http://menu.example.org' })).toThrow(
      /PUBLIC_MENU_URL/,
    );
  });
});
