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
let waiter: Who;
let cashier: Who;
let accountant: Who;
let managerId: string;
let registerId: string;
let sessionId: string;
const product = { fish: '', beer: '' };

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 5);
const approval = () => ({ userId: managerId, pin: DEMO.manager.pin });

/** Table avec une commande envoyée : 1 poisson (4 500) + 3 bières (700) = 6 600 FCFA. */
async function orderOnNewTable(
  lines = [
    { productId: product.fish, quantity: 1 },
    { productId: product.beer, quantity: 3 },
  ],
) {
  const { body: zone } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `C${tag()}` })
    .expect(201);
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `C${tag()}` })
    .expect(201);
  const { body: order } = await as(waiter, http().post('/api/orders/send'))
    .send({ tableId: table.id, idempotencyKey: randomUUID(), lines })
    .expect(200);
  return order as { id: string; total: number; lines: { id: string; productId: string; quantity: number }[] };
}

const bill = (who: Who, orderId: string, body: object = {}) =>
  as(who, http().post(`/api/orders/${orderId}/bills`)).send(body);

const pay = (who: Who, billId: string, body: object) =>
  as(who, http().post(`/api/bills/${billId}/payments`)).send({ idempotencyKey: randomUUID(), ...body });

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  // La base de test est conservée : on repart sans session ouverte.
  await db.cashSession.updateMany({
    where: { status: 'open' },
    data: { status: 'closed', closedAt: new Date() },
  });

  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  accountant = { token: (await passwordLogin(app, DEMO.accountant)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Tablette caisse');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };
  cashier = { token: (await pinLogin(app, deviceToken, DEMO.cashierPin)).accessToken, device: deviceToken };
  managerId = await userIdByName(app, deviceToken, 'Paul (gérant)');

  const { body: category } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `Caisse ${tag()}` } })
    .expect(201);
  const create = async (name: string, priceXaf: number, station: string) =>
    (
      await as(manager, http().post('/api/catalog/products'))
        .send({ categoryId: category.id, name: { fr: name }, priceXaf, station })
        .expect(201)
    ).body.id as string;
  product.fish = await create('Poisson braisé', 4500, 'grill');
  product.beer = await create('Castel 65 cl', 700, 'bar');

  const { body: registers } = await as(cashier, http().get('/api/cash/registers')).expect(200);
  registerId = registers[0].id;
});

afterAll(async () => {
  await db.user.updateMany({
    where: { username: 'gerant' },
    data: { pinFailedCount: 0, pinLockedUntil: null },
  });
  await app?.close();
  await db?.$disconnect();
});

describe('session de caisse', () => {
  it('refuse tout encaissement sans session ouverte', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const res = await pay(cashier, b.id, { method: 'cash', tenderedXaf: 10_000 }).expect(409);
    expect(res.body.code).toBe('NO_OPEN_SESSION');
  });

  it('ouvre une seule session par caissier et par caisse', async () => {
    const { body } = await as(cashier, http().post('/api/cash/sessions'))
      .send({ registerId, openingFloatXaf: 25_000 })
      .expect(201);
    sessionId = body.id;
    expect(body.expectedCashXaf).toBe(25_000);
    const again = await as(cashier, http().post('/api/cash/sessions'))
      .send({ registerId, openingFloatXaf: 0 })
      .expect(409);
    expect(again.body.code).toBe('SESSION_ALREADY_OPEN');
    await as(waiter, http().post('/api/cash/sessions')).send({ registerId, openingFloatXaf: 0 }).expect(403);
  });
});

