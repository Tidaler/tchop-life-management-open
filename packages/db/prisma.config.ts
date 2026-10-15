import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Le fichier .env est à la racine du dépôt.
config({ path: new URL('../../.env', import.meta.url), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Facultatif ici : `prisma generate` n'a pas besoin de la base (en CI, Turborepo ne transmet pas
    // DATABASE_URL à cette tâche). Les commandes de migration et le seed échouent clairement s'il manque.
    url: process.env.DATABASE_URL,
  },
});
