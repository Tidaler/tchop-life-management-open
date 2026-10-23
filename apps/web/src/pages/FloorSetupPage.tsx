import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type QrMode, QR_MODES } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api';
import { ConfirmButton, errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';

export interface FloorTable {
  id: string;
  label: string;
  seats: number;
  posX: number;
  posY: number;
  version: number;
}

export interface FloorZone {
  id: string;
  name: string;
  sortOrder: number;
  /** Salon VIP : tarifs et offre VIP de chaque catégorie. */
  vip: boolean;
  version: number;
  tables: FloorTable[];
}

export interface QrCodeRow {
  tableId: string;
  tableLabel: string;
  zoneName: string;
  mode: QrMode;
  url: string;
}

const FLOOR_KEY = ['floor'] as const;
const QR_KEY = ['qr-codes'] as const;

export function FloorSetupPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const floor = useQuery({ queryKey: FLOOR_KEY, queryFn: () => api<FloorZone[]>('/floor') });
  const qr = useQuery({ queryKey: QR_KEY, queryFn: () => api<{ codes: QrCodeRow[] }>('/floor/qr-codes') });
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [editing, setEditing] = useState<FloorTable | 'new' | null>(null);
  const [newZone, setNewZone] = useState(false);
  const [editingZone, setEditingZone] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: FLOOR_KEY }),
      queryClient.invalidateQueries({ queryKey: QR_KEY }),
    ]);
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') void refresh();
    setNotice({ kind: 'danger', text: errorMessage(e, t) });
  };

  const zone = floor.data?.find((z) => z.id === zoneId) ?? floor.data?.[0];
  const qrByTable = new Map(qr.data?.codes.map((c) => [c.tableId, c]));

  const archiveZone = useMutation({
    mutationFn: (id: string) => api(`/floor/zones/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      setZoneId(null);
      setNotice(null);
      void refresh();
    },
    onError,
  });
  const replaceQr = useMutation({
    mutationFn: (table: FloorTable) => api(`/floor/tables/${table.id}/qr/replace`, { method: 'POST' }),
    onSuccess: (_d, table) => {
      setNotice({ kind: 'ok', text: t('floorSetup.qrReplaced', { label: table.label }) });
      void refresh();
    },
    onError,
  });
  const setMode = useMutation({
    mutationFn: ({ tableId, mode }: { tableId: string; mode: QrMode }) =>
      api(`/floor/tables/${tableId}/qr/mode`, { method: 'PUT', body: { mode } }),
    onSuccess: () => void refresh(),
    onError,
  });

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.floorSetup')}</h1>
        <div className="confirm">
          <Link className="btn primary" to="/floor-setup/menu">
            📄 {t('menuQr.title')}
          </Link>
          <Link className="btn" to="/floor-setup/qr">
            🖨 {t('floorSetup.printQr')}
          </Link>
        </div>
      </div>
      {notice && (
        <div className={`alert ${notice.kind}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}
      {floor.isPending && <p className="muted">{t('common.loading')}</p>}
      {floor.isError && <div className="alert danger">{errorMessage(floor.error, t)}</div>}

      {floor.data && (
        <div className="split">
          <div className="card side-list">
            {floor.data.map((z) => (
              <button
                key={z.id}
                className="item"
                aria-current={z.id === zone?.id}
                onClick={() => setZoneId(z.id)}
              >
                <span>
                  {z.name} {z.vip && <span className="pill">VIP</span>}
                </span>
                <span className="muted">{z.tables.length}</span>
              </button>
            ))}
            <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => setNewZone(true)}>
              + {t('floorSetup.newZone')}
            </button>
          </div>

          {zone && (
            <div>
              <div className="page-head" style={{ marginBottom: 12 }}>
                <h2>
                  {zone.name} {zone.vip && <span className="pill">{t('floorSetup.vip')}</span>}
                </h2>
                <div className="confirm">
                  <button className="btn" onClick={() => setEditingZone(true)}>
                    {t('floorSetup.editZone')}
                  </button>
                  <ConfirmButton
                    label={t('floorSetup.removeZone')}
                    question={zone.name}
                    onConfirm={() => archiveZone.mutate(zone.id)}
                  />
                  <button className="btn primary" onClick={() => setEditing('new')}>
                    + {t('floorSetup.newTable')}
                  </button>
                </div>
              </div>
              {zone.tables.length === 0 && <p className="muted">{t('floorSetup.noTables')}</p>}
              <div className="grid-tiles table-cards">
                {zone.tables.map((table) => {
                  const code = qrByTable.get(table.id);
                  return (
                    <div key={table.id} className="table-card">
                      <div className="table-card-head">
                        <b>{table.label}</b>
                        <span className="muted">{t('floorSetup.seatsShort', { count: table.seats })}</span>
                      </div>
                      {code && (
                        <label className="table-card-mode">
                          <span className="muted">{t('floorSetup.qrMode')}</span>
                          <select
                            value={code.mode}
                            onChange={(e) =>
                              setMode.mutate({ tableId: table.id, mode: e.target.value as QrMode })
                            }
                          >
                            {QR_MODES.map((m) => (
                              <option key={m} value={m}>
                                {t(`qrMode.${m}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <div className="confirm table-card-actions">
                        <button className="btn ghost" onClick={() => setEditing(table)}>
                          {t('common.edit')}
                        </button>
                        <ConfirmButton
                          label={t('floorSetup.replaceQr')}
                          question={t('floorSetup.confirmReplaceQr', { label: table.label })}
                          onConfirm={() => replaceQr.mutate(table)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {newZone && (
        <ZoneEditor onClose={() => setNewZone(false)} onSaved={(id) => setZoneId(id)} refresh={refresh} />
      )}
      {editingZone && zone && (
        <ZoneEditor
          zone={zone}
          onClose={() => setEditingZone(false)}
          onSaved={(id) => setZoneId(id)}
          refresh={refresh}
        />
      )}
      {editing && zone && floor.data && (
        <TableEditor
          zones={floor.data}
          zoneId={zone.id}
          table={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          refresh={refresh}
          onConflict={onError}
        />
      )}
    </>
  );
}

function ZoneEditor({
  zone,
  onClose,
  onSaved,
  refresh,
}: {
  zone?: FloorZone;
  onClose: () => void;
  onSaved: (id: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(zone?.name ?? '');
  const [vip, setVip] = useState(zone?.vip ?? false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      zone
        ? api<{ id: string }>(`/floor/zones/${zone.id}`, {
            method: 'PATCH',
            body: { version: zone.version, name, vip },
          })
        : api<{ id: string }>('/floor/zones', { method: 'POST', body: { name, vip } }),
    onSuccess: (zone) => {
      void refresh();
      onSaved(zone.id);
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  return (
    <Modal title={t(zone ? 'floorSetup.editZone' : 'floorSetup.newZone')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="zone-name">{t('floorSetup.zoneName')}</label>
          <input
            id="zone-name"
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} />
          {t('floorSetup.vipZone')}
        </label>
        <p className="muted small">{t('floorSetup.vipHelp')}</p>
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

function TableEditor({
  zones,
  zoneId,
  table,
  onClose,
  refresh,
  onConflict,
}: {
  zones: FloorZone[];
  zoneId: string;
  table: FloorTable | null;
  onClose: () => void;
  refresh: () => Promise<unknown>;
  onConflict: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState(table?.label ?? '');
  const [seats, setSeats] = useState(table?.seats ?? 4);
  const [zone, setZone] = useState(zoneId);
  const [error, setError] = useState<string | null>(null);

  const handle = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      onConflict(e);
      onClose();
    } else setError(errorMessage(e, t));
  };
  const save = useMutation({
    mutationFn: () =>
      table
        ? api(`/floor/tables/${table.id}`, {
            method: 'PATCH',
            body: { version: table.version, label, seats, zoneId: zone },
          })
        : api('/floor/tables', { method: 'POST', body: { label, seats, zoneId: zone } }),
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: handle,
  });
  const archive = useMutation({
    mutationFn: () => api(`/floor/tables/${table!.id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void refresh();
      onClose();
    },
    onError: handle,
  });

  return (
    <Modal title={t(table ? 'floorSetup.editTable' : 'floorSetup.newTable')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="row2">
          <div className="field">
            <label htmlFor="label">{t('floorSetup.tableLabel')}</label>
            <input
              id="label"
              required
              maxLength={12}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="seats">{t('floorSetup.seats')}</label>
            <input
              id="seats"
              type="number"
              min={1}
              max={50}
              value={seats}
              onChange={(e) => setSeats(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="zone">{t('floorSetup.zone')}</label>
          <select id="zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          {table ? (
            <ConfirmButton
              label={t('floorSetup.removeTable')}
              question={t('floorSetup.confirmRemoveTable', { label: table.label })}
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
