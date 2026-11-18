// UI strings. The daemon sets <html data-lang> from language.primary
// ("de" → German, anything else → English). English is the fallback catalog.
import en from "./i18n/en.js";
import de from "./i18n/de.js";
import viewsEn from "./i18n/views-en.js";
import viewsDe from "./i18n/views-de.js";
import oldviewsEn from "./i18n/oldviews-en.js";
import oldviewsDe from "./i18n/oldviews-de.js";

Object.assign(en, viewsEn, oldviewsEn);
Object.assign(de, viewsDe, oldviewsDe);
const CATALOGS = { en, de };
export const LANG = CATALOGS[document.documentElement.dataset.lang] ? document.documentElement.dataset.lang : "en";
document.documentElement.lang = LANG;
const table = CATALOGS[LANG];

/** t("key", { n: 3 }) — {name} placeholders are replaced from vars. */
export function t(key, vars) {
  const raw = table[key] ?? en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
}

/** Section catalogs (js/i18n/<name>-en.js / -de.js) merge themselves in here. */
export function addStrings(enStrings, deStrings) {
  Object.assign(en, enStrings);
  Object.assign(de, deStrings);
}

export const numberFmt = new Intl.NumberFormat(LANG === "de" ? "de-DE" : "en-US");
