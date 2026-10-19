import { lazy, type ReactNode, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { deviceStore } from './api';
import { useI18n } from './i18n';
import { SCREENS } from './navigation';
import { EnrollPage } from './pages/EnrollPage';
import { HomePage, PlaceholderPage } from './pages/HomePage';
import { PasswordLoginPage } from './pages/PasswordLoginPage';
import { PinLoginPage } from './pages/PinLoginPage';
import { Shell } from './pages/Shell';
import { useSession } from './session';

// Écrans chargés à la demande : la connexion par PIN reste rapide sur une tablette modeste.
const AvailabilityPage = lazy(() =>
  import('./pages/AvailabilityPage').then((m) => ({ default: m.AvailabilityPage })),
);
const CashierPage = lazy(() => import('./pages/CashierPage').then((m) => ({ default: m.CashierPage })));
const CatalogPage = lazy(() => import('./pages/CatalogPage').then((m) => ({ default: m.CatalogPage })));
const DevicesPage = lazy(() => import('./pages/DevicesPage').then((m) => ({ default: m.DevicesPage })));
const FloorPage = lazy(() => import('./pages/FloorPage').then((m) => ({ default: m.FloorPage })));
const FloorSetupPage = lazy(() =>
  import('./pages/FloorSetupPage').then((m) => ({ default: m.FloorSetupPage })),
);
const KitchenPage = lazy(() => import('./pages/KitchenPage').then((m) => ({ default: m.KitchenPage })));
const PrintersPage = lazy(() => import('./pages/PrintersPage').then((m) => ({ default: m.PrintersPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const ExpensesPage = lazy(() => import('./pages/ExpensesPage').then((m) => ({ default: m.ExpensesPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const StockPage = lazy(() => import('./pages/StockPage').then((m) => ({ default: m.StockPage })));
const QrPrintPage = lazy(() => import('./pages/QrPrintPage').then((m) => ({ default: m.QrPrintPage })));
const TableOrderPage = lazy(() =>
  import('./pages/TableOrderPage').then((m) => ({ default: m.TableOrderPage })),
);

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

/** Écrans livrés ; les autres affichent la phase prévue. */
const PAGES: Record<string, ReactNode> = {
  '/floor': <FloorPage />,
  '/kitchen': <KitchenPage />,
  '/cashier': <CashierPage />,
  '/stock': <StockPage />,
  '/dashboard': <DashboardPage />,
  '/reports': <ReportsPage />,
  '/expenses': <ExpensesPage />,
  '/availability': <AvailabilityPage />,
  '/catalog': <CatalogPage />,
  '/floor-setup': <FloorSetupPage />,
  '/printers': <PrintersPage />,
  '/devices': <DevicesPage />,
};

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
            {PAGES[screen.path] ?? <PlaceholderPage screen={screen} />}
          </RequireScreen>
        ),
      })),
      {
        path: 'floor/:tableId',
        element: (
          <RequireScreen path="/floor">
            <TableOrderPage />
          </RequireScreen>
        ),
      },
      {
        path: 'floor-setup/qr',
        element: (
          <RequireScreen path="/floor-setup">
            <Suspense fallback={<Loading />}>
              <QrPrintPage />
            </Suspense>
          </RequireScreen>
        ),
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
