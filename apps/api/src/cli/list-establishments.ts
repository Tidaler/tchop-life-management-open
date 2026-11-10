/**
 * Liste des établissements hébergés sur le serveur en ligne :
 *   pnpm --filter @tchop/api cloud:establishments
 */
import { createPrismaClient } from '@tchop/db';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (base de pilotage du serveur en ligne)');
  if (process.env.API_MODE !== 'cloud')
    throw new Error('Commande réservée au serveur en ligne (API_MODE=cloud)');
  const db = createPrismaClient(url);
  try {
    const rows = await db.establishment.findMany({ orderBy: { createdAt: 'asc' } });
    if (!rows.length) {
      console.log('Aucun établissement. Pour en créer un : cloud:new-establishment');
      return;
    }
    const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');
    console.table(
      rows.map((r) => ({
        code: r.code,
        nom: r.name,
        base: r.databaseName,
        statut: r.status,
        'relais activé': date(r.activatedAt),
        'créé le': date(r.createdAt),
      })),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
