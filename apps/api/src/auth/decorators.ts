import { SetMetadata } from '@nestjs/common';
import { type Access, type Permission } from '@tchop/shared';

/**
 * Chaque route déclare sa politique d'accès. Une route sans politique est refusée
 * (docs/architecture/04-securite.md, « Autorisation »).
 */
export type AccessPolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission; access: Access };

export const ACCESS_POLICY = 'tchop:access-policy';
export const DEVICE_REQUIRED = 'tchop:device-required';
export const AUTH_RATE_LIMITED = 'tchop:auth-rate-limited';
export const PUBLIC_RATE_LIMITED = 'tchop:public-rate-limited';
export const PUBLIC_ORDER_RATE_LIMITED = 'tchop:public-order-rate-limited';

/** Route ouverte sans connexion. */
export const Public = () => SetMetadata(ACCESS_POLICY, { kind: 'public' } satisfies AccessPolicy);

/** Route ouverte à tout utilisateur connecté, quel que soit son rôle. */
export const Authenticated = () =>
  SetMetadata(ACCESS_POLICY, { kind: 'authenticated' } satisfies AccessPolicy);

/** Route réservée aux rôles qui ont la permission (en lecture ou en écriture). */
export const RequirePermission = (permission: Permission, access: Access = 'write') =>
  SetMetadata(ACCESS_POLICY, { kind: 'permission', permission, access } satisfies AccessPolicy);

/** La requête doit venir d'un appareil enregistré (en-tête X-Device-Token). */
export const RequireDevice = () => SetMetadata(DEVICE_REQUIRED, true);

/** Route sensible (connexion, enregistrement) : nombre de tentatives limité par adresse IP. */
export const AuthRateLimited = () => SetMetadata(AUTH_RATE_LIMITED, true);

/** Route publique (menu QR) : limite par adresse IP, plus large que pour les connexions. */
export const PublicRateLimited = () => SetMetadata(PUBLIC_RATE_LIMITED, true);

/** Envoi d'une commande depuis le menu QR : limite stricte par adresse IP. */
export const PublicOrderRateLimited = () => SetMetadata(PUBLIC_ORDER_RATE_LIMITED, true);

export const DEVICE_TOKEN_HEADER = 'x-device-token';
