import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cancelLineSchema,
  type CancelLineInput,
  sendOrderSchema,
  type SendOrderInput,
  STATIONS,
  type Station,
  ticketStatusSchema,
  type TicketStatusInput,
  transferOrderSchema,
  type TransferOrderInput,
} from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { OrdersService } from './orders.service.js';

const uuid = new ParseUUIDPipe();

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly approval: ApprovalService,
  ) {}

  /** Gérants présents pouvant approuver une annulation (choix dans la fenêtre d'approbation). */
  @Get('approvers')
  @RequirePermission('order.line.cancel', 'read')
  approvers(@CurrentAuth() auth: AuthContext) {
    return this.approval.listApprovers(auth);
  }

  @Get('open')
  @RequirePermission('order.view', 'read')
  listOpen(@CurrentAuth() auth: AuthContext) {
    return this.orders.listOpen(auth);
  }

  @Get(':id')
  @RequirePermission('order.view', 'read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.orders.get(auth, id);
  }

  @Post('send')
  @HttpCode(200)
  @RequirePermission('order.create')
  send(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(sendOrderSchema)) body: SendOrderInput) {
    return this.orders.send(auth, body);
  }

  @Post(':id/lines/:lineId/cancel')
  @HttpCode(200)
  @RequirePermission('order.line.cancel')
  cancelLine(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('lineId', uuid) lineId: string,
    @Body(new ZodPipe(cancelLineSchema)) body: CancelLineInput,
  ) {
    return this.orders.cancelLine(auth, id, lineId, body);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @RequirePermission('order.transfer')
  transfer(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(transferOrderSchema)) body: TransferOrderInput,
  ) {
    return this.orders.transfer(auth, id, body);
  }
}

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequirePermission('ticket.update', 'read')
  list(@CurrentAuth() auth: AuthContext, @Query('station') station?: string) {
    const filter = STATIONS.includes(station as Station) ? (station as Station) : undefined;
    return this.tickets.listActive(auth, filter);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('ticket.update')
  updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(ticketStatusSchema)) body: TicketStatusInput,
  ) {
    return this.tickets.updateStatus(auth, id, body);
  }

  @Post(':id/reprint')
  @HttpCode(202)
  @RequirePermission('ticket.update')
  reprint(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.tickets.reprint(auth, id);
  }
}
