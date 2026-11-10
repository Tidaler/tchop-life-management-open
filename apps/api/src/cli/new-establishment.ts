/**
 * Création d'un établissement sur le serveur en ligne, dans une base de données neuve et vide :
 *   pnpm --filter @tchop/api cloud:new-establishment -- --code baobab --name "Restaurant Le Baobab" \
 *     --owner-name "Nom du propriétaire"
 *
 * À lancer sur le serveur en ligne (API_MODE=cloud), DATABASE_URL pointant sur la base de pilotage.
 * Étapes : création de la base « etab_<code> », tables (mêmes migrations que les serveurs locaux),
 * établissement et plan de départ (site:setup), compte propriétaire (user:add, mot de passe demandé au
 * clavier), inscription au registre avec un code d'activation à usage unique, affiché une seule fois.
 * En cas d'échec, la base créée est supprimée : rien ne reste à moitié fait.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPrismaClient } from '@tchop/db';
import { sha256 } from '../common/crypto.js';

// pnpm transmet le séparateur « -- » tel quel : on l'ignore.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    code: { type: 'string' },
    name: { type: 'string' },
    'owner-name': { type: 'string' },
    'owner-username': { type: 'string', default: 'proprietaire' },
    timezone: { type: 'string', default: 'Africa/Douala' },
  },
});

/** Code court de l'établissement : 3 à 30 caractères, lettres minuscules sans accent, chiffres, tirets. */
const CODE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Code d'activation lisible au téléphone : 20 caractères sans O/0 ni I/1, groupés par 4 (100 bits). */
export function newActivationCode(): string {
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => BASE32[b % 32]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

const cli = (name: string) => fileURLToPath(new URL(`./${name}.js`, import.meta.url));
const dbPackage = fileURLToPath(new URL('../../../../packages/db', import.meta.url));

function run(command: string, args: string[], options: SpawnSyncOptions, step: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${step} : ${result.error.message}`);
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().split('\n').pop() : '';
    throw new Error(`${step} : échec${detail ? ` (${detail})` : ''}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (base de pilotage du serveur en ligne)');
  // Garde-fou : jamais sur le serveur local d'un établissement.
  if (process.env.API_MODE !== 'cloud')
    throw new Error('Commande réservée au serveur en ligne (API_MODE=cloud)');
  const code = values.code?.trim().toLowerCase() ?? '';
  if (!CODE.test(code)) {
    throw new Error(
      '--code obligatoire : 3 à 30 caractères (lettres minuscules sans accent, chiffres, tirets)',
    );
  }
  const name = values.name?.trim();
  if (!name) throw new Error('--name "Nom de l\'établissement" obligatoire');
  const ownerName = values['owner-name']?.trim();
  if (!ownerName) throw new Error('--owner-name "Nom du propriétaire" obligatoire');
  const databaseName = `etab_${code.replaceAll('-', '_')}`;

  const pilot = createPrismaClient(url);
  let created = false;
  let registered = false;
  try {
    if (await pilot.establishment.findUnique({ where: { code } })) {
      throw new Error(`L'établissement « ${code} » existe déjà`);
    }
    const existing = await pilot.$queryRaw<
      unknown[]
    >`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
    if (existing.length) throw new Error(`La base « ${databaseName} » existe déjà`);

    console.log(`1/5 Base de données « ${databaseName} »`);
    // Nom contrôlé par l'expression CODE : uniquement [a-z0-9_].
    await pilot.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const target = new URL(url);
    target.pathname = `/${databaseName}`;
    const env = { ...process.env, DATABASE_URL: target.toString() };

    console.log('2/5 Tables');
    run(
      'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy'],
      { cwd: dbPackage, env, shell: process.platform === 'win32' },
      'Tables',
    );

    console.log('3/5 Établissement et plan de départ');
    const setup = run(
      process.execPath,
      [cli('setup-site'), '--name', name, '--timezone', values.timezone!],
      { env },
      'Établissement',
    );
    const siteId = /SITE_ID=([0-9a-f-]{36})/.exec(setup)?.[1];
    if (!siteId) throw new Error('Établissement : identifiant du site introuvable');

    console.log('4/5 Compte du propriétaire');
    run(
      process.execPath,
      [
        cli('add-user'),
        '--username',
        values['owner-username']!,
        '--name',
        ownerName,
        '--role',
        'owner',
        '--site',
        siteId,
      ],
      { env, stdio: ['inherit', 'inherit', 'pipe'] },
      'Compte du propriétaire',
    );

    console.log('5/5 Registre et code d’activation');
    const activationCode = newActivationCode();
    await pilot.establishment.create({
      data: { code, name, databaseName, siteId, activationCodeHash: sha256(activationCode) },
    });
    registered = true;

    console.log(`\nÉtablissement « ${name} » prêt.`);
    console.log(`  Code          : ${code}`);
    console.log(`  Base          : ${databaseName}`);
    console.log(`  Site          : ${siteId}`);
    console.log(`  Propriétaire  : ${values['owner-username']}`);
    console.log(
      `\nCode d’activation (affiché une seule fois, à remettre à l’installateur du relais local) :`,
    );
    console.log(`\n  ${activationCode}\n`);
  } finally {
    if (created && !registered) {
      await pilot
        .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => undefined);
      console.error(`Base « ${databaseName} » supprimée : rien n'a été créé.`);
    }
    await pilot.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
