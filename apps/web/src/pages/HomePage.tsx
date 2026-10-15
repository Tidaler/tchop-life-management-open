import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { SCREENS, type Screen } from '../navigation';
import { useMe, useSession } from '../session';

export function HomePage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const me = useMe();
  const screens = SCREENS.filter((s) => can(s.permission, s.access));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('home.hello', { name: me.user.displayName })}</h1>
          <p className="muted">{t('home.role', { role: me.role.name[locale], site: me.site.name })}</p>
        </div>
      </div>
      <p className="muted">{t('home.pick')}</p>
      <div className="users" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {screens.map((s) => (
          <Link
            key={s.path}
            to={s.path}
            className="user-tile"
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <span style={{ fontSize: 32 }} aria-hidden>
              {s.icon}
            </span>
            <b>{t(s.label)}</b>
            {s.phase && <small>{s.phase}</small>}
          </Link>
        ))}
      </div>
    </>
  );
}

export function PlaceholderPage({ screen }: { screen: Screen }) {
  const { t } = useI18n();
  return (
    <>
      <div className="page-head">
        <h1>{t(screen.label)}</h1>
      </div>
      <div className="card placeholder">
        <div className="icon" aria-hidden>
          {screen.icon}
        </div>
        <p className="muted">{t('home.soon', { phase: screen.phase ?? '' })}</p>
      </div>
    </>
  );
}
