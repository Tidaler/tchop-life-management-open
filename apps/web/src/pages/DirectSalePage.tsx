import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatXaf, pickText } from '@tchop/shared';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { type Bill } from '../cash';
import { type ModifierGroup, type Product, useCatalog, useRefreshCatalog } from '../catalog';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { type DraftLine, newDraft, OptionsPicker, useDraft } from './TableOrderPage';

/**
 * Vente directe à la caisse (comptoir, à emporter) : la caissière choisit les produits, puis
 * « Encaisser » envoie les bons en préparation et ouvre l'addition dans l'écran de caisse.
 */
export function DirectSalePage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const refreshCatalog = useRefreshCatalog();
  const [draft, setDraft] = useDraft('direct');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picking, setPicking] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

  const products = useMemo(() => new Map(catalog.data?.products.map((p) => [p.id, p])), [catalog.data]);
  const groups = useMemo(() => new Map(catalog.data?.modifierGroups.map((g) => [g.id, g])), [catalog.data]);
  const category = catalog.data?.categories.find((c) => c.id === categoryId) ?? catalog.data?.categories[0];

  const unitPrice = (line: DraftLine) => {
    const extras = line.modifierIds.reduce((sum, id) => {
      for (const g of groups.values()) {
        const m = g.modifiers.find((x) => x.id === id);
        if (m) return sum + m.priceDeltaXaf;
      }
      return sum;
    }, 0);
    return (products.get(line.productId)?.priceXaf ?? 0) + extras;
  };
  const total = draft.lines.reduce((s, l) => s + unitPrice(l) * l.quantity, 0);

  const addLine = (productId: string, modifierIds: string[] = [], quantity = 1, note = '') =>
    setDraft((d) => {
      const sorted = [...modifierIds].sort();
      const same = d.lines.find(
        (l) => l.productId === productId && !l.note && !note && l.modifierIds.join() === sorted.join(),
      );
      if (same) {
        return {
          ...d,
          lines: d.lines.map((l) => (l === same ? { ...l, quantity: l.quantity + quantity } : l)),
        };
      }
      return {
        ...d,
        lines: [...d.lines, { uid: crypto.randomUUID(), productId, quantity, modifierIds: sorted, note }],
      };
    });
  const setQuantity = (uid: string, quantity: number) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.uid === uid ? { ...l, quantity } : l)).filter((l) => l.quantity > 0),
    }));

  const checkout = useMutation({
    mutationFn: () =>
      api<Bill>('/cash/direct-sales', {
        method: 'POST',
        body: {
          idempotencyKey: draft.key,
          lines: draft.lines.map(({ productId, quantity, modifierIds, note }) => ({
            productId,
            quantity,
            modifierIds,
            ...(note.trim() ? { note: note.trim() } : {}),
          })),
        },
      }),
    onSuccess: (bill) => {
      setDraft(newDraft());
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      navigate(`/cashier?bill=${bill.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PRODUCT_UNAVAILABLE') void refreshCatalog();
      setError(errorMessage(e, t));
    },
  });

  const onProduct = (p: Product) => {
    if (!p.available) return;
    setError(null);
    if (p.modifierGroupIds.some((id) => groups.has(id))) setPicking(p);
    else addLine(p.id);
  };

  return (
    <div className="pos">
      <section>
        <div className="page-head" style={{ marginBottom: 10 }}>
          <Link className="btn ghost" to="/cashier">
            ← {t('cash.title')}
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
                disabled={!p.available}
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
          <h2>{t('cash.directSale')}</h2>
          <div className="muted">{t('cash.directSaleHelp')}</div>
        </div>
        <div className="ticket-body">
          {error && (
            <div className="alert danger" role="status">
              {error}
            </div>
          )}
          {draft.lines.length === 0 && <p className="muted">{t('order.emptyDraft')}</p>}
          {draft.lines.map((l) => {
            const product = products.get(l.productId);
            return (
              <div key={l.uid} className={`line${product && !product.available ? ' warn' : ''}`}>
                <div className="qty">
                  <button onClick={() => setQuantity(l.uid, l.quantity - 1)} aria-label="-1">
                    −
                  </button>
                  <span>{l.quantity}</span>
                  <button onClick={() => setQuantity(l.uid, Math.min(99, l.quantity + 1))} aria-label="+1">
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
                  {l.note && <small className="note">↳ {l.note}</small>}
                </div>
                <span className="amount">{formatXaf(unitPrice(l) * l.quantity, locale)}</span>
              </div>
            );
          })}
        </div>
        <div className="ticket-foot">
          <div className="row-between total">
            <span>{t('order.total')}</span>
            <span>{formatXaf(total, locale)}</span>
          </div>
          <button
            className="btn primary block"
            disabled={!draft.lines.length || checkout.isPending || !can('payment.record')}
            onClick={() => {
              setError(null);
              checkout.mutate();
            }}
          >
            {t('cash.directSaleCheckout', { amount: formatXaf(total, locale) })}
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
    </div>
  );
}
