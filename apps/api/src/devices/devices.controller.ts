import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { type EnrollDeviceInput, enrollDeviceSchema } from '@tchop/shared';
import { AuthRateLimited, Public, RequireDevice, RequirePermission } from '../auth/decorators.js';
import {
  type AppRequest,
  type AuthContext,
  CurrentAuth,
  CurrentDevice,
  type DeviceContext,
} from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DevicesService } from './devices.service.js';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('enrollment-codes')
  @RequirePermission('device.manage')
  createEnrollmentCode(@CurrentAuth() auth: AuthContext) {
    return this.devices.createEnrollmentCode(auth);
  }

  @Post('enroll')
  @Public()
  @AuthRateLimited()
  enroll(@Body(new ZodPipe(enrollDeviceSchema)) body: EnrollDeviceInput, @Req() req: AppRequest) {
    return this.devices.enroll(body, req.ip);
  }

  /** Appareil courant : site et liste des employés pour l'écran PIN. */
  @Get('me')
  @Public()
  @RequireDevice()
  me(@CurrentDevice() device: DeviceContext) {
    return this.devices.describeDevice(device);
  }

  @Get()
  @RequirePermission('device.manage', 'read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.devices.list(auth);
  }

  @Post(':id/revoke')
  @HttpCode(204)
  @RequirePermission('device.manage')
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: AppRequest,
  ): Promise<void> {
    await this.devices.revoke(id, auth, req.ip);
  }
}
