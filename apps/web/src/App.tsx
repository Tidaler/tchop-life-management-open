import { type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { deviceStore } from './api';
import { useI18n } from './i18n';
import { SCREENS } from './navigation';
import { DevicesPage } from './pages/DevicesPage';
import { EnrollPage } from './pages/EnrollPage';
import { HomePage, PlaceholderPage } from './pages/HomePage';
import { PasswordLoginPage } from './pages/PasswordLoginPage';
import { PinLoginPage } from './pages/PinLoginPage';
import { Shell } from './pages/Shell';
import { useSession } from './session';

function Loading() {
  const { t } = useI18n();
  return <div className="auth-page muted">{t('common.loading')}</div>;
}

/** Écran de connexion adapté : PIN sur un appareil enregistré, mot de passe sinon. */
const loginPath = () => (deviceStore.get() ? '/login' : '/login/password');

function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'anonymous') return <Navigate to={loginPath()} replace />;
  return children;
}

function AnonymousOnly({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'authenticated') return <Navigate to="/" replace />;
  return children;
}

function RequireScreen({ path, children }: { path: string; children: ReactNode }) {
  const { can } = useSession();
  const screen = SCREENS.find((s) => s.path === path);
  if (!screen || !can(screen.permission, screen.access)) return <Navigate to="/" replace />;
  return children;
}

const router = createBrowserRouter([
  { path: '/enroll', element: <EnrollPage /> },
  {
    path: '/login',
    element: (
      <AnonymousOnly>
        <PinLoginPage />
      </AnonymousOnly>
    ),
  },
  {
    path: '/login/password',
    element: (
      <AnonymousOnly>
        <PasswordLoginPage />
      </AnonymousOnly>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <HomePage /> },
      ...SCREENS.map((screen) => ({
        path: screen.path.slice(1),
        element: (
          <RequireScreen path={screen.path}>
            {screen.path === '/devices' ? <DevicesPage /> : <PlaceholderPage screen={screen} />}
          </RequireScreen>
        ),
      })),
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
