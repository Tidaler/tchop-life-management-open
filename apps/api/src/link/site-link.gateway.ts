import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { type Prisma } from '@tchop/db';
import { type Socket } from 'socket.io';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { sha256 } from '../common/crypto.js';
import { PrismaService } from '../prisma.service.js';
import { LINK_NAMESPACE, type RpcRequest, type RpcResponse, snapshotSchema } from './protocol.js';

/** Échecs d'authentification tolérés par adresse IP et par minute avant refus immédiat. */
const MAX_AUTH_FAILURES = 10;
/** Fréquence de revérification des sites connectés (accès révoqué, secret renouvelé). */
const RECHECK_MS = 30_000;

const sameSecret = (secret: string, expectedHash: string): boolean => {
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Côté cloud : accueille les connexions des serveurs locaux. Un site s'authentifie avec son identifiant
 * et son secret (vérifié en temps constant contre l'empreinte stockée). Une seule connexion par site.
 */
@Injectable()
@WebSocketGateway({
  path: '/api/socket.io',
  namespace: LINK_NAMESPACE,
  serveClient: false,
  cors: false,
  maxHttpBufferSize: 1_000_000,
})
export class SiteLinkGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SiteLinkGateway.name);
  private readonly sites = new Map<string, Socket>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  private recheckTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.recheckTimer = setInterval(() => void this.recheckLinks().catch(() => undefined), RECHECK_MS);
    this.recheckTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.recheckTimer);
  }

  /**
   * Coupe les connexions dont l'accès a été révoqué ou dont le secret a été renouvelé depuis la connexion
   * (l'outil d'enregistrement tourne dans un autre processus : la coupure se fait ici).
   */
  async recheckLinks(): Promise<void> {
    if (this.sites.size === 0) return;
    const links = await this.prisma.siteLink.findMany({ where: { siteId: { in: [...this.sites.keys()] } } });
    const valid = new Map(links.filter((l) => !l.revokedAt).map((l) => [l.siteId, l.secretHash]));
    for (const [siteId, socket] of this.sites) {
      if (valid.get(siteId) === socket.data.secretHash) continue;
      this.sites.delete(siteId);
      socket.disconnect(true);
      this.logger.warn(`Lien du site ${siteId} coupé : accès révoqué ou secret renouvelé`);
    }
  }

  isConnected(siteId: string): boolean {
    return !!this.sites.get(siteId)?.connected;
  }

  async handleConnection(client: Socket): Promise<void> {
    const ip = client.handshake.address;
    const failure = this.failures.get(ip);
    if (failure && Date.now() - failure.since < 60_000 && failure.count >= MAX_AUTH_FAILURES) {
      return void client.disconnect(true);
    }
    const { siteId, secret } = (client.handshake.auth ?? {}) as { siteId?: unknown; secret?: unknown };
    const link =
      typeof siteId === 'string' && /^[0-9a-f-]{36}$/.test(siteId)
        ? await this.prisma.siteLink.findUnique({ where: { siteId } })
        : null;
    if (!link || link.revokedAt || typeof secret !== 'string' || !sameSecret(secret, link.secretHash)) {
      const current =
        failure && Date.now() - failure.since < 60_000 ? failure : { count: 0, since: Date.now() };
      this.failures.set(ip, { ...current, count: current.count + 1 });
      this.logger.warn(`Connexion de site refusée (${ip})`);
      return void client.disconnect(true);
    }

    client.data.siteId = link.siteId;
    client.data.secretHash = link.secretHash;
    const previous = this.sites.get(link.siteId);
    this.sites.set(link.siteId, client);
    if (previous && previous.id !== client.id) previous.disconnect(true);
    await this.prisma.siteLink.update({ where: { siteId: link.siteId }, data: { lastSeenAt: new Date() } });
    this.logger.log(`Site relié : ${link.name}`);
  }

  handleDisconnect(client: Socket): void {
    const siteId = client.data.siteId as string | undefined;
    if (siteId && this.sites.get(siteId)?.id === client.id) this.sites.delete(siteId);
  }

  /** Copie du menu envoyée par un site authentifié. L'identifiant du site vient de la connexion, jamais du message. */
  @SubscribeMessage('snapshot')
  async onSnapshot(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean }> {
    const siteId = client.data.siteId as string | undefined;
    if (!siteId) return { ok: false };
    const parsed = snapshotSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`Copie de menu invalide reçue du site ${siteId}`);
      return { ok: false };
    }
    const { menu, routes, media } = parsed.data;
    const payload = menu as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.cloudMenuSnapshot.upsert({
        where: { siteId },
        create: { siteId, payload, hash: sha256(JSON.stringify(menu)) },
        update: { payload, hash: sha256(JSON.stringify(menu)) },
      });
      await tx.cloudQrRoute.deleteMany({ where: { siteId } });
      // Un jeton déjà routé vers un autre site n'est jamais détourné.
      const taken = await tx.cloudQrRoute.findMany({
        where: { tokenHash: { in: routes.map((r) => r.tokenHash) } },
        select: { tokenHash: true },
      });
      const takenSet = new Set(taken.map((t) => t.tokenHash));
      await tx.cloudQrRoute.createMany({
        data: routes.filter((r) => !takenSet.has(r.tokenHash)).map((r) => ({ ...r, siteId })),
      });
      await tx.cloudMediaRoute.deleteMany({ where: { siteId } });
      await tx.cloudMediaRoute.createMany({
        data: media.map((name) => ({ name, siteId })),
        skipDuplicates: true,
      });
      await tx.siteLink.update({ where: { siteId }, data: { lastSeenAt: new Date() } });
    });
    return { ok: true };
  }

  /** Demande relayée vers un site. Hors ligne ou sans réponse dans le délai : erreur « site indisponible ». */
  async rpc(siteId: string, request: RpcRequest): Promise<RpcResponse> {
    const socket = this.sites.get(siteId);
    const offline: RpcResponse = {
      ok: false,
      status: 503,
      error: { code: 'SITE_OFFLINE', message: "L'établissement est momentanément injoignable" },
    };
    if (!socket?.connected) return offline;
    try {
      return (await socket
        .timeout(this.config.LINK_RPC_TIMEOUT_MS)
        .emitWithAck('rpc', request)) as RpcResponse;
    } catch {
      return offline;
    }
  }
}
