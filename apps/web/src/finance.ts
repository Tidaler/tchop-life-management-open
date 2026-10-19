import { useQuery } from '@tanstack/react-query';
import { type ExpenseKind, type ExpenseMethod, type Translated } from '@tchop/shared';
import { api } from './api';

/** Données de pilotage : un événement de vente ou de dépense les recharge (voir realtime). */
export const FINANCE_KEY = ['finance'] as const;

export interface Period {
  from: string;
  to: string;
}

/** Jour d'exploitation local (bascule à 6 h, comme le serveur). */
export function businessToday(cutoffHour = 6): string {
  const d = new Date(Date.now() - cutoffHour * 3_600_000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const shiftDay = (day: string, days: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const periodQuery = (p: Period) => `from=${p.from}&to=${p.to}`;

export interface ExpenseCategory {
  id: string;
  name: string;
  kind: ExpenseKind;
  archived: boolean;
  version: number;
}

export interface Expense {
  id: string;
  number: number;
  date: string;
  category: { id: string; name: string; kind: ExpenseKind };
  amountXaf: number;
  method: ExpenseMethod;
  fromCashSession: boolean;
  description: string;
  reference: string | null;
  hasAttachment: boolean;
  status: 'recorded' | 'voided';
  createdBy: string | null;
  approvedBy: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  createdAt: string;
}

export interface SalesReport {
  period: Period;
  ownOnly: boolean;
  totals: {
    bills: number;
    grossXaf: number;
    discountXaf: number;
    netXaf: number;
    averageTicketXaf: number;
    orders: number | null;
  };
  cancellations: { lines: number; amountXaf: number } | null;
  byDay: { day: string; bills: number; netXaf: number }[];
  byCategory: { id: string; name: Translated; quantity: number; amountXaf: number }[];
  byProduct: { id: string; name: Translated; category: Translated; quantity: number; amountXaf: number }[];
  byWaiter: { id: string | null; name: string | null; bills: number; netXaf: number }[];
  byMethod: { method: string; count: number; amountXaf: number }[];
}

export interface CashReport {
  ownOnly: boolean;
  sessions: {
    id: string;
    status: 'open' | 'closed';
    register: { name: string };
    cashierName: string;
    openedAt: string;
    closedAt: string | null;
    openingFloatXaf: number;
    byMethod: Record<string, number>;
    cashExpensesXaf: number;
    expectedCashXaf: number;
    countedCashXaf: number | null;
    differenceXaf: number | null;
    comment: string | null;
  }[];
  totals: { sessions: number; open: number; differenceXaf: number; cashExpensesXaf: number };
  paymentsToVerify: number;
}

export interface FinanceReport {
  revenueXaf: number;
  costOfSalesXaf: number;
  grossMarginXaf: number;
  grossMarginRate: number | null;
  lossesXaf: number;
  operatingExpensesXaf: number;
  operatingExpenses: { id: string; name: string; amountXaf: number }[];
  estimatedProfitXaf: number;
  purchaseExpensesXaf: number;
  goodsReceivedXaf: number;
  salesWithoutRecipe: { products: number; amountXaf: number };
}

export interface Dashboard {
  period: Period;
  sales: SalesReport['totals'];
  byCategory: SalesReport['byCategory'];
  topProducts: SalesReport['byProduct'];
  byMethod: SalesReport['byMethod'];
  byDay: SalesReport['byDay'];
  expenses: { totalXaf: number; count: number };
  cashSessions: {
    id: string;
    register: string;
    cashier: string;
    openedAt: string;
    collectedXaf: number;
    expectedCashXaf: number;
  }[];
  openOrders: number;
  paymentsToVerify: number;
  stockAlerts: { count: number; items: { id: string; name: string; total: number; unit: string }[] };
}

export const useExpenseCategories = (enabled = true) =>
  useQuery({
    queryKey: [...FINANCE_KEY, 'expense-categories'],
    queryFn: () => api<ExpenseCategory[]>('/expenses/categories'),
    enabled,
  });

export const useReport = <T>(
  kind: 'sales' | 'cash' | 'finance' | 'dashboard',
  period: Period,
  enabled = true,
) =>
  useQuery({
    queryKey: [...FINANCE_KEY, kind, period.from, period.to],
    queryFn: () => api<T>(`/reports/${kind}?${periodQuery(period)}`),
    enabled: enabled && period.from <= period.to,
  });
