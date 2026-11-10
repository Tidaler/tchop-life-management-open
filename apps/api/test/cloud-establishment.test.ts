import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPrismaClient, type PrismaClient } from '@tchop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';

const script = fileURLToPath(new URL('../dist/cli/new-establishment.js', import.meta.url));
const list = fileURLToPath(new URL('../dist/cli/list-establishments.js', import.meta.url));
const tag = randomUUID().slice(0, 6);
const code = `test-${tag}`;
const databaseName = `etab_test_${tag}`;
let pilot: PrismaClient;

/** La base de test sert de base de pilotage ; l'établissement a sa propre base, supprimée à la fin. */
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  API_MODE: 'cloud',
  TCHOP_PASSWORD: 'Proprio-Test-2026',
  ...extra,
});
function create(args: string[], extra: Record<string, string> = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [script, ...args], {
        env: env(extra),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
const databaseExists = async (name: string) =>
  (await pilot.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${name}`).length > 0;

beforeAll(() => {
  pilot = testDb();
});

afterAll(async () => {
  await pilot.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await pilot.establishment.deleteMany({ where: { code: { startsWith: 'test-' } } });
  await pilot.$disconnect();
});

describe('nouvel établissement en ligne', () => {
  it('refuse hors du serveur en ligne et contrôle le code', () => {
    const local = create(['--code', code, '--name', 'X', '--owner-name', 'Y'], { API_MODE: 'site' });
    expect(local.ok).toBe(false);
    expect(local.out).toContain('réservée au serveur en ligne');
    const bad = create(['--code', 'Mon Resto!', '--name', 'X', '--owner-name', 'Y']);
    expect(bad.ok).toBe(false);
    expect(bad.out).toContain('--code obligatoire');
  });

  it('crée une base neuve et vide, l’établissement, le propriétaire et le code d’activation', async () => {
    const result = create(['--code', code, '--name', `Le Baobab ${tag}`, '--owner-name', 'Mama Africa']);
    expect(result.out).toContain('Établissement « Le Baobab');
    expect(result.ok).toBe(true);
    const activation = /\n {2}([A-Z2-9]{4}(?:-[A-Z2-9]{4}){4})\n/.exec(result.out)?.[1];
    expect(activation).toBeDefined();

    const row = await pilot.establishment.findUniqueOrThrow({ where: { code } });
    expect(row).toMatchObject({ databaseName, status: 'active', activatedAt: null });
    expect(row.activationCodeHash).toBe(createHash('sha256').update(activation!).digest('hex'));

    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    const db = createPrismaClient(url.toString());
    try {
      const site = await db.site.findUniqueOrThrow({ where: { id: row.siteId } });
      expect(site.name).toBe(`Le Baobab ${tag}`);
      const owner = await db.user.findFirstOrThrow({ where: { username: 'proprietaire' } });
      expect(owner).toMatchObject({ displayName: 'Mama Africa', active: true });
      expect(owner.passwordHash).toBeTruthy();
      // Base vide : rien d'autre que le départ (plan de salle, caisse, magasins), aucune vente.
      expect(await db.site.count()).toBe(1);
      expect(await db.diningTable.count()).toBe(13);
      expect(await db.order.count()).toBe(0);
      expect(await db.product.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }

    const listed = execFileSync(process.execPath, [list], { env: env(), encoding: 'utf8' });
    expect(listed).toContain(code);
  }, 180_000);

  it('refuse un code déjà pris, sans toucher à la base existante', async () => {
    const again = create(['--code', code, '--name', 'Doublon', '--owner-name', 'Y']);
    expect(again.ok).toBe(false);
    expect(again.out).toContain('existe déjà');
    expect(await databaseExists(databaseName)).toBe(true);
  });

  it('supprime la base créée si une étape échoue', async () => {
    const failing = `test-${tag}-ko`;
    const result = create(['--code', failing, '--name', 'Échec', '--owner-name', 'Y'], {
      TCHOP_PASSWORD: 'court',
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain('supprimée');
    expect(await databaseExists(`etab_test_${tag}_ko`)).toBe(false);
    expect(await pilot.establishment.findUnique({ where: { code: failing } })).toBeNull();
  }, 180_000);
});
