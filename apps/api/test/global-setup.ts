import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Prépare la base de test : migrations puis données de démo (le seed ne fait rien si elles existent).
 * Les tests utilisent TEST_DATABASE_URL, jamais la base de développement.
 */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL manquant (voir .env.example)');
  const cwd = fileURLToPath(new URL('../../../packages/db', import.meta.url));
  const env = { ...process.env, DATABASE_URL: url };
  execSync('pnpm exec prisma migrate deploy', { cwd, env, stdio: 'inherit' });
  execSync('pnpm exec prisma db seed', { cwd, env, stdio: 'inherit' });
  // Chaque passage ajoute des zones et des tables : celles des passages précédents sont retirées du plan
  // (comme le ferait un gérant). Sinon le plan grossit sans fin et dépasse la limite de la copie du menu
  // envoyée au cloud (2 000 QR codes par site). Les zones du seed, créées avec le site, sont gardées.
  execSync('pnpm exec prisma db execute --stdin', {
    cwd,
    env,
    input: STALE_FLOOR_CLEANUP,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

const testZones = `SELECT z.id FROM zone z JOIN site s ON s.id = z.site_id
  WHERE z.archived_at IS NULL AND z.created_at > s.created_at + interval '5 minutes'`;
const STALE_FLOOR_CLEANUP = `
UPDATE qr_code SET active = false, replaced_at = now()
  WHERE active AND table_id IN (SELECT id FROM dining_table WHERE zone_id IN (${testZones}));
UPDATE dining_table SET archived_at = now() WHERE archived_at IS NULL AND zone_id IN (${testZones});
UPDATE zone SET archived_at = now() WHERE id IN (${testZones});
`;
