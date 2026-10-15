import { resolve } from 'node:path';
import { z } from 'zod';

const boolFromEnv = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const configSchema = z
  .object({
    API_MODE: z.enum(['site', 'cloud']).default('site'),
    API_PORT: z.coerce.number().int().positive().default(3000),
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
    /** Intervalle de traitement de la file d'impression (0 : désactivé). */
    PRINT_POLL_MS: z.coerce.number().int().min(0).default(2000),
    /** Délai avant la 2e tentative d'impression ; il double ensuite à chaque échec. */
    PRINT_RETRY_BASE_MS: z.coerce.number().int().min(0).default(2000),
  })
  .refine((c) => c.API_MODE !== 'site' || c.SITE_ID, {
    message: 'SITE_ID est obligatoire en mode site',
    path: ['SITE_ID'],
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
