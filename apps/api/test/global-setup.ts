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
}
