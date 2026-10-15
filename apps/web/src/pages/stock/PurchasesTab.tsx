import { useMutation } from '@tanstack/react-query';
import { formatXaf } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api';
import { ConfirmButton, errorMessage, Modal } from '../../components/common';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import {
  formatQty,
  type Notice,
  parseQty,
  type PurchaseOrder,
  type Supplier,
  usePurchaseOrders,
  useRefreshStock,
  useStockItems,
  useSuppliers,
} from '../../stock';

/** Fournisseurs et commandes d'achat. */
export function PurchasesTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const canEdit = can('purchase.manage');
  const suppliers = useSuppliers();
  const orders = usePurchaseOrders();
  const refresh = useRefreshStock();
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [ordering, setOrdering] = useState(false);

  const close = useMutation({
    mutationFn: (o: PurchaseOrder) =>
      api(`/stock/purchase-orders/${o.id}/close`, { method: 'POST', body: { version: o.version } }),
    onSuccess: () => void refresh(),
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  return (
    <div className="split">
      <div className="card side-list">
        <div className="section-label">{t('stock.suppliers')}</div>
        {suppliers.data?.map((s) => (
          <button key={s.id} className="item" onClick={() => canEdit && setEditing(s)}>
            <span>{s.name}</span>
            <span className="muted">{s.phone ?? ''}</span>
          </button>
        ))}
        {canEdit && (
          <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => setEditing('new')}>
            + {t('stock.newSupplier')}
          </button>
        )}
      </div>

      <div>
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2>{t('stock.purchaseOrders')}</h2>
          {canEdit && (
            <button className="btn primary" onClick={() => setOrdering(true)}>
              + {t('stock.newOrder')}
            </button>
          )}
        </div>
        <div className="card scroll-x">
          {(orders.data?.length ?? 0) === 0 ? (
            <p className="placeholder muted">{t('stock.noOrders')}</p>
          ) : (
            <table className="grid">
              <tbody>
                {orders.data!.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <b>n° {o.number}</b>
                      <div className="muted">{new Date(o.createdAt).toLocaleDateString(locale)}</div>
                    </td>
                    <td>{o.supplier.name}</td>
                    <td>
                      {o.lines.map((l) => (
                        <div key={l.id}>
                          {formatQty(l.receivedQuantity, locale)} / {formatQty(l.quantity, locale)}{' '}
                          {l.unitName} · {l.itemName}
                        </div>
                      ))}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {formatXaf(o.totalXaf, locale)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span
                        className={`pill ${o.status === 'received' ? 'ok' : o.status === 'cancelled' ? 'danger' : ''}`}
                      >
                        {t(`stock.orderStatus.${o.status}`)}
                      </span>{' '}
                      {canEdit && o.status === 'open' && (
                        <ConfirmButton
                          label={t('stock.closeOrder')}
                          question={`n° ${o.number}`}
                          onConfirm={() => close.mutate(o)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editing && (
        <SupplierEditor
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onNotice={onNotice}
        />
      )}
      {ordering && (
        <OrderEditor
          suppliers={suppliers.data ?? []}
          onClose={() => setOrdering(false)}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

function SupplierEditor({
  supplier,
  onClose,
  onNotice,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t } = useI18n();
  const refresh = useRefreshStock();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [contact, setContact] = useState(supplier?.contact ?? '');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (archived?: boolean) =>
      supplier
        ? api(`/stock/suppliers/${supplier.id}`, {
            method: 'PATCH',
            body: {
              version: supplier.version,
              name,
              phone: phone.trim() || null,
              contact: contact.trim() || null,
              ...(archived ? { archived: true } : {}),
            },
          })
        : api('/stock/suppliers', {
            method: 'POST',
            body: { name, phone: phone.trim() || undefined, contact: contact.trim() || undefined },
          }),
    onSuccess: () => {
      void refresh();
      onNotice(null);
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  return (
    <Modal title={supplier ? supplier.name : t('stock.newSupplier')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="field">
          <label htmlFor="sp-name">{t('stock.name')}</label>
          <input
            id="sp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="sp-phone">{t('stock.phone')}</label>
            <input id="sp-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="sp-contact">{t('stock.contact')}</label>
            <input
              id="sp-contact"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={80}
            />
          </div>
        </div>
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          {supplier && (
            <ConfirmButton
              label={t('stock.archive')}
              question={supplier.name}
              onConfirm={() => save.mutate(true)}
            />
          )}
          <button className="btn primary" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface OrderLine {
  uid: string;
  itemId: string;
  packagingId: string;
  quantity: string;
  unitPrice: string;
}

function OrderEditor({
  suppliers,
  onClose,
  onNotice,
}: {
  suppliers: Supplier[];
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const items = useStockItems();
  const refresh = useRefreshStock();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '');
  const [lines, setLines] = useState<OrderLine[]>([
    { uid: crypto.randomUUID(), itemId: '', packagingId: '', quantity: '', unitPrice: '' },
  ]);
  const [error, setError] = useState('');
  const filled = lines.filter((l) => l.itemId && parseQty(l.quantity) > 0);
  const total = filled.reduce((s, l) => s + Math.round(parseQty(l.quantity) * (Number(l.unitPrice) || 0)), 0);
  const update = (uid: string, patch: Partial<OrderLine>) =>
    setLines((all) => all.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  const save = useMutation({
    mutationFn: () =>
      api<PurchaseOrder>('/stock/purchase-orders', {
        method: 'POST',
        body: {
          supplierId,
          lines: filled.map((l) => ({
            itemId: l.itemId,
            packagingId: l.packagingId || null,
            quantity: parseQty(l.quantity),
            unitPriceXaf: Math.round(Number(l.unitPrice) || 0),
          })),
        },
      }),
    onSuccess: (order) => {
      void refresh();
      onNotice({ kind: 'ok', text: t('stock.orderCreated', { n: order.number }) });
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  return (
    <Modal title={t('stock.newOrder')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (filled.length === 0) return setError(t('stock.noLines'));
          save.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="po-supplier">{t('stock.supplier')}</label>
          <select
            id="po-supplier"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            required
          >
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {lines.map((l) => {
          const item = items.data?.find((i) => i.id === l.itemId);
          return (
            <div key={l.uid} className="receipt-line">
              <select
                aria-label={t('stock.item')}
                value={l.itemId}
                onChange={(e) => update(l.uid, { itemId: e.target.value, packagingId: '' })}
              >
                <option value="">{t('stock.chooseItem')}</option>
                {items.data?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('stock.packaging')}
                value={l.packagingId}
                onChange={(e) => update(l.uid, { packagingId: e.target.value })}
                disabled={!item}
              >
                <option value="">{item ? t(`unit.${item.unit}`) : '—'}</option>
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
                value={l.quantity}
                onChange={(e) => update(l.uid, { quantity: e.target.value })}
              />
              <input
                aria-label={t('stock.unitPrice')}
                placeholder={t('stock.unitPrice')}
                inputMode="numeric"
                value={l.unitPrice}
                onChange={(e) => update(l.uid, { unitPrice: e.target.value.replace(/\D/g, '') })}
              />
              <span />
              <button
                type="button"
                className="btn ghost"
                aria-label={t('stock.removeLine')}
                onClick={() => setLines((all) => (all.length > 1 ? all.filter((x) => x.uid !== l.uid) : all))}
              >
                ✕
              </button>
            </div>
          );
        })}
        <div className="row-between" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              setLines((all) => [
                ...all,
                { uid: crypto.randomUUID(), itemId: '', packagingId: '', quantity: '', unitPrice: '' },
              ])
            }
          >
            + {t('stock.addLine')}
          </button>
          <b>
            {t('stock.total')} : {formatXaf(total, locale)}
          </b>
        </div>
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending || !supplierId}>
            {t('stock.createOrder')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
