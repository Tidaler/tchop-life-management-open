import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatXaf, pickText } from '@tchop/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useI18n } from '../i18n';
import { type QrRequest } from '../orders';
import { errorMessage } from './common';

/** Demande QR à valider : détail, puis « Valider et envoyer » ou « Refuser » (motif interne). */
export function QrRequestCard({ request }: { request: QrRequest }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Horloge rafraîchie toutes les 30 s pour le compte à rebours d'expiration.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const minutes = Math.max(0, Math.ceil((new Date(request.expiresAt).getTime() - now) / 60_000));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['qr-requests'] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const onError = (e: unknown) => {
    setError(
      e instanceof ApiError && e.code === 'QR_REQUEST_CLOSED' ? t('qrReq.closed') : errorMessage(e, t),
    );
    refresh();
  };
  const accept = useMutation({
    mutationFn: () => api(`/qr-requests/${request.id}/accept`, { method: 'POST' }),
    onSuccess: refresh,
    onError,
  });
  const reject = useMutation({
    mutationFn: () => api(`/qr-requests/${request.id}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: refresh,
    onError,
  });

  return (
    <div className="qr-alert">
      <div className="row-between">
        <b>📱 {t('floor.qrPending')}</b>
        <span className="muted">{t('qrReq.expiresIn', { minutes })}</span>
      </div>
      {request.items.map((i, k) => (
        <div key={k} className="line">
          <span className="qty-badge">{i.quantity}×</span>
          <div className="grow">
            <div>{pickText(i.name, locale)}</div>
            {i.modifiers.length > 0 && (
              <small className="muted">{i.modifiers.map((m) => pickText(m, locale)).join(', ')}</small>
            )}
            {i.note && <small className="note">↳ {i.note}</small>}
          </div>
          <span className="amount">{formatXaf(i.unitPriceXaf * i.quantity, locale)}</span>
        </div>
      ))}
      <div className="row-between" style={{ fontWeight: 700, marginTop: 6 }}>
        <span>{t('order.total')}</span>
        <span>{formatXaf(request.totalXaf, locale)}</span>
      </div>
      {error && <div className="alert danger">{error}</div>}
      {rejecting ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            reject.mutate();
          }}
        >
          <div className="field">
            <label htmlFor={`reason-${request.id}`}>{t('qrReq.rejectReason')}</label>
            <input
              id={`reason-${request.id}`}
              autoFocus
              required
              minLength={3}
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="confirm" style={{ marginTop: 8 }}>
            <button className="btn danger" disabled={reject.isPending || reason.trim().length < 3}>
              {t('qrReq.reject')}
            </button>
            <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="confirm" style={{ marginTop: 8 }}>
          <button className="btn ok" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {t('qrReq.accept')}
          </button>
          <button className="btn ghost danger" onClick={() => setRejecting(true)}>
            {t('qrReq.reject')}
          </button>
        </div>
      )}
    </div>
  );
}
