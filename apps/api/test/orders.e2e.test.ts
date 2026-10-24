import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import iconv from 'iconv-lite';
import { io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Classes de l'API compilée (voir helpers.ts).
import { MAX_PRINT_ATTEMPTS, PrintService } from '../dist/printing/print.service.js';
import { DEMO, enrollDevice, passwordLogin, pinLogin, startApp, testDb, userIdByName } from './helpers.js';

type Who = { token: string; device?: string };

let app: INestApplication;
let db: PrismaClient;
let manager: Who;
let waiter: Who;
let cashier: Who;
let kitchen: Who;
let managerId: string;
let device: string;
const products: Record<'fish' | 'beer' | 'stew' | 'soldOut', string> = {
  fish: '',
  beer: '',
  stew: '',
  soldOut: '',
};
const options: Record<'miondo' | 'fries' | 'hot', string> = { miondo: '', fries: '', hot: '' };

const http = () => request(app.getHttpServer());
const as = (who: Who, req: request.Test) => {
  req.set('authorization', `Bearer ${who.token}`);
  if (who.device) req.set('x-device-token', who.device);
  return req;
};
const tag = () => randomUUID().slice(0, 5);

/** Fausse imprimante réseau : garde les octets reçus. */
function fakePrinter(): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, received });
    }),
  );
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('Délai dépassé');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function newTable() {
  const { body: zone } = await as(manager, http().post('/api/floor/zones'))
    .send({ name: `Z${tag()}` })
    .expect(201);
  const { body: table } = await as(manager, http().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `T${tag()}` })
    .expect(201);
  return table as { id: string; label: string };
}

const send = (who: Who, tableId: string, lines: object[], key = randomUUID()) =>
  as(who, http().post('/api/orders/send')).send({ tableId, idempotencyKey: key, lines });

const fishLine = (extra: object = {}) => ({
  productId: products.fish,
  quantity: 2,
  modifierIds: [options.fries, options.hot],
  note: 'bien cuit',
  ...extra,
});

