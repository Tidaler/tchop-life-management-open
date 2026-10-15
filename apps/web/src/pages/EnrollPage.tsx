import { type DeviceKind, DEVICE_KINDS } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, deviceStore } from '../api';
import { AuthLayout, Brand, errorMessage } from '../components/common';
import { LanguageSwitch, useI18n } from '../i18n';

interface EnrollResponse {
  deviceToken: string;
  device: { id: string; name: string; siteName: string };
}

export function EnrollPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DeviceKind>('tablet');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<EnrollResponse>('/devices/enroll', {
        method: 'POST',
        body: { code, name, kind },
      });
      deviceStore.set(res.deviceToken);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError &&
          (err.code === 'INVALID_ENROLLMENT_CODE' || err.code === 'VALIDATION_FAILED')
          ? t('enroll.invalid')
          : errorMessage(err, t),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <Brand />
      <h1>{t('enroll.title')}</h1>
      <p className="muted">{t('enroll.intro')}</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="code">{t('enroll.code')}</label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div className="field">
          <label htmlFor="name">{t('enroll.name')}</label>
          <input
            id="name"
            required
            maxLength={60}
            placeholder={t('enroll.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="kind">{t('enroll.kind')}</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
            {DEVICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="alert danger">{error}</div>}
        <button
          className="btn primary block"
          style={{ marginTop: 18 }}
          disabled={busy || code.length !== 6 || !name.trim()}
        >
          {t('enroll.submit')}
        </button>
      </form>
      <div className="auth-footer">
        <Link className="link" to="/login/password">
          {t('pin.passwordLink')}
        </Link>
        <LanguageSwitch />
      </div>
    </AuthLayout>
  );
}
