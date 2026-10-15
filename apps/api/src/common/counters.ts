import { type Prisma } from '@tchop/db';

/**
 * Valeur suivante d'un compteur du site (ex. « order:2026-10-15 »).
 * La ligne est verrouillée jusqu'à la fin de la transaction : pas de trou ni de doublon,
 * même si deux tablettes envoient en même temps.
 */
export async function nextCounter(
  tx: Prisma.TransactionClient,
  siteId: string,
  key: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "site_counter" ("site_id", "key", "value") VALUES (${siteId}::uuid, ${key}, 1)
    ON CONFLICT ("site_id", "key") DO UPDATE SET "value" = "site_counter"."value" + 1
    RETURNING "value"`;
  return rows[0]!.value;
}

/** Date (AAAA-MM-JJ) convertie pour une colonne PostgreSQL de type date. */
export const toDbDate = (day: string): Date => new Date(`${day}T00:00:00Z`);
