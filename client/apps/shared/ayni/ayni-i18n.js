/* Ayni library 0.2.0: the language layer. Plain JavaScript, no build step, evergreen browsers 2024+.
   Load it FIRST, in <head>, without defer, so the texts start loading before the rest of the page:
     <script src="ayni-i18n.js" data-dict="i18n/" data-langs="es en pt fr de"></script>
   data-dict is the folder with the app's own texts (<lang>.json), data-langs the languages the app offers; the
   first one is its reference language. Without them the page gets Ayni's own texts only, in Ayni's languages.
   RULE: no text lives in the code. Every text is a key in one file per language: Ayni's own keys start with "ayni."
   and live in the i18n/ folder beside this file; the app's live in its data-dict folder.
     - in the page:  <span data-i18n="key"></span>, <input data-i18n-attr="placeholder:key, title:key2">
     - in code:      Ayni.t('key'), Ayni.tf('key', { n: 3 }) for "{n}" places
   A key missing in the language in use falls back to the reference language, then to the key itself.
   Nothing may be painted before the texts are in, so this script hides <html> until they are, for SHOW_MS at most:
   a dead network never leaves a blank screen. Code that builds text waits for Ayni.i18n.ready. */
(() => {
'use strict';
const me = document.currentScript;
const AYNI_LANGS = ['en', 'es', 'pt', 'fr', 'de'];
const KEY = 'ayni-lang';                 // the user's choice, kept on this device
const SHOW_MS = 2500;                    // never hide the page longer than this

const appLangs = (me?.dataset.langs || '').split(/[\s,]+/).filter(Boolean);
const LANGS = appLangs.length ? appLangs : AYNI_LANGS;
const SOURCE = LANGS[0];                 // the app's reference language
const base = (path) => { try { return new URL(path, me?.src || location.href).href; } catch { return null; } };
const AYNI_URL = base('i18n/');
const APP_URL = me?.dataset.dict ? new URL(me.dataset.dict, location.href).href : null;

/* The language the user picked, or null when they never did: with nothing stored the browser decides */
const saved = () => { try { const s = localStorage.getItem(KEY); return s && LANGS.includes(s) ? s : null; } catch { return null; } };
const pick = () => saved()
  || (navigator.languages || [navigator.language || '']).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => LANGS.includes(l))
  || (LANGS.includes('en') ? 'en' : SOURCE);
const lang = pick();

/* Armed now, while the parser is still going, so the listener is never attached too late: readyState turns
   "interactive" before the deferred scripts run, and everything waiting on `ready` expects them to be there */
const domReady = new Promise((go) => {
  if (document.readyState !== 'loading') go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
});

/* ---------- Hide the page until the texts are in ---------- */
let hider = null;
try { hider = document.createElement('style'); hider.textContent = 'html{visibility:hidden!important}'; (document.head || document.documentElement).append(hider); } catch {}
const show = () => { hider?.remove(); hider = null; };
setTimeout(show, SHOW_MS);

/* ---------- Look-up ---------- */
let dict = {};
const t = (key) => (key && Object.hasOwn(dict, key) ? dict[key] : key);
const tf = (key, vars) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (vars?.[k] != null ? vars[k] : m));

const els = (scope, sel) => [...(scope.matches?.(sel) ? [scope] : []), ...scope.querySelectorAll(sel)];
const apply = (root = document) => {
  els(root, '[data-i18n]').forEach((el) => { const k = el.getAttribute('data-i18n'); if (k) el.textContent = t(k); });
  els(root, '[data-i18n-attr]').forEach((el) => el.getAttribute('data-i18n-attr').split(',').forEach((pair) => {
    const [attr, k] = pair.split(':').map((x) => x?.trim());
    if (attr && k) el.setAttribute(attr, t(k));
  }));
};

/* ---------- Day and month names: never in a dictionary, the browser knows them all ----------
   weekday(1) → "lunes", "Monday"... (1 = Monday); weekday(1, 'narrow') → "L"; month(0) → "enero"... (0 = January).
   asIs keeps the language's own case, for a name inside a sentence ("2026-09-28 · lunes"). */
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const weekday = (iso, style = 'long', asIs = false) => {
  try { const n = new Intl.DateTimeFormat(lang, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, iso))); return asIs ? n : capitalise(n); }
  catch { return String(iso); }   // 2024-01-01 was a Monday, so 2024-01-<iso> lines the ISO number up
};
const month = (idx, style = 'long') => {
  try { return capitalise(new Intl.DateTimeFormat(lang, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, idx, 1)))); }
  catch { return String(idx + 1); }
};

/* ---------- Load ---------- */
const grab = async (url, code) => {
  if (!url) return null;
  try { const r = await fetch(url + code + '.json'); if (r.ok) return await r.json(); } catch {}
  return null;
};
const ready = (async () => {
  /* Weakest first: Ayni's English, Ayni's language, the app's reference language, the app's language */
  const ayniLang = AYNI_LANGS.includes(lang) ? lang : 'en';
  const layers = await Promise.all([
    grab(AYNI_URL, 'en'), ayniLang !== 'en' ? grab(AYNI_URL, ayniLang) : null,
    grab(APP_URL, SOURCE), lang !== SOURCE ? grab(APP_URL, lang) : null,
  ]);
  dict = Object.assign({}, ...layers.filter(Boolean));
  document.documentElement.lang = lang;
  await domReady;
  apply(document);
  show();
  return dict;
})();

/* Anything added to the page later (a dialog built in code, a row of a list) is translated as it lands */
new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) apply(n); })))
  .observe(document.documentElement, { childList: true, subtree: true });

/* A choice made in another tab reloads this one */
addEventListener('storage', (e) => { if (e.key === KEY) location.reload(); });

/* setLang(code): '' forgets the choice and follows the browser again, a code picks that language, null or undefined
   changes nothing (an app can pass on "the account never chose one" as it is). The page reloads when the choice
   really changed; returns true when that reload is on its way. With storage blocked (private mode) the write is
   refused, so it is read back before reloading: a page that sets the language on every start never spins. */
const setLang = (code) => {
  if (code == null) return false;
  if (code === '') {
    if (!saved()) return false;
    try { localStorage.removeItem(KEY); } catch {}
    if (saved()) return false;
  } else {
    if (!LANGS.includes(code) || code === saved()) return false;
    try { localStorage.setItem(KEY, code); } catch {}
    if (saved() !== code) return false;
  }
  location.reload();
  return true;
};

const Ayni = (window.Ayni ??= {});
Object.assign(Ayni, {
  t, tf,
  i18n: { ready, apply, lang: () => lang, saved, setLang, langs: LANGS.slice(), source: SOURCE, weekday, month },
});
})();