beforeAll(async () => {
  app = await startApp({ PRINT_POLL_MS: '0', PRINT_RETRY_BASE_MS: '0' });
  db = testDb();
  manager = { token: (await passwordLogin(app, DEMO.manager)).accessToken };
  const enrolled = await enrollDevice(app, 'Tablette commandes');
  device = enrolled.deviceToken;
  waiter = { token: (await pinLogin(app, device, DEMO.waiterPin)).accessToken, device };
  cashier = { token: (await pinLogin(app, device, DEMO.cashierPin)).accessToken, device };
  kitchen = { token: (await pinLogin(app, device, DEMO.kitchenPin)).accessToken, device };
  managerId = await userIdByName(app, device, 'Paul (gérant)');

  // Catalogue de test : un plat grillé avec options obligatoire/facultative, une bière, un plat cuisine.
  const { body: category } = await as(manager, http().post('/api/catalog/categories'))
    .send({ name: { fr: `Test ${tag()}` } })
    .expect(201);
  const { body: side } = await as(manager, http().post('/api/catalog/modifier-groups'))
    .send({
      name: { fr: 'Accompagnement' },
      minSelect: 1,
      maxSelect: 1,
      modifiers: [{ name: { fr: 'Miondo' } }, { name: { fr: 'Frites' }, priceDeltaXaf: 300 }],
    })
    .expect(201);
  const { body: chili } = await as(manager, http().post('/api/catalog/modifier-groups'))
    .send({
      name: { fr: 'Piment' },
      minSelect: 0,
      maxSelect: 1,
      modifiers: [{ name: { fr: 'Piment fort' } }],
    })
    .expect(201);
  // Options des groupes créés ici (la base de test garde ceux des lancements précédents).
  const { body: catalog } = await as(manager, http().get('/api/catalog')).expect(200);
  type Group = { id: string; modifiers: { id: string; name: { fr: string } }[] };
  const modifier = (groupId: string, name: string) =>
    catalog.modifierGroups
      .find((g: Group) => g.id === groupId)
      .modifiers.find((m: Group['modifiers'][number]) => m.name.fr === name).id as string;
  options.miondo = modifier(side.id, 'Miondo');
  options.fries = modifier(side.id, 'Frites');
  options.hot = modifier(chili.id, 'Piment fort');

  const create = async (name: string, priceXaf: number, station: string, modifierGroupIds: string[] = []) =>
    (
      await as(manager, http().post('/api/catalog/products'))
        .send({ categoryId: category.id, name: { fr: name }, priceXaf, station, modifierGroupIds })
        .expect(201)
    ).body.id as string;
  products.fish = await create('Poisson braisé', 4500, 'grill', [side.id, chili.id]);
  products.beer = await create('Castel 65 cl', 700, 'bar');
  products.stew = await create('Ndolé', 3500, 'kitchen');
  products.soldOut = await create('Poulet DG', 4000, 'kitchen');
  await as(kitchen, http().put(`/api/catalog/products/${products.soldOut}/availability`))
    .send({ available: false })
    .expect(200);
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

describe('envoi de commande', () => {
  it('ouvre la commande, fige les prix avec options et crée un bon par poste', async () => {
    const table = await newTable();
    const { body: order } = await send(waiter, table.id, [
      fishLine(),
      { productId: products.beer, quantity: 3 },
      { productId: products.stew, quantity: 1 },
    ]).expect(200);

    expect(order.status).toBe('open');
    expect(order.tableLabel).toBe(table.label);
    expect(order.waiterName).toBe('Joël');
    const fish = order.lines.find((l: { productId: string }) => l.productId === products.fish);
    expect(fish.unitPriceXaf).toBe(4800); // 4 500 + frites 300
    expect(fish.modifiers.map((m: { name: { fr: string } }) => m.name.fr)).toEqual(['Frites', 'Piment fort']);
    expect(fish.note).toBe('bien cuit');
    expect(order.total).toBe(4800 * 2 + 700 * 3 + 3500);

    const tickets = await db.kitchenTicket.findMany({ where: { orderId: order.id } });
    expect(tickets.map((t) => t.station).sort()).toEqual(['bar', 'grill', 'kitchen']);
    expect(new Set(tickets.map((t) => t.number)).size).toBe(3);
  });

  it('un renvoi avec la même clé ne crée pas de doublon', async () => {
    const table = await newTable();
    const key = randomUUID();
    const first = await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }], key).expect(200);
    const second = await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }], key).expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(await db.orderLine.count({ where: { orderId: first.body.id } })).toBe(1);
  });

  it('ajoute les envois suivants à la commande ouverte de la table', async () => {
    const table = await newTable();
    const first = await send(waiter, table.id, [{ productId: products.beer, quantity: 2 }]).expect(200);
    const second = await send(cashier, table.id, [{ productId: products.stew, quantity: 1 }]).expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.lines).toHaveLength(2);
    expect(second.body.waiterName).toBe('Joël'); // le serveur reste celui qui a ouvert la table
  });

  it('deux tablettes qui envoient en même temps pour une table libre partagent une seule commande', async () => {
    const table = await newTable();
    const [a, b] = await Promise.all([
      send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]),
      send(cashier, table.id, [{ productId: products.stew, quantity: 1 }]),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).toBe(b.body.id);
    expect(await db.order.count({ where: { tableId: table.id, status: 'open' } })).toBe(1);
  });

  it('refuse un accompagnement obligatoire manquant ou une option étrangère', async () => {
    const table = await newTable();
    const missing = await send(waiter, table.id, [fishLine({ modifierIds: [options.hot] })]).expect(400);
    expect(missing.body.code).toBe('INVALID_OPTIONS');
    const tooMany = await send(waiter, table.id, [
      fishLine({ modifierIds: [options.fries, options.miondo] }),
    ]).expect(400);
    expect(tooMany.body.code).toBe('INVALID_OPTIONS');
    const foreign = await send(waiter, table.id, [
      { productId: products.beer, quantity: 1, modifierIds: [options.hot] },
    ]).expect(400);
    expect(foreign.body.code).toBe('INVALID_OPTIONS');
    expect(await db.order.count({ where: { tableId: table.id } })).toBe(0);
  });

  it('refuse un produit épuisé', async () => {
    const table = await newTable();
    const res = await send(waiter, table.id, [{ productId: products.soldOut, quantity: 1 }]).expect(409);
    expect(res.body.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('la cuisine ne prend pas de commande', async () => {
    const table = await newTable();
    await send(kitchen, table.id, [{ productId: products.beer, quantity: 1 }]).expect(403);
  });
});

describe('écran de préparation', () => {
  it('filtre par poste et fait avancer le bon jusqu’au service', async () => {
    const table = await newTable();
    const { body: order } = await send(waiter, table.id, [
      fishLine({ modifierIds: [options.miondo] }),
      { productId: products.beer, quantity: 1 },
    ]).expect(200);

    const { body: grill } = await as(kitchen, http().get('/api/tickets?station=grill')).expect(200);
    const ticket = grill.find((t: { orderId: string }) => t.orderId === order.id);
    expect(ticket.station).toBe('grill');
    expect(ticket.tableLabel).toBe(table.label);
    expect(ticket.lines[0].modifiers.map((m: { fr: string }) => m.fr)).toEqual(['Miondo']);
    const { body: bar } = await as(kitchen, http().get('/api/tickets?station=bar')).expect(200);
    expect(bar.some((t: { id: string }) => t.id === ticket.id)).toBe(false);

    await as(kitchen, http().post(`/api/tickets/${ticket.id}/status`))
      .send({ status: 'preparing' })
      .expect(200);
    await as(kitchen, http().post(`/api/tickets/${ticket.id}/status`))
      .send({ status: 'ready' })
      .expect(200);
    const back = await as(kitchen, http().post(`/api/tickets/${ticket.id}/status`))
      .send({ status: 'preparing' })
      .expect(409);
    expect(back.body.code).toBe('INVALID_TRANSITION');

    const { body: open } = await as(waiter, http().get('/api/orders/open')).expect(200);
    expect(open.find((o: { id: string }) => o.id === order.id).readyCount).toBe(1);

    await as(waiter, http().post(`/api/tickets/${ticket.id}/status`))
      .send({ status: 'served' })
      .expect(200);
    const { body: after } = await as(waiter, http().get(`/api/orders/${order.id}`)).expect(200);
    expect(after.lines.find((l: { station: string }) => l.station === 'grill').status).toBe('served');
    const { body: active } = await as(kitchen, http().get('/api/tickets')).expect(200);
    expect(active.some((t: { id: string }) => t.id === ticket.id)).toBe(false);
  });

  it('un bon d’un jour passé reste affiché tant que la table est ouverte, puis disparaît', async () => {
    const table = await newTable();
    const { body: order } = await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]).expect(
      200,
    );
    const ticket = await db.kitchenTicket.findFirstOrThrow({ where: { orderId: order.id } });
    // Bon oublié d'une journée précédente (date éloignée : pas de conflit de numéro).
    const past = new Date(Date.UTC(2001, 0, 1 + Math.floor(Math.random() * 3000)));
    await db.kitchenTicket.update({ where: { id: ticket.id }, data: { businessDay: past } });
    const shown = async () => {
      const { body } = await as(kitchen, http().get('/api/tickets')).expect(200);
      return body.some((t: { id: string }) => t.id === ticket.id) as boolean;
    };
    expect(await shown()).toBe(true);
    await db.order.update({ where: { id: order.id }, data: { status: 'billed' } });
    expect(await shown()).toBe(false);
  });

  it('un caissier ne fait pas avancer les bons', async () => {
    const table = await newTable();
    const { body: order } = await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]).expect(
      200,
    );
    const ticket = await db.kitchenTicket.findFirstOrThrow({ where: { orderId: order.id } });
    await as(cashier, http().post(`/api/tickets/${ticket.id}/status`))
      .send({ status: 'ready' })
      .expect(403);
  });
});

