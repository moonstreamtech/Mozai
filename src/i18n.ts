/*
 * Minimal i18n.
 *
 * Reads navigator.language once at module load and resolves to one
 * of the supported languages. Mozai is launching with TR + EN; new
 * languages can be added by extending the Lang union and the
 * STRINGS table. Falls back to EN for anything we don't ship a
 * translation for, then to the key itself if even EN is missing
 * (i.e. a typo in the call site) — that way a missing string is
 * visible in the UI rather than rendering as undefined.
 *
 * Detection runs ONCE: navigator.language is set by the OS / browser
 * locale and is stable for the session. The cached value is exposed
 * via the `lang` constant for callers that need the bare tag (e.g.
 * formatters that take a BCP-47 locale).
 */

export type Lang = 'en' | 'tr';

function detectLang(): Lang {
  const tag = (navigator.language || 'en').toLowerCase();
  // Accept both `tr` and `tr-TR`, `tr-CY` etc. via startsWith.
  if (tag.startsWith('tr')) return 'tr';
  return 'en';
}

export const lang: Lang = detectLang();

type StringKey = 'done';

const STRINGS: Record<StringKey, Record<Lang, string>> = {
  done: { en: 'Done', tr: 'Tamam' },
};

export function t(key: StringKey): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[lang] ?? entry.en ?? key;
}
