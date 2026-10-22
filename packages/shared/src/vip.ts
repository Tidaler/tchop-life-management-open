/**
 * Salon VIP : une table d'une zone VIP voit une carte propre. Chaque catégorie dit si elle y est
 * proposée et quel supplément s'ajoute au prix de ses produits. Les mêmes règles servent au chiffrage
 * des commandes (serveur), au menu QR (site et cloud) et à l'affichage sur la tablette.
 */
export interface VipRule {
  vipOffered: boolean;
  vipSurchargeXaf: number;
}

export const VIP_SURCHARGE_MAX_XAF = 1_000_000;

/** Prix d'un produit à une table : null si sa catégorie n'est pas proposée dans cette zone. */
export function zonePriceXaf(basePriceXaf: number, rule: VipRule, vip: boolean): number | null {
  if (!vip) return basePriceXaf;
  return rule.vipOffered ? basePriceXaf + rule.vipSurchargeXaf : null;
}

/**
 * Menu tel qu'une table le voit : en zone VIP, catégories non proposées retirées et suppléments
 * ajoutés. Les règles elles-mêmes ne sont jamais renvoyées (le client ne voit que des prix).
 */
export function menuForZone<
  M extends {
    categories: (VipRule & { id: string })[];
    products: { categoryId: string; priceXaf: number }[];
  },
>(
  menu: M,
  vip: boolean,
): Omit<M, 'categories'> & { categories: Omit<M['categories'][number], keyof VipRule>[] } {
  const rules = new Map(menu.categories.map((c) => [c.id, c]));
  type Category = Omit<M['categories'][number], keyof VipRule>;
  const categories = menu.categories
    .filter((c) => !vip || c.vipOffered)
    .map(({ vipOffered: _offered, vipSurchargeXaf: _surcharge, ...rest }) => rest as Category);
  const products = menu.products.flatMap((p) => {
    const rule = rules.get(p.categoryId);
    const price = rule ? zonePriceXaf(p.priceXaf, rule, vip) : p.priceXaf;
    return price === null ? [] : [{ ...p, priceXaf: price }];
  }) as M['products'];
  return { ...(menu as Omit<M, 'categories'>), categories, products };
}
