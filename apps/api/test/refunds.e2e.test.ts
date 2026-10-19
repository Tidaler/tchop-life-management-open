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
let cashier: Who;
let managerId: string;
let product: string;
let itemId: string;
let barId: string;
const today = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 6);
const approval = () => ({ userId: managerId, pin: DEMO.manager.pin });

interface PaidBill {
  id: string;
  totalXaf: number;
  receipt: { number: number };
}

/** Commande de `quantity` produits à 1 000 FCFA (1 bouteille chacun), facturée et payée en espèces. */
async function sale(quantity = 3, bill: object = {}): Promise<PaidBill> {
  const { body: zone } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `R${tag()}` })
    .expect(201);
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `R${tag()}` })
    .expect(201);
  const { body: order } = await as(waiter, http().post('/api/orders/send'))
    .send({ tableId: table.id, idempotencyKey: randomUUID(), lines: [{ productId: product, quantity }] })
    .expect(200);
  const { body: b } = await as(manager, http().post(`/api/orders/${order.id}/bills`))
    .send(bill)
    .expect(201);
  const { body: paid } = await as(cashier, http().post(`/api/bills/${b.id}/payments`))
    .send({ idempotencyKey: randomUUID(), method: 'cash', tenderedXaf: b.totalXaf })
    .expect(200);
  return paid;
}

const lookup = async (number: number) =>
  (await as(cashier, http().get(`/api/receipts/by-number/${number}`)).expect(200)).body as {
    billId: string;
    refundableXaf: number;
    refundedXaf: number;
    lines: { orderLineId: string; quantity: number; refundedQuantity: number }[];
  };

const refund = (who: Who, billId: string, body: object) =>
  as(who, http().post(`/api/bills/${billId}/refunds`)).send({
    idempotencyKey: randomUUID(),
    method: 'cash',
    reason: 'Plat froid, client mécontent',
    ...body,
  });

const level = async () =>
  Number(
    (await db.stockLevel.findUnique({ where: { itemId_locationId: { itemId, locationId: barId } } }))
      ?.quantity ?? 0,
  );

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  await db.cashSession.updateMany({
    where: { status: 'open' },
    data: { status: 'closed', closedAt: new Date() },
  });
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  accountant = { token: (await passwordLogin(app, DEMO.accountant)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Tablette remboursements');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };
  cashier = { token: (await pinLogin(app, deviceToken, DEMO.cashierPin)).accessToken, device: deviceToken };
  managerId = await userIdByName(app, deviceToken, 'Paul (gérant)');

  const { body: registers } = await as(cashier, http().get('/api/cash/registers')).expect(200);
  await as(cashier, http().post('/api/cash/sessions'))
    .send({ registerId: registers[0].id, openingFloatXaf: 50_000 })
    .expect(201);

  const { body: cat } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `Remb ${tag()}` } })
    .expect(201);
  product = (
    await as(manager, http().post('/api/catalog/products'))
      .send({ categoryId: cat.id, name: { fr: `Jus ${tag()}` }, priceXaf: 1000, station: 'bar' })
      .expect(201)
  ).body.id;
  const { body: locations } = await as(manager, http().get('/api/stock/locations')).expect(200);
  barId = locations.find((l: { name: string }) => l.name === 'Bar').id;
  itemId = (
    await as(manager, http().post('/api/stock/items'))
      .send({ name: `Jus ${tag()}`, unit: 'bottle', locationId: barId })
      .expect(201)
  ).body.id;
  await as(manager, http().post('/api/stock/receipts'))
    .send({
      idempotencyKey: randomUUID(),
      locationId: barId,
      lines: [{ itemId, quantity: 48, unitPriceXaf: 300 }],
    })
    .expect(201);
  await as(manager, http().put(`/api/stock/recipes/${product}`))
    .send({ lines: [{ itemId, quantity: 1 }] })
    .expect(200);
});

afterAll(async () => {
  await db.user.updateMany({
    where: { username: 'gerant' },
    data: { pinFailedCount: 0, pinLockedUntil: null },
  });
  await db.cashSession.updateMany({
    where: { status: 'open' },
    data: { status: 'closed', closedAt: new Date() },
  });
  await db.$disconnect();
  await app.close();
});

