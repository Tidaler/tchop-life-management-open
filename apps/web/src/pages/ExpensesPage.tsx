import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EXPENSE_METHODS, type ExpenseMethod, formatXaf, newId } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { api, ApiError, apiBlob } from '../api';
import { useCashSession } from '../cash';
import { approvalBody, ApprovalFields, type ApprovalValue } from '../components/ApprovalFields';
import { errorMessage, Modal } from '../components/common';
import { PeriodPicker, presetPeriod } from '../components/PeriodPicker';
import {
  businessToday,
  type Expense,
  FINANCE_KEY,
  type Period,
  periodQuery,
  useExpenseCategories,
} from '../finance';
import { useI18n } from '../i18n';
import { useSession } from '../session';

type Notice = { kind: 'ok' | 'danger'; text: string } | null;
const needsApproval = (e: unknown) => e instanceof ApiError && e.code === 'APPROVAL_REQUIRED';

/** Dépenses : saisie (avec sortie de caisse éventuelle), liste de la période, annulation, justificatif. */
export function ExpensesPage() {
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<Period>(presetPeriod('today'));
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const list = useQuery({
    queryKey: [...FINANCE_KEY, 'expenses', period.from, period.to],
    queryFn: () =>
      api<{
        expenses: Expense[];
        totalXaf: number;
        byCategory: { categoryId: string; name: string; amountXaf: number }[];
      }>(`/expenses?${periodQuery(period)}`),
    enabled: period.from <= period.to,
  });

  const openAttachment = async (e: Expense) => {
    try {
      const url = URL.createObjectURL(await apiBlob(`/expenses/${e.id}/attachment`));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setNotice({ kind: 'danger', text: errorMessage(error, t) });
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.expenses')}</h1>
        <div className="confirm">
          <PeriodPicker value={period} onChange={setPeriod} />
          <button className="btn primary" onClick={() => setCreating(true)}>
            + {t('exp.new')}
          </button>
        </div>
      </div>
      {notice && (
        <div className={`alert ${notice.kind}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}
      {list.data && (
        <div className="kpi-grid" style={{ marginBottom: 12 }}>
          <div className="card kpi strong">
            <div className="kpi-label">{t('exp.total')}</div>
            <div className="kpi-value">{formatXaf(list.data.totalXaf, locale)}</div>
          </div>
          {list.data.byCategory.slice(0, 4).map((c) => (
            <div key={c.categoryId} className="card kpi">
              <div className="kpi-label">{c.name}</div>
              <div className="kpi-value">{formatXaf(c.amountXaf, locale)}</div>
            </div>
          ))}
        </div>
      )}
      <div className="card scroll-x">
        {(list.data?.expenses.length ?? 0) === 0 ? (
          <p className="placeholder muted">{list.isPending ? t('common.loading') : t('exp.none')}</p>
        ) : (
          <table className="grid">
            <tbody>
              {list.data!.expenses.map((e) => (
                <tr key={e.id} className={e.status === 'voided' ? 'voided' : ''}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <b>n° {e.number}</b>
                    <div className="muted">{e.date}</div>
                  </td>
                  <td>
                    <b>{e.description}</b>
                    <div className="muted">
                      {e.category.name}
                      {e.reference && ` · ${e.reference}`}
                    </div>
                  </td>
                  <td>
                    {t(`method.${e.method}`)}
                    {e.fromCashSession && <div className="muted">{t('exp.fromCash')}</div>}
                  </td>
                  <td className="muted">
                    {e.createdBy}
                    {e.approvedBy && (
                      <div>
                        {t('stock.approvedBy')} {e.approvedBy}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <b>{formatXaf(e.amountXaf, locale)}</b>
                    {e.status === 'voided' && (
                      <div>
                        <span className="pill danger">{t('exp.voided')}</span>
                        {e.voidReason && <div className="muted">{e.voidReason}</div>}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <AttachmentButton
                      expense={e}
                      onOpen={() => void openAttachment(e)}
                      onNotice={setNotice}
                    />
                    {e.status === 'recorded' && (
                      <button className="btn ghost danger" onClick={() => setVoiding(e)}>
                        {t('exp.void')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <ExpenseForm onClose={() => setCreating(false)} onNotice={setNotice} />}
      {voiding && <VoidExpense expense={voiding} onClose={() => setVoiding(null)} onNotice={setNotice} />}
    </>
  );
}

function AttachmentButton({
  expense,
  onOpen,
  onNotice,
}: {
  expense: Expense;
  onOpen: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api(`/expenses/${expense.id}/attachment`, { method: 'POST', body: form });
    },
    onSuccess: () => {
      onNotice({ kind: 'ok', text: t('exp.attached') });
      void queryClient.invalidateQueries({ queryKey: FINANCE_KEY });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });
  return (
    <>
      {expense.hasAttachment && (
        <button className="btn ghost" onClick={onOpen}>
          {t('exp.viewAttachment')}
        </button>
      )}
      {expense.status === 'recorded' && (
        <label className="btn ghost">
          {expense.hasAttachment ? t('exp.replaceAttachment') : t('exp.addAttachment')}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = '';
            }}
          />
        </label>
      )}
    </>
  );
}

function ExpenseForm({ onClose, onNotice }: { onClose: () => void; onNotice: (n: Notice) => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const categories = useExpenseCategories();
  const session = useCashSession(can('cash_session.manage', 'read'));
  const hasSession = !!session.data;
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<ExpenseMethod>('cash');
  const [fromCash, setFromCash] = useState(true);
  const [date, setDate] = useState(businessToday());
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [key] = useState(() => newId());
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [error, setError] = useState('');
  const category = categoryId || categories.data?.[0]?.id || '';
  const takeFromCash = hasSession && method === 'cash' && fromCash;

  const save = useMutation({
    mutationFn: () =>
      api<Expense>('/expenses', {
        method: 'POST',
        body: {
          idempotencyKey: key,
          categoryId: category,
          amountXaf: Number(amount),
          method,
          fromCashSession: takeFromCash,
          date: takeFromCash ? undefined : date,
          description,
          reference: reference.trim() || undefined,
          ...approvalBody(approvalNeeded, approval),
        },
      }),
    onSuccess: (e) => {
      void queryClient.invalidateQueries({ queryKey: FINANCE_KEY });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onNotice({ kind: 'ok', text: t('exp.recorded', { n: e.number }) });
      onClose();
    },
    onError: (e) => {
      if (needsApproval(e)) setApprovalNeeded(true);
      setError(errorMessage(e, t));
    },
  });

  return (
    <Modal title={t('exp.new')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError('');
          save.mutate();
        }}
      >
        <div className="row2">
          <div className="field">
            <label htmlFor="ex-category">{t('exp.category')}</label>
            <select id="ex-category" value={category} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-amount">{t('exp.amount')}</label>
            <input
              id="ex-amount"
              inputMode="numeric"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ex-description">{t('exp.description')}</label>
          <input
            id="ex-description"
            required
            minLength={3}
            maxLength={200}
            placeholder={t('exp.descriptionExample')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="section-label">{t('exp.method')}</div>
        <div className="method-grid">
          {EXPENSE_METHODS.map((m) => (
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
        {hasSession && method === 'cash' && (
          <label className="check" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={fromCash} onChange={(e) => setFromCash(e.target.checked)} />
            {t('exp.takeFromCash')}
          </label>
        )}
        <div className="row2">
          {!takeFromCash && (
            <div className="field">
              <label htmlFor="ex-date">{t('exp.date')}</label>
              <input
                id="ex-date"
                type="date"
                max={businessToday()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="ex-reference">{t('exp.reference')}</label>
            <input
              id="ex-reference"
              maxLength={40}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>
        {approvalNeeded && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending || !amount || !category}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function VoidExpense({
  expense,
  onClose,
  onNotice,
}: {
  expense: Expense;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/expenses/${expense.id}/void`, {
        method: 'POST',
        body: { reason, ...approvalBody(approvalNeeded, approval) },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FINANCE_KEY });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onNotice({ kind: 'ok', text: t('exp.voidDone') });
      onClose();
    },
    onError: (e) => {
      if (needsApproval(e)) setApprovalNeeded(true);
      setError(errorMessage(e, t));
    },
  });
  return (
    <Modal
      title={`${t('exp.void')} n° ${expense.number} · ${formatXaf(expense.amountXaf, locale)}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="ex-void">{t('exp.voidReason')}</label>
          <input
            id="ex-void"
            required
            minLength={3}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {approvalNeeded && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn danger" disabled={save.isPending || reason.trim().length < 3}>
            {t('exp.void')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
