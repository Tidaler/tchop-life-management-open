/**
 * Création (ou réinitialisation) d'un compte du personnel, sur le serveur :
 *   pnpm --filter @tchop/api user:add -- --username proprietaire --name "Nom Prénom" --role owner
 *   pnpm --filter @tchop/api user:add -- --username mireille --name "Mireille" --role cashier
 *   pnpm --filter @tchop/api user:add -- --username mireille --reset        (nouveau PIN ou mot de passe)
 *
 * Le mot de passe et le PIN sont demandés au clavier, sans être affichés ni gardés dans l'historique.
 * Mot de passe pour propriétaire, gérant et comptable (connexion back-office) ; PIN pour tous sauf le
 * propriétaire et le comptable (connexion rapide sur tablette). Rôles : owner, manager, cashier, waiter,
 * kitchen, storekeeper, accountant. Le site est celui de SITE_ID (ou --site).
 */
import { parseArgs } from 'node:util';
import { hash } from '@node-rs/argon2';
import { createPrismaClient } from '@tchop/db';
import { DEFAULT_ROLES, isRoleCode, type RoleCode } from '@tchop/shared';
import { askSecret, checkPassword, checkPin } from './prompt.js';

// pnpm transmet le séparateur « -- » tel quel : on l'ignore.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    username: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    site: { type: 'string' },
    reset: { type: 'boolean', default: false },
  },
});

/** Qui se connecte comment : mot de passe (back-office) et/ou PIN (tablette). */
const NEEDS_PASSWORD: RoleCode[] = ['owner', 'manager', 'accountant'];
const NEEDS_PIN: RoleCode[] = ['manager', 'cashier', 'waiter', 'kitchen', 'storekeeper'];

async function askChecked(label: string, env: string, check: (v: string) => string | null): Promise<string> {
  const first = await askSecret(label, env);
  const problem = check(first);
  if (problem) throw new Error(problem);
  if (!process.env[env]) {
    const again = await askSecret(`${label} (confirmation)`, env);
    if (again !== first) throw new Error('Les deux saisies ne correspondent pas');
  }
  return first;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  const siteId = values.site ?? process.env.SITE_ID;
  if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
    throw new Error('--site <identifiant du site> (ou SITE_ID) obligatoire');
  const username = values.username?.trim().toLowerCase();
  if (!username || !/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error('--username obligatoire : 3 à 40 caractères (lettres sans accent, chiffres, . _ -)');
  }

  const db = createPrismaClient(url);
  try {
    const site = await db.site.findUnique({ where: { id: siteId } });
    if (!site) throw new Error('Site introuvable : lancez d’abord site:setup');
    const existing = await db.user.findUnique({
      where: { tenantId_username: { tenantId: site.tenantId, username } },
    });

    if (values.reset) {
      if (!existing) throw new Error(`Aucun compte « ${username} »`);
      const link = await db.userSiteRole.findFirst({
        where: { userId: existing.id },
        include: { role: true },
      });
      const role = (link?.role.code ?? 'waiter') as RoleCode;
      const data: { passwordHash?: string; pinHash?: string; pinFailedCount: number; pinLockedUntil: null } =
        {
          pinFailedCount: 0,
          pinLockedUntil: null,
        };
      if (NEEDS_PASSWORD.includes(role))
        data.passwordHash = await hash(
          await askChecked('Nouveau mot de passe', 'TCHOP_PASSWORD', checkPassword),
        );
      if (NEEDS_PIN.includes(role))
        data.pinHash = await hash(await askChecked('Nouveau PIN', 'TCHOP_PIN', checkPin));
      await db.$transaction([
        db.user.update({ where: { id: existing.id }, data }),
        // Toutes les sessions ouvertes avec l'ancien secret sont fermées.
        db.authSession.updateMany({
          where: { userId: existing.id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        db.auditLog.create({
          data: {
            tenantId: site.tenantId,
            siteId,
            action: 'user.credentials_reset',
            entity: 'user',
            entityId: existing.id,
          },
        }),
      ]);
      console.log(`Accès de « ${username} » réinitialisés ; ses sessions ouvertes sont fermées.`);
      return;
    }

    if (existing) throw new Error(`Le compte « ${username} » existe déjà (--reset pour changer ses accès)`);
    const roleCode = values.role ?? '';
    if (!isRoleCode(roleCode))
      throw new Error(`--role obligatoire : ${Object.keys(DEFAULT_ROLES).join(', ')}`);
    const displayName = values.name?.trim();
    if (!displayName) throw new Error('--name "Nom affiché" obligatoire');
    const role = await db.role.findUnique({
      where: { tenantId_code: { tenantId: site.tenantId, code: roleCode } },
    });
    if (!role) throw new Error('Rôles absents : lancez d’abord site:setup');

    const passwordHash = NEEDS_PASSWORD.includes(roleCode)
      ? await hash(await askChecked('Mot de passe', 'TCHOP_PASSWORD', checkPassword))
      : null;
    const pinHash = NEEDS_PIN.includes(roleCode)
      ? await hash(await askChecked('PIN', 'TCHOP_PIN', checkPin))
      : null;

    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId: site.tenantId,
          username,
          displayName,
          passwordHash,
          pinHash,
          siteRoles: {
            create: { roleId: role.id, siteId: DEFAULT_ROLES[roleCode].tenantWide ? null : siteId },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: site.tenantId,
          siteId,
          action: 'user.created',
          entity: 'user',
          entityId: created.id,
          after: { username, displayName, role: roleCode },
        },
      });
      return created;
    });
    const how = [passwordHash ? 'mot de passe' : null, pinHash ? 'PIN' : null].filter(Boolean).join(' et ');
    console.log(
      `Compte créé : ${user.displayName} (${username}, ${DEFAULT_ROLES[roleCode].name.fr}) - connexion par ${how}.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
