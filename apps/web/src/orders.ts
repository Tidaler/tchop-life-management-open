import { useQuery } from '@tanstack/react-query';
import { type LineStatus, type Station, type TicketStatus, type Translated } from '@tchop/shared';
import { api } from './api';

export interface OpenOrder {
  id: string;
  number: number;
  tableId: string | null;
  tableLabel: string | null;
  waiterName: string | null;
  openedAt: string;
  total: number;
  itemCount: number;
  readyCount: number;
  version: number;
}

export interface OrderLine {
  id: string;
  productId: string;
  name: Translated;
  unitPriceXaf: number;
  quantity: number;
  modifiers: { groupId: string; modifierId: string; name: Translated; priceDeltaXaf: number }[];
  note: string | null;
  station: Station;
  status: LineStatus;
  ticketNumber: number | null;
  cancelReason: string | null;
}

export interface OrderDetail {
  id: string;
  number: number;
  status: 'open' | 'billed' | 'paid' | 'cancelled';
  tableId: string | null;
  tableLabel: string | null;
  waiterName: string | null;
  openedAt: string;
  version: number;
  total: number;
  lines: OrderLine[];
}

export interface Ticket {
  id: string;
  number: number;
  station: Station;
  status: TicketStatus;
  orderId: string;
  orderNumber: number;
  tableLabel: string | null;
  waiterName: string | null;
  createdAt: string;
  lines: {
    id: string;
    name: Translated;
    quantity: number;
    modifiers: Translated[];
    note: string | null;
    status: LineStatus;
  }[];
}

/** Rafraîchissement de secours si la connexion temps réel est coupée. */
const FALLBACK_REFRESH_MS = 15_000;

export function useOpenOrders() {
  return useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => api<OpenOrder[]>('/orders/open'),
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export function useOrder(id: string | undefined) {
  return useQuery({
    queryKey: ['orders', id],
    queryFn: () => api<OrderDetail>(`/orders/${id}`),
    enabled: !!id,
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export function useTickets(station: Station | 'all') {
  return useQuery({
    queryKey: ['tickets', station],
    queryFn: () => api<Ticket[]>(station === 'all' ? '/tickets' : `/tickets?station=${station}`),
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export interface QrRequest {
  id: string;
  tableId: string;
  tableLabel: string;
  createdAt: string;
  expiresAt: string;
  totalXaf: number;
  items: {
    productId: string;
    name: Translated;
    quantity: number;
    unitPriceXaf: number;
    modifiers: Translated[];
    note: string | null;
  }[];
}

/** Commandes QR en attente de validation (seulement pour les rôles qui les traitent). */
export function useQrRequests(enabled: boolean) {
  return useQuery({
    queryKey: ['qr-requests'],
    queryFn: () => api<QrRequest[]>('/qr-requests'),
    enabled,
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}