describe('annulation', () => {
  it('exige le PIN d’un gérant pour un serveur, et trace l’approbateur', async () => {
    const table = await newTable();
    const { body: order } = await send(waiter, table.id, [
      { productId: products.beer, quantity: 2 },
      { productId: products.stew, quantity: 1 },
    ]).expect(200);
    const line = order.lines[0];
    const url = `/api/orders/${order.id}/lines/${line.id}/cancel`;

    const noApproval = await as(waiter, http().post(url)).send({ reason: 'Erreur de saisie' }).expect(403);
    expect(noApproval.body.code).toBe('APPROVAL_REQUIRED');
    const wrongPin = await as(waiter, http().post(url))
      .send({ reason: 'Erreur de saisie', approval: { userId: managerId, pin: '0000' } })
      .expect(403);
    expect(wrongPin.body.code).toBe('APPROVAL_INVALID');
    const waiterId = await userIdByName(app, device, 'Joël');
    await as(waiter, http().post(url))
      .send({ reason: 'Erreur de saisie', approval: { userId: waiterId, pin: DEMO.waiterPin.pin } })
      .expect(403);

    const { body: after } = await as(waiter, http().post(url))
      .send({ reason: 'Erreur de saisie', approval: { userId: managerId, pin: DEMO.manager.pin } })
      .expect(200);
    expect(after.lines.find((l: { id: string }) => l.id === line.id).status).toBe('cancelled');
    expect(after.total).toBe(3500);

    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: line.id, action: 'order.line_cancelled' },
    });
    expect(log.approverId).toBe(managerId);
    expect(log.reason).toBe('Erreur de saisie');
    await db.user.update({ where: { id: managerId }, data: { pinFailedCount: 0 } });
  });

  it('libère la table quand toutes les lignes sont annulées', async () => {
    const table = await newTable();
    const { body: order } = await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]).expect(
      200,
    );
    await as(manager, http().post(`/api/orders/${order.id}/lines/${order.lines[0].id}/cancel`))
      .send({ reason: 'Client parti' })
      .expect(200);
    const closed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed.status).toBe('cancelled');
    const { body: open } = await as(waiter, http().get('/api/orders/open')).expect(200);
    expect(open.some((o: { id: string }) => o.id === order.id)).toBe(false);
    // La table peut de nouveau recevoir une commande, et être retirée du plan.
    await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]).expect(200);
  });

  it('refuse le retrait d’une table qui a une commande ouverte', async () => {
    const table = await newTable();
    await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]).expect(200);
    const res = await as(manager, http().post(`/api/floor/tables/${table.id}/archive`)).expect(409);
    expect(res.body.code).toBe('TABLE_HAS_OPEN_ORDER');
  });
});

