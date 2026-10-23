import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, testDb } from './helpers.js';

const cli = (name: string) => fileURLToPath(new URL(`../dist/cli/${name}.js`, import.meta.url));
const tag = randomUUID().slice(0, 6);
const establishment = `Etablissement ${tag}`;
let db: PrismaClient;
let siteId: string;
let app: INestApplication | undefined;

/** Lance une commande d'installation sur la base de test ; renvoie sa sortie, ou l'erreur affichée. */
function run(name: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [cli(name), '--', ...args], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, SITE_ID: siteId ?? '', ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? error) };
  }
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

describe("installation d'un établissement", () => {
  it('crée le site, les rôles, la caisse, les magasins et les catégories de dépenses ; rejouable', async () => {
    const first = run('setup-site', ['--name', establishment]);
    expect(first.ok).toBe(true);
    siteId = /SITE_ID=([0-9a-f-]{36})/.exec(first.out)![1]!;
    const site = await db.site.findUniqueOrThrow({ where: { id: siteId }, include: { tenant: true } });
    expect(site).toMatchObject({ name: establishment, slug: 'principal', timezone: 'Africa/Douala' });
    expect(await db.role.count({ where: { tenantId: site.tenantId } })).toBe(7);
    expect(await db.cashRegister.count({ where: { siteId } })).toBe(1);
    expect(await db.stockLocation.count({ where: { siteId } })).toBe(4);
    expect(await db.expenseCategory.count({ where: { siteId } })).toBe(7);
    const zones = await db.zone.findMany({
      where: { siteId },
      orderBy: { sortOrder: 'asc' },
      include: { tables: { orderBy: [{ posY: 'asc' }, { posX: 'asc' }], include: { qrCodes: true } } },
    });
    expect(zones.map((z) => [z.name, z.vip, z.tables.map((t) => t.label)])).toEqual([
      ['Salle', false, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11']],
      ['Salon VIP 1', true, ['VIP1']],
      ['Salon VIP 2', true, ['VIP2']],
    ]);
    const qrs = zones.flatMap((z) => z.tables.flatMap((t) => t.qrCodes));
    expect(qrs).toHaveLength(13);
    expect(qrs.every((q) => q.mode === 'menu' && q.active && /^[\w-]{22}$/.test(q.token))).toBe(true);

    const again = run('setup-site', ['--name', establishment]);
    expect(again.out).toContain('déjà présent');
    expect(again.out).toContain(siteId);
    expect(await db.cashRegister.count({ where: { siteId } })).toBe(1);
    expect(await db.diningTable.count({ where: { siteId } })).toBe(13);
  });

  it('refuse les mots de passe et PIN trop simples', () => {
    const weakPassword = run('add-user', ['--username', `p${tag}`, '--name', 'Patron', '--role', 'owner'], {
      TCHOP_PASSWORD: 'motdepasse',
    });
    expect(weakPassword.ok).toBe(false);
    expect(weakPassword.out).toContain('12 caractères');
    for (const pin of ['1234', '0000', '9876']) {
      const weak = run('add-user', ['--username', `c${tag}`, '--name', 'Caisse', '--role', 'cashier'], {
        TCHOP_PIN: pin,
      });
      expect(weak.ok).toBe(false);
      expect(weak.out).toContain('PIN trop simple');
    }
    expect(run('add-user', ['--username', `x${tag}`, '--name', 'X', '--role', 'chef']).out).toContain(
      '--role',
    );
  });

  it('crée le propriétaire et un caissier ; le propriétaire se connecte ; pas de doublon', async () => {
    const owner = run('add-user', ['--username', `patron${tag}`, '--name', 'Le Patron', '--role', 'owner'], {
      TCHOP_PASSWORD: 'Patron-Solide-2026',
    });
    expect(owner.ok).toBe(true);
    expect(owner.out).toContain('connexion par mot de passe');
    const cashier = run(
      'add-user',
      ['--username', `caisse${tag}`, '--name', 'Caissière', '--role', 'cashier'],
      {
        TCHOP_PIN: '5821',
      },
    );
    expect(cashier.out).toContain('connexion par PIN');
    expect(
      run('add-user', ['--username', `caisse${tag}`, '--name', 'Autre', '--role', 'cashier'], {
        TCHOP_PIN: '5821',
      }).out,
    ).toContain('existe déjà');

    const stored = await db.user.findFirstOrThrow({ where: { username: `caisse${tag}` } });
    expect(stored.pinHash).not.toContain('5821');
    expect(stored.passwordHash).toBeNull();

    app = await startApp({ SITE_ID: siteId });
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: `patron${tag}`, password: 'Patron-Solide-2026' })
      .expect(200);
  });

  it('réinitialisation : nouveau secret, sessions ouvertes fermées', async () => {
    const before = await db.authSession.count({
      where: { user: { username: `patron${tag}` }, revokedAt: null },
    });
    expect(before).toBeGreaterThan(0);
    const reset = run('add-user', ['--username', `patron${tag}`, '--reset'], {
      TCHOP_PASSWORD: 'Nouveau-Secret-2027',
    });
    expect(reset.ok).toBe(true);
    expect(
      await db.authSession.count({ where: { user: { username: `patron${tag}` }, revokedAt: null } }),
    ).toBe(0);
    await request(app!.getHttpServer())
      .post('/api/auth/login')
      .send({ username: `patron${tag}`, password: 'Patron-Solide-2026' })
      .expect(401);
    await request(app!.getHttpServer())
      .post('/api/auth/login')
      .send({ username: `patron${tag}`, password: 'Nouveau-Secret-2027' })
      .expect(200);
  });
});
