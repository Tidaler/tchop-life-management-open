import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { api, ApiError, deviceStore } from '../api';
import { AuthLayout, Brand, errorMessage, initials } from '../components/common';
import { LanguageSwitch, useI18n } from '../i18n';
import { useSession } from '../session';

interface DeviceInfo {
  device: { id: string; name: string };
  site: { id: string; name: string; tenantName: string };
  users: { id: string; displayName: string; role: { code: string; name: { fr: string; en: string } } }[];
}

const PIN_MAX = 6;
const PIN_MIN = 4;

export function PinLoginPage() {
  const { t, locale } = useI18n();
  const { loginWithPin } = useSession();
  const hasDevice = deviceStore.get() !== null;
  const info = useQuery({
    queryKey: ['device-me'],
    queryFn: () => api<DeviceInfo>('/devices/me'),
    enabled: hasDevice,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  });
  const [userId, setUserId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!userId || pin.length < PIN_MIN || busy) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithPin(userId, pin);
    } catch (err) {
      setPin('');
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setError(t('pin.wrong'));
      else if (err instanceof ApiError && err.code === 'PIN_LOCKED') {
        const retryAfter = Number(err.body?.retryAfter ?? 300);
        setError(t('pin.locked', { minutes: Math.max(1, Math.ceil(retryAfter / 60)) }));
      } else setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }, [userId, pin, busy, loginWithPin, t]);

  const press = useCallback((digit: string) => {
    setError(null);
    setPin((p) => (p.length < PIN_MAX ? p + digit : p));
  }, []);

  // Saisie possible au clavier physique (ordinateur de caisse).
  useEffect(() => {
    if (!userId) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void submit();
      else if (e.key === 'Escape') setUserId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [userId, press, submit]);

  if (!hasDevice) return <Navigate to="/enroll" replace />;

  if (info.error instanceof ApiError && info.error.code === 'DEVICE_REVOKED') {
    return (
      <AuthLayout>
        <Brand />
        <div className="alert warn">{t('enroll.revoked')}</div>
        <Link
          className="btn primary block"
          style={{ display: 'block', textAlign: 'center', marginTop: 16 }}
          to="/enroll"
        >
          {t('enroll.title')}
        </Link>
      </AuthLayout>
    );
  }

  const selected = info.data?.users.find((u) => u.id === userId);

  return (
    <AuthLayout wide={!selected}>
      <Brand subtitle={[info.data?.site.name, info.data?.device.name]} />
      {info.isPending && <p className="muted">{t('common.loading')}</p>}
      {info.isError && (
        <div className="alert danger">
          {errorMessage(info.error, t)}{' '}
          <button className="link" onClick={() => void info.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {info.data && !selected && (
        <>
          <h1>{t('pin.title')}</h1>
          {info.data.users.length === 0 && <p className="muted">{t('pin.noUsers')}</p>}
          <div className="users">
            {info.data.users.map((u) => (
              <button key={u.id} className="user-tile" onClick={() => setUserId(u.id)}>
                <span className="avatar">{initials(u.displayName)}</span>
                <b>{u.displayName}</b>
                <small>{u.role.name[locale]}</small>
              </button>
            ))}
          </div>
        </>
      )}

      {selected && (
        <>
          <div style={{ textAlign: 'center' }}>
            <span className="avatar" style={{ margin: '0 auto 8px' }}>
              {initials(selected.displayName)}
            </span>
            <h1>{selected.displayName}</h1>
            <p className="muted">{t('pin.enter')}</p>
          </div>
          <div className="pin-dots" aria-label={t('pin.enter')}>
            {Array.from({ length: PIN_MAX }, (_, i) => (
              <span key={i} className={i < pin.length ? 'filled' : ''} />
            ))}
          </div>
          {/* Espace toujours réservé : le pavé ne doit pas bouger quand le message apparaît ou disparaît. */}
          <div className="pin-message" role="alert">
            {error && <div className="alert danger">{error}</div>}
          </div>
          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" onClick={() => press(d)} disabled={busy}>
                {d}
              </button>
            ))}
            <button type="button" className="small" onClick={() => setPin('')} disabled={busy}>
              {t('pin.clear')}
            </button>
            <button type="button" onClick={() => press('0')} disabled={busy}>
              0
            </button>
            <button
              type="button"
              className="small"
              style={{ background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }}
              onClick={() => void submit()}
              disabled={busy || pin.length < PIN_MIN}
            >
              OK
            </button>
          </div>
          <button
            className="link"
            style={{ marginTop: 12 }}
            onClick={() => {
              setUserId(null);
              setPin('');
              setError(null);
            }}
          >
            ← {t('pin.changeUser')}
          </button>
        </>
      )}

      <div className="auth-footer">
        <Link className="link" to="/login/password">
          {t('pin.passwordLink')}
        </Link>
        <LanguageSwitch />
      </div>
    </AuthLayout>
  );
}
