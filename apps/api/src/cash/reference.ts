import { ConflictException } from '@nestjs/common';
import { type Prisma } from '@tchop/db';

/**
 * Une référence de transaction (MoMo, Orange Money, carte) ne sert qu'une fois par site,
 * paiements d'additions et règlements d'ardoise confondus : la même preuve ne justifie pas deux encaissements.
 * Une seule requête (les transactions partagent une connexion : pas de requêtes simultanées).
 */
export async function assertReferenceFree(
  tx: Prisma.TransactionClient,
  siteId: string,
  method: string,
  reference: string,
): Promise<void> {
  const lower = reference.toLowerCase();
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT
      (SELECT count(*) FROM "payment"
        WHERE "site_id" = ${siteId}::uuid AND "method"::text = ${method}
          AND lower("reference") = ${lower} AND "status" <> 'voided')
      +
      (SELECT count(*) FROM "customer_ledger_entry" e JOIN "customer" c ON c."id" = e."customer_id"
        WHERE c."site_id" = ${siteId}::uuid AND e."method"::text = ${method} AND lower(e."reference") = ${lower})
      AS n`;
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new ConflictException({
      code: 'REFERENCE_ALREADY_USED',
      message: 'Cette référence de transaction a déjà été enregistrée',
    });
  }
}
