import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import sharp from 'sharp';
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
let registerId: string;
let categories: { id: string; name: string; kind: string }[];
let product: string;
let itemId: string;
const today = () => new Date(Date.now() - 6 * 3_600_000 + 3_600_000).toISOString().slice(0, 10);

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 6);
const approval = () => ({ userId: managerId, pin: DEMO.manager.pin });
const category = (name: string) => categories.find((c) => c.name === name)!.id;
const expense = (who: Who, body: object) =>
  as(who, http().post('/api/expenses')).send({
    idempotencyKey: randomUUID(),
    categoryId: category('Divers'),
    method: 'cash',
    description: 'Achat de glace',
    ...body,
  });
const period = () => `from=${today()}&to=${today()}`;

/** Commande de 2 produits (2 × 1 000 FCFA) envoyée, facturée et payée en espèces. */
async function sale() {
  const { body: zone } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `F${tag()}` })
    .expect(201);
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `F${tag()}` })
    .expect(201);
  const { body: order } = await as(waiter, http().post('/api/orders/send'))
    .send({ tableId: table.id, idempotencyKey: randomUUID(), lines: [{ productId: product, quantity: 2 }] })
    .expect(200);
  const { body: bill } = await as(cashier, http().post(`/api/orders/${order.id}/bills`))
    .send({})
    .expect(201);
  await as(cashier, http().post(`/api/bills/${bill.id}/payments`))
    .send({ idempotencyKey: randomUUID(), method: 'cash', tenderedXaf: 2000 })
    .expect(200);
  return bill as { id: string; totalXaf: number };
}

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0' });
  db = testDb();
  await db.cashSession.updateMany({
    where: { status: 'open' },
    data: { status: 'closed', closedAt: new Date() },
  });
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  accountant = { token: (await passwordLogin(app, DEMO.accountant)).accessToken };
  const { deviceToken } = await enrollDevice(app, 'Tablette finances');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };
  cashier = { token: (await pinLogin(app, deviceToken, DEMO.cashierPin)).accessToken, device: deviceToken };
  managerId = await userIdByName(app, deviceToken, 'Paul (gérant)');

  categories = (await as(cashier, http().get('/api/expenses/categories')).expect(200)).body;
  const { body: registers } = await as(cashier, http().get('/api/cash/registers')).expect(200);
  registerId = registers[0].id;
  await as(cashier, http().post('/api/cash/sessions'))
    .send({ registerId, openingFloatXaf: 20_000 })
    .expect(201);

  // Produit à 1 000 FCFA dont la recette sort 1 bouteille achetée 400 FCFA.
  const { body: cat } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `Finances ${tag()}` } })
    .expect(201);
  product = (
    await as(manager, http().post('/api/catalog/products'))
      .send({ categoryId: cat.id, name: { fr: `Bière ${tag()}` }, priceXaf: 1000, station: 'bar' })
      .expect(201)
  ).body.id;
  const { body: locations } = await as(manager, http().get('/api/stock/locations')).expect(200);
  const bar = locations.find((l: { name: string }) => l.name === 'Bar').id;
  itemId = (
    await as(manager, http().post('/api/stock/items'))
      .send({ name: `Bière ${tag()}`, unit: 'bottle', locationId: bar })
      .expect(201)
  ).body.id;
  await as(manager, http().post('/api/stock/receipts'))
    .send({
      idempotencyKey: randomUUID(),
      locationId: bar,
      lines: [{ itemId, quantity: 24, unitPriceXaf: 400 }],
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

describe('dépenses', () => {
  it('catégories du cahier des charges ; le serveur n’a pas accès aux dépenses', async () => {
    expect(categories.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'Approvisionnement',
        'Transport',
        'Énergie',
        'Entretien',
        'Salaires',
        'Loyer',
        'Divers',
      ]),
    );
    expect(categories.find((c) => c.name === 'Approvisionnement')!.kind).toBe('purchase');
    await as(waiter, http().get('/api/expenses/categories')).expect(403);
    await expense(waiter, { amountXaf: 500 }).expect(403);
  });

  it('dépense payée depuis la caisse : elle réduit les espèces attendues ; approbation au-delà de 5 000 FCFA', async () => {
    const before = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    const { body: small } = await expense(cashier, { amountXaf: 3000, fromCashSession: true }).expect(201);
    expect(small).toMatchObject({
      amountXaf: 3000,
      fromCashSession: true,
      status: 'recorded',
      approvedBy: null,
    });
    await expense(cashier, { amountXaf: 8000, fromCashSession: true })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));
    const { body: big } = await expense(cashier, {
      amountXaf: 8000,
      fromCashSession: true,
      approval: approval(),
    }).expect(201);
    expect(big.approvedBy).toBe('Paul (gérant)');
    const after = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    expect(after.cashExpensesXaf - before.cashExpensesXaf).toBe(11_000);
    expect(before.expectedCashXaf - after.expectedCashXaf).toBe(11_000);
  });

  it('règles de saisie : idempotence, pas de date future, caisse seulement en espèces', async () => {
    const key = randomUUID();
    const body = {
      idempotencyKey: key,
      categoryId: category('Transport'),
      method: 'mtn_momo',
      amountXaf: 1500,
      description: 'Moto-taxi livraison',
    };
    const { body: a } = await as(cashier, http().post('/api/expenses')).send(body).expect(201);
    const { body: b } = await as(cashier, http().post('/api/expenses')).send(body).expect(201);
    expect(b.id).toBe(a.id);
    await expense(cashier, { amountXaf: 500, date: '2099-01-01' })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('FUTURE_DATE'));
    await expense(cashier, { amountXaf: 500, method: 'mtn_momo', fromCashSession: true }).expect(400);
  });

  it('le caissier ne voit que ses dépenses ; le comptable voit tout', async () => {
    await expense(manager, { amountXaf: 2500, description: 'Ampoules' }).expect(201);
    const mine = (await as(cashier, http().get(`/api/expenses?${period()}`)).expect(200)).body;
    expect(mine.expenses.every((e: { createdBy: string }) => e.createdBy === 'Mireille')).toBe(true);
    const all = (await as(accountant, http().get(`/api/expenses?${period()}`)).expect(200)).body;
    expect(all.expenses.some((e: { createdBy: string }) => e.createdBy === 'Paul (gérant)')).toBe(true);
    expect(all.totalXaf).toBeGreaterThan(mine.totalXaf);
  });

  it('annulation : motif, approbation pour le caissier, rendue à la caisse ; jamais supprimée', async () => {
    const { body: e } = await expense(cashier, { amountXaf: 1000, fromCashSession: true }).expect(201);
    const before = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    await as(cashier, http().post(`/api/expenses/${e.id}/void`))
      .send({ reason: 'Saisie en double' })
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('APPROVAL_REQUIRED'));
    const { body: voided } = await as(cashier, http().post(`/api/expenses/${e.id}/void`))
      .send({ reason: 'Saisie en double', approval: approval() })
      .expect(200);
    expect(voided).toMatchObject({ status: 'voided', voidReason: 'Saisie en double' });
    const after = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    expect(after.expectedCashXaf - before.expectedCashXaf).toBe(1000);
    await as(manager, http().post(`/api/expenses/${e.id}/void`))
      .send({ reason: 'Encore' })
      .expect(409);
    await expect(db.expense.delete({ where: { id: e.id } })).rejects.toThrow();
  });

  it('justificatif : image réencodée, servie seulement à qui voit la dépense', async () => {
    const { body: e } = await expense(cashier, { amountXaf: 700, description: 'Savon' }).expect(201);
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#e0561c' } })
      .png()
      .toBuffer();
    const { body: withFile } = await as(cashier, http().post(`/api/expenses/${e.id}/attachment`))
      .attach('file', png, 'facture.png')
      .expect(201);
    expect(withFile.hasAttachment).toBe(true);
    const res = await as(cashier, http().get(`/api/expenses/${e.id}/attachment`)).expect(200);
    expect(res.headers['content-type']).toContain('image/webp');
    expect(res.headers['cache-control']).toContain('no-store');
    await as(waiter, http().get(`/api/expenses/${e.id}/attachment`)).expect(403);
    const stored = await db.expense.findUniqueOrThrow({ where: { id: e.id } });
    await http().get(`/api/media/${stored.attachment}`).expect(404);
    await as(cashier, http().post(`/api/expenses/${e.id}/attachment`))
      .attach('file', Buffer.from('pas une image'), 'x.png')
      .expect(400);
  });
});

