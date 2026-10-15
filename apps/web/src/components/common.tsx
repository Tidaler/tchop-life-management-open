import { useQuery } from '@tanstack/react-query';
import { type MessageKey } from '@tchop/i18n';
import { type ReactNode, useEffect, useState } from 'react';
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

const ERROR_KEYS: Record<string, MessageKey> = {
  NETWORK: 'error.network',
  FORBIDDEN: 'error.forbidden',
  VERSION_CONFLICT: 'error.conflict',
  VALIDATION_FAILED: 'error.validation',
  CATEGORY_NOT_EMPTY: 'catalog.categoryNotEmpty',
  ZONE_NOT_EMPTY: 'floorSetup.zoneNotEmpty',
  TABLE_LABEL_TAKEN: 'floorSetup.labelTaken',
};

/** Message d'erreur traduit à partir d'une erreur d'API. */
export function errorMessage(error: unknown, t: (key: MessageKey) => string): string {
  const key = error instanceof ApiError ? ERROR_KEYS[error.code] : undefined;
  return t(key ?? 'error.generic');
}

/** Fenêtre modale simple : fermeture par Échap ou clic sur le fond. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Bouton d'action destructrice en deux temps : un premier clic demande confirmation. */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  disabled,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="btn ghost danger" onClick={() => setAsking(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <span className="muted">{question}</span>
      <button
        type="button"
        className="btn danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {t('common.confirm')}
      </button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
        {t('common.cancel')}
      </button>
    </span>
  );
}

export const initials = (name: string): string =>
  name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
