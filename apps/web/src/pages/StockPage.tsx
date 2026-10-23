import { useMutation, useQuery } from '@tanstack/react-query';
import { type MessageKey } from '@tchop/i18n';
import { type Access, formatXaf, LOSS_TYPES, newId, type Permission } from '@tchop/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { approvalBody, ApprovalFields, type ApprovalValue } from '../components/ApprovalFields';
import { errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import {
  formatQty,
  type Notice,
  parseQty,
  STOCK_KEY,
  type StockItem,
  useLocations,
  useRefreshStock,
  useStockItems,
} from '../stock';
import { InventoryTab } from './stock/InventoryTab';
import { ItemsTab } from './stock/ItemsTab';
import { JournalTab } from './stock/JournalTab';
import { PurchasesTab } from './stock/PurchasesTab';
import { ReceiptsTab } from './stock/ReceiptsTab';
import { RecipesTab } from './stock/RecipesTab';

type Tab = 'levels' | 'receipts' | 'purchases' | 'inventory' | 'items' | 'recipes' | 'journal';

const TABS: { id: Tab; label: MessageKey; permission: Permission; access: Access }[] = [
  { id: 'levels', label: 'stock.tabLevels', permission: 'stock.view', access: 'read' },
  { id: 'receipts', label: 'stock.tabReceipts', permission: 'stock.receive', access: 'write' },
  { id: 'purchases', label: 'stock.tabPurchases', permission: 'purchase.manage', access: 'read' },
  { id: 'inventory', label: 'stock.tabInventory', permission: 'stock.count', access: 'read' },
  { id: 'items', label: 'stock.tabItems', permission: 'stock.item.manage', access: 'write' },
  { id: 'recipes', label: 'stock.tabRecipes', permission: 'recipe.edit', access: 'read' },
  { id: 'journal', label: 'stock.tabJournal', permission: 'stock.view', access: 'read' },
];

/** Écran des stocks : état par magasin, réceptions, achats, inventaires, articles, recettes, journal. */
export function StockPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const tabs = TABS.filter((tab) => can(tab.permission, tab.access));
  const [tab, setTab] = useState<Tab>('levels');
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.stock')}</h1>
        <div className="tabs" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.id}
              className="tab"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => {
                setTab(x.id);
                setNotice(null);
              }}
            >
              {t(x.label)}
            </button>
          ))}
        </div>
      </div>
      {notice && (
        <div className={`alert ${notice.kind}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}
      {tab === 'levels' && <LevelsTab onNotice={setNotice} />}
      {tab === 'receipts' && <ReceiptsTab onNotice={setNotice} />}
      {tab === 'purchases' && <PurchasesTab onNotice={setNotice} />}
      {tab === 'inventory' && <InventoryTab onNotice={setNotice} />}
      {tab === 'items' && <ItemsTab onNotice={setNotice} />}
      {tab === 'recipes' && <RecipesTab onNotice={setNotice} />}
      {tab === 'journal' && <JournalTab />}
    </>
  );
}

// ------------------------------------------------------------------ état du stock

function LevelsTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const items = useStockItems();
  const locations = useLocations();
  const missing = useQuery({
    queryKey: [...STOCK_KEY, 'recipes-missing'],
    queryFn: () => api<{ id: string }[]>('/stock/recipes/missing'),
    enabled: can('recipe.edit', 'read'),
  });
  const [search, setSearch] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [acting, setActing] = useState<StockItem | null>(null);
  const canAct = can('stock.loss') || can('stock.transfer') || can('stock.adjust');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (items.data ?? []).filter(
      (i) => (!alertsOnly || i.alert) && (!needle || i.name.toLowerCase().includes(needle)),
    );
  }, [items.data, search, alertsOnly]);
  const alerts = (items.data ?? []).filter((i) => i.alert).length;
  const showValue = items.data?.some((i) => i.valueXaf !== undefined);

  return (
    <>
      <div className="row-between" style={{ marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0, minWidth: 220, flex: 1 }}>
          <input
            type="search"
            placeholder={t('stock.search')}
            aria-label={t('stock.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={alertsOnly} onChange={(e) => setAlertsOnly(e.target.checked)} />
          {t('stock.alertsOnly')} ({alerts})
        </label>
      </div>
      {(missing.data?.length ?? 0) > 0 && (
        <div className="alert" role="status" style={{ marginBottom: 12 }}>
          {t('stock.missingRecipes', { n: missing.data!.length })}
        </div>
      )}
      <div className="card scroll-x">
        {items.isPending ? (
          <p className="placeholder muted">{t('common.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="placeholder muted">{t('stock.noItems')}</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('stock.item')}</th>
                {locations.data?.map((l) => (
                  <th key={l.id} style={{ textAlign: 'right' }}>
                    {l.name}
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}>{t('stock.total')}</th>
                {showValue && <th style={{ textAlign: 'right' }}>{t('stock.value')}</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <b>{i.name}</b>
                    <div className="muted">
                      {t(`unit.${i.unit}`)} · {t('stock.issuedFrom')} {i.location.name}
                    </div>
                  </td>
                  {locations.data?.map((l) => {
                    const q = i.levels.find((x) => x.locationId === l.id)?.quantity ?? 0;
                    return (
                      <td
                        key={l.id}
                        style={{ textAlign: 'right' }}
                        className={q < 0 ? 'danger-text' : q === 0 ? 'muted' : ''}
                      >
                        {formatQty(q, locale)}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <b>{formatQty(i.total, locale)}</b>{' '}
                    {i.alert && <span className="pill danger">{t('stock.low')}</span>}
                  </td>
                  {showValue && (
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {formatXaf(i.valueXaf ?? 0, locale)}
                    </td>
                  )}
                  <td style={{ textAlign: 'right' }}>
                    {canAct && (
                      <button className="btn ghost" onClick={() => setActing(i)}>
                        {t('stock.move')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {acting && <MovementModal item={acting} onClose={() => setActing(null)} onNotice={onNotice} />}
    </>
  );
}

type Action = 'loss' | 'breakage' | 'internal_use' | 'transfer' | 'adjust';

/** Perte, casse, consommation interne, transfert ou correction d'un article. */
function MovementModal({
  item,
  onClose,
  onNotice,
}: {
  item: StockItem;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const locations = useLocations();
  const refresh = useRefreshStock();
  const actions: Action[] = [
    ...(can('stock.loss') ? [...LOSS_TYPES] : []),
    ...(can('stock.transfer') ? (['transfer'] as const) : []),
    ...(can('stock.adjust') ? (['adjust'] as const) : []),
  ];
  const [action, setAction] = useState<Action>(actions[0] ?? 'loss');
  const [locationId, setLocationId] = useState(item.location.id);
  const [toLocationId, setToLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [reason, setReason] = useState('');
  const [key] = useState(() => newId());
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [error, setError] = useState('');

  const others = locations.data?.filter((l) => l.id !== locationId) ?? [];
  const target = toLocationId || others[0]?.id || '';
  const qty = parseQty(quantity);

  const save = useMutation({
    mutationFn: () => {
      if (action === 'transfer') {
        return api('/stock/transfers', {
          method: 'POST',
          body: {
            idempotencyKey: key,
            itemId: item.id,
            fromLocationId: locationId,
            toLocationId: target,
            quantity: qty,
            note: reason || undefined,
          },
        });
      }
      if (action === 'adjust') {
        return api('/stock/adjustments', {
          method: 'POST',
          body: {
            idempotencyKey: key,
            itemId: item.id,
            locationId,
            quantity: direction * qty,
            reason,
            ...approvalBody(needsApproval, approval),
          },
        });
      }
      return api('/stock/losses', {
        method: 'POST',
        body: {
          idempotencyKey: key,
          type: action,
          itemId: item.id,
          locationId,
          quantity: qty,
          reason,
          ...approvalBody(needsApproval, approval),
        },
      });
    },
    onSuccess: () => {
      void refresh();
      onNotice({ kind: 'ok', text: t('stock.moveDone') });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedsApproval(true);
      setError(errorMessage(e, t));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!(qty > 0)) return setError(t('stock.quantityInvalid'));
    save.mutate();
  };

  return (
    <Modal title={item.name} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="mv-action">{t('stock.action')}</label>
          <select id="mv-action" value={action} onChange={(e) => setAction(e.target.value as Action)}>
            {actions.map((a) => (
              <option key={a} value={a}>
                {t(`stock.action.${a}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="mv-location">
              {action === 'transfer' ? t('stock.from') : t('stock.location')}
            </label>
            <select id="mv-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({formatQty(item.levels.find((x) => x.locationId === l.id)?.quantity ?? 0, locale)}
                  )
                </option>
              ))}
            </select>
          </div>
          {action === 'transfer' ? (
            <div className="field">
              <label htmlFor="mv-to">{t('stock.to')}</label>
              <select id="mv-to" value={target} onChange={(e) => setToLocationId(e.target.value)}>
                {others.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          ) : action === 'adjust' ? (
            <div className="field">
              <label htmlFor="mv-direction">{t('stock.direction')}</label>
              <select
                id="mv-direction"
                value={direction}
                onChange={(e) => setDirection(Number(e.target.value) === -1 ? -1 : 1)}
              >
                <option value={1}>{t('stock.add')}</option>
                <option value={-1}>{t('stock.remove')}</option>
              </select>
            </div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="mv-qty">
            {t('stock.quantity')} ({t(`unit.${item.unit}`)})
          </label>
          <input
            id="mv-qty"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="mv-reason">
            {action === 'transfer' ? t('stock.noteOptional') : t('stock.reason')}
          </label>
          <input
            id="mv-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required={action !== 'transfer'}
            minLength={action !== 'transfer' ? 3 : undefined}
            maxLength={200}
          />
        </div>
        {needsApproval && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending}>
            {t('common.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
