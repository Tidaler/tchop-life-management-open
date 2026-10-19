import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatXaf, pickText, REFUND_METHODS, type RefundMethod, type Translated } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
import { useCustomers } from '../cash';
import { approvalBody, ApprovalFields, type ApprovalValue } from '../components/ApprovalFields';
import { errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';
import { useSession } from '../session';

type Notice = { kind: 'ok' | 'danger'; text: string } | null;

interface RefundableBill {
  billId: string;
  status: string;
  receiptNumber: number | null;
  orderNumber: number;
  tableLabel: string | null;
  paidAt: string | null;
  discountXaf: number;
  totalXaf: number;
  refundedXaf: number;
  refundableXaf: number;
  customerIds: string[];
  lines: {
    orderLineId: string;
    name: Translated;
    quantity: number;
    amountXaf: number;
    refundedQuantity: number;
  }[];
  refunds: {
    id: string;
    number: number;
    method: RefundMethod;
    amountXaf: number;
    reason: string;
    createdAt: string;
  }[];
}

export interface RefundContent {
  refundNumber: number;
  receiptNumber: number | null;
  siteName: string;
  createdAt: string;
  tableLabel: string | null;
  orderNumber: number;
  cashierName: string;
  lines: { quantity: number; name: string; amountXaf: number }[];
  amountXaf: number;
  methodLabel: string;
  creditNote: boolean;
  reference: string | null;
  customerName: string | null;
  reason: string;
  restocked: boolean;
}

/** Remboursements et avoirs : retrouver un reçu, rembourser tout ou partie, avec le PIN d'un gérant si besoin. */
export function RefundsTab({
  sessionOpen,
  onNotice,
}: {
  sessionOpen: boolean;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const [number, setNumber] = useState('');
  const [searched, setSearched] = useState<number | null>(null);
  const [shown, setShown] = useState<{ id: string; content: RefundContent } | null>(null);
  const bill = useQuery({
    queryKey: ['refundable', searched],
    queryFn: () => api<RefundableBill>(`/receipts/by-number/${searched}`),
    enabled: searched !== null,
    retry: false,
  });
  const recent = useQuery({
    queryKey: ['refunds', 'recent'],
    queryFn: () =>
      api<
        {
          id: string;
          number: number;
          amountXaf: number;
          reason: string;
          createdAt: string;
          content: RefundContent;
        }[]
      >('/refunds'),
  });

  return (
    <div className="cash-grid refunds">
      <div>
        <form
          className="card small-pad"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const n = Number(number);
            if (Number.isInteger(n) && n > 0) setSearched(n);
          }}
        >
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="rf-number">{t('refund.receiptNumber')}</label>
            <input
              id="rf-number"
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <button className="btn primary block" disabled={!number}>
            {t('refund.find')}
          </button>
          {bill.isError && <p className="alert danger">{errorMessage(bill.error, t)}</p>}
        </form>
        <section className="card small-pad" style={{ marginTop: 12 }}>
          <div className="section-label">{t('refund.recent')}</div>
          {(recent.data?.length ?? 0) === 0 ? (
            <p className="muted">{t('refund.none')}</p>
          ) : (
            recent.data!.map((r) => (
              <button key={r.id} className="item row-between link-row" onClick={() => setShown(r)}>
                <span>
                  n° {r.number} ·{' '}
                  {r.content.receiptNumber ? `${t('refund.receipt')} ${r.content.receiptNumber}` : ''}
                </span>
                <b>{formatXaf(r.amountXaf, locale)}</b>
              </button>
            ))
          )}
        </section>
      </div>
      <div>
        {bill.data && (
          <RefundForm
            key={`${bill.data.billId}:${bill.data.refundedXaf}`}
            bill={bill.data}
            sessionOpen={sessionOpen}
            onDone={(r) => {
              setShown(r);
              onNotice({ kind: 'ok', text: t('refund.done', { number: r.content.refundNumber }) });
            }}
          />
        )}
      </div>
      {shown && <RefundModal refund={shown} onClose={() => setShown(null)} />}
    </div>
  );
}

