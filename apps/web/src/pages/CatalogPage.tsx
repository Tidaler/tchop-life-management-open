import { useMutation } from '@tanstack/react-query';
import { formatXaf, pickText, type Station, STATIONS, type Translated } from '@tchop/shared';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import {
  type Category,
  type Catalog,
  type ModifierGroup,
  type Product,
  useCatalog,
  useRefreshCatalog,
} from '../catalog';
import { ConfirmButton, errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';
import { useSession } from '../session';

type Notice = { kind: 'danger' | 'ok'; text: string } | null;

export function CatalogPage() {
  const { t } = useI18n();
  const catalog = useCatalog();
  const [tab, setTab] = useState<'products' | 'options'>('products');
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.catalog')}</h1>
        <div className="tabs" role="tablist">
          <button
            className="tab"
            role="tab"
            aria-selected={tab === 'products'}
            onClick={() => setTab('products')}
          >
            {t('catalog.tabProducts')}
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={tab === 'options'}
            onClick={() => setTab('options')}
          >
            {t('catalog.tabOptions')}
          </button>
        </div>
      </div>
      {notice && (
        <div className={`alert ${notice.kind}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}
      {catalog.isPending && <p className="muted">{t('common.loading')}</p>}
      {catalog.isError && <div className="alert danger">{errorMessage(catalog.error, t)}</div>}
      {catalog.data && tab === 'products' && <ProductsTab catalog={catalog.data} onNotice={setNotice} />}
      {catalog.data && tab === 'options' && <OptionsTab catalog={catalog.data} onNotice={setNotice} />}
    </>
  );
}

// ------------------------------------------------------------------ produits

function ProductsTab({ catalog, onNotice }: { catalog: Catalog; onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const refresh = useRefreshCatalog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [editingCategory, setEditingCategory] = useState<Category | 'new' | null>(null);

  const category = catalog.categories.find((c) => c.id === selectedId) ?? catalog.categories[0];
  const products = catalog.products.filter((p) => p.categoryId === category?.id);

  const archiveCategory = useMutation({
    mutationFn: (id: string) => api(`/catalog/categories/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      setSelectedId(null);
      onNotice(null);
      void refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  return (
    <div className="split">
      <div className="card side-list">
        {catalog.categories.map((c) => (
          <button
            key={c.id}
            className="item"
            aria-current={c.id === category?.id}
            onClick={() => setSelectedId(c.id)}
          >
            <span>{pickText(c.name, locale)}</span>
            <span className="muted">{catalog.products.filter((p) => p.categoryId === c.id).length}</span>
          </button>
        ))}
        <button
          className="btn ghost block"
          style={{ marginTop: 6 }}
          onClick={() => setEditingCategory('new')}
        >
          + {t('catalog.newCategory')}
        </button>
      </div>

      <div>
        {category && (
          <div className="page-head" style={{ marginBottom: 12 }}>
            <h2>{pickText(category.name, locale)}</h2>
            <div className="confirm">
              <button className="btn" onClick={() => setEditingCategory(category)}>
                {t('common.edit')}
              </button>
              <ConfirmButton
                label={t('catalog.archiveCategory')}
                question={pickText(category.name, locale)}
                onConfirm={() => archiveCategory.mutate(category.id)}
              />
              <button className="btn primary" onClick={() => setEditing('new')}>
                + {t('catalog.newProduct')}
              </button>
            </div>
          </div>
        )}
        <div className="card scroll-x">
          {products.length === 0 ? (
            <p className="placeholder muted">{t('catalog.noProducts')}</p>
          ) : (
            <table className="grid">
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} onClick={() => setEditing(p)} style={{ cursor: 'pointer' }}>
                    <td style={{ width: 60 }}>
                      {p.imageUrl ? (
                        <img className="thumb" src={p.imageUrl} alt="" />
                      ) : (
                        <span className="thumb">📷</span>
                      )}
                    </td>
                    <td>
                      <b>{pickText(p.name, locale)}</b>
                      {p.name.en && locale === 'fr' && <div className="muted">{p.name.en}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <b>{formatXaf(p.priceXaf, locale)}</b>
                    </td>
                    <td>{t(`station.${p.station}`)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!p.available && <span className="pill badge-off">{t('catalog.unavailable')}</span>}{' '}
                      {!p.visibleOnQr && <span className="pill">{t('catalog.hiddenOnQr')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editing && category && (
        <ProductEditor
          catalog={catalog}
          product={editing === 'new' ? null : editing}
          defaultCategoryId={category.id}
          onClose={() => setEditing(null)}
          onNotice={onNotice}
        />
      )}
      {editingCategory && (
        <CategoryEditor
          category={editingCategory === 'new' ? null : editingCategory}
          onClose={() => setEditingCategory(null)}
          onSaved={(id) => setSelectedId(id)}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

function TranslatedFields({
  value,
  onChange,
  labels,
  multiline,
}: {
  value: Translated;
  onChange: (v: Translated) => void;
  labels: [string, string];
  multiline?: boolean;
}) {
  const Input = multiline ? 'textarea' : 'input';
  return (
    <div className="row2">
      <div className="field">
        <label>{labels[0]}</label>
        <Input
          required={!multiline}
          value={value.fr}
          maxLength={multiline ? 400 : 120}
          onChange={(e) => onChange({ ...value, fr: e.target.value })}
        />
      </div>
      <div className="field">
        <label>{labels[1]}</label>
        <Input
          value={value.en}
          maxLength={multiline ? 400 : 120}
          onChange={(e) => onChange({ ...value, en: e.target.value })}
        />
      </div>
    </div>
  );
}

/** Gère les erreurs d'enregistrement : un conflit de version recharge le catalogue et ferme l'éditeur. */
function useSaveErrors(onClose: () => void, onNotice: (n: Notice) => void) {
  const { t } = useI18n();
  const refresh = useRefreshCatalog();
  return (error: unknown): string => {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      void refresh();
      onNotice({ kind: 'danger', text: t('error.conflict') });
      onClose();
    }
    return errorMessage(error, t);
  };
}

function CategoryEditor({
  category,
  onClose,
  onSaved,
  onNotice,
}: {
  category: Category | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  onNotice: (n: Notice) => void;
}) {
  const { t } = useI18n();
  const refresh = useRefreshCatalog();
  const handleError = useSaveErrors(onClose, onNotice);
  const [name, setName] = useState<Translated>(category?.name ?? { fr: '', en: '' });
  const [visibleOnQr, setVisibleOnQr] = useState(category?.visibleOnQr ?? true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      category
        ? api<Category>(`/catalog/categories/${category.id}`, {
            method: 'PATCH',
            body: { version: category.version, name, visibleOnQr },
          })
        : api<Category>('/catalog/categories', { method: 'POST', body: { name, visibleOnQr } }),
    onSuccess: (saved) => {
      void refresh();
      onSaved(saved.id);
      onClose();
    },
    onError: (e) => setError(handleError(e)),
  });

  return (
    <Modal title={t(category ? 'catalog.editCategory' : 'catalog.newCategory')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TranslatedFields
          value={name}
          onChange={setName}
          labels={[t('catalog.nameFr'), t('catalog.nameEn')]}
        />
        <label className="check">
          <input type="checkbox" checked={visibleOnQr} onChange={(e) => setVisibleOnQr(e.target.checked)} />
          {t('catalog.visibleOnQr')}
        </label>
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="btn primary" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProductEditor({
  catalog,
  product,
  defaultCategoryId,
  onClose,
  onNotice,
}: {
  catalog: Catalog;
  product: Product | null;
  defaultCategoryId: string;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const refresh = useRefreshCatalog();
  const handleError = useSaveErrors(onClose, onNotice);
  const canEditPrice = can('price.edit');
  const fileInput = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState(() => ({
    categoryId: product?.categoryId ?? defaultCategoryId,
    name: product?.name ?? { fr: '', en: '' },
    description: product?.description ?? { fr: '', en: '' },
    priceXaf: product?.priceXaf ?? 0,
    taxPercent: (product?.taxRateBp ?? 0) / 100,
    station: product?.station ?? ('kitchen' as Station),
    available: product?.available ?? true,
    visibleOnQr: product?.visibleOnQr ?? true,
    modifierGroupIds: product?.modifierGroupIds ?? [],
  }));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const { taxPercent, ...rest } = form;
      const body = { ...rest, taxRateBp: Math.round(taxPercent * 100) };
      return product
        ? api(`/catalog/products/${product.id}`, {
            method: 'PATCH',
            body: { version: product.version, ...body },
          })
        : api('/catalog/products', { method: 'POST', body });
    },
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: (e) => setError(handleError(e)),
  });

  const archive = useMutation({
    mutationFn: () => api(`/catalog/products/${product!.id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: (e) => setError(handleError(e)),
  });

  const photo = useMutation({
    mutationFn: (file: File | null) => {
      if (!file) return api(`/catalog/products/${product!.id}/image`, { method: 'DELETE' });
      const data = new FormData();
      data.append('image', file);
      return api(`/catalog/products/${product!.id}/image`, { method: 'POST', body: data });
    },
    // La photo change la version du produit : on recharge et on ferme pour repartir d'une fiche à jour.
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  const groupsById = useMemo(() => new Map(catalog.modifierGroups.map((g) => [g.id, g])), [catalog]);

  return (
    <Modal title={t(product ? 'catalog.editProduct' : 'catalog.newProduct')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <TranslatedFields
          value={form.name}
          onChange={(v) => set('name', v)}
          labels={[t('catalog.nameFr'), t('catalog.nameEn')]}
        />
        <TranslatedFields
          multiline
          value={{ fr: form.description.fr, en: form.description.en }}
          onChange={(v) => set('description', v)}
          labels={[t('catalog.descFr'), t('catalog.descEn')]}
        />
        <div className="row2">
          <div className="field">
            <label htmlFor="price">{t('catalog.price')}</label>
            <input
              id="price"
              type="number"
              inputMode="numeric"
              min={0}
              step={25}
              required
              disabled={!canEditPrice && !!product}
              value={form.priceXaf}
              onChange={(e) => set('priceXaf', Math.max(0, Math.round(Number(e.target.value))))}
            />
            {!canEditPrice && product && <span className="hint">{t('catalog.priceLocked')}</span>}
          </div>
          <div className="field">
            <label htmlFor="tax">{t('catalog.tax')}</label>
            <input
              id="tax"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={form.taxPercent}
              onChange={(e) => set('taxPercent', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="category">{t('catalog.category')}</label>
            <select id="category" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {catalog.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {pickText(c.name, locale)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="station">{t('catalog.station')}</label>
            <select
              id="station"
              value={form.station}
              onChange={(e) => set('station', e.target.value as Station)}
            >
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {t(`station.${s}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.available}
            onChange={(e) => set('available', e.target.checked)}
          />
          {t('catalog.available')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.visibleOnQr}
            onChange={(e) => set('visibleOnQr', e.target.checked)}
          />
          {t('catalog.visibleOnQr')}
        </label>

        {catalog.modifierGroups.length > 0 && (
          <div className="field">
            <label>{t('catalog.optionGroups')}</label>
            {catalog.modifierGroups.map((g) => (
              <label key={g.id} className="check" style={{ marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={form.modifierGroupIds.includes(g.id)}
                  onChange={(e) =>
                    set(
                      'modifierGroupIds',
                      e.target.checked
                        ? [...form.modifierGroupIds, g.id]
                        : form.modifierGroupIds.filter((id) => id !== g.id),
                    )
                  }
                />
                {pickText(groupsById.get(g.id)?.name, locale)}
                <span className="muted">
                  · {g.minSelect > 0 ? t('catalog.required') : t('catalog.optional')}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="field">
          <label>{t('catalog.photo')}</label>
          {product ? (
            <div className="photo-box" style={{ marginTop: 0 }}>
              {product.imageUrl ? (
                <img className="thumb" src={product.imageUrl} alt="" />
              ) : (
                <span className="thumb">📷</span>
              )}
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) photo.mutate(file);
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={photo.isPending}
                  onClick={() => fileInput.current?.click()}
                >
                  {t(product.imageUrl ? 'catalog.changePhoto' : 'catalog.addPhoto')}
                </button>{' '}
                {product.imageUrl && (
                  <button
                    type="button"
                    className="btn ghost danger"
                    disabled={photo.isPending}
                    onClick={() => photo.mutate(null)}
                  >
                    {t('catalog.removePhoto')}
                  </button>
                )}
                <div className="hint">{t('catalog.photoHelp')}</div>
              </div>
            </div>
          ) : (
            <span className="hint">{t('catalog.photoAfterSave')}</span>
          )}
        </div>

        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          {product ? (
            <ConfirmButton
              label={t('catalog.archiveProduct')}
              question={t('catalog.confirmArchiveProduct', { name: pickText(product.name, locale) })}
              onConfirm={() => archive.mutate()}
            />
          ) : (
            <span />
          )}
          <button className="btn primary" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ options

function OptionsTab({ catalog, onNotice }: { catalog: Catalog; onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null);

  return (
    <>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <span />
        <button className="btn primary" onClick={() => setEditing('new')}>
          + {t('catalog.newGroup')}
        </button>
      </div>
      {catalog.modifierGroups.length === 0 && <p className="muted">{t('catalog.noGroups')}</p>}
      <div className="grid-tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {catalog.modifierGroups.map((g) => (
          <button key={g.id} className="tile" onClick={() => setEditing(g)}>
            <b>{pickText(g.name, locale)}</b>
            <span className="muted">
              {g.minSelect > 0 ? t('catalog.required') : t('catalog.optional')} ·{' '}
              {t('catalog.choices', { min: g.minSelect, max: g.maxSelect })}
            </span>
            <span>
              {g.modifiers
                .map(
                  (m) =>
                    pickText(m.name, locale) +
                    (m.priceDeltaXaf ? ` (+${formatXaf(m.priceDeltaXaf, locale)})` : ''),
                )
                .join(', ')}
            </span>
            <small className="muted">
              {t('catalog.usedBy', {
                count: catalog.products.filter((p) => p.modifierGroupIds.includes(g.id)).length,
              })}
            </small>
          </button>
        ))}
      </div>
      {editing && (
        <GroupEditor
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onNotice={onNotice}
        />
      )}
    </>
  );
}

interface OptionDraft {
  id?: string;
  name: Translated;
  priceDeltaXaf: number;
  available: boolean;
}

function GroupEditor({
  group,
  onClose,
  onNotice,
}: {
  group: ModifierGroup | null;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t } = useI18n();
  const refresh = useRefreshCatalog();
  const handleError = useSaveErrors(onClose, onNotice);
  const [name, setName] = useState<Translated>(group?.name ?? { fr: '', en: '' });
  const [minSelect, setMin] = useState(group?.minSelect ?? 0);
  const [maxSelect, setMax] = useState(group?.maxSelect ?? 1);
  const [options, setOptions] = useState<OptionDraft[]>(
    group?.modifiers.map((m) => ({ ...m })) ?? [
      { name: { fr: '', en: '' }, priceDeltaXaf: 0, available: true },
    ],
  );
  const [error, setError] = useState<string | null>(null);

  const updateOption = (i: number, patch: Partial<OptionDraft>) =>
    setOptions((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const save = useMutation({
    mutationFn: () => {
      const body = { name, minSelect, maxSelect, modifiers: options };
      return group
        ? api(`/catalog/modifier-groups/${group.id}`, {
            method: 'PATCH',
            body: { version: group.version, ...body },
          })
        : api('/catalog/modifier-groups', { method: 'POST', body });
    },
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: (e) => setError(handleError(e)),
  });

  const archive = useMutation({
    mutationFn: () => api(`/catalog/modifier-groups/${group!.id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: (e) => setError(handleError(e)),
  });

  return (
    <Modal title={t(group ? 'catalog.editGroup' : 'catalog.newGroup')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <TranslatedFields
          value={name}
          onChange={setName}
          labels={[t('catalog.nameFr'), t('catalog.nameEn')]}
        />
        <div className="row2">
          <div className="field">
            <label htmlFor="min">{t('catalog.minSelect')}</label>
            <input
              id="min"
              type="number"
              min={0}
              max={20}
              value={minSelect}
              onChange={(e) => setMin(Number(e.target.value))}
            />
            <span className="hint">0 = {t('catalog.optional').toLowerCase()}</span>
          </div>
          <div className="field">
            <label htmlFor="max">{t('catalog.maxSelect')}</label>
            <input
              id="max"
              type="number"
              min={1}
              max={20}
              value={maxSelect}
              onChange={(e) => setMax(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field">
          <label>{t('catalog.options')}</label>
          {options.map((o, i) => (
            <div key={o.id ?? `new-${i}`} className="option-row">
              <input
                required
                placeholder={t('catalog.nameFr')}
                value={o.name.fr}
                onChange={(e) => updateOption(i, { name: { ...o.name, fr: e.target.value } })}
              />
              <input
                placeholder={t('catalog.nameEn')}
                value={o.name.en}
                onChange={(e) => updateOption(i, { name: { ...o.name, en: e.target.value } })}
              />
              <input
                type="number"
                min={0}
                step={25}
                aria-label={t('catalog.supplement')}
                title={t('catalog.supplement')}
                value={o.priceDeltaXaf}
                onChange={(e) =>
                  updateOption(i, { priceDeltaXaf: Math.max(0, Math.round(Number(e.target.value))) })
                }
              />
              <button
                type="button"
                className="btn ghost danger"
                aria-label={t('common.remove')}
                disabled={options.length === 1}
                onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <span className="hint">{t('catalog.supplement')}</span>
          <button
            type="button"
            className="btn ghost"
            style={{ justifySelf: 'start' }}
            onClick={() =>
              setOptions((list) => [...list, { name: { fr: '', en: '' }, priceDeltaXaf: 0, available: true }])
            }
          >
            + {t('catalog.addOption')}
          </button>
        </div>
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          {group ? (
            <ConfirmButton
              label={t('catalog.archiveGroup')}
              question={pickText(group.name, 'fr')}
              onConfirm={() => archive.mutate()}
            />
          ) : (
            <span />
          )}
          <button className="btn primary" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
