import { useMutation, useQuery } from '@tanstack/react-query';
import { formatXaf, pickText } from '@tchop/shared';
import { useState } from 'react';
import { api } from '../../api';
import { useCatalog } from '../../catalog';
import { errorMessage } from '../../components/common';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { type Notice, parseQty, type Recipe, STOCK_KEY, useRefreshStock, useStockItems } from '../../stock';

interface DraftLine {
  uid: string;
  itemId: string;
  quantity: string;
  modifierId: string;
}

/** Fiches recettes : ce que chaque produit vendu sort du stock, options comprises. */
export function RecipesTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const catalog = useCatalog();
  const missing = useQuery({
    queryKey: [...STOCK_KEY, 'recipes-missing'],
    queryFn: () => api<{ id: string }[]>('/stock/recipes/missing'),
  });
  const missingIds = new Set(missing.data?.map((p) => p.id));
  const [productId, setProductId] = useState<string | null>(null);
  const products = catalog.data?.products ?? [];

  return (
    <div className="split">
      <div className="card side-list">
        {catalog.data?.categories.map((c) => (
          <div key={c.id}>
            <div className="section-label">{pickText(c.name, locale)}</div>
            {products
              .filter((p) => p.categoryId === c.id)
              .map((p) => (
                <button
                  key={p.id}
                  className="item"
                  aria-current={p.id === productId}
                  onClick={() => setProductId(p.id)}
                >
                  <span>{pickText(p.name, locale)}</span>
                  {missingIds.has(p.id) && <span className="pill danger">{t('stock.noRecipe')}</span>}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div>
        {productId ? (
          <RecipeEditor key={productId} productId={productId} onNotice={onNotice} />
        ) : (
          <p className="placeholder muted">{t('stock.pickProduct')}</p>
        )}
      </div>
    </div>
  );
}

function RecipeEditor({ productId, onNotice }: { productId: string; onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const canEdit = can('recipe.edit');
  const items = useStockItems();
  const refresh = useRefreshStock();
  const recipe = useQuery({
    queryKey: [...STOCK_KEY, 'recipe', productId],
    queryFn: () => api<Recipe>(`/stock/recipes/${productId}`),
  });
  const [draft, setDraft] = useState<DraftLine[] | null>(null);
  const lines: DraftLine[] =
    draft ??
    recipe.data?.lines.map((l) => ({
      uid: `${l.itemId}:${l.modifierId ?? ''}`,
      itemId: l.itemId,
      quantity: String(l.quantity),
      modifierId: l.modifierId ?? '',
    })) ??
    [];
  const update = (next: DraftLine[]) => setDraft(next);

  const save = useMutation({
    mutationFn: () =>
      api<Recipe>(`/stock/recipes/${productId}`, {
        method: 'PUT',
        body: {
          lines: lines
            .filter((l) => l.itemId && parseQty(l.quantity) > 0)
            .map((l) => ({
              itemId: l.itemId,
              quantity: parseQty(l.quantity),
              modifierId: l.modifierId || null,
            })),
        },
      }),
    onSuccess: () => {
      setDraft(null);
      void refresh();
      onNotice({ kind: 'ok', text: t('stock.recipeSaved') });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  const data = recipe.data;
  if (!data) return <p className="muted">{t('common.loading')}</p>;

  return (
    <>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <h2>{pickText(data.name, locale)}</h2>
        <div className="muted">
          {t('stock.salePrice')} {formatXaf(data.priceXaf, locale)}
          {data.costXaf !== undefined && (
            <>
              {' '}
              · {t('stock.portionCost')} {formatXaf(data.costXaf, locale)} · {t('stock.margin')}{' '}
              <b>{formatXaf(data.marginXaf ?? 0, locale)}</b>
            </>
          )}
        </div>
      </div>
      <div className="card small-pad">
        {lines.length === 0 && <p className="muted">{t('stock.emptyRecipe')}</p>}
        {lines.map((l) => {
          const item = items.data?.find((i) => i.id === l.itemId);
          return (
            <div key={l.uid} className="recipe-line">
              <select
                aria-label={t('stock.item')}
                value={l.itemId}
                disabled={!canEdit}
                onChange={(e) =>
                  update(lines.map((x) => (x.uid === l.uid ? { ...x, itemId: e.target.value } : x)))
                }
              >
                <option value="">{t('stock.chooseItem')}</option>
                {items.data?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <input
                aria-label={t('stock.quantity')}
                inputMode="decimal"
                value={l.quantity}
                disabled={!canEdit}
                onChange={(e) =>
                  update(lines.map((x) => (x.uid === l.uid ? { ...x, quantity: e.target.value } : x)))
                }
              />
              <span className="muted">{item ? t(`unit.${item.unit}`) : ''}</span>
              <select
                aria-label={t('stock.whenOption')}
                value={l.modifierId}
                disabled={!canEdit}
                onChange={(e) =>
                  update(lines.map((x) => (x.uid === l.uid ? { ...x, modifierId: e.target.value } : x)))
                }
              >
                <option value="">{t('stock.always')}</option>
                {data.modifiers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {t('stock.ifOption')} {pickText(m.name, locale)} ({pickText(m.group, locale)})
                  </option>
                ))}
              </select>
              {canEdit && (
                <button
                  type="button"
                  className="btn ghost"
                  aria-label={t('stock.removeLine')}
                  onClick={() => update(lines.filter((x) => x.uid !== l.uid))}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {canEdit && (
          <div className="modal-foot">
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                update([...lines, { uid: crypto.randomUUID(), itemId: '', quantity: '1', modifierId: '' }])
              }
            >
              + {t('stock.addLine')}
            </button>
            <button
              className="btn primary"
              disabled={save.isPending || draft === null}
              onClick={() => save.mutate()}
            >
              {t('common.save')}
            </button>
          </div>
        )}
      </div>
      <p className="hint">{t('stock.recipeHint')}</p>
    </>
  );
}
