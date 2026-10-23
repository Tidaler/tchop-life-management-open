import { type Locale, type MessageKey, translate } from '@tchop/i18n';
import { formatXaf, newId, pickText, type QrClientStatus } from '@tchop/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ClientRequest,
  fetchMenu,
  fetchMyOrders,
  MenuError,
  type PublicMenu,
  safeImage,
  sendOrder,
  tokenFromPath,
} from './api';

interface CartLine {
  uid: string;
  productId: string;
  quantity: number;
  modifierIds: string[];
  note: string;
}
interface Cart {
  /** Clé d'envoi gardée jusqu'au succès : un renvoi après coupure ne crée pas de doublon. */
  key: string;
  lines: CartLine[];
}

const newCart = (): Cart => ({ key: newId(), lines: [] });
const ACTIVE: QrClientStatus[] = ['pending', 'accepted', 'preparing', 'ready'];
const STEPS: QrClientStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'served'];
const POLL_MS = 5_000;

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('tchop.menu.locale');
    if (saved === 'fr' || saved === 'en') return saved;
  } catch {
    /* préférence non disponible */
  }
  return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

function useCart(token: string) {
  const storageKey = `tchop.menu.cart.${token}`;
  const [cart, setCart] = useState<Cart>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw) as Cart;
    } catch {
      /* panier illisible : on repart de zéro */
    }
    return newCart();
  });
  useEffect(() => {
    try {
      if (cart.lines.length) sessionStorage.setItem(storageKey, JSON.stringify(cart));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* stockage indisponible */
    }
  }, [cart, storageKey]);
  return [cart, setCart] as const;
}

export function MenuApp() {
  const token = tokenFromPath(window.location.pathname);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem('tchop.menu.locale', locale);
    } catch {
      /* préférence non mémorisée */
    }
  }, [locale]);

  if (!token) return <Notice text={t('menu.invalid')} />;
  return <Menu token={token} locale={locale} setLocale={setLocale} t={t} />;
}

type T = (key: MessageKey, params?: Record<string, string | number>) => string;

