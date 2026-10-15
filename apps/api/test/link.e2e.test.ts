import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newOpaqueToken, sha256 } from '../dist/common/crypto.js';
import { SiteLinkGateway } from '../dist/link/site-link.gateway.js';
import { DEMO, DEMO_SITE_ID, passwordLogin, startApp, testDb, UNSET } from './helpers.js';

/**
 * Deux instances réelles de l'API : un « cloud » (API_MODE=cloud) et un serveur local relié au cloud
 * par sa connexion sortante. Les deux partagent la base de test, chacune utilise ses propres tables.
 */
let cloud: INestApplication;
let site: INestApplication | null;
let db: PrismaClient;
let cloudUrl: string;
let manager: string;
const secret = newOpaqueToken();
const product = { beer: '', photo: '' };

const cloudHttp = () => request(cloud.getHttpServer());
const siteHttp = () => request(site!.getHttpServer());
const asManager = (req: request.Test) => req.set('authorization', `Bearer ${manager}`);
const tag = () => randomUUID().slice(0, 5);

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('Délai dépassé');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const startSite = () =>
  startApp({
    CLOUD_URL: cloudUrl,
    SITE_LINK_SECRET: secret,
    LINK_SNAPSHOT_MS: '200',
    PRINT_POLL_MS: '0',
    MEDIA_DIR: join(tmpdir(), 'tchop-test-media-site'),
  });

/** Nouvelle table sur le site, et attente de son aiguillage dans le cloud. */
async function newTable() {
  const { body: zone } = await asManager(siteHttp().post('/api/floor/zones'))
    .send({ name: `L${tag()}` })
    .expect(201);
  const { body: table } = await asManager(siteHttp().post('/api/floor/tables'))
    .send({ zoneId: zone.id, label: `L${tag()}` })
    .expect(201);
  const { body } = await asManager(siteHttp().get('/api/floor/qr-codes')).expect(200);
  const token: string = body.codes
    .find((c: { tableId: string }) => c.tableId === table.id)
    .url.split('/q/')[1];
  await waitFor(() => db.cloudQrRoute.findUnique({ where: { tokenHash: sha256(token) } }));
  return { id: table.id as string, label: table.label as string, token };
}

/** Connexion d'un faux serveur local (pour les tests d'authentification). */
function rawLink(siteId: string, linkSecret: string): Socket {
  return io(`${cloudUrl}/site-link`, {
    path: '/api/socket.io',
    transports: ['websocket'],
    auth: { siteId, secret: linkSecret },
    reconnection: false,
  });
}

beforeAll(async () => {
  db = testDb();
  cloud = await startApp({
    API_MODE: 'cloud',
    SITE_ID: UNSET,
    MEDIA_DIR: join(tmpdir(), `tchop-test-media-cloud-${tag()}`),
  });
  await cloud.listen(0, '127.0.0.1');
  const address = cloud.getHttpServer().address();
  cloudUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await db.siteLink.upsert({
    where: { siteId: DEMO_SITE_ID },
    create: { siteId: DEMO_SITE_ID, name: 'TCHOP LIFE', secretHash: sha256(secret) },
    update: { secretHash: sha256(secret), revokedAt: null },
  });
  site = await startSite();
  manager = (await passwordLogin(site, DEMO.manager)).accessToken;
  await waitFor(() => db.cloudMenuSnapshot.findUnique({ where: { siteId: DEMO_SITE_ID } }));

  const { body: category } = await asManager(siteHttp().post('/api/catalog/categories'))
    .send({ name: { fr: `Cloud ${tag()}` } })
    .expect(201);
  const create = async (name: string) =>
    (
      await asManager(siteHttp().post('/api/catalog/products'))
        .send({ categoryId: category.id, name: { fr: name }, priceXaf: 700, station: 'bar' })
        .expect(201)
    ).body.id as string;
  product.beer = await create('Castel cloud');
  product.photo = await create('Produit avec photo');
}, 60_000);

afterAll(async () => {
  await db.siteLink
    .update({ where: { siteId: DEMO_SITE_ID }, data: { revokedAt: null } })
    .catch(() => undefined);
  await site?.close();
  await cloud?.close();
  await db?.$disconnect();
});

