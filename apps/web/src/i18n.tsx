import { type Locale, type MessageKey, translate } from '@tchop/i18n';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const LOCALE_KEY = 'tchop.locale';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'fr' || stored === 'en') return stored;
  } catch {
    /* stockage indisponible */
  }
  return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* préférence non mémorisée */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n doit être utilisé dans I18nProvider');
  return value;
}

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t('lang.label')}>
      {(['fr', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
          title={t(`lang.${l}`)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
