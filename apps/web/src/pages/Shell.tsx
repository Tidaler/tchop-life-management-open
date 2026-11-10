import { Suspense, useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Brand, OfflineBanner } from '../components/common';
import { LanguageSwitch, useI18n } from '../i18n';
import { SCREENS } from '../navigation';
import { useQrRequests } from '../orders';
import { useRealtime } from '../realtime';
import { useMe, useSession } from '../session';

export function Shell() {
  const { t, locale } = useI18n();
  const { can, lock } = useSession();
  const me = useMe();
  const live = useRealtime(true);
  const qr = useQrRequests(can('qr_request.handle', 'read'));
  const pendingQr = qr.data ?? [];
  const screens = SCREENS.filter((s) => can(s.permission, s.access));
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // Sur un écran étroit, la barre de navigation défile : l'écran ouvert reste visible et repérable.
  useEffect(() => {
    nav.current
      ?.querySelector<HTMLElement>('a.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <div className="shell">
      <header>
        <OfflineBanner />
        <div className="topbar">
          <Brand />
          <nav className="nav" ref={nav}>
            <NavLink to="/" end>
              {t('nav.home')}
            </NavLink>
            {screens.map((s) => (
              <NavLink key={s.path} to={s.path}>
                {t(s.label)}
                {s.path === '/floor' && pendingQr.length > 0 && (
                  <span className="nav-badge">{pendingQr.length}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="who">
            <span
              className={live ? 'live-dot on' : 'live-dot'}
              title={t(live ? 'shell.live' : 'shell.offlineLive')}
            />
            <span>
              <b>{me.user.displayName}</b> <span className="site">· {me.role.name[locale]}</span>
            </span>
            <LanguageSwitch />
            <button
              className="btn"
              onClick={() => void lock()}
              aria-label={t('shell.lock')}
              title={t('shell.autoLock', { seconds: me.autoLockSeconds })}
            >
              🔒 {t('shell.lock')}
            </button>
          </div>
        </div>
      </header>
      {pendingQr[0] && (
        <Link className="qr-banner" to={`/floor/${pendingQr[0].tableId}`}>
          📱 {t('qrReq.new', { label: pendingQr[0].tableLabel })}
          {pendingQr.length > 1 && ` (+${pendingQr.length - 1})`} →
        </Link>
      )}
      <main className="content">
        <Suspense fallback={<p className="muted">{t('common.loading')}</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
