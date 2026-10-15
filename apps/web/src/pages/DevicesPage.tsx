import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';
import { useSession } from '../session';

interface DeviceRow {
  id: string;
  name: string;
  kind: 'tablet' | 'phone' | 'desktop';
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface EnrollmentCode {
  code: string;
  expiresAt: string;
}

export function DevicesPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const canManage = can('device.manage', 'write');
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceRow[]>('/devices') });
  const [confirming, setConfirming] = useState<string | null>(null);

  const newCode = useMutation({
    mutationFn: () => api<EnrollmentCode>('/devices/enrollment-codes', { method: 'POST' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api<void>(`/devices/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : t('devices.never');

  return (
    <>
      <div className="page-head">
        <h1>{t('devices.title')}</h1>
        {canManage && (
          <button className="btn primary" onClick={() => newCode.mutate()} disabled={newCode.isPending}>
            + {t('devices.newCode')}
          </button>
        )}
      </div>

      {newCode.data && <CodePanel code={newCode.data} onExpired={() => newCode.reset()} />}
      {newCode.isError && <div className="alert danger">{errorMessage(newCode.error, t)}</div>}

      <div className="card scroll-x">
        {devices.isPending && <p className="placeholder muted">{t('common.loading')}</p>}
        {devices.isError && <div className="alert danger">{errorMessage(devices.error, t)}</div>}
        {devices.data?.length === 0 && <p className="placeholder muted">{t('devices.empty')}</p>}
        {devices.data && devices.data.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('enroll.name')}</th>
                <th>{t('enroll.kind')}</th>
                <th>{t('devices.lastSeen')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <b>{d.name}</b>
                  </td>
                  <td>{t(`kind.${d.kind}`)}</td>
                  <td>{fmt(d.lastSeenAt)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {d.revokedAt ? (
                      <span className="pill danger">{t('devices.revoked')}</span>
                    ) : confirming === d.id ? (
                      <>
                        <span className="muted" style={{ marginRight: 8 }}>
                          {t('devices.confirmRevoke', { name: d.name })}
                        </span>
                        <button
                          className="btn danger"
                          onClick={() => revoke.mutate(d.id)}
                          disabled={revoke.isPending}
                        >
                          {t('common.confirm')}
                        </button>{' '}
                        <button className="btn ghost" onClick={() => setConfirming(null)}>
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="pill ok" style={{ marginRight: 8 }}>
                          {t('devices.active')}
                        </span>
                        {canManage && (
                          <button className="btn ghost danger" onClick={() => setConfirming(d.id)}>
                            {t('devices.revoke')}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function CodePanel({ code, onExpired }: { code: EnrollmentCode; onExpired: () => void }) {
  const { t } = useI18n();
  const expiresAt = new Date(code.expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const id = window.setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemaining(left);
      if (left === 0) onExpired();
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, onExpired]);

  const mm = Math.floor(remaining / 60_000);
  const ss = Math.floor((remaining % 60_000) / 1000)
    .toString()
    .padStart(2, '0');

  return (
    <div className="card" style={{ padding: 20, marginBottom: 16, maxWidth: 420 }}>
      <div className="code-box" aria-live="polite">
        {code.code}
      </div>
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
        {t('devices.codeHelp', { minutes: 10 })} · {mm}:{ss}
      </p>
    </div>
  );
}
