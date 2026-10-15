import { hash, verify } from '@node-rs/argon2';

// Argon2id avec les paramètres par défaut de @node-rs/argon2 (19 Mio, 2 passes).
export const hashSecret = (secret: string): Promise<string> => hash(secret);

let dummyHash: Promise<string> | undefined;

/**
 * Vérifie un mot de passe ou un PIN. Sans empreinte (utilisateur inconnu), on vérifie quand même
 * contre une empreinte factice : la durée de réponse ne révèle pas si le compte existe.
 */
export async function verifySecret(storedHash: string | null | undefined, secret: string): Promise<boolean> {
  if (!storedHash) {
    dummyHash ??= hash('tchop-dummy-secret');
    await verify(await dummyHash, secret).catch(() => false);
    return false;
  }
  return verify(storedHash, secret).catch(() => false);
}
