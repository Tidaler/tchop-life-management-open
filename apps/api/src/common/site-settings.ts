import { DEFAULT_THRESHOLDS, type Thresholds } from '@tchop/shared';

/** Seuils d'approbation du site : valeurs par défaut, complétées par les paramètres du site. */
export function siteThresholds(settings: unknown): Thresholds {
  const custom = (settings as { thresholds?: Partial<Thresholds> } | null)?.thresholds ?? {};
  return { ...DEFAULT_THRESHOLDS, ...custom };
}

/** Minuit (heure du site) du jour donné (AAAA-MM-JJ), en instant UTC. */
export function zonedMidnight(day: string, timeZone: string): Date {
  const utc = new Date(`${day}T00:00:00Z`);
  const asZone = new Date(utc.toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(utc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(utc.getTime() - (asZone.getTime() - asUtc.getTime()));
}