describe('rapports', () => {
  it('ventes : la vente encaissée apparaît dans les totaux, par produit et par moyen de paiement', async () => {
    const before = (await as(manager, http().get(`/api/reports/sales?${period()}`)).expect(200)).body;
    const bill = await sale();
    const after = (await as(manager, http().get(`/api/reports/sales?${period()}`)).expect(200)).body;
    expect(after.totals.bills - before.totals.bills).toBe(1);
    expect(after.totals.netXaf - before.totals.netXaf).toBe(bill.totalXaf);
    expect(after.byProduct.find((p: { id: string }) => p.id === product)).toMatchObject({
      quantity: 2,
      amountXaf: 2000,
    });
    const cash = (r: { byMethod: { method: string; amountXaf: number }[] }) =>
      r.byMethod.find((m) => m.method === 'cash')?.amountXaf ?? 0;
    expect(cash(after) - cash(before)).toBe(2000);
    expect(after.ownOnly).toBe(false);
  });

  it('le caissier ne voit que ses propres encaissements ; le serveur aucun rapport', async () => {
    const { body } = await as(cashier, http().get(`/api/reports/sales?${period()}`)).expect(200);
    expect(body.ownOnly).toBe(true);
    expect(body.totals.orders).toBeNull();
    expect(body.totals.bills).toBeGreaterThan(0);
    const { body: cash } = await as(cashier, http().get(`/api/reports/cash?${period()}`)).expect(200);
    expect(cash.sessions.every((s: { cashierName: string }) => s.cashierName === 'Mireille')).toBe(true);
    await as(waiter, http().get(`/api/reports/sales?${period()}`)).expect(403);
    await as(cashier, http().get(`/api/reports/finance?${period()}`)).expect(403);
    await as(cashier, http().get('/api/reports/dashboard')).expect(403);
  });

  it('finances : coût des ventes selon la recette, charges comptées, achats de marchandises à part', async () => {
    const before = (await as(accountant, http().get(`/api/reports/finance?${period()}`)).expect(200)).body;
    await sale();
    await expense(manager, {
      amountXaf: 4000,
      categoryId: category('Énergie'),
      description: 'Recharge électricité',
    }).expect(201);
    await expense(manager, {
      amountXaf: 9000,
      categoryId: category('Approvisionnement'),
      method: 'orange_money',
      description: 'Facture dépôt boissons',
    }).expect(201);
    const after = (await as(accountant, http().get(`/api/reports/finance?${period()}`)).expect(200)).body;
    expect(after.revenueXaf - before.revenueXaf).toBe(2000);
    expect(after.costOfSalesXaf - before.costOfSalesXaf).toBe(800);
    expect(after.operatingExpensesXaf - before.operatingExpensesXaf).toBe(4000);
    expect(after.purchaseExpensesXaf - before.purchaseExpensesXaf).toBe(9000);
    // 2 000 de ventes − 800 de coût − 4 000 de charges ; l'achat de marchandises n'est pas une charge.
    expect(after.estimatedProfitXaf - before.estimatedProfitXaf).toBe(-2800);
  });

  it('tableau de bord du jour pour le gérant', async () => {
    const { body } = await as(manager, http().get('/api/reports/dashboard')).expect(200);
    expect(body.period.from).toBe(body.period.to);
    expect(body.sales.netXaf).toBeGreaterThan(0);
    expect(body.cashSessions.some((s: { cashier: string }) => s.cashier === 'Mireille')).toBe(true);
    expect(body).toHaveProperty('stockAlerts.count');
    await as(manager, http().get('/api/reports/sales?from=2026-12-01&to=2026-01-01')).expect(400);
  });

  it('clôture : les dépenses de la caisse sortent du théorique et du rapport Z', async () => {
    const current = (await as(cashier, http().get('/api/cash/sessions/current')).expect(200)).body;
    const { body: closed } = await as(cashier, http().post(`/api/cash/sessions/${current.id}/close`))
      .send({ countedCashXaf: current.expectedCashXaf })
      .expect(200);
    expect(closed.expectedCashXaf).toBe(
      closed.openingFloatXaf + closed.byMethod.cash - closed.cashExpensesXaf,
    );
    expect(closed.differenceXaf).toBe(0);
    const log = await db.auditLog.findFirstOrThrow({
      where: { action: 'cash.session_closed', entityId: current.id },
    });
    expect((log.after as { cashExpensesXaf: number }).cashExpensesXaf).toBe(closed.cashExpensesXaf);
    expect(closed.cashExpensesXaf).toBeGreaterThan(0);
    // Une dépense d'une caisse clôturée ne s'annule plus.
    const cashExpense = await db.expense.findFirstOrThrow({
      where: { sessionId: current.id, status: 'recorded' },
    });
    await as(manager, http().post(`/api/expenses/${cashExpense.id}/void`))
      .send({ reason: 'Trop tard' })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('SESSION_CLOSED'));
  });
});

