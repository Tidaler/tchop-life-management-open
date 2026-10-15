import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type StockMovementType, type StockUnit, type Translated } from '@tchop/shared';
import { api } from './api';

/** Toutes les données de stock partagent ce préfixe : un événement « stock.changed » les recharge. */
export const STOCK_KEY = ['stock'] as const;

export type Notice = { kind: 'ok' | 'danger'; text: string } | null;

export interface Location {
  id: string;
  name: string;
  sortOrder: number;
  version: number;
}

export interface StockItem {
  id: string;
  name: string;
  unit: StockUnit;
  location: { id: string; name: string };
  alertThreshold: number;
  archived: boolean;
  version: number;
  packagings: { id: string; name: string; factor: number }[];
  levels: { locationId: string; quantity: number }[];
  total: number;
  alert: boolean;
  /** Absents pour les rôles qui ne voient pas les coûts. */
  avgCostXaf?: number;
  valueXaf?: number;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  contact: string | null;
  note: string | null;
  archived: boolean;
  version: number;
}

export interface PurchaseOrder {
  id: string;
  number: number;
  status: 'open' | 'received' | 'cancelled';
  supplier: { id: string; name: string };
  note: string | null;
  createdAt: string;
  totalXaf: number;
  version: number;
  lines: {
    id: string;
    itemId: string;
    itemName: string;
    unit: StockUnit;
    unitName: string;
    factor: number;
    quantity: number;
    receivedQuantity: number;
    unitPriceXaf: number;
  }[];
}

export interface GoodsReceipt {
  id: string;
  number: number;
  supplier: { id: string; name: string } | null;
  location: { id: string; name: string };
  purchaseOrder: { id: string; number: number } | null;
  reference: string | null;
  totalXaf: number;
  createdAt: string;
  lines: { itemName: string; unitName: string; quantity: number; baseQuantity: number; totalXaf: number }[];
}

export interface InventorySummary {
  id: string;
  number: number;
  status: 'open' | 'closed' | 'cancelled';
  location: { id: string; name: string };
  lines: number;
  createdAt: string;
  closedAt: string | null;
  varianceXaf?: number | null;
}

export interface Inventory {
  id: string;
  number: number;
  status: 'open' | 'closed' | 'cancelled';
  location: { id: string; name: string };
  version: number;
  varianceXaf?: number | null;
  lines: {
    itemId: string;
    itemName: string;
    unit: StockUnit;
    countedQty: number | null;
    expectedQty?: number | null;
    varianceQty?: number | null;
    varianceXaf?: number;
  }[];
}

export interface Recipe {
  productId: string;
  name: Translated;
  priceXaf: number;
  modifiers: { id: string; name: Translated; group: Translated }[];
  lines: {
    itemId: string;
    itemName: string;
    unit: StockUnit;
    quantity: number;
    modifierId: string | null;
    costXaf?: number;
  }[];
  costXaf?: number;
  marginXaf?: number;
}

export interface Movement {
  id: string;
  type: StockMovementType;
  itemName: string;
  unit: StockUnit;
  locationName: string;
  quantity: number;
  reason: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  valueXaf?: number;
}

const stockQuery = <T>(key: string[], path: string, enabled = true) => ({
  queryKey: [...STOCK_KEY, ...key],
  queryFn: () => api<T>(path),
  enabled,
});

export const useLocations = () => useQuery(stockQuery<Location[]>(['locations'], '/stock/locations'));
export const useStockItems = () => useQuery(stockQuery<StockItem[]>(['items'], '/stock/items'));
export const useSuppliers = (enabled = true) =>
  useQuery(stockQuery<Supplier[]>(['suppliers'], '/stock/suppliers', enabled));
export const usePurchaseOrders = (enabled = true) =>
  useQuery(stockQuery<PurchaseOrder[]>(['purchase-orders'], '/stock/purchase-orders', enabled));

export const useRefreshStock = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: STOCK_KEY });
};

/** Quantité lisible : jusqu'à trois décimales, sans zéros inutiles. */
export const formatQty = (value: number, locale: 'fr' | 'en'): string =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 3 })
    .format(value)
    .replace(/\p{Zs}/gu, ' ');

/** Nombre saisi au clavier (virgule ou point décimal). */
export const parseQty = (raw: string): number => Number(raw.replace(',', '.').replace(/\s/g, ''));
