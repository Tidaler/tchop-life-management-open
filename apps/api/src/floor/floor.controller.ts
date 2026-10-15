import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  qrModeSchema,
  type QrModeInput,
  tableCreateSchema,
  type TableCreateInput,
  tableUpdateSchema,
  type TableUpdateInput,
  zoneCreateSchema,
  type ZoneCreateInput,
  zoneUpdateSchema,
  type ZoneUpdateInput,
} from '@tchop/shared';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { FloorService } from './floor.service.js';

const uuid = new ParseUUIDPipe();

@Controller('floor')
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @Get()
  @RequirePermission('order.view', 'read')
  get(@CurrentAuth() auth: AuthContext) {
    return this.floor.get(auth);
  }

  @Get('qr-codes')
  @RequirePermission('floor.manage', 'read')
  qrCodes(@CurrentAuth() auth: AuthContext) {
    return this.floor.qrCodes(auth);
  }

  @Post('zones')
  @RequirePermission('floor.manage')
  createZone(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(zoneCreateSchema)) body: ZoneCreateInput) {
    return this.floor.createZone(auth, body);
  }

  @Patch('zones/:id')
  @RequirePermission('floor.manage')
  updateZone(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(zoneUpdateSchema)) body: ZoneUpdateInput,
  ) {
    return this.floor.updateZone(auth, id, body);
  }

  @Post('zones/:id/archive')
  @HttpCode(204)
  @RequirePermission('floor.manage')
  async archiveZone(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.floor.archiveZone(auth, id);
  }

  @Post('tables')
  @RequirePermission('floor.manage')
  createTable(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(tableCreateSchema)) body: TableCreateInput,
  ) {
    return this.floor.createTable(auth, body);
  }

  @Patch('tables/:id')
  @RequirePermission('floor.manage')
  updateTable(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(tableUpdateSchema)) body: TableUpdateInput,
  ) {
    return this.floor.updateTable(auth, id, body);
  }

  @Post('tables/:id/archive')
  @HttpCode(204)
  @RequirePermission('floor.manage')
  async archiveTable(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.floor.archiveTable(auth, id);
  }

  @Post('tables/:id/qr/replace')
  @RequirePermission('floor.manage')
  replaceQr(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.floor.replaceQr(auth, id);
  }

  @Put('tables/:id/qr/mode')
  @RequirePermission('floor.manage')
  setQrMode(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(qrModeSchema)) body: QrModeInput,
  ) {
    return this.floor.setQrMode(auth, id, body);
  }
}
