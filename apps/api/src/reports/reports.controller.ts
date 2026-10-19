import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  auditQuerySchema,
  type AuditQuery,
  EXPORT_KINDS,
  type ExportKind,
  type Period,
  periodSchema,
} from '@tchop/shared';
import type { Response } from 'express';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuditViewService } from './audit-view.service.js';
import { ExportsService } from './exports.service.js';
import { ReportsService } from './reports.service.js';

const period = new ZodPipe(periodSchema);

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ExportsService,
  ) {}

  /** Tableau de bord : aujourd'hui par défaut, ou la période demandée. */
  @Get('dashboard')
  @RequirePermission('dashboard.view', 'read')
  dashboard(@CurrentAuth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.reports.dashboard(auth, query.from || query.to ? period.transform(query) : undefined);
  }

  @Get('sales')
  @RequirePermission('report.sales', 'read')
  sales(@CurrentAuth() auth: AuthContext, @Query(period) query: Period) {
    return this.reports.sales(auth, query);
  }

  @Get('cash')
  @RequirePermission('report.cash', 'read')
  cash(@CurrentAuth() auth: AuthContext, @Query(period) query: Period) {
    return this.reports.cashReport(auth, query);
  }

  @Get('finance')
  @RequirePermission('report.finance', 'read')
  finance(@CurrentAuth() auth: AuthContext, @Query(period) query: Period) {
    return this.reports.finance(auth, query);
  }

  /** Export CSV pour le comptable, téléchargé en pièce jointe. */
  @Get('export/:kind')
  @RequirePermission('export.accounting', 'read')
  async export(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Query(period) query: Period,
    @Res() res: Response,
  ): Promise<void> {
    if (!(EXPORT_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: "Type d'export inconnu" });
    }
    const { filename, csv } = await this.exports.export(auth, kind as ExportKind, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  }
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditViewService) {}

  @Get()
  @RequirePermission('audit.view', 'read')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(auditQuerySchema)) query: AuditQuery) {
    return this.audit.list(auth, query);
  }
}
