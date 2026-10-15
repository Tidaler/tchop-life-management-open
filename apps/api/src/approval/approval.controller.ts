import { Controller, Get } from '@nestjs/common';
import { Authenticated } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ApprovalService } from './approval.service.js';

@Controller('approvals')
export class ApprovalController {
  constructor(private readonly approval: ApprovalService) {}

  /**
   * Gérants du site pouvant approuver (noms seulement), pour la fenêtre d'approbation de n'importe quel
   * écran : annulation, remise, perte de stock… Le PIN reste vérifié par l'action elle-même.
   */
  @Get('approvers')
  @Authenticated()
  approvers(@CurrentAuth() auth: AuthContext) {
    return this.approval.listApprovers(auth);
  }
}
