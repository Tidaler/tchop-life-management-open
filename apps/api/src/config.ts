import { resolve } from 'node:path';
import { z } from 'zod';

const boolFromEnv = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_MODE: z.enum(['site', 'cloud']).default('site'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    /** Adresse d'écoute : seulement la machine elle-même, derrière le serveur web HTTPS (Caddy). */
    API_HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.string().min(1),
    /** Site servi par ce serveur local (mode site uniquement). */
    SITE_ID: z.uuid().optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET doit contenir au moins 32 caractères'),
    /** Origines autorisées (CORS), séparées par des virgules. Vide : même origine uniquement. */
    WEB_ORIGIN: z.string().default(''),
    COOKIE_SECURE: boolFromEnv.default(true),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(12),
    /** Tentatives de connexion ou d'enregistrement autorisées par minute et par adresse IP. */
    AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    /** Requêtes du menu QR (lecture) autorisées par minute et par adresse IP. */
    PUBLIC_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    /** Commandes envoyées depuis le menu QR autorisées par minute et par adresse IP. */
    PUBLIC_ORDER_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    /** Une demande QR sans réponse du personnel expire au bout de ce délai. */
    QR_REQUEST_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
    /** Valeur de « trust proxy » d'Express (Caddy devant l'API sur le serveur local). */
    TRUST_PROXY: z.string().default('loopback'),
    /** Dossier des photos de produits. */
    MEDIA_DIR: z
      .string()
      .default('data/media')
      .transform((dir) => resolve(dir)),
    /** Adresse publique du menu client, encodée dans les QR codes (servie par le cloud). */
    PUBLIC_MENU_URL: z.url().default('https://menu.tchoplife.app'),
    /** Heure de bascule de la journée d'exploitation (6 : une vente à 2 h compte pour la veille). */
    BUSINESS_DAY_CUTOFF_HOUR: z.coerce.number().int().min(0).max(12).default(6),
    /** Adresse du cloud auquel ce serveur local se connecte (relais du menu QR). Vide : pas de relais. */
    CLOUD_URL: z.url().optional(),
    /** Secret du site, fourni par le cloud à l'enregistrement du site. */
    SITE_LINK_SECRET: z.string().min(43).optional(),
    /** Fréquence de contrôle du menu envoyé au cloud (envoi seulement s'il a changé). */
    LINK_SNAPSHOT_MS: z.coerce.number().int().min(100).default(15_000),
    /** Délai maximal d'une demande relayée par le cloud vers le serveur local. */
    LINK_RPC_TIMEOUT_MS: z.coerce.number().int().min(100).default(8_000),
    /** Intervalle de traitement de la file d'impression (0 : désactivé). */
    PRINT_POLL_MS: z.coerce.number().int().min(0).default(2000),
    /** Délai avant la 2e tentative d'impression ; il double ensuite à chaque échec. */
    PRINT_RETRY_BASE_MS: z.coerce.number().int().min(0).default(2000),
  })
  .refine((c) => c.API_MODE !== 'site' || c.SITE_ID, {
    message: 'SITE_ID est obligatoire en mode site',
    path: ['SITE_ID'],
  })
  .refine((c) => !c.CLOUD_URL || (c.API_MODE === 'site' && !!c.SITE_LINK_SECRET), {
    message: 'CLOUD_URL demande le mode site et SITE_LINK_SECRET',
    path: ['CLOUD_URL'],
  })
  // En production, on refuse de démarrer avec une configuration de développement.
  .refine((c) => c.NODE_ENV !== 'production' || c.COOKIE_SECURE, {
    message: 'COOKIE_SECURE doit valoir true en production',
    path: ['COOKIE_SECURE'],
  })
  .refine(
    (c) =>
      c.NODE_ENV !== 'production' ||
      (c.JWT_SECRET.length >= 48 && !/dev|change-me|example/i.test(c.JWT_SECRET)),
    {
      message: 'JWT_SECRET de production : 48 caractères aléatoires minimum, jamais la valeur d’exemple',
      path: ['JWT_SECRET'],
    },
  )
  .refine((c) => c.NODE_ENV !== 'production' || !c.CLOUD_URL || c.CLOUD_URL.startsWith('https://'), {
    message: 'CLOUD_URL doit être en HTTPS en production',
    path: ['CLOUD_URL'],
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.PUBLIC_MENU_URL.startsWith('https://'), {
    message: 'PUBLIC_MENU_URL doit être en HTTPS en production',
    path: ['PUBLIC_MENU_URL'],
  });

export type AppConfig = z.infer<typeof configSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${details}`);
  }
  return parsed.data;
}
