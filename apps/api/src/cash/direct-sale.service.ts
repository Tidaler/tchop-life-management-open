import { Injectable } from '@nestjs/common';
import { type DirectSaleInput } from '@tchop/shared';
import { type AuthContext } from '../common/request-context.js';
import { OrdersService } from '../orders/orders.service.js';
import { PrismaService } from '../prisma.service.js';
import { BillsService } from './bills.service.js';

/**
 * Vente directe à la caisse (comptoir, à emporter) : commande sans table, envoyée en préparation si
 * besoin, puis addition prête à encaisser. Mêmes règles que la salle (prix recalculés, stock, bons).
 */
@Injectable()
export class DirectSaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly bills: BillsService,
  ) {}

  async create(auth: AuthContext, input: DirectSaleInput) {
    const orderId = await this.orders.sendDirect(auth, input);
    // Renvoi après une coupure : l'addition déjà préparée est rendue telle quelle.
    const existing = await this.prisma.bill.findFirst({
      where: { orderId, siteId: auth.siteId, status: { not: 'voided' } },
      orderBy: { createdAt: 'desc' },
    });
    return existing ? this.bills.get(auth, existing.id) : this.bills.create(auth, orderId, {});
  }
}