describe('encaissement', () => {
  it('espèces : monnaie rendue, reçu numéroté, commande payée et table libérée', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(waiter, order.id).expect(201); // le serveur prépare l'addition
    expect(b.totalXaf).toBe(6600);
    await pay(waiter, b.id, { method: 'cash', tenderedXaf: 10_000 }).expect(403); // mais n'encaisse pas

    const { body: paid } = await pay(cashier, b.id, { method: 'cash', tenderedXaf: 10_000 }).expect(200);
    expect(paid.status).toBe('paid');
    expect(paid.payments[0]).toMatchObject({ amountXaf: 6600, tenderedXaf: 10_000, changeXaf: 3400 });
    expect(paid.receipt.number).toBeGreaterThan(0);

    const closed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed.status).toBe('paid');
    const { body: open } = await as(waiter, http().get('/api/orders/open')).expect(200);
    expect(open.some((o: { id: string }) => o.id === order.id)).toBe(false);
  });

  it('un reçu émis ne peut plus être modifié ni supprimé', async () => {
    const receipt = await db.receipt.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    await expect(
      db.receipt.update({ where: { id: receipt.id }, data: { snapshot: { faux: true } } }),
    ).rejects.toThrow();
    await expect(db.receipt.delete({ where: { id: receipt.id } })).rejects.toThrow();
    await as(cashier, http().post(`/api/receipts/${receipt.id}/reprint`)).expect(202);
    expect((await db.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).reprints).toBe(1);
  });

  it('paiement mixte : référence MoMo obligatoire et unique, pas de trop-perçu', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const ref = `MP${Date.now()}`;
    await pay(cashier, b.id, { method: 'mtn_momo', amountXaf: 3000 }).expect(400);
    const over = await pay(cashier, b.id, { method: 'mtn_momo', amountXaf: 9000, reference: ref }).expect(
      422,
    );
    expect(over.body.code).toBe('OVERPAYMENT');
    const { body: partial } = await pay(cashier, b.id, {
      method: 'mtn_momo',
      amountXaf: 3000,
      reference: ref,
    }).expect(200);
    expect(partial.remainingXaf).toBe(3600);

    const other = await orderOnNewTable();
    const { body: b2 } = await bill(cashier, other.id).expect(201);
    const reused = await pay(cashier, b2.id, {
      method: 'mtn_momo',
      amountXaf: 1000,
      reference: ref.toLowerCase(),
    }).expect(409);
    expect(reused.body.code).toBe('REFERENCE_ALREADY_USED');

    const { body: done } = await pay(cashier, b.id, { method: 'cash', tenderedXaf: 3600 }).expect(200);
    expect(done.status).toBe('paid');
  });

  it('un paiement renvoyé avec la même clé n’est enregistré qu’une fois', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const key = randomUUID();
    await pay(cashier, b.id, { idempotencyKey: key, method: 'card', amountXaf: 2000 }).expect(200);
    await pay(cashier, b.id, { idempotencyKey: key, method: 'card', amountXaf: 2000 }).expect(200);
    expect(await db.payment.count({ where: { billId: b.id } })).toBe(1);
  });

  it('addition séparée : chaque ligne n’est facturée qu’une fois ; la commande se clôt au dernier paiement', async () => {
    const order = await orderOnNewTable();
    const fish = order.lines.find((l) => l.productId === product.fish)!;
    const beer = order.lines.find((l) => l.productId === product.beer)!;
    const { body: first } = await bill(cashier, order.id, {
      lines: [
        { orderLineId: fish.id, quantity: 1 },
        { orderLineId: beer.id, quantity: 1 },
      ],
    }).expect(201);
    expect(first.totalXaf).toBe(5200);
    const twice = await bill(cashier, order.id, { lines: [{ orderLineId: fish.id, quantity: 1 }] }).expect(
      409,
    );
    expect(twice.body.code).toBe('ALREADY_BILLED');
    const { body: rest } = await bill(cashier, order.id).expect(201);
    expect(rest.totalXaf).toBe(1400);

    await pay(cashier, first.id, { method: 'cash', tenderedXaf: 5200 }).expect(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('open');
    await pay(cashier, rest.id, { method: 'card', amountXaf: 1400 }).expect(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('paid');
  });

  it('une ligne facturée ne s’annule plus directement', async () => {
    const order = await orderOnNewTable();
    await bill(cashier, order.id).expect(201);
    const res = await as(manager, http().post(`/api/orders/${order.id}/lines/${order.lines[0]!.id}/cancel`))
      .send({ reason: 'Erreur' })
      .expect(409);
    expect(res.body.code).toBe('LINE_BILLED');
  });
});

