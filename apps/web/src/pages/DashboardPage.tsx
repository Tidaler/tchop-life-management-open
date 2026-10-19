import { formatXaf, pickText } from '@tchop/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { PeriodPicker, presetPeriod } from '../components/PeriodPicker';
import { type Dashboard, type Period, type SalesReport, useReport } from '../finance';
import { useI18n } from '../i18n';
import { useSession } from '../session';

/** Tableau de bord du gérant : chiffre d'affaires, commandes, panier moyen, catégories, dépenses, caisses, stock. */
export function DashboardPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const [period, setPeriod] = useState<Period>(presetPeriod('today'));
  const report = useReport<Dashboard>('dashboard', period);
  const data = report.data;
  const money = (v: number) => formatXaf(v, locale);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.dashboard')}</h1>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      {!data ? (
        <p className="muted">{report.isError ? t('error.generic') : t('common.loading')}</p>
      ) : (
        <>
          <div className="kpi-grid">
            <Kpi
              label={t('dash.revenue')}
              value={money(data.sales.netXaf)}
              hint={t('dash.taxIncluded')}
              strong
            />
            <Kpi label={t('dash.bills')} value={String(data.sales.bills)} />
            <Kpi label={t('dash.averageTicket')} value={money(data.sales.averageTicketXaf)} />
            <Kpi
              label={t('dash.orders')}
              value={String(data.sales.orders ?? 0)}
              hint={t('dash.openOrders', { count: data.openOrders })}
            />
            <Kpi
              label={t('dash.expenses')}
              value={money(data.expenses.totalXaf)}
              hint={t('dash.expenseCount', { count: data.expenses.count })}
            />
            <Kpi label={t('dash.discounts')} value={money(data.sales.discountXaf)} />
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
              <h2>{t('dash.topProducts')}</h2>
              <BarList
                rows={data.topProducts.map((p) => ({
                  key: p.id,
                  label: `${pickText(p.name, locale)} (${p.quantity})`,
                  value: p.amountXaf,
                }))}
                format={money}
                empty={t('dash.noSales')}
              />
            </section>
          </div>

          <div className="dash-cols">
            <section className="card small-pad dash-section">
              <h2>{t('dash.byMethod')}</h2>
              {data.byMethod.length === 0 ? (
                <p className="muted">{t('dash.noSales')}</p>
              ) : (
                <table className="grid">
                  <tbody>
                    {data.byMethod.map((m) => (
                      <tr key={m.method}>
                        <td>{t(`method.${m.method}` as Parameters<typeof t>[0])}</td>
                        <td className="muted">{m.count}</td>
                        <td style={{ textAlign: 'right' }}>
                          <b>{money(m.amountXaf)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.paymentsToVerify > 0 && (
                <p className="hint">{t('dash.toVerify', { count: data.paymentsToVerify })}</p>
              )}
            </section>
            <section className="card small-pad dash-section">
              <h2>{t('dash.cash')}</h2>
              {data.cashSessions.length === 0 ? (
                <p className="muted">{t('dash.noOpenCash')}</p>
              ) : (
                <table className="grid">
                  <tbody>
                    {data.cashSessions.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <b>{s.register}</b>
                          <div className="muted">{s.cashier}</div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {money(s.collectedXaf)}
                          <div className="muted">
                            {t('dash.expectedCash')} {money(s.expectedCashXaf)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {can('stock.view', 'read') && (
              <section className="card small-pad dash-section">
                <h2>{t('dash.stockAlerts')}</h2>
                {data.stockAlerts.count === 0 ? (
                  <p className="muted">{t('dash.noAlerts')}</p>
                ) : (
                  <>
                    <ul className="plain-list">
                      {data.stockAlerts.items.map((i) => (
                        <li key={i.id}>
                          <span className="pill danger">{t('stock.low')}</span> {i.name}
                        </li>
                      ))}
                    </ul>
                    <Link to="/stock" className="link">
                      {t('dash.seeStock', { count: data.stockAlerts.count })}
                    </Link>
                  </>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Kpi({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className={`card kpi${strong ? ' strong' : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

/** Barres horizontales d'une seule mesure (une teinte), valeur écrite à côté de chaque barre. */
export function BarList({
  rows,
  format,
  empty,
}: {
  rows: { key: string; label: string; value: number }[];
  format: (v: number) => string;
  empty: string;
}) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="bar-list">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label} : ${format(r.value)}`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden>
            <span className="bar-fill" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </span>
          <span className="bar-value">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Chiffre d'affaires par jour : colonnes fines, survol pour la valeur exacte, plus haut jour annoté. */
export function DayBars({ days }: { days: SalesReport['byDay'] }) {
  const { locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 180;
  const pad = { top: 22, bottom: 24, side: 8 };
  const max = Math.max(...days.map((d) => d.netXaf), 1);
  const step = (width - pad.side * 2) / days.length;
  const bar = Math.max(3, Math.min(28, step * 0.6));
  const best = days.reduce((a, d, i) => (d.netXaf > (days[a]?.netXaf ?? 0) ? i : a), 0);
  const label = (day: string) =>
    new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${day}T12:00:00Z`));
  const shown = hover ?? best;
  const focus = days[shown];
  return (
    <div className="day-bars">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Chiffre d'affaires par jour">
        <line
          x1={pad.side}
          x2={width - pad.side}
          y1={height - pad.bottom}
          y2={height - pad.bottom}
          className="axis"
        />
        {days.map((d, i) => {
          const h = ((height - pad.top - pad.bottom) * d.netXaf) / max;
          const x = pad.side + i * step + (step - bar) / 2;
          const y = height - pad.bottom - h;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Zone de survol plus large que la barre. */}
              <rect
                x={pad.side + i * step}
                y={pad.top}
                width={step}
                height={height - pad.top - pad.bottom}
                fill="transparent"
              />
              <path className={i === shown ? 'bar active' : 'bar'} d={roundedTop(x, y, bar, h)} />
              {(i === 0 || i === days.length - 1 || days.length <= 10) && (
                <text x={x + bar / 2} y={height - 6} textAnchor="middle" className="tick">
                  {label(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {focus && (
        <div className="day-focus">
          <b>{label(focus.day)}</b> · {formatXaf(focus.netXaf, locale)} · {focus.bills}
        </div>
      )}
    </div>
  );
}

/** Colonne ancrée à la ligne de base, arrondie (4 px) seulement en haut. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  const base = y + h;
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}
