import { useQueryClient } from '@tanstack/react-query';
import { type Access, can as canGrant, type Grants, type Permission } from '@tchop/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, refreshSession, setAccessToken, setAuthLostHandler } from './api';

export interface Me {
  user: { id: string; displayName: string; username: string; locale: string };
  tenant: { id: string; name: string };
  site: { id: string; name: string };
  role: { code: string; name: { fr: string; en: string } };
  grants: Grants;
  session: { method: 'password' | 'pin'; deviceId: string | null };
  autoLockSeconds: number;
}

type SessionState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; me: Me };

interface SessionValue {
  state: SessionState;
  loginWithPassword: (username: string, password: string) => Promise<void>;
  loginWithPin: (userId: string, pin: string) => Promise<void>;
  lock: () => Promise<void>;
  can: (permission: Permission, access?: Access) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const queryClient = useQueryClient();

  const loadMe = useCallback(async () => {
    const me = await api<Me>('/auth/me');
    setState({ status: 'authenticated', me });
  }, []);

  const toAnonymous = useCallback(() => {
    setAccessToken(null);
    queryClient.clear();
    setState({ status: 'anonymous' });
  }, [queryClient]);

  // Au démarrage : reprise de la session existante grâce au cookie de rafraîchissement.
  useEffect(() => {
    setAuthLostHandler(toAnonymous);
    refreshSession()
      .then((ok) => (ok ? loadMe() : toAnonymous()))
      .catch(toAnonymous);
    return () => setAuthLostHandler(null);
  }, [loadMe, toAnonymous]);

  const login = useCallback(
    async (path: string, body: unknown) => {
      const { accessToken } = await api<{ accessToken: string }>(path, { method: 'POST', body });
      setAccessToken(accessToken);
      await loadMe();
    },
    [loadMe],
  );

  const lock = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    toAnonymous();
  }, [toAnonymous]);

  // Verrouillage automatique après une période d'inactivité (durée fixée par le serveur selon le poste).
  const timer = useRef<number | undefined>(undefined);
  const autoLock = state.status === 'authenticated' ? state.me.autoLockSeconds : null;
  useEffect(() => {
    if (!autoLock) return;
    const arm = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void lock(), autoLock * 1000);
    };
    arm();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    return () => {
      window.clearTimeout(timer.current);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, arm));
    };
  }, [autoLock, lock]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      loginWithPassword: (username, password) => login('/auth/login', { username, password }),
      loginWithPin: (userId, pin) => login('/auth/pin', { userId, pin }),
      lock,
      can: (permission, access = 'write') =>
        state.status === 'authenticated' && canGrant(state.me.grants, permission, access),
    }),
    [state, login, lock],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession doit être utilisé dans SessionProvider');
  return value;
}

/** Profil de l'utilisateur connecté (à utiliser uniquement sous une route protégée). */
export function useMe(): Me {
  const { state } = useSession();
  if (state.status !== 'authenticated') throw new Error('useMe appelé sans session');
  return state.me;
}
