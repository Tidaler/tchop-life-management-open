import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, enrollDevice, passwordLogin, pinLogin, startApp, testDb } from './helpers.js';

type Who = { token: string; device?: string };

let app: INestApplication;
let db: PrismaClient;
let manager: Who;
let cashier: Who;
let waiter: Who;
const product = { beer: '', skewer: '' };

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 5);
const sale = (who: Who, lines: object[], key = randomUUID()) =>
  as(who, http().post('/api/cash/direct-sales')).send({ idempotencyKey: key, lines });

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Caisse vente directe');
  cashier = { token: (await pinLogin(app, deviceToken, DEMO.cashierPin)).accessToken, device: deviceToken };
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };

  const { body: category } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `Comptoir ${tag()}` }, vipSurchargeXaf: 5000 })
    .expect(201);
  const create = async (name: string, priceXaf: number, station: string) =>
    (
      await as(manager, http().post('/api/catalog/products'))
        .send({ categoryId: category.id, name: { fr: `${name} ${tag()}` }, priceXaf, station })
        .expect(201)
    ).body.id as string;
  product.beer = await create('Castel', 1000, 'bar');
  product.skewer = await create('Brochette', 200, 'grill');

  // Caisse ouverte (une seule session par caissier : on reprend celle d'un test précédent s'il y en a une).
  const current = await as(cashier, http().get('/api/cash/sessions/current'));
  if (current.status !== 200 || !current.body?.id) {
    const { body: registers } = await as(cashier, http().get('/api/cash/registers')).expect(200);
    await as(cashier, http().post('/api/cash/sessions'))
      .send({ registerId: registers[0].id, openingFloatXaf: 10_000 })
      .expect(201);
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

describe('vente directe à la caisse', () => {
  it('crée une commande sans table, envoie les bons, et rend l’addition à encaisser', async () => {
    const key = randomUUID();
    const { body: bill } = await sale(
      cashier,
      [
        { productId: product.beer, quantity: 2 },
        { productId: product.skewer, quantity: 5, note: 'bien cuit' },
      ],
      key,
    ).expect(201);
    expect(bill).toMatchObject({ tableLabel: null, totalXaf: 3000, status: 'open' });

    const order = await db.order.findUniqueOrThrow({
      where: { id: bill.orderId },
      include: { tickets: true },
    });
    expect(order).toMatchObject({ tableId: null, type: 'takeaway' });
    expect(order.tickets.map((t) => t.station).sort()).toEqual(['bar', 'grill']);

    // Renvoi après une coupure : même addition, aucune commande de plus.
    const { body: again } = await sale(cashier, [{ productId: product.beer, quantity: 2 }], key).expect(201);
    expect(again.id).toBe(bill.id);
    expect(await db.order.count({ where: { id: bill.orderId } })).toBe(1);

    const { body: paid } = await as(cashier, http().post(`/api/bills/${bill.id}/payments`))
      .send({ idempotencyKey: randomUUID(), method: 'cash', tenderedXaf: 5000 })
      .expect(200);
    expect(paid.status).toBe('paid');
    expect(paid.payments[0]).toMatchObject({ amountXaf: 3000, changeXaf: 2000 });
    expect((await db.order.findUniqueOrThrow({ where: { id: bill.orderId } })).status).toBe('paid');
  });

  it('les prix sont ceux de la carte (pas de supplément VIP sans table)', async () => {
    const { body: bill } = await sale(cashier, [{ productId: product.beer, quantity: 1 }]).expect(201);
    expect(bill.totalXaf).toBe(1000);
    await as(cashier, http().post(`/api/bills/${bill.id}/payments`))
      .send({ idempotencyKey: randomUUID(), method: 'card', amountXaf: 1000, reference: `TPE-${tag()}` })
      .expect(200);
  });

  it('réservée à la caisse : un serveur ne fait pas de vente directe', async () => {
    await sale(waiter, [{ productId: product.beer, quantity: 1 }]).expect(403);
  });

  it('refuse un produit épuisé, sans rien créer', async () => {
    await as(manager, http().patch(`/api/catalog/products/${product.skewer}`))
      .send({
        available: false,
        version: (await db.product.findUniqueOrThrow({ where: { id: product.skewer } })).version,
      })
      .expect(200);
    const before = await db.order.count({ where: { tableId: null } });
    const res = await sale(cashier, [{ productId: product.skewer, quantity: 1 }]).expect(409);
    expect(res.body.code).toBe('PRODUCT_UNAVAILABLE');
    expect(await db.order.count({ where: { tableId: null } })).toBe(before);
  });
});