describe('retrouver un reçu', () => {
  it('par son numéro, avec ce qui reste remboursable ; réservé à qui peut rembourser', async () => {
    const paid = await sale();
    const found = await lookup(paid.receipt.number);
    expect(found).toMatchObject({ billId: paid.id, refundableXaf: 3000, refundedXaf: 0 });
    expect(found.lines[0]).toMatchObject({ quantity: 3, refundedQuantity: 0 });
    await as(cashier, http().get('/api/receipts/by-number/999999')).expect(404);
    await as(waiter, http().get(`/api/receipts/by-number/${paid.receipt.number}`)).expect(403);
  });
});

describe('remboursement', () => {
  it('le caissier rembourse avec le PIN d’un gérant ; les espèces sortent de la caisse ; renvoi sans doublon', async () => {
    const paid = await sale();
    const { lines } = await lookup(paid.receipt.number);
    const body = { lines: [{ orderLineId: lines[0]!.orderLineId, quantity: 1 }] };
    await refund(cashier, paid.id, body)
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));

    const before = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    const key = randomUUID();
    const { body: done } = await refund(cashier, paid.id, {
      ...body,
      idempotencyKey: key,
      approval: approval(),
    }).expect(201);
    expect(done).toMatchObject({ amountXaf: 1000, method: 'cash', approvedById: managerId });
    expect(done.content).toMatchObject({
      kind: 'refund',
      receiptNumber: paid.receipt.number,
      amountXaf: 1000,
      creditNote: false,
    });
    const { body: again } = await refund(cashier, paid.id, {
      ...body,
      idempotencyKey: key,
      approval: approval(),
    }).expect(201);
    expect(again.id).toBe(done.id);

    const after = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    expect(after.cashRefundsXaf - before.cashRefundsXaf).toBe(1000);
    expect(before.expectedCashXaf - after.expectedCashXaf).toBe(1000);
    const state = await lookup(paid.receipt.number);
    expect(state).toMatchObject({ refundedXaf: 1000, refundableXaf: 2000 });
    expect(state.lines[0]!.refundedQuantity).toBe(1);
  });

  it('jamais plus que ce qui a été vendu et payé ; seulement une addition payée', async () => {
    const paid = await sale(2);
    const { lines } = await lookup(paid.receipt.number);
    await refund(manager, paid.id, {
      method: 'card',
      lines: [{ orderLineId: lines[0]!.orderLineId, quantity: 3 }],
    })
      .expect(422)
      .expect((res) => expect(res.body.code).toBe('REFUND_TOO_LARGE'));
    await refund(manager, paid.id, { method: 'card', amountXaf: 2500 }).expect(422);
    // En espèces, l'argent sort d'une caisse : sans session ouverte, refusé.
    await refund(manager, paid.id, { amountXaf: 500 })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('NO_OPEN_SESSION'));
    await refund(manager, paid.id, { method: 'card', amountXaf: 2000 }).expect(201);
    await refund(manager, paid.id, { method: 'card', amountXaf: 1 })
      .expect(422)
      .expect((res) => expect(res.body.code).toBe('REFUND_TOO_LARGE'));

    // Addition encore ouverte : rien à rembourser.
    const { body: zone } = await as(manager, http().post('/api/floor/zones'))
      .send({ name: `R${tag()}` })
      .expect(201);
    const { body: table } = await as(manager, http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label: `R${tag()}` })
      .expect(201);
    const { body: order } = await as(waiter, http().post('/api/orders/send'))
      .send({ tableId: table.id, idempotencyKey: randomUUID(), lines: [{ productId: product, quantity: 1 }] })
      .expect(200);
    const { body: open } = await as(manager, http().post(`/api/orders/${order.id}/bills`))
      .send({})
      .expect(201);
    await refund(manager, open.id, { method: 'card', amountXaf: 500 })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('BILL_NOT_PAID'));
  });

  it('montant au prorata de la remise de l’addition', async () => {
    const paid = await sale(2, { discount: { type: 'percent', value: 10, reason: 'Client fidèle' } });
    expect(paid.totalXaf).toBe(1800);
    const { lines } = await lookup(paid.receipt.number);
    const { body } = await refund(manager, paid.id, {
      method: 'card',
      lines: [{ orderLineId: lines[0]!.orderLineId, quantity: 1 }],
    }).expect(201);
    expect(body.amountXaf).toBe(900);
  });

  it('marchandise intacte : remise en stock au coût de la sortie', async () => {
    const paid = await sale(2);
    const before = await level();
    const { lines } = await lookup(paid.receipt.number);
    await refund(manager, paid.id, {
      method: 'card',
      lines: [{ orderLineId: lines[0]!.orderLineId, quantity: 2 }],
      restock: true,
    }).expect(201);
    expect((await level()) - before).toBe(2);
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { orderLineId: lines[0]!.orderLineId, type: 'sale_cancel' },
    });
    expect(Number(movement.unitCostXaf)).toBe(300);
    // La remise en stock suppose des lignes, pas un montant libre.
    await refund(manager, paid.id, { method: 'card', amountXaf: 100, restock: true }).expect(400);
  });

  it('avoir sur ardoise : le client doit moins ; MoMo exige une référence', async () => {
    const { body: customer } = await as(manager, http().post('/api/customers'))
      .send({ name: `Avoir ${tag()}`, creditLimitXaf: 20_000 })
      .expect(201);
    const paid = await sale(1);
    const { body: done } = await refund(manager, paid.id, {
      amountXaf: 1000,
      method: 'customer_credit',
      customerId: customer.id,
    }).expect(201);
    expect(done.content).toMatchObject({ creditNote: true, customerName: customer.name });
    const { body: after } = await as(manager, http().get(`/api/customers/${customer.id}`)).expect(200);
    expect(after.balanceXaf).toBe(-1000);
    await refund(manager, paid.id, { amountXaf: 100, method: 'customer_credit' }).expect(400);
    const other = await sale(1);
    await refund(manager, other.id, { amountXaf: 500, method: 'mtn_momo' }).expect(400);
    await refund(manager, other.id, {
      amountXaf: 500,
      method: 'mtn_momo',
      reference: 'MP261019.1234',
    }).expect(201);
  });

  it('un remboursement ne se modifie ni ne se supprime', async () => {
    const one = await db.refund.findFirstOrThrow();
    await expect(db.refund.update({ where: { id: one.id }, data: { amountXaf: 1 } })).rejects.toThrow();
    await expect(db.refund.delete({ where: { id: one.id } })).rejects.toThrow();
  });
});

