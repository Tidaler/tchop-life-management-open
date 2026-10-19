import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  refundSchema,
  type RefundInput,
  applyDiscountSchema,
  type ApplyDiscountInput,
  closeSessionSchema,
  type CloseSessionInput,
  createBillSchema,
  type CreateBillInput,
  customerCreateSchema,
  type CustomerCreateInput,
  customerUpdateSchema,
  type CustomerUpdateInput,
  openSessionSchema,
  type OpenSessionInput,
  paymentSchema,
  type PaymentInput,
  settlementSchema,
  type SettlementInput,
  voidPaymentSchema,
  type VoidPaymentInput,
} from '@tchop/shared';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CustomersService } from '../customers/customers.service.js';
import { RefundsService } from './refunds.service.js';
import { BillsService } from './bills.service.js';
import { CashService } from './cash.service.js';

const uuid = new ParseUUIDPipe();

@Controller('cash')
export class CashController {
  constructor(
    private readonly cash: CashService,
    private readonly bills: BillsService,
  ) {}

  @Get('registers')
  @RequirePermission('cash_session.manage', 'read')
  registers(@CurrentAuth() auth: AuthContext) {
    return this.cash.registers(auth);
  }

  /** Session ouverte de l'utilisateur, avec ses totaux en cours (lecture X). */
  @Get('sessions/current')
  @RequirePermission('cash_session.manage', 'read')
  current(@CurrentAuth() auth: AuthContext) {
    return this.cash.current(auth);
  }

  @Post('sessions')
  @RequirePermission('cash_session.manage')
  open(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(openSessionSchema)) body: OpenSessionInput) {
    return this.cash.open(auth, body);
  }

  @Post('sessions/:id/close')
  @HttpCode(200)
  @RequirePermission('cash_session.manage')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(closeSessionSchema)) body: CloseSessionInput,
  ) {
    return this.cash.close(auth, id, body);
  }

  /** Additions ouvertes, à encaisser. */
  @Get('bills')
  @RequirePermission('payment.record', 'read')
  openBills(@CurrentAuth() auth: AuthContext) {
    return this.bills.listOpen(auth);
  }

  /** Paiements électroniques en attente de rapprochement. */
  @Get('payments/to-verify')
  @RequirePermission('payment.verify', 'read')
  toVerify(@CurrentAuth() auth: AuthContext) {
    return this.bills.toVerify(auth);
  }
}

@Controller()
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get('orders/:id/billable')
  @RequirePermission('order.view', 'read')
  billable(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.bills.billable(auth, id);
  }

  /** Addition (pré-addition) : le serveur peut la préparer, le caissier l'encaisse. */
  @Post('orders/:id/bills')
  @RequirePermission('bill.prepare')
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(createBillSchema)) body: CreateBillInput,
  ) {
    return this.bills.create(auth, id, body);
  }

  @Get('bills/:id')
  @RequirePermission('order.view', 'read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.bills.get(auth, id);
  }

  @Post('bills/:id/discount')
  @HttpCode(200)
  @RequirePermission('discount.apply')
  discount(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(applyDiscountSchema)) body: ApplyDiscountInput,
  ) {
    return this.bills.applyDiscount(auth, id, body);
  }

  @Post('bills/:id/void')
  @HttpCode(204)
  @RequirePermission('bill.prepare')
  async void(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.bills.void(auth, id);
  }

  @Post('bills/:id/payments')
  @HttpCode(200)
  @RequirePermission('payment.record')
  pay(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(paymentSchema)) body: PaymentInput,
  ) {
    return this.bills.pay(auth, id, body);
  }

  @Post('payments/:id/void')
  @HttpCode(204)
  @RequirePermission('payment.void')
  async voidPayment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(voidPaymentSchema)) body: VoidPaymentInput,
  ): Promise<void> {
    await this.bills.voidPayment(auth, id, body);
  }

  @Post('payments/:id/verify')
  @HttpCode(204)
  @RequirePermission('payment.verify')
  async verify(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.bills.verifyPayment(auth, id);
  }

  @Get('receipts/:id')
  @RequirePermission('receipt.reprint', 'read')
  receipt(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.bills.receipt(auth, id);
  }

  @Post('receipts/:id/reprint')
  @HttpCode(202)
  @RequirePermission('receipt.reprint')
  async reprint(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.bills.reprint(auth, id);
  }
}

/** Clients à ardoise. */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customer_credit.charge', 'read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.customers.list(auth);
  }

  @Get(':id')
  @RequirePermission('customer_credit.charge', 'read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.customers.get(auth, id);
  }

  @Post()
  @RequirePermission('customer.manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(customerCreateSchema)) body: CustomerCreateInput,
  ) {
    return this.customers.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('customer.manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(customerUpdateSchema)) body: CustomerUpdateInput,
  ) {
    return this.customers.update(auth, id, body);
  }

  @Post(':id/settlements')
  @HttpCode(200)
  @RequirePermission('payment.record')
  settle(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(settlementSchema)) body: SettlementInput,
  ) {
    return this.customers.settle(auth, id, body);
  }
}

/** Remboursements et avoirs : retrouver un reçu, rembourser tout ou partie, réimprimer l'avoir. */
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get('receipts/by-number/:number')
  @RequirePermission('refund.create', 'read')
  byReceipt(@CurrentAuth() auth: AuthContext, @Param('number', new ParseIntPipe()) number: number) {
    return this.refunds.byReceipt(auth, number);
  }

  @Get('refunds')
  @RequirePermission('refund.create', 'read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.refunds.list(auth);
  }

  @Post('bills/:id/refunds')
  @RequirePermission('refund.create')
  refund(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(refundSchema)) body: RefundInput,
  ) {
    return this.refunds.refund(auth, id, body);
  }

  @Post('refunds/:id/reprint')
  @HttpCode(204)
  @RequirePermission('refund.create')
  async reprint(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.refunds.reprint(auth, id);
  }
}
