import English from './snowball/english-stemmer.js';
import French from './snowball/french-stemmer.js';
import German from './snowball/german-stemmer.js';
import Italian from './snowball/italian-stemmer.js';
import Portuguese from './snowball/portuguese-stemmer.js';
import Russian from './snowball/russian-stemmer.js';
import Spanish from './snowball/spanish-stemmer.js';

/**
 * Word forms for the archive search: a query word's stems, by the Snowball
 * rules (snowball/, BSD), so "билеты" finds "билет" and "билетов". Cyrillic
 * words get the Russian stem; Latin ones the English stem and that of the
 * browser's language when there are rules for it. A stem is matched at the
 * start of a word; stems shorter than three letters are not used.
 */

type Stemmer = { stemWord(word: string): string };
const LATIN: Record<string, new () => Stemmer> = {
  en: English,
  de: German,
  es: Spanish,
  fr: French,
  pt: Portuguese,
  it: Italian,
};

/** The languages the Latin words are stemmed in: English and the browser's, when it has rules. */
export function formLanguages(browser = globalThis.navigator?.language ?? ''): string[] {
  const own = browser.toLowerCase().split(/[-_]/)[0] ?? '';
  return own && own !== 'en' && LATIN[own] ? ['en', own] : ['en'];
}

const made = new Map<string, Stemmer>();
function stemmer(language: string): Stemmer | null {
  let s = made.get(language);
  if (!s) {
    const Rules = language === 'ru' ? Russian : LATIN[language];
    if (!Rules) return null;
    made.set(language, (s = new Rules()));
  }
  return s;
}

const MIN_STEM = 3;

/** Letters without their accents: the rules may fold them (häuser → haus). */
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

/**
 * The stems of a lower-case word other than the word itself: Russian for a
 * Cyrillic word, those of `languages` for a Latin one, none for others or for
 * anything that is not a single word.
 */
export function wordStems(word: string, languages: readonly string[]): string[] {
  if (!/^[\p{L}\p{M}'’-]+$/u.test(word)) return [];
  const cyrillic = /\p{Script=Cyrillic}/u.test(word);
  const latin = /^[\p{Script=Latin}\p{M}'’-]+$/u.test(word);
  const tongues = cyrillic ? ['ru'] : latin ? languages : [];
  const stems = new Set<string>();
  for (const language of tongues) {
    const stem = stemmer(language)?.stemWord(word);
    if (
      stem &&
      stem !== word &&
      stem.length >= MIN_STEM &&
      plain(word).startsWith(plain(stem).slice(0, MIN_STEM))
    ) {
      stems.add(stem);
    }
  }
  return [...stems];
}
