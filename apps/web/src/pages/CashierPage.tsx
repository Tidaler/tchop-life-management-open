import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatXaf,
  newId,
  PAYMENT_METHODS,
  type PaymentMethod,
  pickText,
  SETTLEMENT_METHODS,
} from '@tchop/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import {
  type Bill,
  type Billable,
  type CashSession,
  type Customer,
  type OpenCashSession,
  useCashSession,
  useCustomers,
  useOpenBills,
  useOpenSessions,
} from '../cash';
import { approvalBody, ApprovalFields, type ApprovalValue } from '../components/ApprovalFields';
import { errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';
import { useOpenOrders } from '../orders';
import { useSession } from '../session';
import { RefundsTab } from './RefundsTab';

type Notice = { kind: 'ok' | 'danger'; text: string } | null;
const noApproval: ApprovalValue = { userId: '', pin: '' };
const needsApprovalError = (e: unknown) => e instanceof ApiError && e.code === 'APPROVAL_REQUIRED';

/** Écran de caisse : session, additions, encaissements, reçus, ardoises. */
export function CashierPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const session = useCashSession();
  const [tab, setTab] = useState<'bills' | 'customers' | 'refunds'>('bills');
  const canRefund = can('refund.create', 'read');
  const [notice, setNotice] = useState<Notice>(null);
  const canCustomers = can('customer_credit.charge', 'read');

  return (
    <>
      <div className="page-head">
        <h1>{t('cash.title')}</h1>
        {can('payment.record') && (
          <Link className="btn primary" to="/cashier/vente">
            + {t('cash.directSaleNew')}
          </Link>
        )}
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === 'bills'} onClick={() => setTab('bills')}>
            {t('cash.tabBills')}
          </button>
          {canCustomers && (
            <button
              className="tab"
              role="tab"
              aria-selected={tab === 'customers'}
              onClick={() => setTab('customers')}
            >
              {t('cash.tabCustomers')}
            </button>
          )}
          {canRefund && (
            <button
              className="tab"
              role="tab"
              aria-selected={tab === 'refunds'}
              onClick={() => setTab('refunds')}
            >
              {t('cash.tabRefunds')}
            </button>
          )}
        </div>
      </div>
      {notice && (
        <div className={`alert ${notice.kind}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}
      {session.isPending ? (
        <p className="muted">{t('common.loading')}</p>
      ) : session.data ? (
        <SessionBar session={session.data} onNotice={setNotice} />
      ) : (
        <>
          <OpenSession onNotice={setNotice} />
          <OtherSessions onNotice={setNotice} />
        </>
      )}
      {tab === 'bills' && <BillsTab sessionOpen={!!session.data} onNotice={setNotice} />}
      {tab === 'customers' && canCustomers && (
        <CustomersTab sessionOpen={!!session.data} onNotice={setNotice} />
      )}
      {tab === 'refunds' && canRefund && <RefundsTab sessionOpen={!!session.data} onNotice={setNotice} />}
    </>
  );
}

// ------------------------------------------------------------------ session

function OpenSession({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const registers = useQuery({
    queryKey: ['cash', 'registers'],
    queryFn: () => api<{ id: string; name: string }[]>('/cash/registers'),
  });
  const [registerId, setRegisterId] = useState('');
  const [float, setFloat] = useState(0);
  const open = useMutation({
    mutationFn: () =>
      api<CashSession>('/cash/sessions', {
        method: 'POST',
        body: { registerId: registerId || registers.data?.[0]?.id, openingFloatXaf: float },
      }),
    onSuccess: () => {
      onNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });
  return (
    <form
      className="card session-card"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        open.mutate();
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        {t('cash.noSession')}
      </p>
      <div className="row2">
        <div className="field">
          <label htmlFor="register">{t('cash.register')}</label>
          <select
            id="register"
            value={registerId || registers.data?.[0]?.id || ''}
            onChange={(e) => setRegisterId(e.target.value)}
          >
            {registers.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="float">{t('cash.float')}</label>
          <input
            id="float"
            type="number"
            min={0}
            step={500}
            value={float}
            onChange={(e) => setFloat(Math.max(0, Math.round(Number(e.target.value))))}
          />
        </div>
      </div>
      <button
        className="btn primary"
        style={{ marginTop: 12 }}
        disabled={open.isPending || !registers.data?.length}
      >
        {t('cash.open')}
      </button>
    </form>
  );
}

const dateTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Sessions restées ouvertes par d'autres comptes (caissier absent, compte remplacé ou désactivé) :
 * chacune bloque sa caisse. On compte le tiroir et on la clôture avec le PIN du gérant, puis on ouvre la sienne.
 */
function OtherSessions({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const sessions = useOpenSessions();
  const [closing, setClosing] = useState<OpenCashSession | null>(null);
  const others = sessions.data?.filter((s) => !s.mine) ?? [];
  if (others.length === 0) return null;
  return (
    <div className="card session-card">
      <div className="section-label">{t('cash.otherSessions')}</div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('cash.otherSessionsHelp')}
      </p>
      {others.map((s) => (
        <div key={s.id} className="session-row">
          <span className="pill warn">●</span>
          <span>
            {t('cash.sessionOf', {
              register: s.register.name,
              cashier: s.cashierName,
              time: dateTime(s.openedAt, locale),
            })}
            {!s.cashierActive && <span className="muted"> ({t('cash.inactiveAccount')})</span>}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => setClosing(s)}>
            {t('cash.closeOther')}
          </button>
        </div>
      ))}
      {closing && (
        <CloseSession session={closing} other onClose={() => setClosing(null)} onNotice={onNotice} />
      )}
    </div>
  );
}

function SessionBar({ session, onNotice }: { session: CashSession; onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const [closing, setClosing] = useState(false);
  const collected = Object.values(session.byMethod).reduce((s, v) => s + v, 0);
  const time = new Date(session.openedAt).toLocaleTimeString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div className="card session-bar">
      <span className="pill ok">●</span>
      <span>
        {t('cash.openedAt', {
          register: session.register.name,
          time,
          float: formatXaf(session.openingFloatXaf, locale),
        })}
      </span>
      <span>
        {t('cash.collected')} : <b>{formatXaf(collected, locale)}</b>
      </span>
      {session.cashRefundsXaf > 0 && (
        <span>
          {t('cash.refundsPaid')} : <b>{formatXaf(session.cashRefundsXaf, locale)}</b>
        </span>
      )}
      {session.cashExpensesXaf > 0 && (
        <span>
          {t('cash.expensesPaid')} : <b>{formatXaf(session.cashExpensesXaf, locale)}</b>
        </span>
      )}
      <span style={{ flex: 1 }} />
      <button className="btn" onClick={() => setClosing(true)}>
        {t('cash.close')}
      </button>
      {closing && <CloseSession session={session} onClose={() => setClosing(false)} onNotice={onNotice} />}
    </div>
  );
}

function CloseSession({
  session,
  other = false,
  onClose,
  onNotice,
}: {
  session: CashSession;
  /** Session d'un autre compte : le PIN d'un gérant est demandé (sauf si l'on est soi-même gérant). */
  other?: boolean;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needApproval, setNeedApproval] = useState(other && !can('approval.grant'));
  const [approval, setApproval] = useState<ApprovalValue>(noApproval);
  const countedXaf = counted === '' ? null : Math.max(0, Math.round(Number(counted)));
  const difference = countedXaf === null ? null : countedXaf - session.expectedCashXaf;

  const close = useMutation({
    mutationFn: () =>
      api<CashSession>(`/cash/sessions/${session.id}/close`, {
        method: 'POST',
        body: {
          countedCashXaf: countedXaf,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...approvalBody(needApproval, approval),
        },
      }),
    onSuccess: (closed) => {
      const amount = formatXaf(closed.differenceXaf ?? 0, locale);
      onNotice({
        kind: 'ok',
        text: other
          ? t('cash.closedOther', { cashier: closed.cashierName, amount })
          : t('cash.closed', { amount }),
      });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onClose();
    },
    onError: (e) => {
      if (needsApprovalError(e)) setNeedApproval(true);
      setError(errorMessage(e, t));
    },
  });

  return (
    <Modal
      title={other ? t('cash.closeOtherTitle', { cashier: session.cashierName }) : t('cash.close')}
      onClose={onClose}
    >
      {other && (
        <p className="muted" style={{ marginTop: 0 }}>
          {t('cash.sessionOf', {
            register: session.register.name,
            cashier: session.cashierName,
            time: dateTime(session.openedAt, locale),
          })}
        </p>
      )}
      <table className="grid">
        <tbody>
          {PAYMENT_METHODS.map((m) => (
            <tr key={m}>
              <td>{t(`method.${m}`)}</td>
              <td style={{ textAlign: 'right' }}>{formatXaf(session.byMethod[m], locale)}</td>
            </tr>
          ))}
          {session.cashRefundsXaf > 0 && (
            <tr>
              <td>{t('cash.refundsPaid')}</td>
              <td style={{ textAlign: 'right' }}>- {formatXaf(session.cashRefundsXaf, locale)}</td>
            </tr>
          )}
          {session.cashExpensesXaf > 0 && (
            <tr>
              <td>{t('cash.expensesPaid')}</td>
              <td style={{ textAlign: 'right' }}>- {formatXaf(session.cashExpensesXaf, locale)}</td>
            </tr>
          )}
          <tr>
            <td>
              <b>{t('cash.expectedCash')}</b>
            </td>
            <td style={{ textAlign: 'right' }}>
              <b>{formatXaf(session.expectedCashXaf, locale)}</b>
            </td>
          </tr>
        </tbody>
      </table>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          close.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="counted">{t('cash.counted')}</label>
          <input
            id="counted"
            type="number"
            min={0}
            required
            autoFocus
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
          />
        </div>
        {difference !== null && (
          <div className={`alert ${difference === 0 ? 'ok' : 'danger'}`}>
            {difference === 0
              ? t('cash.noDifference')
              : t('cash.difference', {
                  amount: `${difference > 0 ? '+' : ''}${formatXaf(difference, locale)}`,
                })}
          </div>
        )}
        <div className="field">
          <label htmlFor="comment">
            {t('cash.comment')} {difference ? `(${t('cash.commentRequired')})` : ''}
          </label>
          <textarea
            id="comment"
            maxLength={300}
            required={!!difference}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        {needApproval && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button
            className="btn primary"
            disabled={
              close.isPending ||
              countedXaf === null ||
              (!!difference && comment.trim().length < 3) ||
              (needApproval && approval.pin.length < 4)
            }
          >
            {t('cash.closeConfirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ additions

function BillsTab({ sessionOpen, onNotice }: { sessionOpen: boolean; onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const bills = useOpenBills();
  const orders = useOpenOrders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const billedOrders = new Set(bills.data?.map((b) => b.orderId));
  const withoutBill = (orders.data ?? []).filter((o) => !billedOrders.has(o.id));
  // Après une vente directe, l'écran s'ouvre sur son addition (?bill=…).
  const [searchParams] = useSearchParams();
  const wanted = selectedId ?? searchParams.get('bill');
  const selected = bills.data?.find((b) => b.id === wanted) ?? bills.data?.[0] ?? null;

  const prepare = useMutation({
    mutationFn: (orderId: string) => api<Bill>(`/orders/${orderId}/bills`, { method: 'POST', body: {} }),
    onSuccess: (bill) => {
      setSelectedId(bill.id);
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  return (
    <div className="cash-grid">
      <div className="card side-list">
        <div className="section-label">{t('cash.openBills')}</div>
        {bills.data?.length === 0 && <p className="muted small-pad">{t('cash.noBills')}</p>}
        {bills.data?.map((b) => (
          <button
            key={b.id}
            className="item"
            aria-current={b.id === selected?.id}
            onClick={() => setSelectedId(b.id)}
          >
            <span>
              <b>
                {b.tableLabel
                  ? t('order.title', { label: b.tableLabel })
                  : t('cash.directSaleLabel', { number: b.orderNumber })}
              </b>
            </span>
            <span>{formatXaf(b.remainingXaf, locale)}</span>
          </button>
        ))}
        {withoutBill.length > 0 && <div className="section-label">{t('cash.tablesWithoutBill')}</div>}
        {withoutBill.map((o) => (
          <div key={o.id} className="item static">
            <span>
              <b>{o.tableLabel ?? t('cash.directSaleLabel', { number: o.number })}</b>{' '}
              <span className="muted">{formatXaf(o.total, locale)}</span>
            </span>
            {can('bill.prepare') && (
              <span className="confirm">
                <button
                  className="btn ghost small"
                  disabled={prepare.isPending}
                  onClick={() => prepare.mutate(o.id)}
                >
                  {t('cash.prepareBill')}
                </button>
                <button className="btn ghost small" onClick={() => setSplitting(o.id)}>
                  {t('cash.splitBill')}
                </button>
              </span>
            )}
          </div>
        ))}
      </div>

      {selected ? (
        <>
          <BillDetail bill={selected} onNotice={onNotice} onReplaced={setSelectedId} />
          <PaymentPanel
            bill={selected}
            sessionOpen={sessionOpen}
            onPaid={(id) => setReceiptId(id)}
            onNotice={onNotice}
          />
        </>
      ) : (
        <div className="card placeholder muted" style={{ gridColumn: 'span 2' }}>
          {t('cash.selectBill')}
        </div>
      )}

      {splitting && (
        <SplitBill
          orderId={splitting}
          onClose={() => setSplitting(null)}
          onCreated={(id) => {
            setSplitting(null);
            setSelectedId(id);
          }}
        />
      )}
      {receiptId && <ReceiptModal receiptId={receiptId} onClose={() => setReceiptId(null)} />}
    </div>
  );
}

function BillDetail({
  bill,
  onNotice,
  onReplaced,
}: {
  bill: Bill;
  onNotice: (n: Notice) => void;
  onReplaced: (id: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [discounting, setDiscounting] = useState(false);
  const live = bill.payments.filter((p) => p.status !== 'voided');

  const voidBill = useMutation({
    mutationFn: () => api(`/bills/${bill.id}/void`, { method: 'POST' }),
    onSuccess: () => {
      onReplaced(null);
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  return (
    <div className="card pane-pad">
      <div className="row-between">
        <h2>
          {bill.tableLabel
            ? t('cash.billTitle', { label: bill.tableLabel })
            : t('cash.billTitleDirect', { number: bill.orderNumber })}
        </h2>
        <span className="muted">{t('order.number', { number: bill.orderNumber })}</span>
      </div>
      {bill.lines.map((l) => (
        <div key={l.id} className="line">
          <span className="qty-badge">{l.quantity}×</span>
          <div className="grow">
            <div>{pickText(l.name, locale)}</div>
            {l.modifiers.length > 0 && (
              <small className="muted">{l.modifiers.map((m) => pickText(m, locale)).join(', ')}</small>
            )}
          </div>
          <span className="amount">{formatXaf(l.amountXaf, locale)}</span>
        </div>
      ))}
      {bill.discountXaf > 0 && (
        <>
          <div className="row-between muted">
            <span>{t('cash.subtotal')}</span>
            <span>{formatXaf(bill.subtotalXaf, locale)}</span>
          </div>
          <div className="row-between muted">
            <span>
              {t('cash.discount')} · {bill.discountReason}
            </span>
            <span>−{formatXaf(bill.discountXaf, locale)}</span>
          </div>
        </>
      )}
      <div className="row-between total-line">
        <span>{t('cash.total')}</span>
        <span>{formatXaf(bill.totalXaf, locale)}</span>
      </div>
      {live.length === 0 && (
        <div className="confirm" style={{ marginTop: 12 }}>
          {can('discount.apply') && (
            <button className="btn" onClick={() => setDiscounting(true)}>
              % {t('cash.addDiscount')}
            </button>
          )}
          {can('bill.prepare') && (
            <button
              className="btn ghost danger"
              disabled={voidBill.isPending}
              onClick={() => voidBill.mutate()}
            >
              {t('cash.voidBill')}
            </button>
          )}
        </div>
      )}
      {discounting && (
        <DiscountModal
          bill={bill}
          onClose={() => setDiscounting(false)}
          onDone={(id) => {
            setDiscounting(false);
            onReplaced(id);
          }}
        />
      )}
    </div>
  );
}

/** Remise sur l'addition (sans paiement) : la règle de seuil et l'approbation sont vérifiées par le serveur. */
function DiscountModal({
  bill,
  onClose,
  onDone,
}: {
  bill: Bill;
  onClose: () => void;
  onDone: (billId: string) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [type, setType] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState(10);
  const [reason, setReason] = useState('');
  const [needApproval, setNeedApproval] = useState(false);
  const [approval, setApproval] = useState(noApproval);
  const [error, setError] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: () =>
      api<Bill>(`/bills/${bill.id}/discount`, {
        method: 'POST',
        body: { discount: { type, value, reason }, ...approvalBody(needApproval, approval) },
      }),
    onSuccess: (b) => {
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      onDone(b.id);
    },
    onError: (e) => {
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      if (needsApprovalError(e)) setNeedApproval(true);
      setError(errorMessage(e, t));
    },
  });

  return (
    <Modal title={t('cash.discountTitle')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          apply.mutate();
        }}
      >
        <div className="chips">
          <button
            type="button"
            className="chip"
            aria-pressed={type === 'percent'}
            onClick={() => setType('percent')}
          >
            {t('cash.discountPercent')}
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={type === 'amount'}
            onClick={() => setType('amount')}
          >
            {t('cash.discountAmount')}
          </button>
        </div>
        <div className="field">
          <label htmlFor="d-value">{t('cash.discountValue')}</label>
          <input
            id="d-value"
            type="number"
            min={0}
            max={type === 'percent' ? 100 : undefined}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="d-reason">{t('cash.discountReason')}</label>
          <input
            id="d-reason"
            required
            minLength={3}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {needApproval && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="btn primary" disabled={apply.isPending || reason.trim().length < 3}>
            {t('cash.applyDiscount')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SplitBill({
  orderId,
  onClose,
  onCreated,
}: {
  orderId: string;
  onClose: () => void;
  onCreated: (billId: string) => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const billable = useQuery({
    queryKey: ['billable', orderId],
    queryFn: () => api<Billable>(`/orders/${orderId}/billable`),
  });
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const total = useMemo(
    () => billable.data?.lines.reduce((s, l) => s + (qty[l.id] ?? 0) * l.unitPriceXaf, 0) ?? 0,
    [billable.data, qty],
  );
  const create = useMutation({
    mutationFn: () =>
      api<Bill>(`/orders/${orderId}/bills`, {
        method: 'POST',
        body: {
          lines: Object.entries(qty)
            .filter(([, q]) => q > 0)
            .map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
        },
      }),
    onSuccess: (b) => {
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      onCreated(b.id);
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  return (
    <Modal title={t('cash.splitTitle', { label: billable.data?.tableLabel ?? '' })} onClose={onClose}>
      {billable.data?.lines
        .filter((l) => l.remaining > 0)
        .map((l) => (
          <div key={l.id} className="line">
            <div className="qty">
              <button
                onClick={() => setQty((q) => ({ ...q, [l.id]: Math.max(0, (q[l.id] ?? 0) - 1) }))}
                aria-label="-1"
              >
                −
              </button>
              <span>{qty[l.id] ?? 0}</span>
              <button
                onClick={() => setQty((q) => ({ ...q, [l.id]: Math.min(l.remaining, (q[l.id] ?? 0) + 1) }))}
                aria-label="+1"
              >
                +
              </button>
            </div>
            <div className="grow">
              <div>{pickText(l.name, locale)}</div>
              <small className="muted">
                / {l.remaining} · {formatXaf(l.unitPriceXaf, locale)}
              </small>
            </div>
          </div>
        ))}
      {error && <div className="alert danger">{error}</div>}
      <div className="modal-foot">
        <b>{formatXaf(total, locale)}</b>
        <button
          className="btn primary"
          disabled={create.isPending || total === 0}
          onClick={() => create.mutate()}
        >
          {t('cash.createBill')}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ encaissement

function PaymentPanel({
  bill,
  sessionOpen,
  onPaid,
  onNotice,
}: {
  bill: Bill;
  sessionOpen: boolean;
  onPaid: (receiptId: string) => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const customers = useCustomers(can('customer_credit.charge', 'read'));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [needApproval, setNeedApproval] = useState(false);
  const [approval, setApproval] = useState(noApproval);
  const [key, setKey] = useState(() => newId());
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);

  const value = amount === '' ? bill.remainingXaf : Math.max(0, Math.round(Number(amount)));
  const change = method === 'cash' ? Math.max(0, value - bill.remainingXaf) : 0;
  const customer = customers.data?.find((c) => c.id === (customerId || customers.data?.[0]?.id));
  const methods = PAYMENT_METHODS.filter((m) => m !== 'customer_credit' || can('customer_credit.charge'));
  const reset = () => {
    setAmount('');
    setReference('');
    setNeedApproval(false);
    setApproval(noApproval);
    setKey(newId());
  };

  const pay = useMutation({
    mutationFn: () =>
      api<Bill>(`/bills/${bill.id}/payments`, {
        method: 'POST',
        body: {
          idempotencyKey: key,
          method,
          ...(method === 'cash' ? { tenderedXaf: value } : { amountXaf: value }),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(method === 'customer_credit' ? { customerId: customer?.id } : {}),
          ...approvalBody(needApproval, approval),
        },
      }),
    onSuccess: (updated) => {
      setError(null);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      if (updated.status === 'paid' && updated.receipt) {
        onNotice({
          kind: 'ok',
          text: t(updated.tableLabel ? 'cash.receiptPrinted' : 'cash.receiptPrintedDirect'),
        });
        onPaid(updated.receipt.id);
      }
    },
    onError: (e) => {
      if (needsApprovalError(e)) setNeedApproval(true);
      else setKey(newId());
      setError(errorMessage(e, t));
    },
  });

  return (
    <div className="card pane-pad">
      <h2>{t('cash.payment')}</h2>
      <div className="method-grid">
        {methods.map((m) => (
          <button
            key={m}
            type="button"
            className="method"
            aria-pressed={method === m}
            onClick={() => {
              setMethod(m);
              reset();
              setError(null);
            }}
          >
            {t(`method.${m}`)}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          pay.mutate();
        }}
      >
        {method === 'customer_credit' && (
          <div className="field">
            <label htmlFor="p-customer">{t('cash.customer')}</label>
            <select
              id="p-customer"
              value={customer?.id ?? ''}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              {customers.data
                ?.filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            {customer && (
              <span className="hint">
                {t('cash.customerBalance', {
                  balance: formatXaf(customer.balanceXaf, locale),
                  limit: formatXaf(customer.creditLimitXaf, locale),
                  available: formatXaf(customer.availableXaf, locale),
                })}
              </span>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="p-amount">{method === 'cash' ? t('cash.tendered') : t('cash.amount')}</label>
          <input
            id="p-amount"
            className="amount-input"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder={String(bill.remainingXaf)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        {change > 0 && (
          <div className="alert ok">{t('cash.change', { amount: formatXaf(change, locale) })}</div>
        )}
        {(method === 'mtn_momo' || method === 'orange_money' || method === 'card') && (
          <div className="field">
            <label htmlFor="p-ref">{t('cash.reference')}</label>
            <input
              id="p-ref"
              required={method !== 'card'}
              maxLength={40}
              pattern="[A-Za-z0-9._\/\-]{4,40}"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            {method !== 'card' && <span className="hint">{t('cash.referenceHelp')}</span>}
          </div>
        )}
        {needApproval && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && <div className="alert danger">{error}</div>}
        <button
          className="btn ok block"
          style={{ marginTop: 12 }}
          disabled={!sessionOpen || pay.isPending || bill.remainingXaf === 0 || value <= 0}
        >
          {t('cash.record')} · {formatXaf(Math.min(value, bill.remainingXaf), locale)}
        </button>
      </form>

      <div className="section-label">{t('cash.payments')}</div>
      {bill.payments.length === 0 && <p className="muted">{t('cash.noPayments')}</p>}
      {bill.payments.map((p) => (
        <div key={p.id} className={`line${p.status === 'voided' ? ' cancelled' : ''}`}>
          <div className="grow">
            <div>{t(`method.${p.method}`)}</div>
            {p.reference && <small className="muted">{p.reference}</small>}
          </div>
          <span className="amount">{formatXaf(p.amountXaf, locale)}</span>
          {p.status !== 'voided' && can('payment.void') && (
            <button
              className="btn ghost danger icon"
              aria-label={t('cash.voidPayment')}
              onClick={() => setVoiding(p.id)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="row-between total-line">
        <span>{bill.remainingXaf > 0 ? t('cash.remaining') : t('cash.paidInFull')}</span>
        <span>{formatXaf(bill.remainingXaf, locale)}</span>
      </div>
      {voiding && (
        <VoidPayment
          paymentId={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            void queryClient.invalidateQueries({ queryKey: ['bills'] });
            void queryClient.invalidateQueries({ queryKey: ['cash'] });
            void queryClient.invalidateQueries({ queryKey: ['customers'] });
          }}
        />
      )}
    </div>
  );
}

function VoidPayment({
  paymentId,
  onClose,
  onDone,
}: {
  paymentId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [needApproval, setNeedApproval] = useState(false);
  const [approval, setApproval] = useState(noApproval);
  const [error, setError] = useState<string | null>(null);
  const voidIt = useMutation({
    mutationFn: () =>
      api(`/payments/${paymentId}/void`, {
        method: 'POST',
        body: { reason, ...approvalBody(needApproval, approval) },
      }),
    onSuccess: onDone,
    onError: (e) => {
      if (needsApprovalError(e)) setNeedApproval(true);
      setError(errorMessage(e, t));
    },
  });
  return (
    <Modal title={t('cash.voidPayment')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          voidIt.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="v-reason">{t('cash.voidReason')}</label>
          <input
            id="v-reason"
            required
            minLength={3}
            maxLength={200}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {needApproval && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="btn danger" disabled={voidIt.isPending || reason.trim().length < 3}>
            {t('common.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ReceiptContent {
  siteName: string;
  receiptNumber: number;
  tableLabel: string | null;
  orderNumber: number;
  cashierName: string;
  paidAt: string;
  lines: { quantity: number; name: string; modifiers: string[]; amountXaf: number }[];
  subtotalXaf: number;
  discountXaf: number;
  totalXaf: number;
  payments: {
    label: string;
    amountXaf: number;
    tenderedXaf: number | null;
    changeXaf: number;
    reference: string | null;
  }[];
}

function ReceiptModal({ receiptId, onClose }: { receiptId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const receipt = useQuery({
    queryKey: ['receipt', receiptId],
    queryFn: () => api<{ id: string; number: number; content: ReceiptContent }>(`/receipts/${receiptId}`),
    enabled: can('receipt.reprint', 'read'),
  });
  const reprint = useMutation({
    mutationFn: () => api(`/receipts/${receiptId}/reprint`, { method: 'POST' }),
  });
  const r = receipt.data?.content;
  return (
    <Modal title={t('cash.receiptTitle', { number: receipt.data?.number ?? '' })} onClose={onClose}>
      {r && (
        <div className="receipt">
          <div className="c">
            <b>{r.siteName}</b>
            <br />
            {new Date(r.paidAt).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
            <br />
            {r.tableLabel ? `Table ${r.tableLabel} · ` : ''}#{r.orderNumber} · {r.cashierName}
          </div>
          <hr />
          {r.lines.map((l, i) => (
            <div key={i} className="r">
              <span>
                {l.quantity} × {l.name}
              </span>
              <span>{formatXaf(l.amountXaf, locale)}</span>
            </div>
          ))}
          <hr />
          {r.discountXaf > 0 && (
            <div className="r">
              <span>{t('cash.discount')}</span>
              <span>−{formatXaf(r.discountXaf, locale)}</span>
            </div>
          )}
          <div className="r">
            <b>TOTAL</b>
            <b>{formatXaf(r.totalXaf, locale)}</b>
          </div>
          {r.payments.map((p, i) => (
            <div key={i} className="r">
              <span>
                {p.label}
                {p.reference ? ` (${p.reference})` : ''}
              </span>
              <span>{formatXaf(p.tenderedXaf ?? p.amountXaf, locale)}</span>
            </div>
          ))}
          {r.payments.some((p) => p.changeXaf > 0) && (
            <div className="r">
              <span>Monnaie rendue</span>
              <span>
                {formatXaf(
                  r.payments.reduce((s, p) => s + p.changeXaf, 0),
                  locale,
                )}
              </span>
            </div>
          )}
        </div>
      )}
      <div className="modal-foot">
        {can('receipt.reprint') ? (
          <button className="btn" disabled={reprint.isPending} onClick={() => reprint.mutate()}>
            🖨 {t('cash.reprint')}
          </button>
        ) : (
          <span />
        )}
        <button className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ ardoises

function CustomersTab({ sessionOpen, onNotice }: { sessionOpen: boolean; onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const customers = useCustomers();
  const [creating, setCreating] = useState(false);
  const [settling, setSettling] = useState<Customer | null>(null);

  return (
    <>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <p className="muted" style={{ margin: 0 }}>
          {t('customers.privacy')}
        </p>
        {can('customer.manage') && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            + {t('customers.new')}
          </button>
        )}
      </div>
      <div className="card scroll-x">
        {customers.data?.length === 0 && <p className="placeholder muted">{t('customers.empty')}</p>}
        {!!customers.data?.length && (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('customers.name')}</th>
                <th>{t('customers.balance')}</th>
                <th>{t('customers.limit')}</th>
                <th>{t('customers.available')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>{' '}
                    {!c.active && <span className="pill danger">{t('customers.inactive')}</span>}
                    {c.phone && <div className="muted">{c.phone}</div>}
                  </td>
                  <td>
                    <b>{formatXaf(c.balanceXaf, locale)}</b>
                  </td>
                  <td>{formatXaf(c.creditLimitXaf, locale)}</td>
                  <td>{formatXaf(c.availableXaf, locale)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {c.balanceXaf > 0 && can('payment.record') && (
                      <button className="btn" disabled={!sessionOpen} onClick={() => setSettling(c)}>
                        {t('customers.settle')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <NewCustomer onClose={() => setCreating(false)} onNotice={onNotice} />}
      {settling && <Settle customer={settling} onClose={() => setSettling(null)} />}
    </>
  );
}

function NewCustomer({ onClose, onNotice }: { onClose: () => void; onNotice: (n: Notice) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState(20_000);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api('/customers', {
        method: 'POST',
        body: { name, creditLimitXaf: limit, ...(phone.trim() ? { phone: phone.trim() } : {}) },
      }),
    onSuccess: () => {
      onNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  return (
    <Modal title={t('customers.new')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="c-name">{t('customers.name')}</label>
          <input
            id="c-name"
            required
            minLength={2}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="c-phone">{t('customers.phone')}</label>
            <input
              id="c-phone"
              inputMode="tel"
              maxLength={20}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="c-limit">{t('customers.limit')}</label>
            <input
              id="c-limit"
              type="number"
              min={0}
              step={1000}
              value={limit}
              onChange={(e) => setLimit(Math.max(0, Math.round(Number(e.target.value))))}
            />
          </div>
        </div>
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="btn primary" disabled={create.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Settle({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<(typeof SETTLEMENT_METHODS)[number]>('cash');
  const [amount, setAmount] = useState(customer.balanceXaf);
  const [reference, setReference] = useState('');
  const [key] = useState(() => newId());
  const [error, setError] = useState<string | null>(null);
  const settle = useMutation({
    mutationFn: () =>
      api(`/customers/${customer.id}/settlements`, {
        method: 'POST',
        body: {
          idempotencyKey: key,
          method,
          amountXaf: amount,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  return (
    <Modal title={t('customers.settleTitle', { name: customer.name })} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          settle.mutate();
        }}
      >
        <div className="method-grid">
          {SETTLEMENT_METHODS.map((m) => (
            <button
              key={m}
              type="button"
              className="method"
              aria-pressed={method === m}
              onClick={() => setMethod(m)}
            >
              {t(`method.${m}`)}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="s-amount">
            {t('cash.amount')} · {t('customers.balance')} {formatXaf(customer.balanceXaf, locale)}
          </label>
          <input
            id="s-amount"
            type="number"
            min={1}
            max={customer.balanceXaf}
            value={amount}
            onChange={(e) => setAmount(Math.round(Number(e.target.value)))}
          />
        </div>
        {method !== 'cash' && (
          <div className="field">
            <label htmlFor="s-ref">{t('cash.reference')}</label>
            <input
              id="s-ref"
              required={method !== 'card'}
              maxLength={40}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        )}
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="btn ok" disabled={settle.isPending || amount <= 0}>
            {t('customers.settle')} · {formatXaf(amount, locale)}
          </button>
        </div>
      </form>
    </Modal>
  );
}