function Menu({
  token,
  locale,
  setLocale,
  t,
}: {
  token: string;
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: T;
}) {
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [loadError, setLoadError] = useState<MenuError | null>(null);
  const [orders, setOrders] = useState<ClientRequest[]>([]);
  const [cart, setCart] = useCart(token);
  const [view, setView] = useState<'menu' | 'cart' | 'orders'>('menu');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picking, setPicking] = useState<PublicMenu['products'][number] | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchMenu(token)
      .then((m) => {
        setMenu(m);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(e instanceof MenuError ? e : new MenuError(0, 'NETWORK')));
  }, [token]);

  const loadOrders = useCallback(() => {
    fetchMyOrders(token)
      .then(setOrders)
      .catch(() => undefined);
  }, [token]);

  useEffect(() => {
    load();
    loadOrders();
  }, [load, loadOrders]);

  // Suivi : on interroge le serveur tant qu'une commande est en cours.
  const hasActive = orders.some((o) => ACTIVE.includes(o.status));
  useEffect(() => {
    if (!hasActive && view !== 'orders') return;
    const id = window.setInterval(() => {
      loadOrders();
      load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [hasActive, view, load, loadOrders]);

  const products = useMemo(() => new Map(menu?.products.map((p) => [p.id, p])), [menu]);
  const groups = useMemo(() => new Map(menu?.modifierGroups.map((g) => [g.id, g])), [menu]);
  const modifierById = useMemo(
    () => new Map(menu?.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.id, m] as const))),
    [menu],
  );

  if (loadError?.status === 404) return <Notice text={t('menu.invalid')} />;
  if (!menu) {
    return loadError ? (
      <Notice text={t('menu.offline')} />
    ) : (
      <Notice text={translate(locale, 'common.loading')} />
    );
  }

  const category = menu.categories.find((c) => c.id === categoryId) ?? menu.categories[0];
  const unitPrice = (l: CartLine) =>
    (products.get(l.productId)?.priceXaf ?? 0) +
    l.modifierIds.reduce((s, id) => s + (modifierById.get(id)?.priceDeltaXaf ?? 0), 0);
  const cartCount = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const cartTotal = cart.lines.reduce((s, l) => s + unitPrice(l) * l.quantity, 0);
  const canOrder = menu.ordering && !loadError;

  const add = (productId: string, modifierIds: string[] = [], quantity = 1, note = '') =>
    setCart((c) => {
      const key = [...modifierIds].sort().join();
      const same = c.lines.find(
        (l) => l.productId === productId && !l.note && !note && l.modifierIds.join() === key,
      );
      if (same)
        return {
          ...c,
          lines: c.lines.map((l) =>
            l === same ? { ...l, quantity: Math.min(30, l.quantity + quantity) } : l,
          ),
        };
      return {
        ...c,
        lines: [
          ...c.lines,
          { uid: newId(), productId, quantity, modifierIds: [...modifierIds].sort(), note },
        ],
      };
    });
  const setQty = (uid: string, quantity: number) =>
    setCart((c) => ({
      ...c,
      lines: c.lines.map((l) => (l.uid === uid ? { ...l, quantity } : l)).filter((l) => l.quantity > 0),
    }));

  const submit = async () => {
    setSending(true);
    setMessage(null);
    try {
      await sendOrder(token, {
        idempotencyKey: cart.key,
        lines: cart.lines.map(({ productId, quantity, modifierIds, note }) => ({
          productId,
          quantity,
          modifierIds,
          ...(note.trim() ? { note: note.trim() } : {}),
        })),
      });
      setCart(newCart());
      setView('orders');
      loadOrders();
    } catch (e) {
      const code = e instanceof MenuError ? e.code : 'NETWORK';
      const key: MessageKey =
        code === 'TOO_MANY_PENDING'
          ? 'menu.tooMany'
          : code === 'ORDER_TOO_LARGE'
            ? 'menu.tooLarge'
            : code === 'SITE_OFFLINE'
              ? 'menu.offline'
              : code === 'PRODUCT_UNAVAILABLE' || code === 'NOT_FOUND'
                ? 'menu.soldOut'
                : e instanceof MenuError && e.status === 429
                  ? 'menu.slowDown'
                  : code === 'NETWORK'
                    ? 'menu.offline'
                    : 'menu.error';
      setMessage(t(key));
      if (code === 'PRODUCT_UNAVAILABLE' || code === 'NOT_FOUND') load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="app">
      <header className="head">
        <div>
          <div className="site">{menu.site.name}</div>
          <div className="table">{t('menu.table', { label: menu.table.label })}</div>
        </div>
        <div className="lang" role="group">
          {(['fr', 'en'] as const).map((l) => (
            <button key={l} aria-pressed={locale === l} onClick={() => setLocale(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {loadError && <div className="banner warn">{t('menu.offline')}</div>}
      {menu.orderingPaused ? (
        <div className="banner warn">{t('menu.offline')}</div>
      ) : (
        !menu.ordering && <div className="banner">{t('menu.browseOnly')}</div>
      )}
      {orders.length > 0 && view === 'menu' && (
        <button className="banner link" onClick={() => setView('orders')}>
          {t('menu.myOrders')} · {t(`qrStatus.${orders[0]!.status}`)} →
        </button>
      )}

      {view === 'menu' && (
        <main>
          <nav className="cats">
            {menu.categories.map((c) => (
              <button key={c.id} aria-pressed={c.id === category?.id} onClick={() => setCategoryId(c.id)}>
                {pickText(c.name, locale)}
              </button>
            ))}
          </nav>
          {menu.products
            .filter((p) => p.categoryId === category?.id)
            .map((p) => {
              const img = safeImage(p.imageUrl);
              const inCart = cart.lines
                .filter((l) => l.productId === p.id)
                .reduce((n, l) => n + l.quantity, 0);
              return (
                <article key={p.id} className={`item${p.available ? '' : ' off'}`}>
                  {img ? <img src={img} alt="" loading="lazy" /> : <div className="ph">🍽</div>}
                  <div className="info">
                    <b>{pickText(p.name, locale)}</b>
                    {p.description && pickText(p.description, locale) && (
                      <span>{pickText(p.description, locale)}</span>
                    )}
                    <div className="price">
                      {p.available ? formatXaf(p.priceXaf, locale) : t('menu.unavailable')}
                    </div>
                  </div>
                  {canOrder && p.available && (
                    <div className="add-col">
                      <button
                        className="add"
                        aria-label={`${t('menu.add')} ${pickText(p.name, locale)}`}
                        onClick={() =>
                          p.modifierGroupIds.some((id) => groups.has(id)) ? setPicking(p) : add(p.id)
                        }
                      >
                        +
                      </button>
                      {inCart > 0 && <span className="in-cart">×{inCart}</span>}
                    </div>
                  )}
                </article>
              );
            })}
          {cartCount > 0 && canOrder && (
            <button className="cartbar" onClick={() => setView('cart')}>
              <span>
                {t('menu.cart')} · {cartCount}
              </span>
              <span>{formatXaf(cartTotal, locale)}</span>
            </button>
          )}
        </main>
      )}

      {view === 'cart' && (
        <main className="pad">
          <button className="back" onClick={() => setView('menu')}>
            ← {t('menu.back')}
          </button>
          <h2>{t('menu.yourOrder')}</h2>
          {cart.lines.length === 0 && <p className="muted">{t('menu.empty')}</p>}
          {cart.lines.map((l) => {
            const p = products.get(l.productId);
            return (
              <div key={l.uid} className={`line${p && !p.available ? ' warn' : ''}`}>
                <div className="grow">
                  <b>{p ? pickText(p.name, locale) : '…'}</b>
                  {l.modifierIds.length > 0 && (
                    <small>
                      {l.modifierIds.map((id) => pickText(modifierById.get(id)?.name, locale)).join(', ')}
                    </small>
                  )}
                  {l.note && <small className="note">↳ {l.note}</small>}
                  {p && !p.available && <small className="note">{t('menu.unavailable')}</small>}
                  <small>{formatXaf(unitPrice(l), locale)}</small>
                </div>
                <div className="qty">
                  <button onClick={() => setQty(l.uid, l.quantity - 1)} aria-label={t('menu.remove')}>
                    −
                  </button>
                  <span>{l.quantity}</span>
                  <button
                    onClick={() => setQty(l.uid, Math.min(30, l.quantity + 1))}
                    aria-label={t('menu.add')}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
          <div className="total">
            <span>{t('menu.total')}</span>
            <span>{formatXaf(cartTotal, locale)}</span>
          </div>
          <p className="muted small">{t('menu.payInfo')}</p>
          {message && <div className="banner warn">{message}</div>}
          <button
            className="primary"
            disabled={!cart.lines.length || sending || !canOrder}
            onClick={() => void submit()}
          >
            {t('menu.send')}
          </button>
        </main>
      )}

      {view === 'orders' && (
        <main className="pad">
          <button className="back" onClick={() => setView('menu')}>
            ← {t('menu.back')}
          </button>
          <h2>{t('menu.myOrders')}</h2>
          {orders.map((o) => (
            <section key={o.id} className="order">
              {o.status === 'rejected' || o.status === 'expired' ? (
                <div className="banner warn">{t(`qrStatus.${o.status}`)}</div>
              ) : (
                <ol className="steps">
                  {STEPS.map((s, i) => {
                    const at = STEPS.indexOf(o.status);
                    return (
                      <li key={s} className={i < at ? 'done' : i === at ? 'current' : ''}>
                        <span className="dot">{i < at ? '✓' : i + 1}</span>
                        {t(`qrStatus.${s}`)}
                      </li>
                    );
                  })}
                </ol>
              )}
              <ul className="summary">
                {o.items.map((i, k) => (
                  <li key={k}>
                    {i.quantity} × {pickText(i.name, locale)}
                    {i.modifiers.length > 0 && (
                      <small> ({i.modifiers.map((m) => pickText(m, locale)).join(', ')})</small>
                    )}
                  </li>
                ))}
              </ul>
              <div className="total small">
                <span>{t('menu.total')}</span>
                <span>{formatXaf(o.totalXaf, locale)}</span>
              </div>
            </section>
          ))}
          <p className="muted small">{t('menu.payInfo')}</p>
          {canOrder && (
            <button className="secondary" onClick={() => setView('menu')}>
              {t('menu.orderMore')}
            </button>
          )}
        </main>
      )}

      {picking && (
        <OptionsSheet
          product={picking}
          groups={picking.modifierGroupIds
            .map((id) => groups.get(id))
            .filter((g): g is PublicMenu['modifierGroups'][number] => !!g)}
          locale={locale}
          t={t}
          onClose={() => setPicking(null)}
          onAdd={(ids, quantity, note) => {
            add(picking.id, ids, quantity, note);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function OptionsSheet({
  product,
  groups,
  locale,
  t,
  onClose,
  onAdd,
}: {
  product: PublicMenu['products'][number];
  groups: PublicMenu['modifierGroups'];
  locale: Locale;
  t: T;
  onClose: () => void;
  onAdd: (ids: string[], quantity: number, note: string) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const toggle = (g: PublicMenu['modifierGroups'][number], id: string) =>
    setChosen((c) => {
      const cur = c[g.id] ?? [];
      if (cur.includes(id)) return { ...c, [g.id]: cur.filter((x) => x !== id) };
      if (g.maxSelect === 1) return { ...c, [g.id]: [id] };
      return cur.length >= g.maxSelect ? c : { ...c, [g.id]: [...cur, id] };
    });
  const complete = groups.every((g) => (chosen[g.id]?.length ?? 0) >= g.minSelect);
  const extras = groups
    .flatMap((g) => g.modifiers.filter((m) => chosen[g.id]?.includes(m.id)))
    .reduce((s, m) => s + m.priceDeltaXaf, 0);

  return (
    <div className="sheet-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={pickText(product.name, locale)}>
        <h2>{pickText(product.name, locale)}</h2>
        {groups.map((g) => (
          <div key={g.id} className="group">
            <b>
              {pickText(g.name, locale)}{' '}
              <span className="muted">({g.minSelect > 0 ? t('menu.required') : t('menu.optional')})</span>
            </b>
            <div className="chips">
              {g.modifiers.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={chosen[g.id]?.includes(m.id) ?? false}
                  onClick={() => toggle(g, m.id)}
                >
                  {pickText(m.name, locale)}
                  {m.priceDeltaXaf > 0 && ` +${formatXaf(m.priceDeltaXaf, locale)}`}
                </button>
              ))}
            </div>
          </div>
        ))}
        <label className="group">
          <b>{t('menu.note')}</b>
          <input
            maxLength={140}
            placeholder={t('menu.notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="sheet-foot">
          <div className="qty">
            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label={t('menu.remove')}>
              −
            </button>
            <span>{quantity}</span>
            <button onClick={() => setQuantity((q) => Math.min(30, q + 1))} aria-label={t('menu.add')}>
              +
            </button>
          </div>
          <button
            className="primary"
            disabled={!complete}
            onClick={() => onAdd(Object.values(chosen).flat(), quantity, note.trim())}
          >
            {t('menu.add')} · {formatXaf((product.priceXaf + extras) * quantity, locale)}
          </button>
        </div>
      </div>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="app">
      <header className="head">
        <div className="site">TCHOP LIFE</div>
      </header>
      <p className="notice">{text}</p>
    </div>
  );
}