describe('remises', () => {
  it('le caissier accorde seul une petite remise ; au-delà du seuil, il faut un gérant', async () => {
    const order = await orderOnNewTable();
    const { body: small } = await bill(cashier, order.id, {
      discount: { type: 'percent', value: 5, reason: 'Client fidèle' },
    }).expect(201);
    expect(small.discountXaf).toBe(330);
    await as(cashier, http().post(`/api/bills/${small.id}/void`)).expect(204);

    const big = { discount: { type: 'percent', value: 50, reason: 'Geste commercial' } };
    const refused = await bill(cashier, order.id, big).expect(403);
    expect(refused.body.code).toBe('APPROVAL_REQUIRED');
    const { body: approved } = await bill(cashier, order.id, { ...big, approval: approval() }).expect(201);
    expect(approved.discountXaf).toBe(3300);
    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: approved.id, action: 'bill.created' },
    });
    expect(log.approverId).toBe(managerId);
  });

  it('une remise s’applique à une addition existante, avec le même contrôle de seuil', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const url = `/api/bills/${b.id}/discount`;
    const refused = await as(cashier, http().post(url))
      .send({ discount: { type: 'amount', value: 3000, reason: 'Anniversaire' } })
      .expect(403);
    expect(refused.body.code).toBe('APPROVAL_REQUIRED');
    const { body: discounted } = await as(cashier, http().post(url))
      .send({ discount: { type: 'amount', value: 3000, reason: 'Anniversaire' }, approval: approval() })
      .expect(200);
    expect(discounted.totalXaf).toBe(3600);
    await pay(cashier, b.id, { method: 'card', amountXaf: 1000 }).expect(200);
    const locked = await as(cashier, http().post(url))
      .send({ discount: { type: 'amount', value: 0, reason: 'Retrait' } })
      .expect(409);
    expect(locked.body.code).toBe('BILL_HAS_PAYMENTS');
  });

  it('le serveur ne fait pas de remise', async () => {
    const order = await orderOnNewTable();
    const res = await bill(waiter, order.id, {
      discount: { type: 'amount', value: 100, reason: 'Ami' },
    }).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('annulation de paiement', () => {
  it('demande un motif et le PIN d’un gérant pour le caissier', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const { body: partial } = await pay(cashier, b.id, { method: 'card', amountXaf: 1000 }).expect(200);
    const paymentId = partial.payments[0].id;
    const res = await as(cashier, http().post(`/api/payments/${paymentId}/void`))
      .send({ reason: 'Erreur de montant' })
      .expect(403);
    expect(res.body.code).toBe('APPROVAL_REQUIRED');
    await as(cashier, http().post(`/api/payments/${paymentId}/void`))
      .send({ reason: 'Erreur de montant', approval: approval() })
      .expect(204);
    const { body: after } = await as(cashier, http().get(`/api/bills/${b.id}`)).expect(200);
    expect(after.remainingXaf).toBe(6600);
    expect(after.payments[0].status).toBe('voided');
  });
});

describe('ardoise', () => {
  it('plafond respecté, approbation au-delà, règlement en caisse, historique non modifiable', async () => {
    await as(cashier, http().post('/api/customers'))
      .send({ name: 'Interdit', creditLimitXaf: 1000 })
      .expect(403);
    const { body: customer } = await as(manager, http().post('/api/customers'))
      .send({ name: `M. Test ${tag()}`, phone: '+237 6 99 00 00 00', creditLimitXaf: 8000 })
      .expect(201);

    const o1 = await orderOnNewTable();
    const { body: b1 } = await bill(cashier, o1.id).expect(201);
    await pay(cashier, b1.id, { method: 'customer_credit', amountXaf: 6600, customerId: customer.id }).expect(
      200,
    );

    const o2 = await orderOnNewTable();
    const { body: b2 } = await bill(cashier, o2.id).expect(201);
    const over = await pay(cashier, b2.id, {
      method: 'customer_credit',
      amountXaf: 6600,
      customerId: customer.id,
    }).expect(403);
    expect(over.body.code).toBe('APPROVAL_REQUIRED');
    await pay(cashier, b2.id, {
      method: 'customer_credit',
      amountXaf: 6600,
      customerId: customer.id,
      approval: approval(),
    }).expect(200);

    const { body: owed } = await as(cashier, http().get(`/api/customers/${customer.id}`)).expect(200);
    expect(owed.balanceXaf).toBe(13_200);

    const key = randomUUID();
    await as(cashier, http().post(`/api/customers/${customer.id}/settlements`))
      .send({ idempotencyKey: key, method: 'cash', amountXaf: 13_200 })
      .expect(200);
    await as(cashier, http().post(`/api/customers/${customer.id}/settlements`))
      .send({ idempotencyKey: key, method: 'cash', amountXaf: 13_200 })
      .expect(200); // renvoi : sans effet
    const tooMuch = await as(cashier, http().post(`/api/customers/${customer.id}/settlements`))
      .send({ idempotencyKey: randomUUID(), method: 'cash', amountXaf: 1 })
      .expect(422);
    expect(tooMuch.body.code).toBe('OVERPAYMENT');
    const { body: settled } = await as(cashier, http().get(`/api/customers/${customer.id}`)).expect(200);
    expect(settled.balanceXaf).toBe(0);

    const entry = await db.customerLedgerEntry.findFirstOrThrow({ where: { customerId: customer.id } });
    await expect(
      db.customerLedgerEntry.update({ where: { id: entry.id }, data: { amountXaf: 0 } }),
    ).rejects.toThrow();
    await expect(db.customerLedgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});

describe('rapprochement', () => {
  it('le comptable confirme un paiement MoMo ; le caissier ne le peut pas', async () => {
    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const { body: paid } = await pay(cashier, b.id, {
      method: 'orange_money',
      amountXaf: 6600,
      reference: `OM${Date.now()}`,
    }).expect(200);
    const paymentId = paid.payments[0].id;
    await as(cashier, http().post(`/api/payments/${paymentId}/verify`)).expect(403);
    await as(accountant, http().post(`/api/payments/${paymentId}/verify`)).expect(204);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('verified');
  });
});

describe('clôture', () => {
  it('calcule l’écart, exige un commentaire, puis ferme la session', async () => {
    const { body: current } = await as(cashier, http().get('/api/cash/sessions/current')).expect(200);
    expect(current.id).toBe(sessionId);
    // Fond 25 000 + espèces encaissées (dont 13 200 de règlement d'ardoise).
    expect(current.expectedCashXaf).toBe(25_000 + current.byMethod.cash);
    expect(current.byMethod.cash).toBeGreaterThanOrEqual(6600 + 3600 + 5200 + 13_200);

    const short = current.expectedCashXaf - 500;
    const noComment = await as(cashier, http().post(`/api/cash/sessions/${sessionId}/close`))
      .send({ countedCashXaf: short })
      .expect(400);
    expect(noComment.body.code).toBe('COMMENT_REQUIRED');
    await as(waiter, http().post(`/api/cash/sessions/${sessionId}/close`))
      .send({ countedCashXaf: short })
      .expect(403);

    const { body: closed } = await as(cashier, http().post(`/api/cash/sessions/${sessionId}/close`))
      .send({ countedCashXaf: short, comment: 'Erreur de monnaie sur une table' })
      .expect(200);
    expect(closed.status).toBe('closed');
    expect(closed.differenceXaf).toBe(-500);
    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: sessionId, action: 'cash.session_closed' },
    });
    expect(log.reason).toBe('Erreur de monnaie sur une table');

    const order = await orderOnNewTable();
    const { body: b } = await bill(cashier, order.id).expect(201);
    const after = await pay(cashier, b.id, { method: 'cash', tenderedXaf: 10_000 }).expect(409);
    expect(after.body.code).toBe('NO_OPEN_SESSION');
  });
});
