import { NavLink, Outlet } from 'react-router';
import { Brand, OfflineBanner } from '../components/common';
import { LanguageSwitch, useI18n } from '../i18n';
import { SCREENS } from '../navigation';
import { useMe, useSession } from '../session';

export function Shell() {
  const { t, locale } = useI18n();
  const { can, lock } = useSession();
  const me = useMe();
  const screens = SCREENS.filter((s) => can(s.permission, s.access));

  return (
    <div className="shell">
      <header>
        <OfflineBanner />
        <div className="topbar">
          <Brand subtitle={me.site.name} />
          <nav className="nav">
            <NavLink to="/" end>
              {t('nav.home')}
            </NavLink>
            {screens.map((s) => (
              <NavLink key={s.path} to={s.path}>
                {t(s.label)}
              </NavLink>
            ))}
          </nav>
          <div className="who">
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
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
