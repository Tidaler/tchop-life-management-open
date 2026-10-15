import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';

export interface ApprovalValue {
  userId: string;
  pin: string;
}

/**
 * Choix du gérant présent et saisie de son PIN, pour une action qui demande une approbation.
 * Affiché seulement quand le serveur l'exige (réponse APPROVAL_REQUIRED).
 */
export function ApprovalFields({
  value,
  onChange,
}: {
  value: ApprovalValue;
  onChange: (v: ApprovalValue) => void;
}) {
  const { t } = useI18n();
  const approvers = useQuery({
    queryKey: ['approvers'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/approvals/approvers'),
  });
  const userId = value.userId || approvers.data?.[0]?.id || '';

  return (
    <>
      <div className="section-label">{t('order.approval')}</div>
      <div className="row2">
        <div className="field">
          <label htmlFor="approval-user">{t('order.approver')}</label>
          <select
            id="approval-user"
            value={userId}
            onChange={(e) => onChange({ ...value, userId: e.target.value })}
          >
            {approvers.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="approval-pin">{t('order.approverPin')}</label>
          <input
            id="approval-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={value.pin}
            onChange={(e) => onChange({ userId, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
          />
        </div>
      </div>
    </>
  );
}

/** Corps d'approbation à joindre à la requête, ou rien si l'approbation n'est pas demandée. */
export const approvalBody = (needed: boolean, value: ApprovalValue, fallbackUserId?: string) =>
  needed && value.pin.length >= 4
    ? { approval: { userId: value.userId || fallbackUserId || '', pin: value.pin } }
    : {};
