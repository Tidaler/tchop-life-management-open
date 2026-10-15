import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import { type CustomerCreateInput, type CustomerUpdateInput, type SettlementInput } from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { BillsService } from '../cash/bills.service.js';
import { CashService } from '../cash/cash.service.js';
import { assertReferenceFree } from '../cash/reference.js';
import { notFound, versionConflict } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Clients à ardoise. Données au strict minimum (nom, téléphone facultatif, plafond).
 * Le solde est toujours la somme des écritures ; il ne se modifie jamais directement.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cash: CashService,
    private readonly bills: BillsService,
  ) {}

  async list(auth: AuthContext) {
    const customers = await this.prisma.customer.findMany({
      where: { siteId: auth.siteId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const balances = await this.prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: { customerId: { in: customers.map((c) => c.id) } },
      _sum: { amountXaf: true },
    });
    const byId = new Map(balances.map((b) => [b.customerId, b._sum.amountXaf ?? 0]));
    return customers.map((c) => this.toCustomer(c, byId.get(c.id) ?? 0));
  }

  async get(auth: AuthContext, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, siteId: auth.siteId },
      include: { ledger: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
    if (!customer) throw notFound('Client');
    const balance = await this.bills.balance(this.prisma, id);
    return {
      ...this.toCustomer(customer, balance),
      ledger: customer.ledger.map((e) => ({
        id: e.id,
        type: e.type,
        amountXaf: e.amountXaf,
        method: e.method,
        reference: e.reference,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  }

  async create(auth: AuthContext, input: CustomerCreateInput) {
    const customer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({ data: { siteId: auth.siteId, ...input } });
      // Pas de téléphone dans le journal : seulement ce qui est utile au contrôle.
      await this.log(tx, auth, 'customer.created', created.id, { creditLimitXaf: input.creditLimitXaf });
      return created;
    });
    return this.toCustomer(customer, 0);
  }

  async update(auth: AuthContext, id: string, input: CustomerUpdateInput) {
    const { version, ...data } = input;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.customer.findFirst({ where: { id, siteId: auth.siteId } });
      if (!before) throw notFound('Client');
      const res = await tx.customer.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count !== 1) throw versionConflict();
      if (data.creditLimitXaf !== undefined && data.creditLimitXaf !== before.creditLimitXaf) {
        await this.log(
          tx,
          auth,
          'customer.limit_changed',
          id,
          { creditLimitXaf: data.creditLimitXaf },
          {
            creditLimitXaf: before.creditLimitXaf,
          },
        );
      }
      if (data.active !== undefined && data.active !== before.active) {
        await this.log(tx, auth, data.active ? 'customer.reactivated' : 'customer.deactivated', id);
      }
    });
    return this.get(auth, id);
  }

  /** Règlement d'ardoise, encaissé dans la session de caisse ouverte du caissier. */
  async settle(auth: AuthContext, id: string, input: SettlementInput) {
    await this.prisma.$transaction(async (tx) => {
      const session = await this.cash.requireOpenSession(tx, auth);
      await tx.$queryRaw`SELECT 1 FROM "cash_session" WHERE "id" = ${session.id}::uuid AND "status" = 'open' FOR SHARE`;
      const customer = await tx.customer.findFirst({ where: { id, siteId: auth.siteId } });
      if (!customer) throw notFound('Client');
      await tx.$queryRaw`SELECT 1 FROM "customer" WHERE "id" = ${id}::uuid FOR UPDATE`;

      // Renvoi de la même requête : rien de plus.
      if (
        await tx.customerLedgerEntry.count({
          where: { customerId: id, idempotencyKey: input.idempotencyKey },
        })
      ) {
        return;
      }
      const balance = await this.bills.balance(tx, id);
      if (input.amountXaf > balance) {
        throw new HttpException(
          { code: 'OVERPAYMENT', message: 'Montant supérieur au solde de l’ardoise', remainingXaf: balance },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (input.reference) await assertReferenceFree(tx, auth.siteId, input.method, input.reference);

      const entry = await tx.customerLedgerEntry.create({
        data: {
          customerId: id,
          type: 'payment',
          amountXaf: -input.amountXaf,
          sessionId: session.id,
          method: input.method,
          reference: input.reference ?? null,
          createdById: auth.userId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await this.log(tx, auth, 'customer.settled', id, {
        entryId: entry.id,
        method: input.method,
        amountXaf: input.amountXaf,
        reference: input.reference,
      });
    });
    return this.get(auth, id);
  }

  private toCustomer(c: Prisma.CustomerGetPayload<object>, balance: number) {
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      note: c.note,
      creditLimitXaf: c.creditLimitXaf,
      balanceXaf: balance,
      availableXaf: Math.max(0, c.creditLimitXaf - balance),
      active: c.active,
      version: c.version,
    };
  }

  private log(tx: Tx, auth: AuthContext, action: string, id: string, after?: object, before?: object) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity: 'customer',
        entityId: id,
        after: after as Prisma.InputJsonValue | undefined,
        before: before as Prisma.InputJsonValue | undefined,
      },
      tx,
    );
  }
}
