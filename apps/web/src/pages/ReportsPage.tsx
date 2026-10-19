import { useInfiniteQuery } from '@tanstack/react-query';
import { type MessageKey } from '@tchop/i18n';
import { type Access, EXPORT_KINDS, formatXaf, type Permission, pickText } from '@tchop/shared';
import { useState } from 'react';
import { api, downloadFile } from '../api';
import { errorMessage } from '../components/common';
import { PeriodPicker, presetPeriod } from '../components/PeriodPicker';
import {
  type CashReport,
  type FinanceReport,
  type Period,
  periodQuery,
  type SalesReport,
  useReport,
} from '../finance';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { BarList, DayBars } from './DashboardPage';

type Tab = 'sales' | 'cash' | 'finance' | 'exports' | 'audit';
const TABS: { id: Tab; label: MessageKey; permission: Permission; access: Access }[] = [
  { id: 'sales', label: 'rep.tabSales', permission: 'report.sales', access: 'read' },
  { id: 'cash', label: 'rep.tabCash', permission: 'report.cash', access: 'read' },
  { id: 'finance', label: 'rep.tabFinance', permission: 'report.finance', access: 'read' },
  { id: 'exports', label: 'rep.tabExports', permission: 'export.accounting', access: 'read' },
  { id: 'audit', label: 'rep.tabAudit', permission: 'audit.view', access: 'read' },
];

/** Rapports : ventes, caisse, résultat estimé, exports pour le comptable, journal d'audit. */
export function ReportsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const tabs = TABS.filter((x) => can(x.permission, x.access));
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'sales');
  const [period, setPeriod] = useState<Period>(presetPeriod('week'));

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.reports')}</h1>
        <div className="tabs" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.id}
              className="tab"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
            >
              {t(x.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="report-bar">
        <PeriodPicker value={period} onChange={setPeriod} />
        {tab !== 'exports' && tab !== 'audit' && (
          <button className="btn ghost" onClick={() => window.print()}>
            {t('rep.print')}
          </button>
        )}
      </div>
      {tab === 'sales' && <SalesTab period={period} />}
      {tab === 'cash' && <CashTab period={period} />}
      {tab === 'finance' && <FinanceTab period={period} />}
      {tab === 'exports' && <ExportsTab period={period} />}
      {tab === 'audit' && <AuditTab period={period} />}
    </>
  );
}

