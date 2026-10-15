import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Grants, type RoleCode } from '@tchop/shared';
import type { Request } from 'express';

export interface DeviceContext {
  id: string;
  siteId: string;
  name: string;
}

export interface AuthContext {
  userId: string;
  tenantId: string;
  siteId: string;
  sessionId: string;
  deviceId: string | null;
  method: 'password' | 'pin';
  roleCode: RoleCode | string;
  grants: Grants;
}

export interface AppRequest extends Request {
  auth?: AuthContext;
  device?: DeviceContext;
}

/** Contexte de l'utilisateur connecté (garanti présent sur une route non publique). */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw new Error('CurrentAuth utilisé sur une route publique');
  return req.auth;
});

/** Appareil enregistré à l'origine de la requête, s'il y en a un. */
export const CurrentDevice = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): DeviceContext | undefined =>
    ctx.switchToHttp().getRequest<AppRequest>().device,
);