describe('exports et journal', () => {
  it('export CSV pour le comptable, protégé contre les formules', async () => {
    await expense(manager, { amountXaf: 100, description: '=HYPERLINK("http://exemple.test")' }).expect(201);
    const res = await as(accountant, http().get(`/api/reports/export/expenses?${period()}`)).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Jour;N°;Catégorie');
    expect(text).toContain(`"'=HYPERLINK(""http://exemple.test"")"`);
    for (const kind of ['sales', 'payments', 'stock-movements']) {
      await as(accountant, http().get(`/api/reports/export/${kind}?${period()}`)).expect(200);
    }
    await as(accountant, http().get(`/api/reports/export/autre?${period()}`)).expect(400);
    await as(cashier, http().get(`/api/reports/export/sales?${period()}`)).expect(403);
  });

  it('journal d’audit consultable par le comptable, filtrable par action', async () => {
    const { body } = await as(accountant, http().get('/api/audit?action=expense.&limit=20')).expect(200);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e: { action: string }) => e.action.startsWith('expense.'))).toBe(true);
    expect(body.entries.some((e: { actor: string }) => e.actor === 'Mireille')).toBe(true);
    await as(cashier, http().get('/api/audit')).expect(403);
    await as(manager, http().get('/api/audit?action=DROP TABLE')).expect(400);
  });
});