function SalesTab({ period }: { period: Period }) {
  const { t, locale } = useI18n();
  const report = useReport<SalesReport>('sales', period);
  const data = report.data;
  const money = (v: number) => formatXaf(v, locale);
  if (!data)
    return <p className="muted">{report.isError ? errorMessage(report.error, t) : t('common.loading')}</p>;
  return (
    <>
      {data.ownOnly && <p className="hint">{t('rep.ownOnly')}</p>}
      <div className="kpi-grid">
        <div className="card kpi strong">
          <div className="kpi-label">{t('dash.revenue')}</div>
          <div className="kpi-value">{money(data.totals.revenueXaf)}</div>
          <div className="kpi-hint">{t('dash.taxIncluded')}</div>
        </div>
        {data.totals.refundsXaf > 0 && (
          <div className="card kpi warn">
            <div className="kpi-label">{t('rep.refunds')}</div>
            <div className="kpi-value">{money(data.totals.refundsXaf)}</div>
            <div className="kpi-hint">{t('rep.refundCount', { count: data.totals.refunds })}</div>
          </div>
        )}
        <div className="card kpi">
          <div className="kpi-label">{t('dash.bills')}</div>
          <div className="kpi-value">{data.totals.bills}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">{t('dash.averageTicket')}</div>
          <div className="kpi-value">{money(data.totals.averageTicketXaf)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">{t('dash.discounts')}</div>
          <div className="kpi-value">{money(data.totals.discountXaf)}</div>
        </div>
        {data.cancellations && (
          <div className="card kpi">
            <div className="kpi-label">{t('rep.cancellations')}</div>
            <div className="kpi-value">{money(data.cancellations.amountXaf)}</div>
            <div className="kpi-hint">{t('rep.cancelledLines', { count: data.cancellations.lines })}</div>
          </div>
        )}
      </div>
      {data.byDay.length > 1 && (
        <section className="card small-pad dash-section">
          <h2>{t('dash.revenueByDay')}</h2>
          <DayBars days={data.byDay} />
        </section>
      )}
      <div className="dash-cols">
        <section className="card small-pad dash-section">
          <h2>{t('dash.byCategory')}</h2>
          <BarList
            rows={data.byCategory.map((c) => ({
              key: c.id,
              label: pickText(c.name, locale),
              value: c.amountXaf,
            }))}
            format={money}
            empty={t('dash.noSales')}
          />
        </section>
        <section className="card small-pad dash-section">
          <h2>{t('rep.byWaiter')}</h2>
          <BarList
            rows={data.byWaiter.map((w) => ({
              key: w.id ?? 'qr',
              label: `${w.name ?? t('rep.qrOrders')} (${w.bills})`,
              value: w.netXaf,
            }))}
            format={money}
            empty={t('dash.noSales')}
          />
        </section>
        <section className="card small-pad dash-section">
          <h2>{t('dash.byMethod')}</h2>
          <BarList
            rows={data.byMethod.map((m) => ({
              key: m.method,
              label: `${t(`method.${m.method}` as MessageKey)} (${m.count})`,
              value: m.amountXaf,
            }))}
            format={money}
            empty={t('dash.noSales')}
          />
        </section>
      </div>
      <section className="card scroll-x dash-section">
        <h2 className="pane-pad">{t('rep.byProduct')}</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>{t('rep.product')}</th>
              <th>{t('rep.category')}</th>
              <th style={{ textAlign: 'right' }}>{t('rep.quantity')}</th>
              <th style={{ textAlign: 'right' }}>{t('rep.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.byProduct.map((p) => (
              <tr key={p.id}>
                <td>{pickText(p.name, locale)}</td>
                <td className="muted">{pickText(p.category, locale)}</td>
                <td style={{ textAlign: 'right' }}>{p.quantity}</td>
                <td style={{ textAlign: 'right' }}>{money(p.amountXaf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function CashTab({ period }: { period: Period }) {
  const { t, locale } = useI18n();
  const report = useReport<CashReport>('cash', period);
  const data = report.data;
  const money = (v: number) => formatXaf(v, locale);
  if (!data)
    return <p className="muted">{report.isError ? errorMessage(report.error, t) : t('common.loading')}</p>;
  return (
    <>
      {data.ownOnly && <p className="hint">{t('rep.ownCash')}</p>}
      <div className="kpi-grid">
        <div className="card kpi">
          <div className="kpi-label">{t('rep.sessions')}</div>
          <div className="kpi-value">{data.totals.sessions}</div>
          <div className="kpi-hint">{t('rep.openSessions', { count: data.totals.open })}</div>
        </div>
        <div className={`card kpi${data.totals.differenceXaf !== 0 ? ' warn' : ''}`}>
          <div className="kpi-label">{t('rep.totalDifference')}</div>
          <div className="kpi-value">{money(data.totals.differenceXaf)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">{t('rep.cashExpenses')}</div>
          <div className="kpi-value">{money(data.totals.cashExpensesXaf)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">{t('rep.toVerify')}</div>
          <div className="kpi-value">{data.paymentsToVerify}</div>
        </div>
      </div>
      <div className="card scroll-x dash-section">
        {data.sessions.length === 0 ? (
          <p className="placeholder muted">{t('rep.noSessions')}</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('rep.session')}</th>
                <th style={{ textAlign: 'right' }}>{t('rep.float')}</th>
                <th style={{ textAlign: 'right' }}>{t('rep.collected')}</th>
                <th style={{ textAlign: 'right' }}>{t('rep.cashExpenses')}</th>
                <th style={{ textAlign: 'right' }}>{t('rep.expected')}</th>
                <th style={{ textAlign: 'right' }}>{t('rep.counted')}</th>
                <th style={{ textAlign: 'right' }}>{t('rep.difference')}</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{s.register.name}</b> · {s.cashierName}
                    <div className="muted">
                      {new Date(s.openedAt).toLocaleString(locale)}
                      {s.status === 'open' ? ` · ${t('rep.stillOpen')}` : ''}
                    </div>
                    {s.comment && <div className="muted">{s.comment}</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(s.openingFloatXaf)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {money(Object.values(s.byMethod).reduce((a, b) => a + b, 0))}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {money(s.cashExpensesXaf)}
                    {s.cashRefundsXaf > 0 && (
                      <div className="muted">
                        {t('rep.refunds')} {money(s.cashRefundsXaf)}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(s.expectedCashXaf)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {s.countedCashXaf === null ? '-' : money(s.countedCashXaf)}
                  </td>
                  <td
                    style={{ textAlign: 'right' }}
                    className={(s.differenceXaf ?? 0) !== 0 ? 'danger-text' : ''}
                  >
                    {s.differenceXaf === null ? '-' : money(s.differenceXaf)}
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

function FinanceTab({ period }: { period: Period }) {
  const { t, locale } = useI18n();
  const report = useReport<FinanceReport>('finance', period);
  const data = report.data;
  const money = (v: number) => formatXaf(v, locale);
  if (!data)
    return <p className="muted">{report.isError ? errorMessage(report.error, t) : t('common.loading')}</p>;
  const lines: { label: string; value: number; strong?: boolean; sign?: '-' }[] = [
    { label: t('fin.revenue'), value: data.revenueXaf },
    { label: t('fin.costOfSales'), value: data.costOfSalesXaf, sign: '-' },
    { label: t('fin.grossMargin'), value: data.grossMarginXaf, strong: true },
    { label: t('fin.losses'), value: data.lossesXaf, sign: '-' },
    ...data.operatingExpenses.map((e) => ({ label: e.name, value: e.amountXaf, sign: '-' as const })),
    { label: t('fin.estimatedProfit'), value: data.estimatedProfitXaf, strong: true },
  ];
  return (
    <>
      <div className="alert" role="note" style={{ marginBottom: 12 }}>
        {t('fin.disclaimer')}
      </div>
      <div className="dash-cols">
        <section className="card small-pad dash-section">
          <h2>{t('fin.title')}</h2>
          <table className="grid">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className={l.strong ? 'total-row' : ''}>
                  <td>{l.strong ? <b>{l.label}</b> : l.label}</td>
                  <td style={{ textAlign: 'right' }} className={l.strong && l.value < 0 ? 'danger-text' : ''}>
                    {l.sign && l.value ? '- ' : ''}
                    {l.strong ? <b>{money(l.value)}</b> : money(l.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.grossMarginRate !== null && (
            <p className="muted">
              {t('fin.marginRate', { rate: data.grossMarginRate.toLocaleString(locale) })}
            </p>
          )}
        </section>
        <section className="card small-pad dash-section">
          <h2>{t('fin.cashOut')}</h2>
          <table className="grid">
            <tbody>
              <tr>
                <td>{t('fin.purchases')}</td>
                <td style={{ textAlign: 'right' }}>{money(data.purchaseExpensesXaf)}</td>
              </tr>
              <tr>
                <td>{t('fin.goodsReceived')}</td>
                <td style={{ textAlign: 'right' }}>{money(data.goodsReceivedXaf)}</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">{t('fin.purchasesHint')}</p>
          {data.salesWithoutRecipe.products > 0 && (
            <div className="alert warn">
              {t('fin.noRecipe', {
                count: data.salesWithoutRecipe.products,
                amount: money(data.salesWithoutRecipe.amountXaf),
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function ExportsTab({ period }: { period: Period }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (kind: string) => {
    setError('');
    setBusy(kind);
    try {
      await downloadFile(
        `/reports/export/${kind}?${periodQuery(period)}`,
        `tchop-${kind}-${period.from}-${period.to}.csv`,
      );
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card small-pad">
      <p className="muted" style={{ marginTop: 0 }}>
        {t('rep.exportHelp')}
      </p>
      <div className="export-grid">
        {EXPORT_KINDS.map((k) => (
          <button key={k} className="btn" disabled={busy !== null} onClick={() => void download(k)}>
            ⬇ {t(`rep.export.${k}`)}
          </button>
        ))}
      </div>
      {error && (
        <div className="alert danger" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  entity: string | null;
  actor: string | null;
  approver: string | null;
  reason: string | null;
  after: unknown;
}

function AuditTab({ period }: { period: Period }) {
  const { t, locale } = useI18n();
  const [action, setAction] = useState('');
  const filter = /^[a-z_.]*$/.test(action) ? action : '';
  const log = useInfiniteQuery({
    queryKey: ['audit', period.from, period.to, filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ entries: AuditEntry[]; next: string | null }>(
        `/audit?${periodQuery(period)}&limit=50${filter ? `&action=${filter}` : ''}${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="audit-action">{t('rep.auditFilter')}</label>
        <input
          id="audit-action"
          placeholder="payment. / stock. / expense."
          value={action}
          onChange={(e) => setAction(e.target.value.toLowerCase().trim())}
        />
      </div>
      <div className="card scroll-x">
        {rows.length === 0 ? (
          <p className="placeholder muted">{log.isPending ? t('common.loading') : t('rep.auditEmpty')}</p>
        ) : (
          <table className="grid">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString(locale)}</td>
                  <td>
                    <code>{r.action}</code>
                  </td>
                  <td>
                    {r.actor ?? '-'}
                    {r.approver && (
                      <div className="muted">
                        {t('stock.approvedBy')} {r.approver}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.reason && <div>{r.reason}</div>}
                    {r.after !== null && r.after !== undefined && (
                      <small className="muted audit-detail">{JSON.stringify(r.after)}</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {log.hasNextPage && (
        <button
          className="btn ghost block"
          style={{ marginTop: 8 }}
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t('stock.more')}
        </button>
      )}
    </>
  );
}
