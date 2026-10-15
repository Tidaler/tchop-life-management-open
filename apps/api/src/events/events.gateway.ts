import { Injectable, Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { type Server, type Socket } from 'socket.io';
import { sha256 } from '../common/crypto.js';
import { TokensService } from '../auth/tokens.service.js';
import { PrismaService } from '../prisma.service.js';

/** Événements temps réel : ils signalent seulement « ceci a changé », l'écran recharge ensuite via l'API. */
export type RealtimeEvent =
  | { type: 'orders.changed'; orderId: string; tableId: string | null }
  | { type: 'tickets.changed'; ticketId: string; station: string }
  | { type: 'catalog.changed' }
  | { type: 'qr.changed'; tableId: string | null }
  | { type: 'bills.changed'; orderId: string }
  | { type: 'stock.changed' };

const siteRoom = (siteId: string) => `site:${siteId}`;

/**
 * Connexion WebSocket du personnel (path /api/socket.io). Authentification par le jeton d'accès
 * et, pour une session PIN, par le jeton de l'appareil, comme pour l'API HTTP.
 */
@WebSocketGateway({ path: '/api/socket.io', serveClient: false, cors: false })
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const auth = client.handshake.auth as { token?: unknown; deviceToken?: unknown };
    const payload = typeof auth.token === 'string' ? await this.tokens.verifyAccessToken(auth.token) : null;
    if (!payload) return void client.disconnect(true);

    const session = await this.prisma.authSession.findUnique({ where: { id: payload.sess } });
    if (!session || session.revokedAt) return void client.disconnect(true);
    if (payload.did) {
      const device =
        typeof auth.deviceToken === 'string'
          ? await this.prisma.device.findUnique({ where: { tokenHash: sha256(auth.deviceToken) } })
          : null;
      if (!device || device.revokedAt || device.id !== payload.did) return void client.disconnect(true);
    }
    await client.join(siteRoom(payload.sid));
  }

  emit(siteId: string, event: RealtimeEvent): void {
    // Le serveur n'existe pas encore si l'application n'écoute pas (certains tests) : on ignore.
    if (!this.server) return;
    this.server.to(siteRoom(siteId)).emit('change', event);
    this.logger.debug(`${event.type} → ${siteId}`);
  }
}

/** Point d'entrée pour publier un événement depuis les services métier. */
@Injectable()
export class EventsService {
  constructor(private readonly gateway: EventsGateway) {}

  emit(siteId: string, event: RealtimeEvent): void {
    this.gateway.emit(siteId, event);
  }
}
