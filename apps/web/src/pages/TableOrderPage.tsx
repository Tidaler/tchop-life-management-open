import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatXaf, needsApproval, pickText, type Station } from '@tchop/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { type Product, type ModifierGroup, useCatalog, useRefreshCatalog } from '../catalog';
import { errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';
import { type OrderDetail, type OrderLine, useOpenOrders, useOrder } from '../orders';
import { useMe, useSession } from '../session';
import { useFloor } from './FloorPage';

interface DraftLine {
  uid: string;
  productId: string;
  quantity: number;
  modifierIds: string[];
  note: string;
}

interface Draft {
  /** Clé d'envoi : conservée tant que l'envoi n'a pas réussi, pour qu'un renvoi ne crée pas de doublon. */
  key: string;
  lines: DraftLine[];
}

const newDraft = (): Draft => ({ key: crypto.randomUUID(), lines: [] });

/** Saisie non envoyée, gardée sur la tablette (survit à un rechargement de la page). */
function useDraft(tableId: string) {
  const storageKey = `tchop.draft.${tableId}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw) as Draft;
    } catch {
      /* saisie illisible : on repart de zéro */
    }
    return newDraft();
  });
  useEffect(() => {
    try {
      if (draft.lines.length) sessionStorage.setItem(storageKey, JSON.stringify(draft));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* stockage indisponible */
    }
  }, [draft, storageKey]);
  return [draft, setDraft] as const;
}

export function TableOrderPage() {
  const { tableId = '' } = useParams();
  const { t, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refreshCatalog = useRefreshCatalog();
  const catalog = useCatalog();
  const floor = useFloor();
  const openOrders = useOpenOrders();
  const orderId = openOrders.data?.find((o) => o.tableId === tableId)?.id;
  const order = useOrder(orderId);
  const [draft, setDraft] = useDraft(tableId);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picking, setPicking] = useState<Product | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<OrderLine | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const table = floor.data?.flatMap((z) => z.tables).find((tb) => tb.id === tableId);
  const products = useMemo(() => new Map(catalog.data?.products.map((p) => [p.id, p])), [catalog.data]);
  const groups = useMemo(() => new Map(catalog.data?.modifierGroups.map((g) => [g.id, g])), [catalog.data]);
  const category = catalog.data?.categories.find((c) => c.id === categoryId) ?? catalog.data?.categories[0];
  const canOrder = can('order.create');

  const unitPrice = (line: DraftLine) => {
    const product = products.get(line.productId);
    const extras = line.modifierIds.reduce((sum, id) => {
      for (const g of groups.values()) {
        const m = g.modifiers.find((x) => x.id === id);
        if (m) return sum + m.priceDeltaXaf;
      }
      return sum;
    }, 0);
    return (product?.priceXaf ?? 0) + extras;
  };
  const draftTotal = draft.lines.reduce((s, l) => s + unitPrice(l) * l.quantity, 0);
  const draftCount = draft.lines.reduce((s, l) => s + l.quantity, 0);

  const addLine = (productId: string, modifierIds: string[] = [], quantity = 1, note = '') =>
    setDraft((d) => {
      const same = d.lines.find(
        (l) =>
          l.productId === productId &&
          !l.note &&
          !note &&
          l.modifierIds.join() === [...modifierIds].sort().join(),
      );
      if (same)
        return {
          ...d,
          lines: d.lines.map((l) => (l === same ? { ...l, quantity: l.quantity + quantity } : l)),
        };
      return {
        ...d,
        lines: [
          ...d.lines,
          { uid: crypto.randomUUID(), productId, quantity, modifierIds: [...modifierIds].sort(), note },
        ],
      };
    });
  const updateLine = (uid: string, patch: Partial<DraftLine>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.uid === uid ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0),
    }));

  const send = useMutation({
    mutationFn: () =>
      api<OrderDetail>('/orders/send', {
        method: 'POST',
        body: {
          tableId,
          idempotencyKey: draft.key,
          lines: draft.lines.map(({ productId, quantity, modifierIds, note }) => ({
            productId,
            quantity,
            modifierIds,
            ...(note.trim() ? { note: note.trim() } : {}),
          })),
        },
      }),
    onSuccess: (sent) => {
      const stations = [...new Set(draft.lines.map((l) => products.get(l.productId)?.station))].filter(
        (s): s is Station => !!s,
      );
      setDraft(newDraft());
      setNotice({
        kind: 'ok',
        text: t('order.sentOk', { stations: stations.map((s) => t(`station.${s}`)).join(', ') }),
      });
      queryClient.setQueryData(['orders', sent.id], sent);
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PRODUCT_UNAVAILABLE') void refreshCatalog();
      setNotice({ kind: 'danger', text: errorMessage(e, t) });
    },
  });

  const onProduct = (p: Product) => {
    if (!p.available || !canOrder) return;
    setNotice(null);
    if (p.modifierGroupIds.some((id) => groups.has(id))) setPicking(p);
    else addLine(p.id);
  };

  if (floor.data && !table) {
    return <div className="alert danger">{t('error.generic')}</div>;
  }

  return (
    <div className="pos">
      <section>
        <div className="page-head" style={{ marginBottom: 10 }}>
          <Link className="btn ghost" to="/floor">
            ← {t('order.back')}
          </Link>
        </div>
        <div className="tabs">
          {catalog.data?.categories.map((c) => (
            <button
              key={c.id}
              className="tab"
              aria-selected={c.id === category?.id}
              onClick={() => setCategoryId(c.id)}
            >
              {pickText(c.name, locale)}
            </button>
          ))}
        </div>
        <div className="product-grid">
          {catalog.data?.products
            .filter((p) => p.categoryId === category?.id)
            .map((p) => (
              <button
                key={p.id}
                className={`product${p.available ? '' : ' off'}`}
                disabled={!p.available || !canOrder}
                onClick={() => onProduct(p)}
              >
                {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <span className="ph">🍽</span>}
                <b>{pickText(p.name, locale)}</b>
                <span className="row-between">
                  <span className="price">{formatXaf(p.priceXaf, locale)}</span>
                  <span className="muted">
                    {p.available ? t(`station.${p.station}`) : t('catalog.unavailable')}
                  </span>
                </span>
              </button>
            ))}
        </div>
      </section>

      <aside className="card ticket-panel">
        <div className="ticket-head">
          <div className="row-between">
            <h2>{t('order.title', { label: table?.label ?? '…' })}</h2>
            {order.data && can('order.transfer') && (
              <button className="btn ghost" onClick={() => setTransferring(true)}>
                ⇄ {t('order.transfer')}
              </button>
            )}
          </div>
          {order.data && (
            <div className="muted">
              {t('order.number', { number: order.data.number })}
              {order.data.waiterName && ` · ${t('order.waiter', { name: order.data.waiterName })}`}
            </div>
          )}
        </div>

        <div className="ticket-body">
          {notice && (
            <div className={`alert ${notice.kind}`} role="status">
              {notice.text}
            </div>
          )}
          {order.data && order.data.lines.length > 0 && (
            <>
              <div className="section-label">{t('order.sent')}</div>
              {order.data.lines.map((l) => (
                <div key={l.id} className={`line${l.status === 'cancelled' ? ' cancelled' : ''}`}>
                  <span className="qty-badge">{l.quantity}×</span>
                  <div className="grow">
                    <div>{pickText(l.name, locale)}</div>
                    {l.modifiers.length > 0 && (
                      <small className="muted">
                        {l.modifiers.map((m) => pickText(m.name, locale)).join(', ')}
                      </small>
                    )}
                    {l.note && <small className="note">↳ {l.note}</small>}
                    <span className={`status ${l.status}`}>{t(`status.${l.status}`)}</span>
                  </div>
                  <span className="amount">{formatXaf(l.unitPriceXaf * l.quantity, locale)}</span>
                  {l.status !== 'cancelled' && can('order.line.cancel') && (
                    <button
                      className="btn ghost danger icon"
                      aria-label={t('order.cancel')}
                      onClick={() => setCancelling(l)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </>
          )}

          <div className="section-label">{t('order.draft')}</div>
          {draft.lines.length === 0 && <p className="muted">{t('order.emptyDraft')}</p>}
          {draft.lines.map((l) => {
            const product = products.get(l.productId);
            const unavailable = product && !product.available;
            return (
              <div key={l.uid} className={`line${unavailable ? ' warn' : ''}`}>
                <div className="qty">
                  <button onClick={() => updateLine(l.uid, { quantity: l.quantity - 1 })} aria-label="-1">
                    −
                  </button>
                  <span>{l.quantity}</span>
                  <button
                    onClick={() => updateLine(l.uid, { quantity: Math.min(99, l.quantity + 1) })}
                    aria-label="+1"
                  >
                    +
                  </button>
                </div>
                <div className="grow">
                  <div>{product ? pickText(product.name, locale) : '…'}</div>
                  {l.modifierIds.length > 0 && (
                    <small className="muted">
                      {l.modifierIds
                        .map((id) =>
                          [...groups.values()].flatMap((g) => g.modifiers).find((m) => m.id === id),
                        )
                        .map((m) => (m ? pickText(m.name, locale) : ''))
                        .join(', ')}
                    </small>
                  )}
                  {unavailable && <small className="note">{t('catalog.unavailable')}</small>}
                  {editingNote === l.uid ? (
                    <input
                      className="note-input"
                      autoFocus
                      maxLength={140}
                      placeholder={t('order.notePlaceholder')}
                      value={l.note}
                      onChange={(e) => updateLine(l.uid, { note: e.target.value })}
                      onBlur={() => setEditingNote(null)}
                      onKeyDown={(e) => e.key === 'Enter' && setEditingNote(null)}
                    />
                  ) : (
                    <button className="link small" onClick={() => setEditingNote(l.uid)}>
                      ✎ {l.note ? `↳ ${l.note}` : t('order.note')}
                    </button>
                  )}
                </div>
                <span className="amount">{formatXaf(unitPrice(l) * l.quantity, locale)}</span>
              </div>
            );
          })}
        </div>

        <div className="ticket-foot">
          <div className="row-between total">
            <span>{t('order.total')}</span>
            <span>{formatXaf((order.data?.total ?? 0) + draftTotal, locale)}</span>
          </div>
          <button
            className="btn primary block"
            disabled={!draft.lines.length || send.isPending || !canOrder}
            onClick={() => {
              setNotice(null);
              send.mutate();
            }}
          >
            {draftCount ? t('order.sendCount', { count: draftCount }) : t('order.send')}
          </button>
          {draft.lines.length > 0 && (
            <button className="btn ghost block" onClick={() => setDraft(newDraft())}>
              {t('order.discardDraft')}
            </button>
          )}
        </div>
      </aside>

      {picking && (
        <OptionsPicker
          product={picking}
          groups={picking.modifierGroupIds.map((id) => groups.get(id)).filter((g): g is ModifierGroup => !!g)}
          onClose={() => setPicking(null)}
          onAdd={(modifierIds, quantity, note) => {
            addLine(picking.id, modifierIds, quantity, note);
            setPicking(null);
          }}
        />
      )}
      {cancelling && order.data && (
        <CancelDialog
          order={order.data}
          line={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            void queryClient.invalidateQueries({ queryKey: ['orders'] });
          }}
        />
      )}
      {transferring && order.data && floor.data && (
        <TransferDialog
          order={order.data}
          tables={floor.data.flatMap((z) => z.tables.map((tb) => ({ ...tb, zone: z.name })))}
          busy={new Set((openOrders.data ?? []).map((o) => o.tableId).filter((id): id is string => !!id))}
          onClose={() => setTransferring(false)}
          onDone={(target) => {
            setTransferring(false);
            void queryClient.invalidateQueries({ queryKey: ['orders'] });
            navigate(`/floor/${target}`, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function OptionsPicker({
  product,
  groups,
  onClose,
  onAdd,
}: {
  product: Product;
  groups: ModifierGroup[];
  onClose: () => void;
  onAdd: (modifierIds: string[], quantity: number, note: string) => void;
}) {
  const { t, locale } = useI18n();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');

  const toggle = (g: ModifierGroup, id: string) =>
    setChosen((c) => {
      const current = c[g.id] ?? [];
      if (current.includes(id)) return { ...c, [g.id]: current.filter((x) => x !== id) };
      // Un seul choix possible : le nouveau remplace l'ancien.
      if (g.maxSelect === 1) return { ...c, [g.id]: [id] };
      if (current.length >= g.maxSelect) return c;
      return { ...c, [g.id]: [...current, id] };
    });
  const complete = groups.every((g) => (chosen[g.id]?.length ?? 0) >= g.minSelect);
  const extras = groups
    .flatMap((g) => g.modifiers.filter((m) => chosen[g.id]?.includes(m.id)))
    .reduce((s, m) => s + m.priceDeltaXaf, 0);

  return (
    <Modal title={pickText(product.name, locale)} onClose={onClose}>
      {groups.map((g) => (
        <div key={g.id} className="field">
          <label>
            {pickText(g.name, locale)}{' '}
            <span className="muted">
              ({g.minSelect > 0 ? t('order.required') : t('catalog.optional').toLowerCase()}
              {g.maxSelect > 1 ? ` · ${t('order.upTo', { max: g.maxSelect })}` : ''})
            </span>
          </label>
          <div className="chips">
            {g.modifiers
              .filter((m) => m.available)
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="chip"
                  aria-pressed={chosen[g.id]?.includes(m.id) ?? false}
                  onClick={() => toggle(g, m.id)}
                >
                  {pickText(m.name, locale)}
                  {m.priceDeltaXaf > 0 && ` +${formatXaf(m.priceDeltaXaf, locale)}`}
                </button>
              ))}
          </div>
        </div>
      ))}
      <div className="field">
        <label htmlFor="opt-note">{t('order.note')}</label>
        <input
          id="opt-note"
          maxLength={140}
          placeholder={t('order.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="modal-foot">
        <div className="qty big">
          <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="-1">
            −
          </button>
          <span>{quantity}</span>
          <button onClick={() => setQuantity((q) => Math.min(99, q + 1))} aria-label="+1">
            +
          </button>
        </div>
        <button
          className="btn primary"
          disabled={!complete}
          onClick={() => onAdd(Object.values(chosen).flat(), quantity, note.trim())}
        >
          {t('common.add')} · {formatXaf((product.priceXaf + extras) * quantity, locale)}
        </button>
      </div>
    </Modal>
  );
}

function CancelDialog({
  order,
  line,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  line: OrderLine;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const me = useMe();
  const needs = needsApproval(me.grants, 'order.line.cancel') === 'always';
  const approvers = useQuery({
    queryKey: ['approvers'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/orders/approvers'),
    enabled: needs,
  });
  const [reason, setReason] = useState('');
  const [approverId, setApproverId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const approver = approverId || approvers.data?.[0]?.id || '';

  const cancel = useMutation({
    mutationFn: () =>
      api(`/orders/${order.id}/lines/${line.id}/cancel`, {
        method: 'POST',
        body: { reason, ...(needs ? { approval: { userId: approver, pin } } : {}) },
      }),
    onSuccess: onDone,
    onError: (e) => {
      setPin('');
      setError(errorMessage(e, t));
    },
  });

  return (
    <Modal
      title={t('order.cancelTitle', { name: `${line.quantity} × ${pickText(line.name, locale)}` })}
      onClose={onClose}
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          cancel.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="reason">{t('order.reason')}</label>
          <input
            id="reason"
            required
            minLength={3}
            maxLength={200}
            autoFocus
            placeholder={t('order.reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {needs && (
          <>
            <div className="section-label">{t('order.approval')}</div>
            <div className="row2">
              <div className="field">
                <label htmlFor="approver">{t('order.approver')}</label>
                <select id="approver" value={approver} onChange={(e) => setApproverId(e.target.value)}>
                  {approvers.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="approver-pin">{t('order.approverPin')}</label>
                <input
                  id="approver-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="\d{4,6}"
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </div>
            </div>
          </>
        )}
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button
            className="btn danger"
            disabled={
              cancel.isPending || reason.trim().length < 3 || (needs && (!approver || pin.length < 4))
            }
          >
            {t('order.cancelConfirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TransferDialog({
  order,
  tables,
  busy,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  tables: { id: string; label: string; zone: string }[];
  busy: Set<string>;
  onClose: () => void;
  onDone: (tableId: string) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const transfer = useMutation({
    mutationFn: (tableId: string) =>
      api(`/orders/${order.id}/transfer`, { method: 'POST', body: { tableId, version: order.version } }),
    onSuccess: (_d, tableId) => onDone(tableId),
    onError: (e) => setError(errorMessage(e, t)),
  });
  const free = tables.filter((tb) => !busy.has(tb.id));

  return (
    <Modal title={t('order.transferTo')} onClose={onClose}>
      {error && <div className="alert danger">{error}</div>}
      <div className="tables-grid" style={{ marginTop: 12 }}>
        {free.map((tb) => (
          <button
            key={tb.id}
            className="floor-table free"
            disabled={transfer.isPending}
            onClick={() => transfer.mutate(tb.id)}
          >
            <b>{tb.label}</b>
            <span className="muted">{tb.zone}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
