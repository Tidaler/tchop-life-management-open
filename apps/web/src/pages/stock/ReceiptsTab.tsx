import { useMutation, useQuery } from '@tanstack/react-query';
import { formatXaf, newId } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api';
import { errorMessage } from '../../components/common';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import {
  formatQty,
  type GoodsReceipt,
  type Notice,
  parseQty,
  STOCK_KEY,
  type StockItem,
  useLocations,
  usePurchaseOrders,
  useRefreshStock,
  useStockItems,
  useSuppliers,
} from '../../stock';

interface DraftLine {
  uid: string;
  itemId: string;
  packagingId: string;
  quantity: string;
  unitPrice: string;
  purchaseOrderLineId?: string;
}

const emptyLine = (): DraftLine => ({
  uid: newId(),
  itemId: '',
  packagingId: '',
  quantity: '',
  unitPrice: '',
});

/** Réception d'une livraison (avec ou sans commande d'achat) et historique des réceptions. */
export function ReceiptsTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const items = useStockItems();
  const locations = useLocations();
  const canPurchases = can('purchase.manage', 'read');
  const suppliers = useSuppliers(canPurchases);
  const orders = usePurchaseOrders(canPurchases);
  const history = useQuery({
    queryKey: [...STOCK_KEY, 'receipts'],
    queryFn: () => api<GoodsReceipt[]>('/stock/receipts'),
    enabled: can('report.stock', 'read'),
  });
  const refresh = useRefreshStock();

  const [locationId, setLocationId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [key, setKey] = useState(() => newId());

  const byId = new Map((items.data ?? []).map((i) => [i.id, i]));
  const openOrders = (orders.data ?? []).filter(
    (o) => o.status === 'open' && (!supplierId || o.supplier.id === supplierId),
  );
  const location = locationId || locations.data?.[0]?.id || '';

  const pickOrder = (id: string) => {
    setOrderId(id);
    const order = orders.data?.find((o) => o.id === id);
    if (!order) return;
    setSupplierId(order.supplier.id);
    // Préremplit avec le reste à livrer, dans le conditionnement commandé.
    setLines(
      order.lines
        .filter((l) => l.receivedQuantity < l.quantity)
        .map((l) => ({
          uid: newId(),
          itemId: l.itemId,
          packagingId: byId.get(l.itemId)?.packagings.find((p) => p.name === l.unitName)?.id ?? '',
          quantity: String(Math.round((l.quantity - l.receivedQuantity) * 1000) / 1000),
          unitPrice: String(l.unitPriceXaf),
          purchaseOrderLineId: l.id,
        })),
    );
  };

  const update = (uid: string, patch: Partial<DraftLine>) =>
    setLines((all) => all.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  const filled = lines.filter((l) => l.itemId && parseQty(l.quantity) > 0);
  const total = filled.reduce((s, l) => s + Math.round(parseQty(l.quantity) * (Number(l.unitPrice) || 0)), 0);

  const save = useMutation({
    mutationFn: () =>
      api<GoodsReceipt>('/stock/receipts', {
        method: 'POST',
        body: {
          idempotencyKey: key,
          locationId: location,
          supplierId: supplierId || undefined,
          purchaseOrderId: orderId || undefined,
          reference: reference.trim() || undefined,
          lines: filled.map((l) => ({
            itemId: l.itemId,
            packagingId: l.packagingId || null,
            quantity: parseQty(l.quantity),
            unitPriceXaf: Math.round(Number(l.unitPrice) || 0),
            purchaseOrderLineId: l.purchaseOrderLineId,
          })),
        },
      }),
    onSuccess: (receipt) => {
      void refresh();
      onNotice({ kind: 'ok', text: t('stock.receiptDone', { n: receipt.number }) });
      setLines([emptyLine()]);
      setOrderId('');
      setReference('');
      setKey(newId());
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (filled.length === 0) return onNotice({ kind: 'danger', text: t('stock.noLines') });
    save.mutate();
  };

  return (
    <>
      <form className="card small-pad" onSubmit={submit} style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>{t('stock.newReceipt')}</h2>
        <div className="row2">
          <div className="field">
            <label htmlFor="rc-location">{t('stock.receivedIn')}</label>
            <select id="rc-location" value={location} onChange={(e) => setLocationId(e.target.value)}>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rc-ref">{t('stock.reference')}</label>
            <input
              id="rc-ref"
              value={reference}
              maxLength={40}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>
        {canPurchases && (
          <div className="row2">
            <div className="field">
              <label htmlFor="rc-supplier">{t('stock.supplier')}</label>
              <select
                id="rc-supplier"
                value={supplierId}
                onChange={(e) => {
                  setSupplierId(e.target.value);
                  setOrderId('');
                }}
              >
                <option value="">{t('stock.noSupplier')}</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rc-order">{t('stock.purchaseOrder')}</label>
              <select id="rc-order" value={orderId} onChange={(e) => pickOrder(e.target.value)}>
                <option value="">{t('stock.noOrder')}</option>
                {openOrders.map((o) => (
                  <option key={o.id} value={o.id}>
                    n° {o.number} · {o.supplier.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="section-label">{t('stock.lines')}</div>
        {lines.map((l) => (
          <ReceiptLine
            key={l.uid}
            line={l}
            items={items.data ?? []}
            onChange={(patch) => update(l.uid, patch)}
            onRemove={
              lines.length > 1 ? () => setLines((all) => all.filter((x) => x.uid !== l.uid)) : undefined
            }
          />
        ))}
        <div className="row-between" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setLines((all) => [...all, emptyLine()])}
          >
            + {t('stock.addLine')}
          </button>
          <b>
            {t('stock.total')} : {formatXaf(total, locale)}
          </b>
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={save.isPending}>
            {t('stock.receive')}
          </button>
        </div>
      </form>

      {history.data && (
        <div className="card scroll-x">
          <table className="grid">
            <thead>
              <tr>
                <th>n°</th>
                <th>{t('stock.date')}</th>
                <th>{t('stock.supplier')}</th>
                <th>{t('stock.location')}</th>
                <th>{t('stock.lines')}</th>
                <th style={{ textAlign: 'right' }}>{t('stock.total')}</th>
              </tr>
            </thead>
            <tbody>
              {history.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t('stock.noReceipts')}
                  </td>
                </tr>
              )}
              {history.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.number}</td>
                  <td>{new Date(r.createdAt).toLocaleString(locale)}</td>
                  <td>
                    {r.supplier?.name ?? '-'}
                    {r.purchaseOrder && <div className="muted">n° {r.purchaseOrder.number}</div>}
                    {r.reference && <div className="muted">{r.reference}</div>}
                  </td>
                  <td>{r.location.name}</td>
                  <td>
                    {r.lines.map((x, i) => (
                      <div key={i}>
                        {formatQty(x.quantity, locale)} {x.unitName} · {x.itemName}
                      </div>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {formatXaf(r.totalXaf, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ReceiptLine({
  line,
  items,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  items: StockItem[];
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove?: () => void;
}) {
  const { t, locale } = useI18n();
  const item = items.find((i) => i.id === line.itemId);
  const factor = item?.packagings.find((p) => p.id === line.packagingId)?.factor ?? 1;
  const qty = parseQty(line.quantity);
  return (
    <div className="receipt-line">
      <select
        aria-label={t('stock.item')}
        value={line.itemId}
        onChange={(e) =>
          onChange({ itemId: e.target.value, packagingId: '', purchaseOrderLineId: undefined })
        }
      >
        <option value="">{t('stock.chooseItem')}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <select
        aria-label={t('stock.packaging')}
        value={line.packagingId}
        onChange={(e) => onChange({ packagingId: e.target.value })}
        disabled={!item}
      >
        <option value="">{item ? t(`unit.${item.unit}`) : '-'}</option>
        {item?.packagings.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({formatQty(p.factor, locale)})
          </option>
        ))}
      </select>
      <input
        aria-label={t('stock.quantity')}
        placeholder={t('stock.quantity')}
        inputMode="decimal"
        value={line.quantity}
        onChange={(e) => onChange({ quantity: e.target.value })}
      />
      <input
        aria-label={t('stock.unitPrice')}
        placeholder={t('stock.unitPrice')}
        inputMode="numeric"
        value={line.unitPrice}
        onChange={(e) => onChange({ unitPrice: e.target.value.replace(/\D/g, '') })}
      />
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>
        {item && qty > 0 ? `= ${formatQty(qty * factor, locale)} ${t(`unit.${item.unit}`)}` : ''}
      </span>
      {onRemove ? (
        <button type="button" className="btn ghost" onClick={onRemove} aria-label={t('stock.removeLine')}>
          ✕
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