describe('effets sur la caisse et les rapports', () => {
  it('chiffre d’affaires net des remboursements ; export CSV des remboursements', async () => {
    const period = `from=${today()}&to=${today()}`;
    const before = (await as(manager, http().get(`/api/reports/sales?${period}`)).expect(200)).body;
    const paid = await sale(1);
    await refund(manager, paid.id, { method: 'card', amountXaf: 400 }).expect(201);
    const after = (await as(manager, http().get(`/api/reports/sales?${period}`)).expect(200)).body;
    expect(after.totals.netXaf - before.totals.netXaf).toBe(1000);
    expect(after.totals.refundsXaf - before.totals.refundsXaf).toBe(400);
    expect(after.totals.revenueXaf - before.totals.revenueXaf).toBe(600);
    const csv = await as(accountant, http().get(`/api/reports/export/refunds?${period}`)).expect(200);
    expect(csv.text).toContain('Plat froid');
  });

  it('clôture : les remboursements en espèces sortent du théorique', async () => {
    const current = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    expect(current.cashRefundsXaf).toBeGreaterThan(0);
    const { body: closed } = await as(cashier, http().post(`/api/cash/sessions/${current.id}/close`))
      .send({ countedCashXaf: current.expectedCashXaf })
      .expect(200);
    expect(closed.expectedCashXaf).toBe(
      closed.openingFloatXaf + closed.byMethod.cash - closed.cashExpensesXaf - closed.cashRefundsXaf,
    );
    const log = await db.auditLog.findFirstOrThrow({
      where: { action: 'cash.session_closed', entityId: current.id },
    });
    expect((log.after as { cashRefundsXaf: number }).cashRefundsXaf).toBe(closed.cashRefundsXaf);
    // Plus de caisse ouverte : plus de remboursement possible.
    const paid = await db.bill.findFirstOrThrow({ where: { status: 'paid' }, orderBy: { paidAt: 'desc' } });
    await refund(cashier, paid.id, { amountXaf: 1, approval: approval() })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('NO_OPEN_SESSION'));
  });
});
