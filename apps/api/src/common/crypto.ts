import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Jeton opaque (jeton d'appareil, jeton de rafraîchissement) : 256 bits aléatoires. */
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

/** Les jetons opaques sont stockés uniquement sous forme d'empreinte SHA-256. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Code numérique à 6 chiffres (enregistrement d'un appareil). */
export const newNumericCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');
