/** Montants en FCFA : entiers, sans décimales. Les espaces insécables du formatage sont remplacées par des espaces. */
export function formatXaf(amount: number, locale: 'fr' | 'en' = 'fr'): string {
  const n = Math.round(amount).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');
  return `${n.replace(/\p{Zs}/gu, ' ')} FCFA`;
}
