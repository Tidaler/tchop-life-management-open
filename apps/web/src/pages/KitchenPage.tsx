import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pickText, type Station, STATIONS, type TicketStatus } from '@tchop/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';
import { type Ticket, useTickets } from '../orders';

const STATION_KEY = 'tchop.kitchen.station';
const LATE_MINUTES = 15;

function initialStation(): Station | 'all' {
  try {
    const saved = localStorage.getItem(STATION_KEY);
    if (saved === 'all' || STATIONS.includes(saved as Station)) return saved as Station | 'all';
  } catch {
    /* préférence non disponible */
  }
  return 'all';
}

/** Écran de préparation (cuisine, grill, bar) : bons en colonnes, du plus ancien au plus récent. */
export function KitchenPage() {
  const { t } = useI18n();
  const [station, setStation] = useState<Station | 'all'>(initialStation);
  const tickets = useTickets(station);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const choose = (s: Station | 'all') => {
    setStation(s);
    try {
      localStorage.setItem(STATION_KEY, s);
    } catch {
      /* préférence non mémorisée */
    }
  };

  const columns: { status: TicketStatus; label: string }[] = [
    { status: 'new', label: t('kitchen.new') },
    { status: 'preparing', label: t('kitchen.preparing') },
    { status: 'ready', label: t('kitchen.ready') },
  ];

  return (
    <div className="kds">
      <div className="page-head">
        <h1>{t('kitchen.title')}</h1>
        <div className="tabs">
          {(['all', ...STATIONS] as const).map((s) => (
            <button key={s} className="tab" aria-selected={station === s} onClick={() => choose(s)}>
              {s === 'all' ? t('kitchen.all') : t(`station.${s}`)}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="alert danger">{error}</div>}
      {tickets.isError && <div className="alert danger">{errorMessage(tickets.error, t)}</div>}
      <div className="kds-cols">
        {columns.map((col) => {
          const list = tickets.data?.filter((tk) => tk.status === col.status) ?? [];
          return (
            <section key={col.status}>
              <h3 className="kds-col-title">
                {col.label} <span>{list.length}</span>
              </h3>
              {list.length === 0 && <p className="kds-empty">{t('kitchen.empty')}</p>}
              {list.map((tk) => (
                <TicketCard
                  key={tk.id}
                  ticket={tk}
                  now={now}
                  showStation={station === 'all'}
                  onError={setError}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TicketCard({
  ticket,
  now,
  showStation,
  onError,
}: {
  ticket: Ticket;
  now: number;
  showStation: boolean;
  onError: (message: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const minutes = Math.max(0, Math.floor((now - new Date(ticket.createdAt).getTime()) / 60_000));

  const move = useMutation({
    mutationFn: (status: 'preparing' | 'ready' | 'served') =>
      api(`/tickets/${ticket.id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => {
      onError(null);
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (e) => {
      onError(errorMessage(e, t));
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
  const reprint = useMutation({
    mutationFn: () => api(`/tickets/${ticket.id}/reprint`, { method: 'POST' }),
    onError: (e) => onError(errorMessage(e, t)),
  });

  return (
    <article className="kticket">
      <header>
        <div>
          <b className="kt-table">
            {ticket.tableLabel ?? t('cash.directSaleLabel', { number: ticket.orderNumber })}
          </b>
          <div className="kt-meta">
            {t('kitchen.ticket', { number: ticket.number })}
            {showStation && (
              <span className={`station ${ticket.station}`}>{t(`station.${ticket.station}`)}</span>
            )}
            {ticket.waiterName && ` · ${ticket.waiterName}`}
          </div>
        </div>
        <span className={`timer${minutes >= LATE_MINUTES && ticket.status !== 'ready' ? ' late' : ''}`}>
          {t('kitchen.minutes', { count: minutes })}
        </span>
      </header>
      <ul>
        {ticket.lines.map((l) => (
          <li key={l.id} className={l.status === 'cancelled' ? 'cancelled' : ''}>
            <span className="kq">{l.quantity}×</span>
            <span>
              {pickText(l.name, locale)}
              {l.modifiers.length > 0 && (
                <small>{l.modifiers.map((m) => pickText(m, locale)).join(' · ')}</small>
              )}
              {l.note && <small className="kt-note">↳ {l.note}</small>}
            </span>
          </li>
        ))}
      </ul>
      <footer>
        {ticket.status === 'new' && (
          <button className="btn primary" disabled={move.isPending} onClick={() => move.mutate('preparing')}>
            {t('kitchen.start')}
          </button>
        )}
        {ticket.status !== 'ready' && (
          <button className="btn ok" disabled={move.isPending} onClick={() => move.mutate('ready')}>
            {t('kitchen.markReady')}
          </button>
        )}
        {ticket.status === 'ready' && (
          <button className="btn ok" disabled={move.isPending} onClick={() => move.mutate('served')}>
            {t('kitchen.markServed')} ✓
          </button>
        )}
        <button
          className="btn ghost"
          disabled={reprint.isPending}
          onClick={() => reprint.mutate()}
          title={t('kitchen.reprint')}
        >
          🖨
        </button>
      </footer>
    </article>
  );
}
