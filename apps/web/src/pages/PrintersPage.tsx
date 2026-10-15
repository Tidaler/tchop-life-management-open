import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PrinterRole, PRINTER_ROLES } from '@tchop/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { ConfirmButton, errorMessage, Modal } from '../components/common';
import { useI18n } from '../i18n';
import { useSession } from '../session';

interface Printer {
  id: string;
  name: string;
  host: string;
  port: number;
  paperWidth: 58 | 80;
  role: PrinterRole;
  active: boolean;
  version: number;
}

interface FailedJob {
  id: string;
  printerName: string;
  kind: string;
  lastError: string | null;
  attempts: number;
  createdAt: string;
}

const KEY = ['printers'] as const;

export function PrintersPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: KEY,
    queryFn: () => api<{ printers: Printer[]; failedJobs: FailedJob[] }>('/printers'),
    refetchInterval: 20_000,
  });
  const [editing, setEditing] = useState<Printer | 'new' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  const canEdit = can('site.settings');
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });

  const report = (r: { status: string; lastError: string | null }) =>
    setNotice(
      r.status === 'printed'
        ? { kind: 'ok', text: t('printers.testOk') }
        : r.status === 'pending' && !r.lastError
          ? { kind: 'ok', text: t('printers.testPending') }
          : { kind: 'danger', text: t('printers.testFailed', { error: r.lastError ?? '' }) },
    );

  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ status: string; lastError: string | null }>(`/printers/${id}/test`, { method: 'POST' }),
    onSuccess: report,
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      api<{ status: string; lastError: string | null }>(`/printers/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: (r) => {
      report(r);
      void refresh();
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e, t) }),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.printers')}</h1>
          <p className="muted">{t('printers.help')}</p>
        </div>
        {canEdit && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            + {t('printers.new')}
          </button>
        )}
      </div>
      {notice && (
        <div className={`alert ${notice.kind}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}
      {data.isError && <div className="alert danger">{errorMessage(data.error, t)}</div>}
      <div className="card scroll-x">
        {data.data?.printers.length === 0 && <p className="placeholder muted">{t('printers.empty')}</p>}
        {data.data && data.data.printers.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('printers.name')}</th>
                <th>{t('printers.role')}</th>
                <th>{t('printers.host')}</th>
                <th>{t('printers.paper')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.data.printers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.name}</b>{' '}
                    {!p.active && <span className="pill danger">{t('printers.inactive')}</span>}
                  </td>
                  <td>{t(`role.${p.role}`)}</td>
                  <td>
                    {p.host}:{p.port}
                  </td>
                  <td>{p.paperWidth} mm</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost" disabled={test.isPending} onClick={() => test.mutate(p.id)}>
                      🖨 {t('printers.test')}
                    </button>
                    {canEdit && (
                      <button className="btn ghost" onClick={() => setEditing(p)}>
                        {t('common.edit')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.data && data.data.failedJobs.length > 0 && (
        <>
          <h2 style={{ margin: '24px 0 10px' }}>{t('printers.failedJobs')}</h2>
          <div className="card scroll-x">
            <table className="grid">
              <tbody>
                {data.data.failedJobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <b>{j.printerName}</b>
                      <div className="muted">{j.lastError}</div>
                    </td>
                    <td>
                      {new Date(j.createdAt).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
                        timeStyle: 'short',
                        dateStyle: 'short',
                      })}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {canEdit && (
                        <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate(j.id)}>
                          {t('printers.retry')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <PrinterEditor
          printer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

function PrinterEditor({
  printer,
  onClose,
  onSaved,
}: {
  printer: Printer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: printer?.name ?? '',
    host: printer?.host ?? '',
    port: printer?.port ?? 9100,
    paperWidth: printer?.paperWidth ?? 80,
    role: printer?.role ?? ('kitchen' as PrinterRole),
    active: printer?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () =>
      printer
        ? api(`/printers/${printer.id}`, { method: 'PATCH', body: { version: printer.version, ...form } })
        : api('/printers', { method: 'POST', body: form }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });
  const archive = useMutation({
    mutationFn: () => api(`/printers/${printer!.id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t)),
  });

  return (
    <Modal title={t(printer ? 'printers.edit' : 'printers.new')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="row2">
          <div className="field">
            <label htmlFor="p-name">{t('printers.name')}</label>
            <input
              id="p-name"
              required
              maxLength={40}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="p-role">{t('printers.role')}</label>
            <select
              id="p-role"
              value={form.role}
              onChange={(e) => set('role', e.target.value as PrinterRole)}
            >
              {PRINTER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-host">{t('printers.host')}</label>
            <input
              id="p-host"
              required
              placeholder="192.168.1.50"
              value={form.host}
              onChange={(e) => set('host', e.target.value.trim())}
            />
          </div>
          <div className="field">
            <label htmlFor="p-port">{t('printers.port')}</label>
            <input
              id="p-port"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="p-paper">{t('printers.paper')}</label>
            <select
              id="p-paper"
              value={form.paperWidth}
              onChange={(e) => set('paperWidth', Number(e.target.value) as 58 | 80)}
            >
              <option value={80}>80 mm</option>
              <option value={58}>58 mm</option>
            </select>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
          {t('printers.active')}
        </label>
        {error && <div className="alert danger">{error}</div>}
        <div className="modal-foot">
          {printer ? (
            <ConfirmButton
              label={t('printers.remove')}
              question={printer.name}
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
