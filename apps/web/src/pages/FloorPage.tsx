import { useQuery } from '@tanstack/react-query';
import { formatXaf } from '@tchop/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';
import { type OpenOrder, useOpenOrders } from '../orders';
import { type FloorZone } from './FloorSetupPage';

export const useFloor = () => useQuery({ queryKey: ['floor'], queryFn: () => api<FloorZone[]>('/floor') });

const sinceTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

/** Plan de salle du service : état de chaque table, accès à sa commande. */
export function FloorPage() {
  const { t, locale } = useI18n();
  const floor = useFloor();
  const orders = useOpenOrders();
  const [zoneId, setZoneId] = useState<string | null>(null);

  const byTable = new Map<string, OpenOrder>(
    (orders.data ?? []).filter((o) => o.tableId).map((o) => [o.tableId!, o]),
  );
  const zone = floor.data?.find((z) => z.id === zoneId) ?? floor.data?.[0];

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.floor')}</h1>
        <div className="tabs" role="tablist">
          {floor.data?.map((z) => {
            const busy = z.tables.filter((tb) => byTable.has(tb.id)).length;
            return (
              <button
                key={z.id}
                className="tab"
                role="tab"
                aria-selected={z.id === zone?.id}
                onClick={() => setZoneId(z.id)}
              >
                {z.name}
                {busy > 0 && ` · ${busy}`}
              </button>
            );
          })}
        </div>
      </div>
      {floor.isPending && <p className="muted">{t('common.loading')}</p>}
      {floor.isError && <div className="alert danger">{errorMessage(floor.error, t)}</div>}
      {floor.data?.length === 0 && <p className="muted">{t('floor.noTables')}</p>}

      <div className="tables-grid">
        {zone?.tables.map((table) => {
          const order = byTable.get(table.id);
          const state = !order ? 'free' : order.readyCount > 0 ? 'ready' : 'busy';
          return (
            <Link key={table.id} to={`/floor/${table.id}`} className={`floor-table ${state}`}>
              <b>{table.label}</b>
              {order ? (
                <>
                  <span>
                    {order.waiterName} · {sinceTime(order.openedAt, locale)}
                  </span>
                  <strong>{formatXaf(order.total, locale)}</strong>
                  {order.readyCount > 0 && (
                    <span className="pill ok">{t('floor.ready', { count: order.readyCount })}</span>
                  )}
                </>
              ) : (
                <span className="muted">{t('floor.free')}</span>
              )}
            </Link>
          );
        })}
      </div>
    </>
  );
}
