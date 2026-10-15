import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Station, type Translated } from '@tchop/shared';
import { api } from './api';

export interface Category {
  id: string;
  name: Translated;
  visibleOnQr: boolean;
  sortOrder: number;
  version: number;
}

export interface Product {
  id: string;
  categoryId: string;
  name: Translated;
  description: Translated | null;
  imageUrl: string | null;
  priceXaf: number;
  taxRateBp: number;
  station: Station;
  available: boolean;
  visibleOnQr: boolean;
  sortOrder: number;
  version: number;
  modifierGroupIds: string[];
}

export interface Modifier {
  id: string;
  name: Translated;
  priceDeltaXaf: number;
  available: boolean;
}

export interface ModifierGroup {
  id: string;
  name: Translated;
  minSelect: number;
  maxSelect: number;
  version: number;
  modifiers: Modifier[];
}

export interface Catalog {
  categories: Category[];
  products: Product[];
  modifierGroups: ModifierGroup[];
}

export const CATALOG_KEY = ['catalog'] as const;

export function useCatalog() {
  return useQuery({ queryKey: CATALOG_KEY, queryFn: () => api<Catalog>('/catalog') });
}

/** Recharge le catalogue après une modification (ou un conflit de version). */
export function useRefreshCatalog() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
}
