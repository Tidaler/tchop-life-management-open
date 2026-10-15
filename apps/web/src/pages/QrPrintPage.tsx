import { useQuery } from '@tanstack/react-query';
import { translate } from '@tchop/i18n';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';
import { type QrCodeRow } from './FloorSetupPage';

/** Planche de QR codes à imprimer et découper, une carte par table. */
export function QrPrintPage() {
  const { t } = useI18n();
  const qr = useQuery({
    queryKey: ['qr-codes'],
    queryFn: () => api<{ siteName: string; codes: QrCodeRow[] }>('/floor/qr-codes'),
  });

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1>{t('qrPrint.title')}</h1>
          <p className="muted">{t('qrPrint.help')}</p>
        </div>
        <div className="confirm">
          <Link className="btn ghost" to="/floor-setup">
            ← {t('common.back')}
          </Link>
          <button className="btn primary" onClick={() => window.print()} disabled={!qr.data}>
            🖨 {t('qrPrint.print')}
          </button>
        </div>
      </div>
      {qr.isPending && <p className="muted">{t('common.loading')}</p>}
      {qr.isError && <div className="alert danger">{errorMessage(qr.error, t)}</div>}
      <div className="qr-sheet">
        {qr.data?.codes.map((code) => (
          <QrCard key={code.tableId} code={code} siteName={qr.data.siteName} />
        ))}
      </div>
    </>
  );
}

function QrCard({ code, siteName }: { code: QrCodeRow; siteName: string }) {
  const { t } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Correction d'erreur « M » : le code reste lisible même un peu abîmé ou taché.
    void QRCode.toString(code.url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }).then(
      (s) => alive && setSvg(s),
    );
    return () => {
      alive = false;
    };
  }, [code.url]);

  return (
    <div className="qr-card">
      <div className="muted" style={{ fontWeight: 700 }}>
        {siteName}
      </div>
      {/* SVG produit localement par la bibliothèque qrcode à partir de l'adresse du menu. */}
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div style={{ height: 170 }} />}
      <div className="label">{t('qrPrint.table', { label: code.tableLabel })}</div>
      <div className="muted">{code.zoneName}</div>
      {/* Carte toujours bilingue, quelle que soit la langue de l'écran. */}
      <div style={{ marginTop: 6, fontWeight: 600 }}>{translate('fr', 'qrPrint.scan')}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {translate('en', 'qrPrint.scan')}
      </div>
    </div>
  );
}
