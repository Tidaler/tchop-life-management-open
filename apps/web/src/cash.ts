import { useQuery } from '@tanstack/react-query';
import { type PaymentMethod, type Translated } from '@tchop/shared';
import { api } from './api';

export interface CashSession {
  id: string;
  status: 'open' | 'closed';
  register: { id: string; name: string };
  cashierName: string;
  openedAt: string;
  openingFloatXaf: number;
  byMethod: Record<PaymentMethod, number>;
  paymentCount: number;
  /** Dépenses payées avec les espèces de la caisse : déduites du théorique. */
  cashExpensesXaf: number;
  /** Remboursements en espèces sortis de la caisse : déduits du théorique. */
  cashRefundsXaf: number;
  expectedCashXaf: number;
  countedCashXaf: number | null;
  differenceXaf: number | null;
}

export interface Bill {
  id: string;
  orderId: string;
  orderNumber: number;
  tableId: string | null;
  tableLabel: string | null;
  status: 'open' | 'paid' | 'voided';
  subtotalXaf: number;
  discountXaf: number;
  discountReason: string | null;
  totalXaf: number;
  paidXaf: number;
  remainingXaf: number;
  receipt: { id: string; number: number } | null;
  lines: { id: string; name: Translated; modifiers: Translated[]; quantity: number; amountXaf: number }[];
  payments: {
    id: string;
    method: PaymentMethod;
    amountXaf: number;
    tenderedXaf: number | null;
    changeXaf: number;
    reference: string | null;
    status: 'recorded' | 'verified' | 'voided';
  }[];
}

export interface Billable {
  orderId: string;
  orderNumber: number;
  tableLabel: string | null;
  lines: {
    id: string;
    name: Translated;
    modifiers: Translated[];
    unitPriceXaf: number;
    quantity: number;
    remaining: number;
  }[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  creditLimitXaf: number;
  balanceXaf: number;
  availableXaf: number;
  active: boolean;
  version: number;
}

export const useCashSession = (enabled = true) =>
  useQuery({
    queryKey: ['cash', 'session'],
    queryFn: () => api<CashSession | null>('/cash/sessions/current'),
    enabled,
  });

export const useOpenBills = () =>
  useQuery({
    queryKey: ['bills', 'open'],
    queryFn: () => api<Bill[]>('/cash/bills'),
    refetchInterval: 15_000,
  });

export const useCustomers = (enabled = true) =>
  useQuery({ queryKey: ['customers'], queryFn: () => api<Customer[]>('/customers'), enabled });
