import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, deviceStore } from '../api';
import { AuthLayout, Brand, errorMessage } from '../components/common';
import { LanguageSwitch, useI18n } from '../i18n';
import { useSession } from '../session';

export function PasswordLoginPage() {
  const { t } = useI18n();
  const { loginWithPassword } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasDevice = deviceStore.get() !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginWithPassword(username, password);
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError && err.status === 401 ? t('login.invalid') : errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <Brand />
      <h1>{t('login.title')}</h1>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="username">{t('login.username')}</label>
          <input
            id="username"
            autoComplete="username"
            autoCapitalize="none"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t('login.password')}</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary block" style={{ marginTop: 18 }} disabled={busy}>
          {t('login.submit')}
        </button>
      </form>
      <div className="auth-footer">
        {hasDevice ? (
          <Link className="link" to="/login">
            {t('login.usePin')}
          </Link>
        ) : (
          <Link className="link" to="/enroll">
            {t('enroll.title')}
          </Link>
        )}
        <LanguageSwitch />
      </div>
    </AuthLayout>
  );
}
