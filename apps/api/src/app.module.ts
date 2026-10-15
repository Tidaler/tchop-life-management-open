import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApprovalService } from './approval/approval.service.js';
import { AuditService } from './audit/audit.service.js';
import { BillsService } from './cash/bills.service.js';
import { BillsController, CashController, CustomersController } from './cash/cash.controllers.js';
import { CashService } from './cash/cash.service.js';
import { CustomersService } from './customers/customers.service.js';
import { EventsGateway, EventsService } from './events/events.gateway.js';
import { OrdersController, TicketsController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { PricingService } from './orders/pricing.service.js';
import { PrintService } from './printing/print.service.js';
import { PrintersController } from './printing/printers.controller.js';
import { TicketsService } from './tickets/tickets.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { FloorController } from './floor/floor.controller.js';
import { FloorService } from './floor/floor.service.js';
import { MediaController } from './media/media.controller.js';
import { MediaService } from './media/media.service.js';
import { AccessService } from './auth/access.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { AUTH_RATE_LIMITED, PUBLIC_ORDER_RATE_LIMITED, PUBLIC_RATE_LIMITED } from './auth/decorators.js';
import { TokensService } from './auth/tokens.service.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { HealthController } from './health/health.controller.js';
import { CloudMenuService, PUBLIC_MENU_BACKEND } from './link/cloud-menu.service.js';
import { SiteLinkClient } from './link/site-link.client.js';
import { SiteLinkGateway } from './link/site-link.gateway.js';
import { PrismaService } from './prisma.service.js';
import { PublicMenuController, QrRequestsController } from './qr/qr.controllers.js';
import { QrRequestsService } from './qr/qr-requests.service.js';

const reflector = new Reflector();

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        JwtModule.register({ secret: config.JWT_SECRET, signOptions: { algorithm: 'HS256' } }),
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 600 },
          {
            name: 'auth',
            ttl: 60_000,
            limit: config.AUTH_RATE_LIMIT,
            skipIf: (ctx) => !reflector.get<boolean | undefined>(AUTH_RATE_LIMITED, ctx.getHandler()),
          },
          {
            name: 'public',
            ttl: 60_000,
            limit: config.PUBLIC_RATE_LIMIT,
            skipIf: (ctx) => !reflector.get<boolean | undefined>(PUBLIC_RATE_LIMITED, ctx.getHandler()),
          },
          {
            name: 'public-order',
            ttl: 60_000,
            limit: config.PUBLIC_ORDER_RATE_LIMIT,
            skipIf: (ctx) => !reflector.get<boolean | undefined>(PUBLIC_ORDER_RATE_LIMITED, ctx.getHandler()),
          },
        ]),
      ],
      controllers: [
        HealthController,
        AuthController,
        DevicesController,
        CatalogController,
        FloorController,
        MediaController,
        OrdersController,
        TicketsController,
        PrintersController,
        PublicMenuController,
        QrRequestsController,
        CashController,
        BillsController,
        CustomersController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        PrismaService,
        AuditService,
        AccessService,
        TokensService,
        AuthService,
        DevicesService,
        CatalogService,
        FloorService,
        MediaService,
        ApprovalService,
        EventsGateway,
        EventsService,
        PrintService,
        OrdersService,
        TicketsService,
        PricingService,
        QrRequestsService,
        CashService,
        BillsService,
        CustomersService,
        // Menu QR : servi par le site lui-même, ou par le cloud qui relaie vers les sites.
        ...(config.API_MODE === 'cloud'
          ? [
              SiteLinkGateway,
              CloudMenuService,
              { provide: PUBLIC_MENU_BACKEND, useExisting: CloudMenuService },
            ]
          : [SiteLinkClient, { provide: PUBLIC_MENU_BACKEND, useExisting: QrRequestsService }]),
        // Ordre des gardes : limitation de débit, puis identification et permissions.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
