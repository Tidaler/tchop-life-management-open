import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, enrollDevice, passwordLogin, pinLogin, startApp, testDb } from './helpers.js';

let app: INestApplication;
let db: PrismaClient;
let manager: string;
let waiter: { token: string; device: string };
let kitchen: { token: string; device: string };

const http = () => request(app.getHttpServer());
const asManager = (req: request.Test) => req.set('authorization', `Bearer ${manager}`);
const as = (who: { token: string; device: string }, req: request.Test) =>
  req.set('authorization', `Bearer ${who.token}`).set('x-device-token', who.device);
/** Suffixe unique : la base de test est conservée d'un lancement à l'autre. */
const tag = () => randomUUID().slice(0, 6);

beforeAll(async () => {
  app = await startApp();
  db = testDb();
  manager = (await passwordLogin(app, DEMO.manager)).accessToken;
  const { deviceToken } = await enrollDevice(app, 'Tablette catalogue');
  waiter = { token: (await pinLogin(app, deviceToken, DEMO.waiterPin)).accessToken, device: deviceToken };
  kitchen = { token: (await pinLogin(app, deviceToken, DEMO.kitchenPin)).accessToken, device: deviceToken };
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

async function createCategory(name = `Catégorie ${tag()}`) {
  const { body } = await asManager(http().post('/api/catalog/categories'))
    .send({ name: { fr: name, en: name } })
    .expect(201);
  return body as { id: string; version: number };
}

async function createProduct(categoryId: string, extra: Record<string, unknown> = {}) {
  const { body } = await asManager(http().post('/api/catalog/products'))
    .send({ categoryId, name: { fr: `Produit ${tag()}` }, priceXaf: 2500, station: 'grill', ...extra })
    .expect(201);
  return body as { id: string; version: number; priceXaf: number; imageUrl: string | null };
}

describe('catalogue', () => {
  it('se lit par tout le personnel, se modifie par le gérant seulement', async () => {
    const { body } = await as(waiter, http().get('/api/catalog')).expect(200);
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.products.length).toBeGreaterThan(0);

    await as(waiter, http().post('/api/catalog/categories'))
      .send({ name: { fr: 'Interdit' } })
      .expect(403);
  });

  it('crée un produit avec ses groupes d’options', async () => {
    const category = await createCategory();
    const { body: group } = await asManager(http().post('/api/catalog/modifier-groups'))
      .send({
        name: { fr: 'Cuisson', en: 'Cooking' },
        minSelect: 1,
        maxSelect: 1,
        modifiers: [{ name: { fr: 'Saignant' } }, { name: { fr: 'Bien cuit' }, priceDeltaXaf: 0 }],
      })
      .expect(201);
    const product = await createProduct(category.id, { modifierGroupIds: [group.id] });

    const { body } = await asManager(http().get('/api/catalog')).expect(200);
    const found = body.products.find((p: { id: string }) => p.id === product.id);
    expect(found.modifierGroupIds).toEqual([group.id]);
    const foundGroup = body.modifierGroups.find((g: { id: string }) => g.id === group.id);
    expect(foundGroup.modifiers).toHaveLength(2);
    expect(found.name.en).toBe(''); // l'anglais vide retombe sur le français à l'affichage
  });

  it('refuse une modification faite sur une version périmée', async () => {
    const category = await createCategory();
    await asManager(http().patch(`/api/catalog/categories/${category.id}`))
      .send({ version: category.version, visibleOnQr: false })
      .expect(200);
    const stale = await asManager(http().patch(`/api/catalog/categories/${category.id}`))
      .send({ version: category.version, sortOrder: 3 })
      .expect(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('trace chaque changement de prix', async () => {
    const product = await createProduct((await createCategory()).id);
    const { body } = await asManager(http().patch(`/api/catalog/products/${product.id}`))
      .send({ version: product.version, priceXaf: 3000 })
      .expect(200);
    expect(body.priceXaf).toBe(3000);
    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: product.id, action: 'catalog.price_changed' },
    });
    expect(log.before).toEqual({ priceXaf: 2500 });
    expect(log.after).toEqual({ priceXaf: 3000 });
  });

  it('exige la permission price.edit pour changer un prix', async () => {
    const product = await createProduct((await createCategory()).id);
    const managerRole = await db.role.findFirstOrThrow({ where: { code: 'manager' } });
    await db.rolePermission.delete({
      where: { roleId_permission: { roleId: managerRole.id, permission: 'price.edit' } },
    });
    try {
      const res = await asManager(http().patch(`/api/catalog/products/${product.id}`))
        .send({ version: product.version, priceXaf: 9999 })
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      // Le reste de la fiche reste modifiable.
      await asManager(http().patch(`/api/catalog/products/${product.id}`))
        .send({ version: product.version, sortOrder: 2 })
        .expect(200);
    } finally {
      await db.rolePermission.create({
        data: { roleId: managerRole.id, permission: 'price.edit', level: 'full' },
      });
    }
  });

  it('la cuisine marque un produit épuisé mais ne peut pas le modifier', async () => {
    const product = await createProduct((await createCategory()).id);
    await as(kitchen, http().put(`/api/catalog/products/${product.id}/availability`))
      .send({ available: false })
      .expect(200);
    const { body } = await as(waiter, http().get('/api/catalog')).expect(200);
    expect(body.products.find((p: { id: string }) => p.id === product.id).available).toBe(false);

    await as(kitchen, http().patch(`/api/catalog/products/${product.id}`))
      .send({ version: product.version + 1, sortOrder: 1 })
      .expect(403);
    await as(waiter, http().put(`/api/catalog/products/${product.id}/availability`))
      .send({ available: true })
      .expect(403);
  });

  it("n'archive pas une catégorie qui contient des produits", async () => {
    const category = await createCategory();
    const product = await createProduct(category.id);
    const res = await asManager(http().post(`/api/catalog/categories/${category.id}/archive`)).expect(400);
    expect(res.body.code).toBe('CATEGORY_NOT_EMPTY');

    await asManager(http().post(`/api/catalog/products/${product.id}/archive`)).expect(204);
    await asManager(http().post(`/api/catalog/categories/${category.id}/archive`)).expect(204);
    const { body } = await asManager(http().get('/api/catalog')).expect(200);
    expect(body.categories.some((c: { id: string }) => c.id === category.id)).toBe(false);
  });

  it('remplace la liste des options : modifiées, ajoutées, retirées', async () => {
    const { body: group } = await asManager(http().post('/api/catalog/modifier-groups'))
      .send({
        name: { fr: 'Sauce' },
        minSelect: 0,
        maxSelect: 2,
        modifiers: [{ name: { fr: 'Arachide' } }, { name: { fr: 'Tomate' } }],
      })
      .expect(201);
    const { body: catalog } = await asManager(http().get('/api/catalog')).expect(200);
    const [peanut] = catalog.modifierGroups.find((g: { id: string }) => g.id === group.id).modifiers;

    await asManager(http().patch(`/api/catalog/modifier-groups/${group.id}`))
      .send({
        version: group.version,
        name: { fr: 'Sauce' },
        minSelect: 0,
        maxSelect: 2,
        modifiers: [
          { id: peanut.id, name: { fr: 'Arachide maison' } },
          { name: { fr: 'Piment vert' }, priceDeltaXaf: 200 },
        ],
      })
      .expect(200);
    const { body: after } = await asManager(http().get('/api/catalog')).expect(200);
    const names = after.modifierGroups
      .find((g: { id: string }) => g.id === group.id)
      .modifiers.map((m: { name: { fr: string } }) => m.name.fr);
    expect(names).toEqual(['Arachide maison', 'Piment vert']);
  });

  it('refuse un groupe d’options incohérent', async () => {
    const res = await asManager(http().post('/api/catalog/modifier-groups'))
      .send({ name: { fr: 'X' }, minSelect: 3, maxSelect: 1, modifiers: [{ name: { fr: 'A' } }] })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('photos des produits', () => {
  const png = () =>
    sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#d9480f' } })
      .png()
      .toBuffer();

  it('réencode la photo en WebP réduit et la sert publiquement', async () => {
    const product = await createProduct((await createCategory()).id);
    const { body } = await asManager(http().post(`/api/catalog/products/${product.id}/image`))
      .attach('image', await png(), 'photo.png')
      .expect(201);
    expect(body.imageUrl).toMatch(/^\/api\/media\/[0-9a-f-]{36}\.webp$/);

    const image = await http().get(body.imageUrl).buffer(true).expect(200);
    expect(image.headers['content-type']).toMatch(/image\/webp/);
    const meta = await sharp(image.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(800);
  });

  it("supprime l'ancienne photo quand on la remplace", async () => {
    const product = await createProduct((await createCategory()).id);
    const first = await asManager(http().post(`/api/catalog/products/${product.id}/image`))
      .attach('image', await png(), 'a.png')
      .expect(201);
    await asManager(http().post(`/api/catalog/products/${product.id}/image`))
      .attach('image', await png(), 'b.png')
      .expect(201);
    await http().get(first.body.imageUrl).expect(404);
  });

  it('refuse un fichier qui n’est pas une image', async () => {
    const product = await createProduct((await createCategory()).id);
    const res = await asManager(http().post(`/api/catalog/products/${product.id}/image`))
      .attach('image', Buffer.from('ceci n’est pas une image'), 'faux.png')
      .expect(400);
    expect(res.body.code).toBe('INVALID_IMAGE');
  });

  it('ne sert pas un chemin arbitraire', async () => {
    await http().get('/api/media/..%2F..%2Fpackage.json').expect(404);
  });
});

describe('salle et QR codes', () => {
  async function createZone() {
    const { body } = await asManager(http().post('/api/floor/zones'))
      .send({ name: `Zone ${tag()}` })
      .expect(201);
    return body as { id: string; version: number };
  }

  it('le serveur voit le plan de salle mais pas les QR codes', async () => {
    const { body } = await as(waiter, http().get('/api/floor')).expect(200);
    expect(body.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/token|\/q\//);
    await as(waiter, http().get('/api/floor/qr-codes')).expect(403);
    await as(waiter, http().post('/api/floor/zones')).send({ name: 'Interdit' }).expect(403);
  });

  it('une nouvelle table reçoit son QR code', async () => {
    const zone = await createZone();
    const label = `N${tag()}`.slice(0, 8);
    const { body: table } = await asManager(http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label, seats: 6 })
      .expect(201);
    const { body } = await asManager(http().get('/api/floor/qr-codes')).expect(200);
    const qr = body.codes.find((c: { tableId: string }) => c.tableId === table.id);
    expect(qr.url).toMatch(/^https:\/\/menu\.test\.local\/q\/[\w-]{22}$/);
    expect(qr.mode).toBe('order');
  });

  it('refuse deux zones actives du même nom, à la création comme au renommage', async () => {
    const name = `Terrasse ${tag()}`;
    await asManager(http().post('/api/floor/zones')).send({ name }).expect(201);
    const dup = await asManager(http().post('/api/floor/zones'))
      .send({ name: ` ${name.toUpperCase()} ` })
      .expect(409);
    expect(dup.body.code).toBe('ZONE_NAME_TAKEN');
    const other = await createZone();
    const rename = await asManager(http().patch(`/api/floor/zones/${other.id}`))
      .send({ name, version: other.version })
      .expect(409);
    expect(rename.body.code).toBe('ZONE_NAME_TAKEN');
  });

  it('refuse deux tables actives du même nom, sans tenir compte de la casse', async () => {
    const zone = await createZone();
    const label = `D${tag()}`.slice(0, 8);
    const { body: first } = await asManager(http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label })
      .expect(201);
    const dup = await asManager(http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label: label.toLowerCase() })
      .expect(409);
    expect(dup.body.code).toBe('TABLE_LABEL_TAKEN');

    // Une fois la table supprimée du plan, son nom est de nouveau libre et son QR désactivé.
    await asManager(http().post(`/api/floor/tables/${first.id}/archive`)).expect(204);
    expect(await db.qrCode.count({ where: { tableId: first.id, active: true } })).toBe(0);
    await asManager(http().post('/api/floor/tables')).send({ zoneId: zone.id, label }).expect(201);
  });

  it('remplacer un QR code invalide l’ancien', async () => {
    const zone = await createZone();
    const { body: table } = await asManager(http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label: `R${tag()}`.slice(0, 8) })
      .expect(201);
    const before = await db.qrCode.findFirstOrThrow({ where: { tableId: table.id, active: true } });

    await asManager(http().put(`/api/floor/tables/${table.id}/qr/mode`))
      .send({ mode: 'menu' })
      .expect(200);
    const { body } = await asManager(http().post(`/api/floor/tables/${table.id}/qr/replace`)).expect(201);
    expect(body.url).not.toContain(before.token);
    expect(body.mode).toBe('menu');

    const codes = await db.qrCode.findMany({ where: { tableId: table.id } });
    expect(codes.filter((c) => c.active)).toHaveLength(1);
    expect(codes.find((c) => c.id === before.id)?.active).toBe(false);
  });

  it("n'archive pas une zone qui contient des tables", async () => {
    const zone = await createZone();
    await asManager(http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label: `Z${tag()}`.slice(0, 8) })
      .expect(201);
    const res = await asManager(http().post(`/api/floor/zones/${zone.id}/archive`)).expect(400);
    expect(res.body.code).toBe('ZONE_NOT_EMPTY');
  });

  it('refuse un nom de table invalide', async () => {
    const zone = await createZone();
    await asManager(http().post('/api/floor/tables'))
      .send({ zoneId: zone.id, label: '<script>' })
      .expect(400);
  });
});
