/**
 * Client HTTP de l'API du serveur local.
 * - Jeton d'accès en mémoire uniquement ; le jeton de rafraîchissement est un cookie HttpOnly.
 * - Jeton d'appareil dans le stockage local de la tablette (posé à l'enregistrement).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const DEVICE_KEY = 'tchop.deviceToken';

export const deviceStore = {
  get(): string | null {
    try {
      return localStorage.getItem(DEVICE_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      localStorage.setItem(DEVICE_KEY, token);
    } catch {
      /* stockage indisponible : l'appareil devra être réenregistré */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(DEVICE_KEY);
    } catch {
      /* rien à faire */
    }
  },
};

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

/** Appelé quand la session ne peut plus être prolongée (révoquée, expirée). */
export const setAuthLostHandler = (handler: (() => void) | null): void => {
  onAuthLost = handler;
};

function headers(json: boolean): Headers {
  const h = new Headers();
  if (json) h.set('content-type', 'application/json');
  if (accessToken) h.set('authorization', `Bearer ${accessToken}`);
  const device = deviceStore.get();
  if (device) h.set('x-device-token', device);
  return h;
}

async function send(path: string, method: string, body: unknown): Promise<Response> {
  try {
    // FormData (envoi de photo) : le navigateur pose lui-même l'en-tête multipart.
    const isForm = body instanceof FormData;
    return await fetch(`/api${path}`, {
      method,
      headers: headers(body !== undefined && !isForm),
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Serveur injoignable');
  }
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : `HTTP_${res.status}`;
  const message = typeof body.message === 'string' ? body.message : res.statusText;
  if (code === 'DEVICE_REVOKED') deviceStore.clear();
  return new ApiError(res.status, code, message, body);
}

/** Prolonge la session avec le cookie de rafraîchissement. Un seul appel à la fois. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await send('/auth/refresh', 'POST', undefined);
      if (!res.ok) {
        await toError(res);
        accessToken = null;
        return false;
      }
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let res = await send(path, method, options.body);

  // Jeton d'accès expiré : on prolonge la session une fois, puis on rejoue la requête.
  if (res.status === 401 && accessToken) {
    const error = await toError(res.clone());
    if (error.code === 'UNAUTHENTICATED') {
      if (await refreshSession()) res = await send(path, method, options.body);
      else onAuthLost?.();
    } else if (
      error.code === 'SESSION_INVALID' ||
      error.code === 'DEVICE_MISMATCH' ||
      error.code === 'DEVICE_REVOKED'
    ) {
      accessToken = null;
      onAuthLost?.();
    }
  }

  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
