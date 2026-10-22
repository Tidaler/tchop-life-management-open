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
let waiter: Who;
const product = { beer: '', wine: '', skewer: '' };
let vipZone: { id: string; version: number };

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 5);

async function newTable(zoneId: string) {
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId, label: `V${tag()}` })
    .expect(201);
  const { body } = await as(manager, http().get('/api/floor/qr-codes')).expect(200);
  const url: string = body.codes.find((c: { tableId: string }) => c.tableId === table.id).url;
  return { id: table.id as string, token: url.split('/q/')[1]! };
}

const send = (tableId: string, productId: string) =>
  as(waiter, http().post('/api/orders/send')).send({
    tableId,
    idempotencyKey: randomUUID(),
    lines: [{ productId, quantity: 1 }],
  });

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Tablette VIP');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };

  const category = async (fr: string, rule: object) =>
    (
      await as(manager, http().post('/api/catalog/categories'))
        .send({ name: { fr: `${fr} ${tag()}` }, ...rule })
        .expect(201)
    ).body as { id: string; vipOffered: boolean; vipSurchargeXaf: number };
  const beers = await category('Bières', { vipOffered: false });
  const wines = await category('Vins', { vipSurchargeXaf: 5000 });
  const grills = await category('Grillades', { vipSurchargeXaf: 100 });
  expect(wines).toMatchObject({ vipOffered: true, vipSurchargeXaf: 5000 });
  const create = async (categoryId: string, name: string, priceXaf: number, station: string) =>
    (
      await as(manager, http().post('/api/catalog/products'))
        .send({ categoryId, name: { fr: `${name} ${tag()}` }, priceXaf, station })
        .expect(201)
    ).body.id as string;
  product.beer = await create(beers.id, 'Castel', 1000, 'bar');
  product.wine = await create(wines.id, 'Cantelou', 8000, 'bar');
  product.skewer = await create(grills.id, 'Brochette', 200, 'grill');

  const { body } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `Salon VIP ${tag()}`, vip: true })
    .expect(201);
  vipZone = body;
  expect(body.vip).toBe(true);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

describe('salon VIP', () => {
  it('commande du personnel : supplément en VIP, produit non proposé refusé, prix normal ailleurs', async () => {
    const vip = await newTable(vipZone.id);
    const { body: order } = await send(vip.id, product.wine).expect(200);
    expect(order.lines[0].unitPriceXaf).toBe(13000);
    await send(vip.id, product.skewer).expect(200);
    const lines = await db.orderLine.findMany({ where: { orderId: order.id } });
    expect(lines.map((l) => l.unitPriceXaf).sort((a, b) => a - b)).toEqual([300, 13000]);

    const refused = await send(vip.id, product.beer).expect(409);
    expect(refused.body.code).toBe('NOT_OFFERED_IN_ZONE');

    const { body: room } = await as(manager, http().post('/api/floor/zones'))
      .send({ name: `Salle ${tag()}` })
      .expect(201);
    const normal = await newTable(room.id);
    const { body: standard } = await send(normal.id, product.wine).expect(200);
    expect(standard.lines[0].unitPriceXaf).toBe(8000);
    await send(normal.id, product.beer).expect(200);
  });

  it('menu QR d’une table VIP : catégorie retirée, prix majorés, règles jamais exposées', async () => {
    const vip = await newTable(vipZone.id);
    const { body } = await http().get(`/api/public/menu/${vip.token}`).expect(200);
    const ids = body.products.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(product.beer);
    expect(body.products.find((p: { id: string }) => p.id === product.wine).priceXaf).toBe(13000);
    expect(JSON.stringify(body)).not.toContain('vipSurcharge');

    // Commander un produit absent du menu de la table : refusé comme un produit inconnu.
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(`/api/public/menu/${vip.token}/orders`)
      .send({ idempotencyKey: randomUUID(), lines: [{ productId: product.beer, quantity: 1 }] })
      .expect(404);
    const { body: submitted } = await agent
      .post(`/api/public/menu/${vip.token}/orders`)
      .send({ idempotencyKey: randomUUID(), lines: [{ productId: product.wine, quantity: 1 }] })
      .expect(201);
    const { body: accepted } = await as(
      waiter,
      http().post(`/api/qr-requests/${submitted.id}/accept`),
    ).expect(200);
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: accepted.orderId } });
    expect(line.unitPriceXaf).toBe(13000);
  });

  it('une commande garde ses prix si la zone change ; les nouveaux envois suivent la zone', async () => {
    const vip = await newTable(vipZone.id);
    const { body: order } = await send(vip.id, product.wine).expect(200);
    const { body: zone } = await as(manager, http().get('/api/floor')).expect(200);
    const current = zone.find((z: { id: string }) => z.id === vipZone.id);
    await as(manager, http().patch(`/api/floor/zones/${vipZone.id}`))
      .send({ vip: false, version: current.version })
      .expect(200);
    const { body: after } = await send(vip.id, product.wine).expect(200);
    const prices = after.lines.map((l: { unitPriceXaf: number }) => l.unitPriceXaf).sort();
    expect(after.id).toBe(order.id);
    expect(prices).toEqual([13000, 8000].sort());
    await as(manager, http().patch(`/api/floor/zones/${vipZone.id}`))
      .send({ vip: true, version: current.version + 1 })
      .expect(200);
  });
});
