import { useQuery } from '@tanstack/react-query';
import { translate } from '@tchop/i18n';
import { formatXaf, menuForZone, pickText, textMenuParts, type TextMenuPart } from '@tchop/shared';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useCatalog } from '../catalog';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';
import { type QrCodeRow } from './FloorSetupPage';

/**
 * Menu sans connexion : la carte est écrite dans les QR codes eux-mêmes. Le client scanne avec l'appareil
 * photo et lit la carte sur son téléphone, sans Internet ni Wi-Fi. La carte imprimée autour des QR codes
 * présente le même menu, mis en page. Une carte pour la salle, une autre aux prix VIP.
 */
export function MenuQrPage() {
  const { t } = useI18n();
  const catalog = useCatalog();
  const site = useQuery({
    queryKey: ['qr-codes'],
    queryFn: () => api<{ siteName: string; codes: QrCodeRow[] }>('/floor/qr-codes'),
  });
  const siteName = site.data?.siteName ?? 'TCHOP LIFE';

  // Seuls les produits et catégories visibles sur le menu client y figurent.
  const visible = useMemo(() => {
    if (!catalog.data) return null;
    const categories = catalog.data.categories.filter((c) => c.visibleOnQr);
    const ids = new Set(categories.map((c) => c.id));
    const products = catalog.data.products.filter((p) => p.visibleOnQr && ids.has(p.categoryId));
    return { categories, products };
  }, [catalog.data]);

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1>{t('menuQr.title')}</h1>
          <p className="muted">{t('menuQr.help')}</p>
        </div>
        <div className="confirm">
          <Link className="btn ghost" to="/floor-setup">
            ← {t('common.back')}
          </Link>
          <button className="btn primary" onClick={() => window.print()} disabled={!visible}>
            🖨 {t('qrPrint.print')}
          </button>
        </div>
      </div>
      {catalog.isPending && <p className="muted">{t('common.loading')}</p>}
      {catalog.isError && <div className="alert danger">{errorMessage(catalog.error, t)}</div>}
      {visible && (
        <>
          <MenuCard menu={menuForZone(visible, false)} siteName={siteName} zone={t('menuQr.room')} />
          <MenuCard menu={menuForZone(visible, true)} siteName={siteName} zone={t('menuQr.vip')} />
        </>
      )}
    </>
  );
}

type Menu = {
  categories: { id: string; name: { fr: string; en?: string } }[];
  products: { id: string; categoryId: string; name: { fr: string; en?: string }; priceXaf: number }[];
};

function MenuCard({ menu, siteName, zone }: { menu: Menu; siteName: string; zone: string }) {
  const { t } = useI18n();
  const parts = useMemo(
    () => textMenuParts(menu, { title: `${siteName} - Menu ${zone}` }),
    [menu, siteName, zone],
  );

  return (
    <section className="menu-card">
      <div className="menu-card-head">
        <span className="menu-logo">TL</span>
        <div>
          <div className="menu-site">{siteName}</div>
          <div className="menu-zone">{zone}</div>
        </div>
      </div>
      <p className="menu-scan">
        <b>{translate('fr', 'menuQr.scan')}</b>
        <br />
        <span className="muted">{translate('en', 'menuQr.scan')}</span>
      </p>
      <div className="menu-qr-row">
        {parts.map((part, i) => (
          <MenuQr key={i} part={part} index={i} count={parts.length} />
        ))}
      </div>
      <div className="menu-list">
        {menu.categories
          .map((c) => ({ c, items: menu.products.filter((p) => p.categoryId === c.id) }))
          .filter(({ items }) => items.length > 0)
          .map(({ c, items }) => (
            <div key={c.id} className="menu-cat">
              <h3>{pickText(c.name as { fr: string; en: string }, 'fr')}</h3>
              {items.map((p) => (
                <div key={p.id} className="menu-item">
                  <span>{p.name.fr}</span>
                  <span className="menu-dots" />
                  <b>{formatXaf(p.priceXaf, 'fr')}</b>
                </div>
              ))}
            </div>
          ))}
      </div>
      <p className="menu-foot muted">{t('menuQr.foot')}</p>
    </section>
  );
}

function MenuQr({ part, index, count }: { part: TextMenuPart; index: number; count: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Correction « M » : lisible même un peu abîmé ; le texte est écrit tel quel dans le QR code.
    void QRCode.toString(part.text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }).then(
      (s) => alive && setSvg(s),
    );
    return () => {
      alive = false;
    };
  }, [part.text]);
  return (
    <figure className="menu-qr">
      {/* SVG produit localement par la bibliothèque qrcode à partir du texte du menu. */}
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="menu-qr-wait" />}
      <figcaption>
        <b>{count > 1 ? `${index + 1}/${count}` : ''}</b> {part.categories.join(', ')}
      </figcaption>
      <details className="no-print">
        <summary>Texte</summary>
        <pre>{part.text}</pre>
      </details>
    </figure>
  );
}
