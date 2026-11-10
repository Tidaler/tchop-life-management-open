import { useQuery } from '@tanstack/react-query';
import { type MessageKey } from '@tchop/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useI18n } from '../i18n';

/**
 * Logo et nom de l'application. Le sous-titre (établissement, appareil) omet ce qui répète déjà le nom
 * affiché.
 */
/** Logo TidalEx : quatre cercles violets. */
export function LogoMark() {
  return (
    <svg viewBox="80 83 340 340" focusable="false">
      <circle cx="172.5" cy="158.5" r="63.5" fill="#d292fc" />
      <circle cx="306.5" cy="195.5" r="69.5" fill="#e596fd" />
      <circle cx="180" cy="310" r="88" fill="#b362e2" />
      <circle cx="337.5" cy="335" r="69.5" fill="#e2bdff" />
    </svg>
  );
}

export function Brand({ subtitle }: { subtitle?: (string | undefined)[] }) {
  const { t } = useI18n();
  const name = t('app.name');
  const rest = (subtitle ?? []).filter(
    (part): part is string => !!part && part.toLowerCase() !== name.toLowerCase(),
  );
  return (
    <div className="brand">
      <div className="mark" aria-hidden>
        <LogoMark />
      </div>
      <div>
        {name}
        {rest.length > 0 && <small>{rest.join(' · ')}</small>}
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
  ZONE_NAME_TAKEN: 'floorSetup.zoneNameTaken',
  NOT_OFFERED_IN_ZONE: 'order.notOfferedInZone',
  TABLE_HAS_OPEN_ORDER: 'order.tableHasOrder',
  TABLE_OCCUPIED: 'order.tableOccupied',
  APPROVAL_REQUIRED: 'order.approvalRequired',
  APPROVAL_INVALID: 'order.approvalInvalid',
  PIN_LOCKED: 'order.pinLocked',
  PRODUCT_UNAVAILABLE: 'order.productUnavailable',
  INVALID_OPTIONS: 'order.invalidOptions',
  INVALID_TRANSITION: 'kitchen.alreadyMoved',
  NO_OPEN_SESSION: 'cash.noSessionCode',
  SESSION_ALREADY_OPEN: 'cash.sessionAlreadyOpen',
  OVERPAYMENT: 'cash.overpayment',
  REFERENCE_ALREADY_USED: 'cash.referenceUsed',
  ALREADY_BILLED: 'cash.alreadyBilled',
  NOTHING_TO_BILL: 'cash.nothingToBill',
  BILL_CLOSED: 'cash.billClosed',
  BILL_HAS_PAYMENTS: 'cash.billHasPayments',
  LINE_BILLED: 'cash.lineBilled',
  COMMENT_REQUIRED: 'cash.commentRequired',
  NAME_TAKEN: 'stock.nameTaken',
  ITEM_HAS_STOCK: 'stock.itemHasStock',
  ITEM_IN_RECIPE: 'stock.itemInRecipe',
  LOCATION_IN_USE: 'stock.locationInUse',
  INVENTORY_IN_PROGRESS: 'stock.inventoryInProgress',
  INVENTORY_CLOSED: 'stock.inventoryClosedError',
  NOTHING_COUNTED: 'stock.nothingCounted',
  ORDER_CLOSED: 'stock.orderClosed',
  SUPPLIER_MISMATCH: 'stock.supplierMismatch',
  ORDER_LINE_MISMATCH: 'stock.orderLineMismatch',
  NOT_FOUND: 'error.notFound',
  FUTURE_DATE: 'exp.futureDate',
  BILL_NOT_PAID: 'refund.notPaid',
  REFUND_TOO_LARGE: 'refund.tooLarge',
  CASH_EXPENSE_TODAY: 'exp.cashToday',
  ALREADY_VOIDED: 'exp.alreadyVoided',
  SESSION_CLOSED: 'exp.sessionClosed',
  INVALID_IMAGE: 'exp.invalidImage',
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
