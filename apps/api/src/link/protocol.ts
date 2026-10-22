import { QR_MODES, VIP_SURCHARGE_MAX_XAF } from '@tchop/shared';
import { z } from 'zod';

/**
 * Protocole du lien entre un serveur local et le cloud (namespace Socket.IO « /site-link »).
 * Le serveur local se connecte lui-même au cloud : aucun port n'est ouvert dans l'établissement.
 *
 * - site → cloud : « snapshot » (menu public, aiguillage des QR codes, noms des photos) ;
 * - cloud → site : « rpc » (demande d'un client relayée), avec accusé de réception contenant la réponse.
 */

export const LINK_NAMESPACE = '/site-link';

const translated = z.object({ fr: z.string().max(400), en: z.string().max(400) }).passthrough();

/** Copie du menu public : mêmes champs que l'API publique du site, rien de plus. */
export const snapshotSchema = z.object({
  menu: z.object({
    site: z.object({ name: z.string().max(120) }),
    categories: z
      .array(
        z.object({
          id: z.uuid(),
          name: translated,
          vipOffered: z.boolean().default(true),
          vipSurchargeXaf: z.number().int().min(0).max(VIP_SURCHARGE_MAX_XAF).default(0),
        }),
      )
      .max(500),
    products: z
      .array(
        z.object({
          id: z.uuid(),
          categoryId: z.uuid(),
          name: translated,
          description: translated.nullable(),
          imageUrl: z
            .string()
            .regex(/^\/api\/media\/[0-9a-f-]{36}\.webp$/)
            .nullable(),
          priceXaf: z.number().int().min(0),
          available: z.boolean(),
          modifierGroupIds: z.array(z.uuid()).max(20),
        }),
      )
      .max(2000),
    modifierGroups: z
      .array(
        z.object({
          id: z.uuid(),
          name: translated,
          minSelect: z.number().int().min(0),
          maxSelect: z.number().int().min(1),
          modifiers: z
            .array(z.object({ id: z.uuid(), name: translated, priceDeltaXaf: z.number().int().min(0) }))
            .max(50),
        }),
      )
      .max(500),
  }),
  routes: z
    .array(
      z.object({
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
        tableLabel: z.string().max(12),
        mode: z.enum(QR_MODES),
        vip: z.boolean().default(false),
      }),
    )
    .max(2000),
  media: z.array(z.string().regex(/^[0-9a-f-]{36}\.webp$/)).max(2000),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/** Seules ces opérations peuvent être demandées par le cloud au serveur local. */
export type RpcRequest =
  | { method: 'qr.submit'; token: string; clientSession: string; body: unknown }
  | { method: 'qr.requests'; token: string; clientSession: string | null }
  | { method: 'media.get'; name: string };

export type RpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: { code: string; message: string; [key: string]: unknown } };

/** Taille maximale d'une photo relayée (les photos du site font moins de 300 Ko). */
export const MAX_RELAYED_MEDIA_BYTES = 2 * 1024 * 1024;
