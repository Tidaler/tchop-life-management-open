import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaPg } from '@prisma/adapter-pg';

export * from './generated/prisma/client.js';

/** Crée un client Prisma connecté à PostgreSQL via le pilote `pg`. */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
