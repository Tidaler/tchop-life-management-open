import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { qrSubmitSchema } from '@tchop/shared';
import { io, type Socket } from 'socket.io-client';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { MediaService } from '../media/media.service.js';
import { QrRequestsService } from '../qr/qr-requests.service.js';
import { LINK_NAMESPACE, MAX_RELAYED_MEDIA_BYTES, type RpcRequest, type RpcResponse } from './protocol.js';

const CLIENT_SESSION = /^[A-Za-z0-9_-]{43}$/;

/**
 * Côté serveur local : connexion sortante permanente vers le cloud.
 * Envoie la copie du menu public quand elle change et répond aux demandes relayées par le cloud,
 * en appliquant exactement les mêmes contrôles que l'API publique locale (aucune confiance accordée au cloud).
 */
@Injectable()
export class SiteLinkClient implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SiteLinkClient.name);
  private socket?: Socket;
  private timer?: NodeJS.Timeout;
  private lastHash: string | null = null;

  constructor(
    private readonly qr: QrRequestsService,
    private readonly media: MediaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get connected(): boolean {
    return !!this.socket?.connected;
  }

  onApplicationBootstrap(): void {
    if (this.config.API_MODE !== 'site' || !this.config.CLOUD_URL) return;
    this.socket = io(`${this.config.CLOUD_URL.replace(/\/+$/, '')}${LINK_NAMESPACE}`, {
      path: '/api/socket.io',
      transports: ['websocket'],
      auth: { siteId: this.config.SITE_ID, secret: this.config.SITE_LINK_SECRET },
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });
    this.socket.on('connect', () => {
      this.logger.log('Relié au cloud');
      this.lastHash = null; // le cloud reçoit toujours une copie fraîche après une reconnexion
      void this.pushSnapshot();
    });
    this.socket.on('disconnect', (reason) => this.logger.warn(`Lien cloud interrompu (${reason})`));
    this.socket.on('connect_error', (error) =>
      this.logger.warn(`Connexion au cloud impossible : ${error.message}`),
    );
    this.socket.on('rpc', (request: RpcRequest, ack: (response: RpcResponse) => void) => {
      void this.handle(request).then(ack);
    });
    this.timer = setInterval(() => void this.pushSnapshot(), this.config.LINK_SNAPSHOT_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.socket?.close();
  }

  /** Envoie la copie du menu si elle a changé depuis le dernier envoi. */
  async pushSnapshot(): Promise<void> {
    if (!this.socket?.connected) return;
    try {
      const snapshot = await this.qr.linkSnapshot(this.config.SITE_ID!);
      const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      if (hash === this.lastHash) return;
      const ack = (await this.socket
        .timeout(this.config.LINK_RPC_TIMEOUT_MS)
        .emitWithAck('snapshot', snapshot)) as {
        ok: boolean;
      };
      if (ack?.ok) this.lastHash = hash;
    } catch (error) {
      this.logger.warn(`Envoi du menu au cloud : ${String(error)}`);
    }
  }

  /** Traite une demande relayée. Toute erreur est renvoyée sous la forme d'une réponse HTTP. */
  private async handle(request: RpcRequest): Promise<RpcResponse> {
    try {
      switch (request?.method) {
        case 'qr.submit': {
          if (typeof request.token !== 'string' || !CLIENT_SESSION.test(String(request.clientSession))) {
            return badRequest();
          }
          await this.assertOwnQr(request.token);
          const body = qrSubmitSchema.safeParse(request.body);
          if (!body.success) return badRequest();
          return { ok: true, data: await this.qr.submit(request.token, request.clientSession, body.data) };
        }
        case 'qr.requests': {
          if (typeof request.token !== 'string') return badRequest();
          await this.assertOwnQr(request.token);
          const session =
            request.clientSession && CLIENT_SESSION.test(request.clientSession)
              ? request.clientSession
              : undefined;
          return { ok: true, data: await this.qr.clientRequests(request.token, session) };
        }
        case 'media.get': {
          const path = typeof request.name === 'string' ? this.media.resolve(request.name) : null;
          if (!path) return notFoundResponse();
          const info = await stat(path).catch(() => null);
          if (!info || info.size > MAX_RELAYED_MEDIA_BYTES) return notFoundResponse();
          return { ok: true, data: (await readFile(path)).toString('base64') };
        }
        default:
          return badRequest();
      }
    } catch (error) {
      if (error instanceof HttpException) {
        // Seuls le code et le message repartent vers le cloud.
        const body = error.getResponse();
        const detail = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
        return {
          ok: false,
          status: error.getStatus(),
          error: {
            code: typeof detail.code === 'string' ? detail.code : `HTTP_${error.getStatus()}`,
            message: typeof detail.message === 'string' ? detail.message : error.message,
          },
        };
      }
      this.logger.error(`Demande relayée en échec : ${String(error)}`);
      return { ok: false, status: 500, error: { code: 'INTERNAL', message: 'Erreur interne' } };
    }
  }

  /** Le jeton doit désigner un QR code de CE site : le cloud ne peut pas viser un autre établissement. */
  private async assertOwnQr(token: string): Promise<void> {
    const qr = await this.qr.resolveQr(token);
    if (qr.siteId !== this.config.SITE_ID)
      throw new HttpException({ code: 'NOT_FOUND', message: 'Menu introuvable' }, 404);
  }
}

const badRequest = (): RpcResponse => ({
  ok: false,
  status: 400,
  error: { code: 'VALIDATION_FAILED', message: 'Données invalides' },
});
const notFoundResponse = (): RpcResponse => ({
  ok: false,
  status: 404,
  error: { code: 'NOT_FOUND', message: 'Introuvable' },
});
