import { type QrClientStatus, type Translated } from '@tchop/shared';

/** Menu public, tel que l'API le renvoie (aucune donnée interne). */
export interface PublicMenu {
  site: { name: string };
  table: { label: string };
  ordering: boolean;
  categories: { id: string; name: Translated }[];
  products: {
    id: string;
    categoryId: string;
    name: Translated;
    description: Translated | null;
    imageUrl: string | null;
    priceXaf: number;
    available: boolean;
    modifierGroupIds: string[];
  }[];
  modifierGroups: {
    id: string;
    name: Translated;
    minSelect: number;
    maxSelect: number;
    modifiers: { id: string; name: Translated; priceDeltaXaf: number }[];
  }[];
}

export interface ClientRequest {
  id: string;
  createdAt: string;
  status: QrClientStatus;
  totalXaf: number;
  items: {
    name: Translated;
    quantity: number;
    unitPriceXaf: number;
    modifiers: Translated[];
    note: string | null;
  }[];
}

export class MenuError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Le jeton vient de l'adresse /q/{jeton} ; il est vérifié côté serveur. */
export const tokenFromPath = (path: string): string | null =>
  /^\/q\/([A-Za-z0-9_-]{22})\/?$/.exec(path)?.[1] ?? null;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/public/menu/${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch {
    throw new MenuError(0, 'NETWORK');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    throw new MenuError(res.status, body.code ?? `HTTP_${res.status}`);
  }
  return (await res.json()) as T;
}

export const fetchMenu = (token: string) => call<PublicMenu>(token);
export const fetchMyOrders = (token: string) => call<ClientRequest[]>(`${token}/orders`);
export const sendOrder = (
  token: string,
  body: {
    idempotencyKey: string;
    lines: { productId: string; quantity: number; modifierIds: string[]; note?: string }[];
  },
) => call<ClientRequest>(`${token}/orders`, { method: 'POST', body: JSON.stringify(body) });

/** N'affiche que les photos servies par le serveur de l'établissement (jamais une adresse externe). */
export const safeImage = (url: string | null): string | null =>
  url && /^\/api\/media\/[0-9a-f-]{36}\.webp$/.test(url) ? url : null;