function RefundForm({
  bill,
  sessionOpen,
  onDone,
}: {
  bill: RefundableBill;
  sessionOpen: boolean;
  onDone: (r: { id: string; content: RefundContent }) => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const customers = useCustomers(can('customer_credit.charge', 'read'));
  const [mode, setMode] = useState<'lines' | 'amount'>('lines');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<RefundMethod>(sessionOpen ? 'cash' : 'card');
  const [customerId, setCustomerId] = useState(bill.customerIds[0] ?? '');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [error, setError] = useState('');

  const ratio =
    bill.totalXaf /
    Math.max(
      1,
      bill.lines.reduce((s, l) => s + l.amountXaf, 0),
    );
  const linesAmount = bill.lines.reduce(
    (s, l) => s + Math.round(((l.amountXaf * (quantities[l.orderLineId] ?? 0)) / l.quantity) * ratio),
    0,
  );
  const total = mode === 'lines' ? linesAmount : Number(amount) || 0;
  const methods = REFUND_METHODS.filter(
    (m) => m !== 'customer_credit' || can('customer_credit.charge', 'read'),
  );

  const save = useMutation({
    mutationFn: () =>
      api<{ id: string; content: RefundContent }>(`/bills/${bill.billId}/refunds`, {
        method: 'POST',
        body: {
          idempotencyKey: key,
          method,
          reason,
          ...(mode === 'lines'
            ? {
                lines: Object.entries(quantities)
                  .filter(([, q]) => q > 0)
                  .map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
                restock,
              }
            : { amountXaf: Number(amount) }),
          ...(method === 'customer_credit' ? { customerId } : {}),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...approvalBody(needsApproval, approval),
        },
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['refundable'] });
      void queryClient.invalidateQueries({ queryKey: ['refunds'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onDone(r);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedsApproval(true);
      setError(errorMessage(e, t));
    },
  });

  if (bill.status !== 'paid' || bill.refundableXaf <= 0) {
    return (
      <div className="card small-pad">
        <h2 style={{ marginTop: 0 }}>
          {t('refund.receipt')} n° {bill.receiptNumber}
        </h2>
        <p className="muted">{t('refund.nothingLeft')}</p>
      </div>
    );
  }

  return (
    <form
      className="card small-pad"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setError('');
        save.mutate();
      }}
    >
      <h2 style={{ marginTop: 0 }}>
        {t('refund.receipt')} n° {bill.receiptNumber}
        {bill.tableLabel ? ` · Table ${bill.tableLabel}` : ''}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('refund.paid', { amount: formatXaf(bill.totalXaf, locale) })}
        {bill.refundedXaf > 0 &&
          ` · ${t('refund.alreadyRefunded', { amount: formatXaf(bill.refundedXaf, locale) })}`}
        {' · '}
        <b>{t('refund.refundable', { amount: formatXaf(bill.refundableXaf, locale) })}</b>
      </p>
      <div className="chips" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className="chip"
          aria-pressed={mode === 'lines'}
          onClick={() => setMode('lines')}
        >
          {t('refund.byLines')}
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={mode === 'amount'}
          onClick={() => setMode('amount')}
        >
          {t('refund.byAmount')}
        </button>
      </div>
      {mode === 'lines' ? (
        <>
          {bill.lines.map((l) => {
            const left = l.quantity - l.refundedQuantity;
            const q = quantities[l.orderLineId] ?? 0;
            return (
              <div key={l.orderLineId} className="line">
                <div className="grow">
                  {pickText(l.name, locale)}
                  <small className="muted"> · {t('refund.left', { count: left })}</small>
                </div>
                <div className="qty">
                  <button
                    type="button"
                    disabled={q <= 0}
                    onClick={() => setQuantities((s) => ({ ...s, [l.orderLineId]: q - 1 }))}
                    aria-label="-"
                  >
                    -
                  </button>
                  <span>{q}</span>
                  <button
                    type="button"
                    disabled={q >= left}
                    onClick={() => setQuantities((s) => ({ ...s, [l.orderLineId]: q + 1 }))}
                    aria-label="+"
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
          <label className="check" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
            {t('refund.restock')}
          </label>
        </>
      ) : (
        <div className="field">
          <label htmlFor="rf-amount">{t('cash.amount')}</label>
          <input
            id="rf-amount"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
          />
        </div>
      )}
      <div className="section-label">{t('refund.method')}</div>
      <div className="method-grid">
        {methods.map((m) => (
          <button
            key={m}
            type="button"
            className="method"
            aria-pressed={method === m}
            disabled={m === 'cash' && !sessionOpen}
            onClick={() => setMethod(m)}
          >
            {t(`refundMethod.${m}`)}
          </button>
        ))}
      </div>
      {!sessionOpen && <p className="hint">{t('refund.cashNeedsSession')}</p>}
      {method === 'customer_credit' && (
        <div className="field">
          <label htmlFor="rf-customer">{t('cash.customer')}</label>
          <select
            id="rf-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            required
          >
            <option value="">-</option>
            {customers.data
              ?.filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
      )}
      {method !== 'cash' && method !== 'customer_credit' && (
        <div className="field">
          <label htmlFor="rf-ref">{t('cash.reference')}</label>
          <input
            id="rf-ref"
            value={reference}
            maxLength={40}
            required={method !== 'card'}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="rf-reason">{t('refund.reason')}</label>
        <input
          id="rf-reason"
          required
          minLength={3}
          maxLength={200}
          placeholder={t('refund.reasonExample')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {needsApproval && <ApprovalFields value={approval} onChange={setApproval} />}
      {error && (
        <div className="alert danger" role="alert">
          {error}
        </div>
      )}
      <button
        className="btn primary block"
        disabled={save.isPending || total <= 0 || total > bill.refundableXaf || reason.trim().length < 3}
      >
        {t('refund.submit', { amount: formatXaf(total, locale) })}
      </button>
    </form>
  );
}

function RefundModal({
  refund,
  onClose,
}: {
  refund: { id: string; content: RefundContent };
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const r = refund.content;
  const reprint = useMutation({ mutationFn: () => api(`/refunds/${refund.id}/reprint`, { method: 'POST' }) });
  return (
    <Modal
      title={`${r.creditNote ? t('refund.creditNote') : t('refund.title')} n° ${r.refundNumber}`}
      onClose={onClose}
    >
      <div className="receipt">
        <div className="c">
          <b>{r.siteName}</b>
          <br />
          {new Date(r.createdAt).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
            dateStyle: 'short',
            timeStyle: 'short',
          })}
          <br />
          {r.tableLabel ? `Table ${r.tableLabel} · ` : ''}#{r.orderNumber} · {r.cashierName}
          {r.receiptNumber && (
            <>
              <br />
              {t('refund.origin', { number: r.receiptNumber })}
            </>
          )}
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
        {r.lines.length > 0 && <hr />}
        <div className="r">
          <b>{t('refund.amount')}</b>
          <b>{formatXaf(r.amountXaf, locale)}</b>
        </div>
        <div className="r">
          <span>
            {r.methodLabel}
            {r.reference ? ` (${r.reference})` : ''}
          </span>
          <span>{r.customerName ?? ''}</span>
        </div>
        <div>{r.reason}</div>
        {r.restocked && <div className="muted">{t('refund.restocked')}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={reprint.isPending} onClick={() => reprint.mutate()}>
          🖨 {t('cash.reprint')}
        </button>
        <button className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
