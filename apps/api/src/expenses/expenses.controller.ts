import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  expenseCategoryCreateSchema,
  type ExpenseCategoryCreateInput,
  expenseCategoryUpdateSchema,
  type ExpenseCategoryUpdateInput,
  expenseCreateSchema,
  type ExpenseCreateInput,
  expensesQuerySchema,
  type ExpensesQuery,
  expenseVoidSchema,
  type ExpenseVoidInput,
} from '@tchop/shared';
import type { Response } from 'express';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MAX_UPLOAD_BYTES } from '../media/media.service.js';
import { ExpensesService } from './expenses.service.js';

const uuid = new ParseUUIDPipe();

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('categories')
  @RequirePermission('expense.create', 'read')
  categories(@CurrentAuth() auth: AuthContext, @Query('includeArchived') includeArchived?: string) {
    return this.expenses.categories(auth, includeArchived === 'true');
  }

  @Post('categories')
  @RequirePermission('site.settings')
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(expenseCategoryCreateSchema)) body: ExpenseCategoryCreateInput,
  ) {
    return this.expenses.createCategory(auth, body);
  }

  @Patch('categories/:id')
  @RequirePermission('site.settings')
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(expenseCategoryUpdateSchema)) body: ExpenseCategoryUpdateInput,
  ) {
    return this.expenses.updateCategory(auth, id, body);
  }

  /** Dépenses de la période (toutes avec expense.view, sinon seulement les siennes). */
  @Get()
  @RequirePermission('expense.create', 'read')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(expensesQuerySchema)) query: ExpensesQuery) {
    return this.expenses.list(auth, query);
  }

  @Get(':id')
  @RequirePermission('expense.create', 'read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.expenses.get(auth, id);
  }

  @Post()
  @RequirePermission('expense.create')
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(expenseCreateSchema)) body: ExpenseCreateInput) {
    return this.expenses.create(auth, body);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission('expense.create')
  void(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(expenseVoidSchema)) body: ExpenseVoidInput,
  ) {
    return this.expenses.void(auth, id, body);
  }

  @Post(':id/attachment')
  @RequirePermission('expense.create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  attach(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ code: 'IMAGE_REQUIRED', message: 'Aucune image reçue' });
    return this.expenses.attach(auth, id, file.buffer);
  }

  /** Justificatif : servi seulement à qui peut voir la dépense, jamais mis en cache partagé. */
  @Get(':id/attachment')
  @RequirePermission('expense.create', 'read')
  async attachment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const path = await this.expenses.attachmentPath(auth, id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('image/webp').sendFile(path);
  }
}
