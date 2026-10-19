import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@tchop/db';
import {
  businessDay,
  can,
  type ExpenseCategoryCreateInput,
  type ExpenseCategoryUpdateInput,
  type ExpenseCreateInput,
  type ExpensesQuery,
  type ExpenseVoidInput,
  needsApproval,
} from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CashService } from '../cash/cash.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { nextCounter, toDbDate } from '../common/counters.js';
import { isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { siteThresholds } from '../common/site-settings.js';
import { MediaService } from '../media/media.service.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

const ATTACHMENTS = 'expenses';

const expenseInclude = {
  category: { select: { id: true, name: true, kind: true } },
} satisfies Prisma.ExpenseInclude;
type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

/**
 * Dépenses : saisies avec motif et catégorie, jamais supprimées (annulation tracée).
 * Payée depuis la caisse, une dépense réduit les espèces attendues à la clôture de la session.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approval: ApprovalService,
    private readonly cash: CashService,
    private readonly media: MediaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ catégories

  categories(auth: AuthContext, includeArchived = false) {
    return this.prisma.expenseCategory
      .findMany({
        where: { siteId: auth.siteId, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })
      .then((rows) =>
        rows.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          archived: !!c.archivedAt,
          version: c.version,
        })),
      );
  }

  async createCategory(auth: AuthContext, input: ExpenseCategoryCreateInput) {
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const category = await tx.expenseCategory.create({ data: { siteId: auth.siteId, ...input } });
        await this.log(tx, auth, 'expense.category_created', 'expense_category', category.id, {
          after: input,
        });
        return category;
      });
      return {
        id: created.id,
        name: created.name,
        kind: created.kind,
        archived: false,
        version: created.version,
      };
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async updateCategory(auth: AuthContext, id: string, input: ExpenseCategoryUpdateInput) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const category = await tx.expenseCategory.findFirst({ where: { id, siteId: auth.siteId } });
        if (!category) throw notFound('Catégorie');
        const { version, archived, ...fields } = input;
        const { count } = await tx.expenseCategory.updateMany({
          where: { id, version },
          data: {
            ...fields,
            archivedAt: archived === undefined ? undefined : archived ? new Date() : null,
            version: { increment: 1 },
          },
        });
        if (count === 0) throw versionConflict();
        await this.log(tx, auth, 'expense.category_updated', 'expense_category', id, {
          before: { name: category.name, kind: category.kind, archived: !!category.archivedAt },
          after: {
            name: input.name ?? category.name,
            kind: input.kind ?? category.kind,
            archived: archived ?? !!category.archivedAt,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    return (await this.categories(auth, true)).find((c) => c.id === id);
  }

  // ------------------------------------------------------------------ dépenses

  /** Dépenses de la période. Sans droit de consultation, seulement les siennes. */
  async list(auth: AuthContext, query: ExpensesQuery) {
    const rows = await this.prisma.expense.findMany({
      where: {
        siteId: auth.siteId,
        businessDay: { gte: toDbDate(query.from), lte: toDbDate(query.to) },
        categoryId: query.categoryId,
        ...(can(auth.grants, 'expense.view', 'read') ? {} : { createdById: auth.userId }),
      },
      include: expenseInclude,
      orderBy: [{ businessDay: 'desc' }, { number: 'desc' }],
      take: 500,
    });
    const names = await this.userNames(rows.flatMap((r) => [r.createdById, r.approvedById, r.voidedById]));
    const expenses = rows.map((r) => this.toExpense(r, names));
    const recorded = expenses.filter((e) => e.status === 'recorded');
    return {
      expenses,
      totalXaf: recorded.reduce((s, e) => s + e.amountXaf, 0),
      byCategory: Object.values(
        recorded.reduce<Record<string, { categoryId: string; name: string; amountXaf: number }>>((acc, e) => {
          acc[e.category.id] ??= { categoryId: e.category.id, name: e.category.name, amountXaf: 0 };
          acc[e.category.id]!.amountXaf += e.amountXaf;
          return acc;
        }, {}),
      ).sort((a, b) => b.amountXaf - a.amountXaf),
    };
  }

  async create(auth: AuthContext, input: ExpenseCreateInput) {
    const replay = await this.findReplay(auth, input.idempotencyKey);
    if (replay) return replay;
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
        const today = businessDay(new Date(), site.timezone, this.config.BUSINESS_DAY_CUTOFF_HOUR);
        const day = input.date ?? today;
        if (day > today) {
          throw new BadRequestException({
            code: 'FUTURE_DATE',
            message: 'Une dépense ne peut pas être datée dans le futur',
          });
        }
        const category = await tx.expenseCategory.findFirst({
          where: { id: input.categoryId, siteId: auth.siteId, archivedAt: null },
        });
        if (!category) throw notFound('Catégorie');
        if (input.supplierId) {
          const supplier = await tx.supplier.count({ where: { id: input.supplierId, siteId: auth.siteId } });
          if (!supplier) throw notFound('Fournisseur');
        }

        // Espèces prises dans la caisse : session ouverte de l'utilisateur, verrouillée contre une clôture simultanée.
        let sessionId: string | null = null;
        if (input.fromCashSession) {
          const session = await this.cash.requireOpenSession(tx, auth);
          const [locked] = await tx.$queryRaw<{ status: string }[]>`
            SELECT "status" FROM "cash_session" WHERE "id" = ${session.id}::uuid FOR SHARE`;
          if (locked?.status !== 'open') {
            throw new ConflictException({
              code: 'NO_OPEN_SESSION',
              message: "Ouvrez d'abord votre session de caisse",
            });
          }
          if (day !== today) {
            throw new BadRequestException({
              code: 'CASH_EXPENSE_TODAY',
              message: "Une dépense payée depuis la caisse est datée d'aujourd'hui",
            });
          }
          sessionId = session.id;
        }

        // Au-delà du seuil du site, un rôle limité (caissier) doit faire approuver par un gérant.
        const level = needsApproval(auth.grants, 'expense.create');
        const over =
          level === 'always' ||
          (level === 'over_threshold' && input.amountXaf > siteThresholds(site.settings).expenseXaf);
        const approvedById = over ? await this.approval.requireApprover(auth, input.approval, tx) : null;

        const expense = await tx.expense.create({
          data: {
            siteId: auth.siteId,
            number: await nextCounter(tx, auth.siteId, 'expense'),
            categoryId: category.id,
            businessDay: toDbDate(day),
            amountXaf: input.amountXaf,
            method: input.method,
            sessionId,
            supplierId: input.supplierId,
            description: input.description,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            createdById: auth.userId,
            approvedById,
          },
        });
        await this.log(tx, auth, 'expense.recorded', 'expense', expense.id, {
          after: {
            number: expense.number,
            category: category.name,
            amountXaf: input.amountXaf,
            method: input.method,
            fromCashSession: !!sessionId,
            day,
          },
          reason: input.description,
          approverId: approvedById,
        });
        return expense.id;
      });
      return this.get(auth, id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.findReplay(auth, input.idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  /**
   * Annulation : motif obligatoire ; approbation d'un gérant pour un rôle limité au seuil.
   * Une dépense prise dans une caisse déjà clôturée ne s'annule plus (le rapport Z est figé).
   */
  async void(auth: AuthContext, id: string, input: ExpenseVoidInput) {
    await this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findFirst({ where: { id, siteId: auth.siteId } });
      if (!expense) throw notFound('Dépense');
      if (expense.status === 'voided') {
        throw new ConflictException({ code: 'ALREADY_VOIDED', message: 'Dépense déjà annulée' });
      }
      if (expense.sessionId) {
        const [session] = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status" FROM "cash_session" WHERE "id" = ${expense.sessionId}::uuid FOR SHARE`;
        if (session?.status !== 'open') {
          throw new ConflictException({
            code: 'SESSION_CLOSED',
            message: 'La caisse de cette dépense est clôturée : la dépense ne peut plus être annulée',
          });
        }
      }
      const level = needsApproval(auth.grants, 'expense.create');
      const approverId =
        level === 'never' ? null : await this.approval.requireApprover(auth, input.approval, tx);
      const { count } = await tx.expense.updateMany({
        where: { id, status: 'recorded' },
        data: {
          status: 'voided',
          voidedAt: new Date(),
          voidedById: auth.userId,
          voidApprovedById: approverId,
          voidReason: input.reason,
          version: { increment: 1 },
        },
      });
      if (count === 0)
        throw new ConflictException({ code: 'ALREADY_VOIDED', message: 'Dépense déjà annulée' });
      await this.log(tx, auth, 'expense.voided', 'expense', id, {
        before: { number: expense.number, amountXaf: expense.amountXaf },
        reason: input.reason,
        approverId,
      });
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: {
        id,
        siteId: auth.siteId,
        ...(can(auth.grants, 'expense.view', 'read') ? {} : { createdById: auth.userId }),
      },
      include: expenseInclude,
    });
    if (!row) throw notFound('Dépense');
    return this.toExpense(row, await this.userNames([row.createdById, row.approvedById, row.voidedById]));
  }

  // ------------------------------------------------------------------ justificatif

  /** Justificatif : image réencodée, rangée hors du dossier public ; remplace le précédent. */
  async attach(auth: AuthContext, id: string, buffer: Buffer) {
    const expense = await this.prisma.expense.findFirst({
      where: {
        id,
        siteId: auth.siteId,
        ...(can(auth.grants, 'expense.view', 'read') ? {} : { createdById: auth.userId }),
      },
    });
    if (!expense) throw notFound('Dépense');
    const name = await this.media.savePrivateImage(buffer, ATTACHMENTS);
    await this.prisma.$transaction(async (tx) => {
      await tx.expense.update({ where: { id }, data: { attachment: name, version: { increment: 1 } } });
      await this.log(tx, auth, 'expense.attachment_added', 'expense', id, {
        after: { number: expense.number },
      });
    });
    if (expense.attachment) await this.media.removePrivate(ATTACHMENTS, expense.attachment);
    return this.get(auth, id);
  }

  /** Chemin du justificatif, pour un utilisateur qui a le droit de voir la dépense. */
  async attachmentPath(auth: AuthContext, id: string): Promise<string> {
    const expense = await this.prisma.expense.findFirst({
      where: {
        id,
        siteId: auth.siteId,
        ...(can(auth.grants, 'expense.view', 'read') ? {} : { createdById: auth.userId }),
      },
    });
    const path = expense?.attachment ? this.media.resolvePrivate(ATTACHMENTS, expense.attachment) : null;
    if (!path) throw notFound('Justificatif');
    return path;
  }

  // ------------------------------------------------------------------ outils

  private async findReplay(auth: AuthContext, key: string) {
    const found = await this.prisma.expense.findUnique({
      where: { siteId_idempotencyKey: { siteId: auth.siteId, idempotencyKey: key } },
    });
    if (!found) return null;
    if (found.createdById !== auth.userId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Clé de requête déjà utilisée',
      });
    }
    return this.get(auth, found.id);
  }

  private toExpense(row: ExpenseRow, names: Map<string, string>) {
    return {
      id: row.id,
      number: row.number,
      date: row.businessDay.toISOString().slice(0, 10),
      category: row.category,
      amountXaf: row.amountXaf,
      method: row.method,
      fromCashSession: !!row.sessionId,
      description: row.description,
      reference: row.reference,
      hasAttachment: !!row.attachment,
      status: row.status,
      createdBy: names.get(row.createdById) ?? null,
      approvedBy: row.approvedById ? (names.get(row.approvedById) ?? null) : null,
      voidedBy: row.voidedById ? (names.get(row.voidedById) ?? null) : null,
      voidReason: row.voidReason,
      createdAt: row.createdAt,
    };
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private log(
    tx: Tx,
    auth: AuthContext,
    action: string,
    entity: string,
    entityId: string,
    extra: {
      before?: Prisma.InputJsonValue;
      after?: Prisma.InputJsonValue;
      reason?: string;
      approverId?: string | null;
    } = {},
  ) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity,
        entityId,
        ...extra,
      },
      tx,
    );
  }
}

const nameTaken = () => new ConflictException({ code: 'NAME_TAKEN', message: 'Ce nom est déjà utilisé' });
