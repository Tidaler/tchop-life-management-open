import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { formatXaf, STOCK_MOVEMENT_TYPES, type StockMovementType } from '@tchop/shared';
import { useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { formatQty, type Movement, STOCK_KEY, useStockItems } from '../../stock';

interface Report {
  items: {
    id: string;
    name: string;
    unit: string;
    received: { quantity: number; valueXaf: number };
    sold: { quantity: number; valueXaf: number };
    losses: { quantity: number; valueXaf: number };
    adjustments: { quantity: number; valueXaf: number };
  }[];
  totals: { receivedXaf: number; soldXaf: number; lossesXaf: number; adjustmentsXaf: number };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Journal des mouvements (filtrable) et, pour les rôles autorisés, rapport de la période et valeur du stock. */
export function JournalTab() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const items = useStockItems();
  const [type, setType] = useState<StockMovementType | ''>('');
  const [itemId, setItemId] = useState('');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());

  const movements = useInfiniteQuery({
    queryKey: [...STOCK_KEY, 'movements', type, itemId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (type) params.set('type', type);
      if (itemId) params.set('itemId', itemId);
      if (pageParam) params.set('before', pageParam);
      return api<{ movements: Movement[]; next: string | null }>(`/stock/movements?${params}`);
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const canReport = can('report.stock', 'read');
  const valuation = useQuery({
    queryKey: [...STOCK_KEY, 'valuation'],
    queryFn: () =>
      api<{ totalXaf: number; locations: { id: string; name: string; valueXaf: number }[] }>(
        '/stock/valuation',
      ),
    enabled: canReport,
  });
  const report = useQuery({
    queryKey: [...STOCK_KEY, 'report', from, to],
    queryFn: () => api<Report>(`/stock/report?from=${from}&to=${to}`),
    enabled: canReport && from <= to,
  });

  const rows = movements.data?.pages.flatMap((p) => p.movements) ?? [];

  return (
    <>
      {canReport && (
        <div className="card small-pad" style={{ marginBottom: 16 }}>
          {valuation.data && (
            <p style={{ marginTop: 0 }}>
              <b>
                {t('stock.stockValue')} : {formatXaf(valuation.data.totalXaf, locale)}
              </b>{' '}
              <span className="muted">
                {valuation.data.locations
                  .map((l) => `${l.name} ${formatXaf(l.valueXaf, locale)}`)
                  .join(' · ')}
              </span>
            </p>
          )}
          <div className="row2">
            <div className="field">
              <label htmlFor="rp-from">{t('stock.from')}</label>
              <input
                id="rp-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rp-to">{t('stock.to')}</label>
              <input id="rp-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {report.data && (
            <>
              <p className="muted">
                {t('stock.reportReceived')} {formatXaf(report.data.totals.receivedXaf, locale)} ·{' '}
                {t('stock.reportSold')} {formatXaf(report.data.totals.soldXaf, locale)} ·{' '}
                {t('stock.reportLosses')} {formatXaf(report.data.totals.lossesXaf, locale)} ·{' '}
                {t('stock.reportAdjustments')} {formatXaf(report.data.totals.adjustmentsXaf, locale)}
              </p>
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>{t('stock.item')}</th>
                      <th style={{ textAlign: 'right' }}>{t('stock.reportReceived')}</th>
                      <th style={{ textAlign: 'right' }}>{t('stock.reportSold')}</th>
                      <th style={{ textAlign: 'right' }}>{t('stock.reportLosses')}</th>
                      <th style={{ textAlign: 'right' }}>{t('stock.reportAdjustments')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.items.map((i) => (
                      <tr key={i.id}>
                        <td>{i.name}</td>
                        {[i.received, i.sold, i.losses, i.adjustments].map((v, k) => (
                          <td key={k} style={{ textAlign: 'right' }}>
                            {v.quantity === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              formatQty(v.quantity, locale)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div className="row2" style={{ marginBottom: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="jr-type">{t('stock.movementType')}</label>
          <select
            id="jr-type"
            value={type}
            onChange={(e) => setType(e.target.value as StockMovementType | '')}
          >
            <option value="">{t('stock.allTypes')}</option>
            {STOCK_MOVEMENT_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`stock.type.${x}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="jr-item">{t('stock.item')}</label>
          <select id="jr-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">{t('stock.allItems')}</option>
            {items.data?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="card scroll-x">
        {rows.length === 0 ? (
          <p className="placeholder muted">
            {movements.isPending ? t('common.loading') : t('stock.noMovements')}
          </p>
        ) : (
          <table className="grid">
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.createdAt).toLocaleString(locale)}</td>
                  <td>
                    <span className="pill">{t(`stock.type.${m.type}`)}</span>
                  </td>
                  <td>
                    <b>{m.itemName}</b>
                    <div className="muted">{m.locationName}</div>
                  </td>
                  <td
                    style={{ textAlign: 'right', whiteSpace: 'nowrap' }}
                    className={m.quantity < 0 ? 'danger-text' : ''}
                  >
                    {m.quantity > 0 ? '+' : ''}
                    {formatQty(m.quantity, locale)} {t(`unit.${m.unit}`)}
                    {m.valueXaf !== undefined && <div className="muted">{formatXaf(m.valueXaf, locale)}</div>}
                  </td>
                  <td>
                    {m.reason && <div>{m.reason}</div>}
                    <div className="muted">
                      {m.createdBy}
                      {m.approvedBy && ` · ${t('stock.approvedBy')} ${m.approvedBy}`}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {movements.hasNextPage && (
        <button
          className="btn ghost block"
          style={{ marginTop: 8 }}
          disabled={movements.isFetchingNextPage}
          onClick={() => void movements.fetchNextPage()}
        >
          {t('stock.more')}
        </button>
      )}
    </>
  );
}
