import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pickText } from '@tchop/shared';
import { useState } from 'react';
import { api } from '../api';
import { type Catalog, CATALOG_KEY, useCatalog } from '../catalog';
import { errorMessage } from '../components/common';
import { useI18n } from '../i18n';

/** Écran de la cuisine et du bar : marquer un produit épuisé, en un geste. */
export function AvailabilityPage() {
  const { t, locale } = useI18n();
  const catalog = useCatalog();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: ({ id, available }: { id: string; available: boolean }) =>
      api(`/catalog/products/${id}/availability`, { method: 'PUT', body: { available } }),
    // Mise à jour immédiate de l'écran, annulée si le serveur refuse.
    onMutate: async ({ id, available }) => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: CATALOG_KEY });
      const previous = queryClient.getQueryData<Catalog>(CATALOG_KEY);
      queryClient.setQueryData<Catalog>(
        CATALOG_KEY,
        (c) => c && { ...c, products: c.products.map((p) => (p.id === id ? { ...p, available } : p)) },
      );
      return { previous };
    },
    onError: (e, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(CATALOG_KEY, context.previous);
      setError(errorMessage(e, t));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CATALOG_KEY }),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('availability.title')}</h1>
          <p className="muted">{t('availability.help')}</p>
        </div>
      </div>
      {error && <div className="alert danger">{error}</div>}
      {catalog.isPending && <p className="muted">{t('common.loading')}</p>}
      {catalog.data?.categories.map((c) => {
        const products = catalog.data.products.filter((p) => p.categoryId === c.id);
        if (!products.length) return null;
        return (
          <section key={c.id} style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 8 }}>{pickText(c.name, locale)}</h3>
            <div className="grid-tiles">
              {products.map((p) => (
                <button
                  key={p.id}
                  className={`tile${p.available ? '' : ' off'}`}
                  aria-pressed={!p.available}
                  onClick={() => toggle.mutate({ id: p.id, available: !p.available })}
                >
                  <b>{pickText(p.name, locale)}</b>
                  <span className={p.available ? 'muted' : ''}>
                    {p.available ? t('catalog.available') : t('catalog.unavailable')}
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
