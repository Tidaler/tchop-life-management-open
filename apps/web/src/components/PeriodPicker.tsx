import { businessToday, type Period, shiftDay } from '../finance';
import { useI18n } from '../i18n';

type Preset = 'today' | 'yesterday' | 'week' | 'month';

export function presetPeriod(preset: Preset): Period {
  const today = businessToday();
  if (preset === 'yesterday') return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
  if (preset === 'week') return { from: shiftDay(today, -6), to: today };
  if (preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: today, to: today };
}

/** Choix de la période : raccourcis (aujourd'hui, hier, 7 jours, ce mois) ou dates libres. */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useI18n();
  const presets: Preset[] = ['today', 'yesterday', 'week', 'month'];
  return (
    <div className="period">
      <div className="chips">
        {presets.map((p) => {
          const range = presetPeriod(p);
          return (
            <button
              key={p}
              type="button"
              className="chip"
              aria-pressed={range.from === value.from && range.to === value.to}
              onClick={() => onChange(range)}
            >
              {t(`period.${p}`)}
            </button>
          );
        })}
      </div>
      <div className="period-dates">
        <input
          type="date"
          aria-label={t('period.from')}
          value={value.from}
          max={value.to}
          onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
        />
        <span className="muted">-</span>
        <input
          type="date"
          aria-label={t('period.to')}
          value={value.to}
          min={value.from}
          onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
        />
      </div>
    </div>
  );
}
