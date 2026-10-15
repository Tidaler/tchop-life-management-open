import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditService } from './audit/audit.service.js';
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
import { AUTH_RATE_LIMITED } from './auth/decorators.js';
import { TokensService } from './auth/tokens.service.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { HealthController } from './health/health.controller.js';
import { PrismaService } from './prisma.service.js';

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
        ]),
      ],
      controllers: [
        HealthController,
        AuthController,
        DevicesController,
        CatalogController,
        FloorController,
        MediaController,
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
        // Ordre des gardes : limitation de débit, puis identification et permissions.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