describe('changement de table', () => {
  it('déplace la commande vers une table libre, pas vers une table occupée', async () => {
    const [a, b, c] = [await newTable(), await newTable(), await newTable()];
    const { body: order } = await send(waiter, a.id, [{ productId: products.beer, quantity: 1 }]).expect(200);
    await send(waiter, b.id, [{ productId: products.beer, quantity: 1 }]).expect(200);

    const occupied = await as(waiter, http().post(`/api/orders/${order.id}/transfer`))
      .send({ tableId: b.id, version: order.version })
      .expect(409);
    expect(occupied.body.code).toBe('TABLE_OCCUPIED');

    const { body: moved } = await as(waiter, http().post(`/api/orders/${order.id}/transfer`))
      .send({ tableId: c.id, version: order.version })
      .expect(200);
    expect(moved.tableLabel).toBe(c.label);
    const stale = await as(waiter, http().post(`/api/orders/${order.id}/transfer`))
      .send({ tableId: a.id, version: order.version })
      .expect(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });
});

describe('impression des bons', () => {
  it('imprime le bon du grill en ESC/POS avec les accents', async () => {
    const printer = await fakePrinter();
    const { body: created } = await as(manager, http().post('/api/printers'))
      .send({ name: `Grill ${tag()}`, host: '127.0.0.1', port: printer.port, role: 'grill' })
      .expect(201);
    try {
      const table = await newTable();
      await send(waiter, table.id, [fishLine()]).expect(200);
      const bytes = await waitFor(async () => printer.received.find((b) => b.includes(Buffer.from('GRILL'))));
      const textOut = iconv.decode(bytes, 'cp858');
      expect(textOut).toContain(`Table ${table.label}`);
      expect(textOut).toContain('2 x Poisson braisé');
      expect(textOut).toContain('- Frites');
      expect(textOut).toContain('! bien cuit');
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40])); // initialisation
    } finally {
      await as(manager, http().post(`/api/printers/${created.id}/archive`)).expect(204);
      printer.server.close();
    }
  });

  it('longue commande mixte : cuisine, grill et bar impriment seuls, chacun ses lignes', async () => {
    // Comme la carte du site : les brochettes sont rangées dans Plats mais partent au grill.
    const { body: dishes } = await as(manager, http().post('/api/catalog/categories'))
      .send({ name: { fr: `Plats ${tag()}` }, vipSurchargeXaf: 500 })
      .expect(201);
    const create = async (name: string, priceXaf: number, station: string, extra: object = {}) =>
      (
        await as(manager, http().post('/api/catalog/products'))
          .send({ categoryId: dishes.id, name: { fr: name }, priceXaf, station, ...extra })
          .expect(201)
      ).body.id as string;
    const chicken = await create('1/4 poulet rôti frites', 2500, 'kitchen');
    const pork = await create('Brochette de porc', 200, 'grill', { vipSurchargeXaf: 100 });
    const beef = await create('Brochette de viande', 200, 'grill', { vipSurchargeXaf: 100 });
    const juice = await create('Djino', 1000, 'bar');

    const printers = { kitchen: await fakePrinter(), grill: await fakePrinter(), bar: await fakePrinter() };
    const ids: string[] = [];
    for (const [role, printer] of Object.entries(printers)) {
      const { body } = await as(manager, http().post('/api/printers'))
        .send({ name: `${role} ${tag()}`, host: '127.0.0.1', port: printer.port, role })
        .expect(201);
      ids.push(body.id);
    }
    try {
      const table = await newTable();
      const { body: order } = await send(waiter, table.id, [
        { productId: products.stew, quantity: 3 },
        { productId: products.beer, quantity: 6 },
        { productId: pork, quantity: 10, note: 'bien pimenté' },
        { productId: chicken, quantity: 2 },
        { productId: juice, quantity: 4 },
        fishLine(),
        { productId: beef, quantity: 8 },
        { productId: products.stew, quantity: 1, note: 'sans piment' },
        { productId: products.beer, quantity: 2 },
        { productId: chicken, quantity: 1 },
        { productId: pork, quantity: 5 },
        { productId: juice, quantity: 2 },
      ]).expect(200);
      expect(order.lines).toHaveLength(12);

      // Aucune relance manuelle : l'envoi déclenche l'impression.
      const ticket = async (printer: { received: Buffer[] }) =>
        iconv.decode(await waitFor(async () => printer.received[0]), 'cp858');
      const kitchenTicket = await ticket(printers.kitchen);
      const grillTicket = await ticket(printers.grill);
      const barTicket = await ticket(printers.bar);

      expect(kitchenTicket).toContain('CUISINE');
      expect(kitchenTicket).toContain(`Table ${table.label}`);
      expect(kitchenTicket).toContain('3 x Ndolé');
      expect(kitchenTicket).toContain('1 x Ndolé');
      expect(kitchenTicket).toContain('! sans piment');
      expect(kitchenTicket).toContain('2 x 1/4 poulet rôti frites');
      for (const other of ['Brochette', 'Poisson', 'Castel', 'Djino'])
        expect(kitchenTicket).not.toContain(other);

      expect(grillTicket).toContain('GRILL');
      expect(grillTicket).toContain('10 x Brochette de porc');
      expect(grillTicket).toContain('! bien pimenté');
      expect(grillTicket).toContain('5 x Brochette de porc');
      expect(grillTicket).toContain('8 x Brochette de viande');
      expect(grillTicket).toContain('2 x Poisson braisé');
      for (const other of ['Ndolé', 'poulet', 'Castel', 'Djino']) expect(grillTicket).not.toContain(other);

      expect(barTicket).toContain('BAR');
      expect(barTicket).toContain('6 x Castel 65 cl');
      expect(barTicket).toContain('2 x Castel 65 cl');
      expect(barTicket).toContain('4 x Djino');
      for (const other of ['Ndolé', 'Brochette', 'Poisson', 'poulet']) expect(barTicket).not.toContain(other);

      const jobs = await waitFor(async () => {
        const found = await db.printJob.findMany({ where: { printerId: { in: ids } } });
        return found.length === 3 && found.every((j) => j.status === 'printed') ? found : null;
      });
      expect(jobs).toHaveLength(3);

      // Ajout à la commande : seul le poste concerné reçoit un nouveau bon, avec les seules lignes ajoutées.
      await send(waiter, table.id, [{ productId: products.beer, quantity: 3 }]).expect(200);
      const extra = iconv.decode(await waitFor(async () => printers.bar.received[1]), 'cp858');
      expect(extra).toContain('3 x Castel 65 cl');
      expect(extra).not.toContain('Djino');
      await new Promise((r) => setTimeout(r, 300));
      expect(printers.kitchen.received).toHaveLength(1);
      expect(printers.grill.received).toHaveLength(1);
    } finally {
      for (const id of ids) await as(manager, http().post(`/api/printers/${id}/archive`)).expect(204);
      for (const printer of Object.values(printers)) printer.server.close();
    }
  });

  it('réessaie puis signale l’échec quand l’imprimante ne répond pas', async () => {
    const dead = await fakePrinter();
    const port = dead.port;
    await new Promise((r) => dead.server.close(r)); // port fermé : connexion refusée
    const { body: printer } = await as(manager, http().post('/api/printers'))
      .send({ name: `Bar HS ${tag()}`, host: '127.0.0.1', port, role: 'bar' })
      .expect(201);
    try {
      const table = await newTable();
      await send(waiter, table.id, [{ productId: products.beer, quantity: 1 }]).expect(200);
      // PRINT_POLL_MS=0 dans les tests : on fait tourner la file comme le ferait le minuteur.
      // Un passage peut déjà être en cours (lancé par l'envoi) : on insiste jusqu'à l'échec définitif.
      const queue = app.get(PrintService);
      const job = await waitFor(async () => {
        await queue.processDue();
        const found = await db.printJob.findFirst({ where: { printerId: printer.id } });
        return found?.status === 'failed' ? found : null;
      });
      expect(job.attempts).toBe(MAX_PRINT_ATTEMPTS);
      expect(job.lastError).toBeTruthy();
      const { body } = await as(manager, http().get('/api/printers')).expect(200);
      expect(body.failedJobs.some((j: { id: string }) => j.id === job.id)).toBe(true);

      // Relance manuelle depuis l'écran Imprimantes : nouvelle tentative immédiate, de nouveau en attente.
      const { body: retried } = await as(manager, http().post(`/api/printers/jobs/${job.id}/retry`)).expect(
        202,
      );
      expect(retried.status).toBe('pending');
      expect(retried.lastError).toBeTruthy();
    } finally {
      await as(manager, http().post(`/api/printers/${printer.id}/archive`)).expect(204);
    }
  });

  it('seul le gérant configure les imprimantes', async () => {
    await as(waiter, http().get('/api/printers')).expect(403);
    await as(kitchen, http().post('/api/printers'))
      .send({ name: 'X', host: '1.2.3.4', role: 'bar' })
      .expect(403);
  });
});

