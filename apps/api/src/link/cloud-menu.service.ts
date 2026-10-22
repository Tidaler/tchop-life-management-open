import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpException, Injectable } from '@nestjs/common';
import { menuForZone, QR_TOKEN_PATTERN, type QrSubmitInput } from '@tchop/shared';
import { sha256 } from '../common/crypto.js';
import { notFound } from '../common/errors.js';
import { MediaService } from '../media/media.service.js';
import { PrismaService } from '../prisma.service.js';
import { MAX_RELAYED_MEDIA_BYTES, type RpcResponse, type Snapshot } from './protocol.js';
import { SiteLinkGateway } from './site-link.gateway.js';

/** Interface commune aux deux façons de servir le menu QR : par le site lui-même, ou par le cloud. */
export interface PublicMenuBackend {
  menu(token: string): Promise<unknown>;
  submit(token: string, clientSession: string, input: QrSubmitInput): Promise<unknown>;
  clientRequests(token: string, clientSession: string | undefined): Promise<unknown>;
}
export const PUBLIC_MENU_BACKEND = Symbol('PUBLIC_MENU_BACKEND');

/**
 * Menu QR servi par le cloud. La consultation fonctionne avec la dernière copie reçue, même si le site
 * est hors ligne (commande alors désactivée). Les commandes et le suivi sont relayés au site, qui décide.
 */
@Injectable()
export class CloudMenuService implements PublicMenuBackend {
  constructor(
    private readonly prisma: PrismaService,
    private readonly link: SiteLinkGateway,
    private readonly media: MediaService,
  ) {}

  /** Aiguillage par l'empreinte du jeton : 404 neutre pour un jeton invalide ou inconnu. */
  private async route(token: string) {
    if (!QR_TOKEN_PATTERN.test(token)) throw notFound('Menu');
    const route = await this.prisma.cloudQrRoute.findUnique({ where: { tokenHash: sha256(token) } });
    const link = route ? await this.prisma.siteLink.findUnique({ where: { siteId: route.siteId } }) : null;
    if (!route || !link || link.revokedAt) throw notFound('Menu');
    return route;
  }

  async menu(token: string) {
    const route = await this.route(token);
    const snapshot = await this.prisma.cloudMenuSnapshot.findUnique({ where: { siteId: route.siteId } });
    if (!snapshot) throw notFound('Menu');
    return {
      ...menuForZone(snapshot.payload as unknown as Snapshot['menu'], route.vip),
      table: { label: route.tableLabel },
      // Commande possible seulement si le site est relié à cet instant.
      ordering: route.mode === 'order' && this.link.isConnected(route.siteId),
      orderingPaused: route.mode === 'order' && !this.link.isConnected(route.siteId),
    };
  }

  async submit(token: string, clientSession: string, input: QrSubmitInput) {
    const route = await this.route(token);
    return unwrap(
      await this.link.rpc(route.siteId, { method: 'qr.submit', token, clientSession, body: input }),
    );
  }

  async clientRequests(token: string, clientSession: string | undefined) {
    const route = await this.route(token);
    if (!clientSession) return [];
    return unwrap(await this.link.rpc(route.siteId, { method: 'qr.requests', token, clientSession }));
  }

  /**
   * Photo du menu : servie depuis le cache du cloud, sinon demandée au site puis mise en cache
   * (les noms changent à chaque nouvelle photo, le cache n'a jamais à être invalidé).
   */
  async mediaPath(name: string): Promise<string | null> {
    const path = this.media.resolve(name);
    if (!path) return null;
    if (existsSync(path)) return path;
    const route = await this.prisma.cloudMediaRoute.findUnique({ where: { name } });
    if (!route) return null;
    const response = await this.link.rpc(route.siteId, { method: 'media.get', name });
    if (!response.ok || typeof response.data !== 'string') return null;
    const bytes = Buffer.from(response.data, 'base64');
    // Seule une image WebP de taille raisonnable est acceptée (le site réencode déjà toutes les photos).
    if (bytes.length > MAX_RELAYED_MEDIA_BYTES || bytes.subarray(8, 12).toString('ascii') !== 'WEBP')
      return null;
    await mkdir(this.media.dir, { recursive: true });
    await writeFile(join(this.media.dir, name), bytes);
    return path;
  }
}

function unwrap(response: RpcResponse): unknown {
  if (response.ok) return response.data;
  throw new HttpException({ code: response.error.code, message: response.error.message }, response.status);
}
