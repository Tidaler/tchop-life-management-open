import { Injectable, Logger } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import { PrismaService } from '../prisma.service.js';

export interface AuditEntry {
  tenantId: string;
  siteId?: string | null;
  actorId?: string | null;
  approverId?: string | null;
  deviceId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
  ip?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Ajoute une entrée au journal. `tx` permet d'écrire dans la même transaction que l'action tracée. */
  async log(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.auditLog.create({ data: entry });
    this.logger.debug(`${entry.action} ${entry.entity ?? ''} ${entry.entityId ?? ''}`.trim());
  }
}