describe('temps réel', () => {
  it('prévient les écrans connectés quand une commande part en préparation', async () => {
    const server = app.getHttpServer();
    if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/api/socket.io',
      transports: ['websocket'],
      auth: { token: kitchen.token, deviceToken: device },
    });
    try {
      await waitFor(async () => socket.connected);
      const received: { type: string }[] = [];
      socket.on('change', (e: { type: string }) => received.push(e));
      const table = await newTable();
      await send(waiter, table.id, [{ productId: products.stew, quantity: 1 }]).expect(200);
      await waitFor(async () => received.some((e) => e.type === 'tickets.changed'));
      expect(received.some((e) => e.type === 'orders.changed')).toBe(true);
    } finally {
      socket.close();
    }
  });

  it('refuse une connexion sans jeton valide', async () => {
    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/api/socket.io',
      transports: ['websocket'],
      auth: { token: 'faux' },
    });
    try {
      const disconnected = await new Promise<boolean>((resolve) => {
        socket.on('disconnect', () => resolve(true));
        setTimeout(() => resolve(!socket.connected), 2_000);
      });
      expect(disconnected).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe('approbateurs', () => {
  it('liste les gérants qui ont un PIN, sans l’utilisateur courant', async () => {
    const { body } = await as(waiter, http().get('/api/orders/approvers')).expect(200);
    const names = body.map((u: { displayName: string }) => u.displayName);
    expect(names).toContain('Paul (gérant)');
    expect(names).not.toContain('Joël');
    await as(kitchen, http().get('/api/orders/approvers')).expect(403);
  });
});
