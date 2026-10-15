import { useMutation } from '@tanstack/react-query';
import { STOCK_UNITS, type StockUnit } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api';
import { ConfirmButton, errorMessage, Modal } from '../../components/common';
import { useI18n } from '../../i18n';
import {
  formatQty,
  type Location,
  type Notice,
  parseQty,
  type StockItem,
  useLocations,
  useRefreshStock,
  useStockItems,
} from '../../stock';

/** Articles de stock (unité, magasin de sortie, seuil, conditionnements) et magasins. */
export function ItemsTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { t, locale } = useI18n();
  const items = useStockItems();
  const locations = useLocations();
  const [editing, setEditing] = useState<StockItem | 'new' | null>(null);
  const [editingLocation, setEditingLocation] = useState<Location | 'new' | null>(null);

  return (
    <div className="split">
      <div className="card side-list">
        <div className="section-label">{t('stock.locations')}</div>
        {locations.data?.map((l) => (
          <button key={l.id} className="item" onClick={() => setEditingLocation(l)}>
            <span>{l.name}</span>
          </button>
        ))}
        <button
          className="btn ghost block"
          style={{ marginTop: 6 }}
          onClick={() => setEditingLocation('new')}
        >
          + {t('stock.newLocation')}
        </button>
      </div>
      <div>
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2>{t('stock.tabItems')}</h2>
          <button className="btn primary" onClick={() => setEditing('new')}>
            + {t('stock.newItem')}
          </button>
        </div>
        <div className="card scroll-x">
          <table className="grid">
            <tbody>
              {items.data?.map((i) => (
                <tr key={i.id} onClick={() => setEditing(i)} style={{ cursor: 'pointer' }}>
                  <td>
                    <b>{i.name}</b>
                    <div className="muted">{t(`unit.${i.unit}`)}</div>
                  </td>
                  <td>{i.location.name}</td>
                  <td>
                    {i.packagings.map((p) => (
                      <span key={p.id} className="pill" style={{ marginRight: 4 }}>
                        {p.name} = {formatQty(p.factor, locale)}
                      </span>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right' }} className="muted">
                    {t('stock.alertAt')} {formatQty(i.alertThreshold, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && (
        <ItemEditor
          item={editing === 'new' ? null : editing}
          locations={locations.data ?? []}
          onClose={() => setEditing(null)}
          onNotice={onNotice}
        />
      )}
      {editingLocation && (
        <LocationEditor
          location={editingLocation === 'new' ? null : editingLocation}
          onClose={() => setEditingLocation(null)}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

function ItemEditor({
  item,
  locations,
  onClose,
  onNotice,
}: {
  item: StockItem | null;
  locations: Location[];
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t, locale } = useI18n();
  const refresh = useRefreshStock();
  const [name, setName] = useState(item?.name ?? '');
  const [unit, setUnit] = useState<StockUnit>(item?.unit ?? 'bottle');
  const [locationId, setLocationId] = useState(item?.location.id ?? locations[0]?.id ?? '');
  const [threshold, setThreshold] = useState(String(item?.alertThreshold ?? 0));
  const [packName, setPackName] = useState('');
  const [packFactor, setPackFactor] = useState('');
  const [error, setError] = useState('');

  const done = () => {
    void refresh();
    onNotice(null);
  };
  const save = useMutation({
    mutationFn: (archived?: boolean) =>
      item
        ? api(`/stock/items/${item.id}`, {
            method: 'PATCH',
            body: {
              version: item.version,
              name,
              locationId,
              alertThreshold: parseQty(threshold) || 0,
              ...(archived ? { archived: true } : {}),
            },
          })
        : api('/stock/items', {
            method: 'POST',
            body: {
              name,
              unit,
              locationId,
              alertThreshold: parseQty(threshold) || 0,
              packagings:
                packName.trim() && parseQty(packFactor) > 0
                  ? [{ name: packName, factor: parseQty(packFactor) }]
                  : [],
            },
          }),
    onSuccess: () => {
      done();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  const addPack = useMutation({
    mutationFn: () =>
      api(`/stock/items/${item!.id}/packagings`, {
        method: 'POST',
        body: { name: packName, factor: parseQty(packFactor) },
      }),
    onSuccess: () => {
      done();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  const removePack = useMutation({
    mutationFn: (packagingId: string) =>
      api(`/stock/items/${item!.id}/packagings/${packagingId}`, { method: 'DELETE' }),
    onSuccess: () => {
      done();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  return (
    <Modal title={item ? item.name : t('stock.newItem')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="field">
          <label htmlFor="it-name">{t('stock.name')}</label>
          <input
            id="it-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="it-unit">{t('stock.baseUnit')}</label>
            <select
              id="it-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as StockUnit)}
              disabled={!!item}
            >
              {STOCK_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`unit.${u}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="it-location">{t('stock.issuedFromLabel')}</label>
            <select id="it-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="it-threshold">{t('stock.alertThreshold')}</label>
          <input
            id="it-threshold"
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </div>

        <div className="section-label">{t('stock.packagings')}</div>
        {item?.packagings.map((p) => (
          <div key={p.id} className="row-between" style={{ marginBottom: 6 }}>
            <span>
              1 {p.name} = {formatQty(p.factor, locale)} {t(`unit.${item.unit}`)}
            </span>
            <ConfirmButton
              label={t('stock.archive')}
              question={p.name}
              onConfirm={() => removePack.mutate(p.id)}
            />
          </div>
        ))}
        <div className="row2">
          <div className="field">
            <label htmlFor="it-pack">{t('stock.packagingName')}</label>
            <input
              id="it-pack"
              placeholder={t('stock.packagingExample')}
              value={packName}
              onChange={(e) => setPackName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="it-factor">
              {t('stock.packagingFactor')} ({t(`unit.${unit}`)})
            </label>
            <input
              id="it-factor"
              inputMode="decimal"
              value={packFactor}
              onChange={(e) => setPackFactor(e.target.value)}
            />
          </div>
        </div>
        {item && (
          <button
            type="button"
            className="btn ghost"
            disabled={!packName.trim() || !(parseQty(packFactor) > 0) || addPack.isPending}
            onClick={() => addPack.mutate()}
          >
            + {t('stock.addPackaging')}
          </button>
        )}
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          {item && (
            <ConfirmButton
              label={t('stock.archive')}
              question={item.name}
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

function LocationEditor({
  location,
  onClose,
  onNotice,
}: {
  location: Location | null;
  onClose: () => void;
  onNotice: (n: Notice) => void;
}) {
  const { t } = useI18n();
  const refresh = useRefreshStock();
  const [name, setName] = useState(location?.name ?? '');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (archived?: boolean) =>
      location
        ? api(`/stock/locations/${location.id}`, {
            method: 'PATCH',
            body: { version: location.version, name, ...(archived ? { archived: true } : {}) },
          })
        : api('/stock/locations', { method: 'POST', body: { name } }),
    onSuccess: () => {
      void refresh();
      onNotice(null);
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  return (
    <Modal title={location ? location.name : t('stock.newLocation')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="field">
          <label htmlFor="loc-name">{t('stock.name')}</label>
          <input
            id="loc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </div>
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          {location && (
            <ConfirmButton
              label={t('stock.archive')}
              question={location.name}
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
