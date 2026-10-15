import { useQuery } from '@tanstack/react-query';
import { type MessageKey } from '@tchop/i18n';
import { type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { useI18n } from '../i18n';

export function Brand({ subtitle }: { subtitle?: string }) {
  const { t } = useI18n();
  return (
    <div className="brand">
      <div className="mark" aria-hidden>
        TL
      </div>
      <div>
        {t('app.name')}
        {subtitle && <small>{subtitle}</small>}
      </div>
    </div>
  );
}

export function AuthLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <>
      <OfflineBanner />
      <div className="auth-page">
        <div className={`card auth-card${wide ? ' wide' : ''}`}>{children}</div>
      </div>
    </>
  );
}

/** Bandeau affiché tant que le serveur local ne répond pas. */
export function OfflineBanner() {
  const { t } = useI18n();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ status: string }>('/health'),
    refetchInterval: (query) => (query.state.status === 'error' ? 5_000 : 30_000),
    retry: false,
  });
  if (!health.isError && health.data?.status !== 'degraded') return null;
  return (
    <div className="offline" role="status">
      {t('offline.banner')}
    </div>
  );
}

/** Message d'erreur traduit à partir d'une erreur d'API. */
export function errorMessage(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') return t('error.network');
    if (error.code === 'FORBIDDEN') return t('error.forbidden');
  }
  return t('error.generic');
}

export const initials = (name: string): string =>
  name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
