import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// En local, les variables viennent du .env racine ; en CI, de l'environnement du workflow.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