describe('menu servi par le cloud', () => {
  it('sert le menu du site, sans donnée interne, commande ouverte quand le site est relié', async () => {
    const table = await newTable();
    const { body } = await waitFor(async () => {
      const res = await cloudHttp().get(`/api/public/menu/${table.token}`);
      return res.status === 200 && res.body.products.some((p: { id: string }) => p.id === product.beer)
        ? res
        : null;
    });
    expect(body.site.name).toBe('TCHOP LIFE');
    expect(body.table.label).toBe(table.label);
    expect(body.ordering).toBe(true);
    const raw = JSON.stringify(body);
    for (const secretWord of ['token', 'version', 'taxRateBp', 'tenant', 'waiter', 'siteId']) {
      expect(raw).not.toContain(secretWord);
    }
  });

  it('ne garde que l’empreinte des jetons QR', async () => {
    const table = await newTable();
    expect(await db.cloudQrRoute.count({ where: { tokenHash: table.token } })).toBe(0);
    expect(await db.cloudQrRoute.count({ where: { tokenHash: sha256(table.token) } })).toBe(1);
  });

  it('répond 404 pour un jeton invalide ou inconnu', async () => {
    const a = await cloudHttp().get('/api/public/menu/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    const b = await cloudHttp().get('/api/public/menu/..%2Fx').expect(404);
    expect(a.body).toEqual(b.body);
  });

  it('le serveur local signale son lien avec le cloud', async () => {
    const { body } = await siteHttp().get('/api/health').expect(200);
    expect(body.cloud).toBe('connected');
  });
});

describe('commande relayée', () => {
  it('la commande passe par le cloud, se valide sur le site, et le client suit l’avancement', async () => {
    const table = await newTable();
    const client = request.agent(cloud.getHttpServer());
    const { body: submitted, headers } = await client
      .post(`/api/public/menu/${table.token}/orders`)
      .send({
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.beer, quantity: 2, unitPriceXaf: 1 }],
      })
      .expect(201);
    expect(String(headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(submitted.status).toBe('pending');
    expect(submitted.totalXaf).toBe(1400); // prix recalculé par le site

    const { body: pending } = await asManager(siteHttp().get('/api/qr-requests')).expect(200);
    expect(pending.some((r: { id: string }) => r.id === submitted.id)).toBe(true);
    await asManager(siteHttp().post(`/api/qr-requests/${submitted.id}/accept`)).expect(200);

    const { body: mine } = await client.get(`/api/public/menu/${table.token}/orders`).expect(200);
    expect(mine[0].status).toBe('accepted');
    const { body: others } = await request(cloud.getHttpServer())
      .get(`/api/public/menu/${table.token}/orders`)
      .expect(200);
    expect(others).toEqual([]);
  });

  it('les règles du site s’appliquent telles quelles (produit masqué, plafond)', async () => {
    const table = await newTable();
    await request(cloud.getHttpServer())
      .post(`/api/public/menu/${table.token}/orders`)
      .send({ idempotencyKey: randomUUID(), lines: [{ productId: randomUUID(), quantity: 1 }] })
      .expect(404);
    await request(cloud.getHttpServer())
      .post(`/api/public/menu/${table.token}/orders`)
      .send({ idempotencyKey: randomUUID(), lines: [{ productId: product.beer, quantity: 31 }] })
      .expect(400);
  });
});

describe('photos relayées', () => {
  it('le cloud récupère la photo auprès du site, puis la garde en cache', async () => {
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#d9480f' } })
      .png()
      .toBuffer();
    const { body } = await asManager(siteHttp().post(`/api/catalog/products/${product.photo}/image`))
      .attach('image', png, 'photo.png')
      .expect(201);
    const name = (body.imageUrl as string).split('/').pop()!;
    await waitFor(() => db.cloudMediaRoute.findUnique({ where: { name } }));
    const image = await cloudHttp().get(body.imageUrl).buffer(true).expect(200);
    expect(image.headers['content-type']).toMatch(/image\/webp/);
    expect((image.body as Buffer).subarray(8, 12).toString('ascii')).toBe('WEBP');
    await cloudHttp().get('/api/media/00000000-0000-0000-0000-000000000000.webp').expect(404);
  });
});

describe('sécurité du lien', () => {
  it('refuse un site inconnu ou un mauvais secret', async () => {
    const bad = rawLink(DEMO_SITE_ID, newOpaqueToken());
    const unknown = rawLink(randomUUID(), secret);
    try {
      for (const socket of [bad, unknown]) {
        const kicked = await new Promise<boolean>((resolve) => {
          socket.on('disconnect', () => resolve(true));
          socket.on('connect_error', () => resolve(true));
          setTimeout(() => resolve(false), 3_000);
        });
        expect(kicked).toBe(true);
      }
    } finally {
      bad.close();
      unknown.close();
    }
  });

  it('un autre site ne peut ni détourner un QR code, ni envoyer une copie invalide', async () => {
    const table = await newTable();
    const otherId = randomUUID();
    const otherSecret = newOpaqueToken();
    await db.siteLink.create({
      data: { siteId: otherId, name: 'Autre site', secretHash: sha256(otherSecret) },
    });
    const other = rawLink(otherId, otherSecret);
    try {
      await waitFor(async () => other.connected);
      const snapshot = {
        menu: { site: { name: 'Pirate' }, categories: [], products: [], modifierGroups: [] },
        routes: [{ tokenHash: sha256(table.token), tableLabel: 'X', mode: 'order' }],
        media: [],
      };
      const ack = await other.timeout(3_000).emitWithAck('snapshot', snapshot);
      expect(ack.ok).toBe(true);
      const route = await db.cloudQrRoute.findUniqueOrThrow({ where: { tokenHash: sha256(table.token) } });
      expect(route.siteId).toBe(DEMO_SITE_ID);

      const invalid = await other
        .timeout(3_000)
        .emitWithAck('snapshot', { menu: { site: 'x' }, routes: 'all' });
      expect(invalid.ok).toBe(false);
    } finally {
      other.close();
      await db.cloudMenuSnapshot.deleteMany({ where: { siteId: otherId } });
      await db.siteLink.delete({ where: { siteId: otherId } });
    }
  });
});

describe('site hors ligne', () => {
  it('le menu reste consultable, la commande est suspendue', async () => {
    const table = await newTable();
    await site!.close();
    site = null;
    const { body } = await waitFor(async () => {
      const res = await cloudHttp().get(`/api/public/menu/${table.token}`);
      return res.status === 200 && res.body.ordering === false ? res : null;
    });
    expect(body.table.label).toBe(table.label);
    expect(body.orderingPaused).toBe(true);
    const res = await request(cloud.getHttpServer())
      .post(`/api/public/menu/${table.token}/orders`)
      .send({ idempotencyKey: randomUUID(), lines: [{ productId: product.beer, quantity: 1 }] })
      .expect(503);
    expect(res.body.code).toBe('SITE_OFFLINE');
  });

  it('un site révoqué n’est plus servi', async () => {
    site = await startSite();
    const table = await waitFor(async () => {
      const route = await db.cloudQrRoute.findFirst({ where: { siteId: DEMO_SITE_ID } });
      return route ?? null;
    });
    expect(table.siteId).toBe(DEMO_SITE_ID);
    const gateway = cloud.get(SiteLinkGateway);
    await waitFor(async () => gateway.isConnected(DEMO_SITE_ID));
    await db.siteLink.update({ where: { siteId: DEMO_SITE_ID }, data: { revokedAt: new Date() } });
    // La connexion en cours est coupée à la revérification, et les reconnexions sont refusées.
    await gateway.recheckLinks();
    expect(gateway.isConnected(DEMO_SITE_ID)).toBe(false);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(gateway.isConnected(DEMO_SITE_ID)).toBe(false);
    const { body } = await asManager(request(site.getHttpServer()).get('/api/floor/qr-codes')).expect(200);
    const token: string = body.codes[0].url.split('/q/')[1];
    await cloudHttp().get(`/api/public/menu/${token}`).expect(404);
  });
});
