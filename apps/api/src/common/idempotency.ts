import { ConflictException } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import { type AuthContext } from './request-context.js';

type Db = Prisma.TransactionClient;

const reused = () =>
  new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'Clé de requête déjà utilisée' });

/**
 * Réponse déjà enregistrée pour cette clé (requête renvoyée après une coupure Wi-Fi), ou null.
 * Une clé n'est rejouable que par la même personne, pour la même opération.
 */
export async function replayed<T>(db: Db, auth: AuthContext, key: string, route: string): Promise<T | null> {
  const found = await db.idempotencyKey.findUnique({ where: { siteId_key: { siteId: auth.siteId, key } } });
  if (!found) return null;
  if (found.userId !== auth.userId || found.route !== route) throw reused();
  return found.response as T;
}

/** Retient la réponse dans la transaction de l'opération : deux envois simultanés ne passent pas tous les deux. */
export async function remember(
  tx: Db,
  auth: AuthContext,
  key: string,
  route: string,
  response: Prisma.InputJsonValue,
): Promise<void> {
  await tx.idempotencyKey.create({
    data: { siteId: auth.siteId, key, userId: auth.userId, route, response },
  });
}
