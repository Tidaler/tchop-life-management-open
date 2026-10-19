import { useMutation, useQuery } from '@tanstack/react-query';
import { formatXaf } from '@tchop/shared';
import { useState } from 'react';
import { api, ApiError } from '../../api';
import { approvalBody, ApprovalFields, type ApprovalValue } from '../../components/ApprovalFields';
import { ConfirmButton, errorMessage } from '../../components/common';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import {
  formatQty,
  type Inventory,
  type InventorySummary,
  type Notice,
  parseQty,
  STOCK_KEY,
  useLocations,
  useRefreshStock,
} from '../../stock';

/** Inventaires : ouverture par magasin, comptage à l'aveugle, clôture avec ajustement des écarts. */
export function InventoryTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const canCount = can('stock.count');
  const locations = useLocations();
  const refresh = useRefreshStock();
  const list = useQuery({
    queryKey: [...STOCK_KEY, 'inventories'],
    queryFn: () => api<InventorySummary[]>('/stock/inventories'),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState('');
  const location = locationId || locations.data?.[0]?.id || '';

  const start = useMutation({
    mutationFn: () =>
      api<Inventory>('/stock/inventories', { method: 'POST', body: { locationId: location } }),
    onSuccess: (count) => {
      void refresh();
      setOpenId(count.id);
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  if (openId) return <InventorySheet id={openId} onBack={() => setOpenId(null)} onNotice={onNotice} />;

  return (
    <>
      {canCount && (
        <div className="card small-pad row-between" style={{ marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0, minWidth: 220 }}>
            <label htmlFor="inv-location">{t('stock.location')}</label>
            <select id="inv-location" value={location} onChange={(e) => setLocationId(e.target.value)}>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn primary"
            onClick={() => start.mutate()}
            disabled={start.isPending || !location}
          >
            {t('stock.startInventory')}
          </button>
        </div>
      )}
      <div className="card scroll-x">
        {(list.data?.length ?? 0) === 0 ? (
          <p className="placeholder muted">{t('stock.noInventories')}</p>
        ) : (
          <table className="grid">
            <tbody>
              {list.data!.map((c) => (
                <tr key={c.id} onClick={() => setOpenId(c.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <b>n° {c.number}</b>
                    <div className="muted">{new Date(c.createdAt).toLocaleString(locale)}</div>
                  </td>
                  <td>{c.location.name}</td>
                  <td>
                    {c.lines} {t('stock.itemsCount')}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {c.varianceXaf != null && c.status === 'closed' && (
                      <span style={{ marginRight: 8 }}>{formatXaf(c.varianceXaf, locale)}</span>
                    )}
                    <span
                      className={`pill ${c.status === 'closed' ? 'ok' : c.status === 'cancelled' ? 'danger' : ''}`}
                    >
                      {t(`stock.inventoryStatus.${c.status}`)}
                    </span>
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

function InventorySheet({
  id,
  onBack,
  onNotice,
}: {
  id: string;
  onBack: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const refresh = useRefreshStock();
  const count = useQuery({
    queryKey: [...STOCK_KEY, 'inventory', id],
    queryFn: () => api<Inventory>(`/stock/inventories/${id}`),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [error, setError] = useState('');
  const data = count.data;
  const editable = data?.status === 'open' && can('stock.count');

  const changes = () =>
    Object.entries(draft).map(([itemId, raw]) => ({
      itemId,
      countedQty: raw.trim() === '' ? null : parseQty(raw),
    }));

  const saveCounts = useMutation({
    mutationFn: () =>
      api<Inventory>(`/stock/inventories/${id}/counts`, { method: 'PUT', body: { lines: changes() } }),
    onSuccess: () => {
      setDraft({});
      void refresh();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  const close = useMutation({
    mutationFn: async () => {
      if (Object.keys(draft).length > 0)
        await api(`/stock/inventories/${id}/counts`, { method: 'PUT', body: { lines: changes() } });
      setDraft({});
      return api<Inventory>(`/stock/inventories/${id}/close`, {
        method: 'POST',
        body: { version: data!.version, ...approvalBody(needsApproval, approval) },
      });
    },
    onSuccess: () => {
      void refresh();
      onNotice({ kind: 'ok', text: t('stock.inventoryClosed') });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedsApproval(true);
      setError(errorMessage(e, t));
      void refresh();
    },
  });

  const cancel = useMutation({
    mutationFn: () =>
      api(`/stock/inventories/${id}/cancel`, { method: 'POST', body: { version: data!.version } }),
    onSuccess: () => void refresh(),
    onError: (e) => setError(errorMessage(e, t)),
  });

  if (!data) return <p className="muted">{t('common.loading')}</p>;
  const closed = data.status === 'closed';
  const invalid = Object.values(draft).some((raw) => raw.trim() !== '' && !(parseQty(raw) >= 0));

  return (
    <>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <h2>
          <button className="btn ghost" onClick={onBack} aria-label={t('common.back')}>
            ←
          </button>{' '}
          {t('stock.inventory')} n° {data.number} · {data.location.name}
        </h2>
        <span className={`pill ${closed ? 'ok' : data.status === 'cancelled' ? 'danger' : ''}`}>
          {t(`stock.inventoryStatus.${data.status}`)}
        </span>
      </div>
      {editable && <p className="hint">{t('stock.blindHint')}</p>}
      <div className="card scroll-x">
        <table className="grid">
          <thead>
            <tr>
              <th>{t('stock.item')}</th>
              <th style={{ textAlign: 'right' }}>{t('stock.counted')}</th>
              {closed && <th style={{ textAlign: 'right' }}>{t('stock.expected')}</th>}
              {closed && <th style={{ textAlign: 'right' }}>{t('stock.variance')}</th>}
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.itemId}>
                <td>
                  <b>{l.itemName}</b> <span className="muted">{t(`unit.${l.unit}`)}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {editable ? (
                    <input
                      className="qty-input"
                      inputMode="decimal"
                      aria-label={`${t('stock.counted')} ${l.itemName}`}
                      value={draft[l.itemId] ?? (l.countedQty === null ? '' : String(l.countedQty))}
                      onChange={(e) => setDraft((d) => ({ ...d, [l.itemId]: e.target.value }))}
                    />
                  ) : l.countedQty === null ? (
                    <span className="muted">-</span>
                  ) : (
                    formatQty(l.countedQty, locale)
                  )}
                </td>
                {closed && (
                  <td style={{ textAlign: 'right' }}>
                    {l.expectedQty == null ? '-' : formatQty(l.expectedQty, locale)}
                  </td>
                )}
                {closed && (
                  <td
                    style={{ textAlign: 'right' }}
                    className={(l.varianceQty ?? 0) < 0 ? 'danger-text' : ''}
                  >
                    {l.varianceQty == null ? '-' : formatQty(l.varianceQty, locale)}
                    {l.varianceXaf !== undefined && (
                      <div className="muted">{formatXaf(l.varianceXaf, locale)}</div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {closed && data.varianceXaf != null && (
        <p style={{ marginTop: 12 }}>
          <b>
            {t('stock.netVariance')} : {formatXaf(data.varianceXaf, locale)}
          </b>
        </p>
      )}
      {editable && (
        <div className="card small-pad" style={{ marginTop: 12 }}>
          {needsApproval && <ApprovalFields value={approval} onChange={setApproval} />}
          {error && (
            <div className="alert danger" role="alert">
              {error}
            </div>
          )}
          <div className="modal-foot">
            <ConfirmButton
              label={t('stock.cancelInventory')}
              question={`n° ${data.number}`}
              onConfirm={() => cancel.mutate()}
            />
            <button
              className="btn"
              disabled={saveCounts.isPending || invalid || Object.keys(draft).length === 0}
              onClick={() => saveCounts.mutate()}
            >
              {t('stock.saveCounts')}
            </button>
            <button
              className="btn primary"
              disabled={close.isPending || invalid}
              onClick={() => close.mutate()}
            >
              {t('stock.closeInventory')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
