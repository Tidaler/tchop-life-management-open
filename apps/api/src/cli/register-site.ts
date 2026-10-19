/**
 * Enregistre (ou renouvelle) l'accès d'un serveur local au cloud.
 * À lancer sur le cloud :
 *   pnpm --filter @tchop/api cloud:register-site -- --site <identifiant du site> --name "Nom du site"
 *   pnpm --filter @tchop/api cloud:register-site -- --site <identifiant> --revoke
 *
 * Le secret n'est affiché qu'une fois : il se copie dans SITE_LINK_SECRET sur le serveur local.
 * Le cloud n'en garde que l'empreinte SHA-256. Renouveler le secret ou révoquer l'accès refuse toute
 * nouvelle connexion et coupe celle en cours dans les 30 secondes (revérification par le cloud).
 */
import { parseArgs } from 'node:util';
import { createPrismaClient } from '@tchop/db';
import { newOpaqueToken, sha256 } from '../common/crypto.js';

// pnpm transmet le séparateur « -- » tel quel : on l'ignore.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    site: { type: 'string' },
    name: { type: 'string' },
    revoke: { type: 'boolean', default: false },
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (base du cloud)');
  if (!values.site || !UUID.test(values.site)) throw new Error('--site <identifiant du site> obligatoire');
  const db = createPrismaClient(url);
  try {
    if (values.revoke) {
      await db.siteLink.update({ where: { siteId: values.site }, data: { revokedAt: new Date() } });
      console.log('Accès du site révoqué : il ne peut plus se connecter au cloud.');
      return;
    }
    if (!values.name) throw new Error('--name "Nom du site" obligatoire');
    const secret = newOpaqueToken();
    await db.siteLink.upsert({
      where: { siteId: values.site },
      create: { siteId: values.site, name: values.name, secretHash: sha256(secret) },
      update: { name: values.name, secretHash: sha256(secret), revokedAt: null },
    });
    console.log('Site enregistré. Copiez ce secret dans SITE_LINK_SECRET sur le serveur local.');
    console.log('Il ne sera plus jamais affiché :');
    console.log(`\n  ${secret}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
