/* Ayni library 0.1.0, base: the foundations every page needs and every family file builds on (colours and light
   and dark, icons, texts, the browser check, start-up). Plain JavaScript, no build step, evergreen browsers 2024+.
   Load it after ayni-i18n.js and the icons, before any family file:
     <script src="ayni-i18n.js"></script>
     <script src="ayni-icons.js" defer></script>
     <script src="ayni-base.js" defer></script>
     <script src="ayni.js" defer></script>            (the controls; later one file per family)
   RULE: a family file (ayni-<family>.js) takes the shared helpers from Ayni.core and hands its start-up to
   Ayni.core.family({ setup, init }): setup runs once, init on the page and on every Ayni.init(root). */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fire = (el, type, detail) => el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
/* Each control is wired once, so Ayni.init() can run again on new content */
const wired = new WeakMap();
const once = (key, el) => { let s = wired.get(el); if (!s) wired.set(el, (s = new Set())); if (s.has(key)) return false; s.add(key); return true; };
const each = (root, sel, key, fn) => [...(root.matches?.(sel) ? [root] : []), ...$$(sel, root)].forEach((el) => { if (once(key, el)) fn(el); });
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform);
const isRO = (el) => el?.getAttribute?.('aria-readonly') === 'true';
/* Shared layers (tooltip, help, notifications…), created when the page does not have them yet */
const layer = (id, html) => document.getElementById(id) || (document.body.insertAdjacentHTML('beforeend', html), document.getElementById(id));

/* Texts: every text Ayni shows is a key in i18n/<lang>.json, read through ayni-i18n.js (loaded first). tx('tree.name')
   reads "ayni.tree.name"; txf() fills its {places}. Without ayni-i18n.js the keys themselves show. */
const tx = (k) => (window.Ayni?.t ? window.Ayni.t('ayni.' + k) : 'ayni.' + k);
const txf = (k, vars) => String(tx(k)).replace(/\{(\w+)\}/g, (m, v) => (vars?.[v] != null ? vars[v] : m));
const LOCALE = window.Ayni?.i18n?.lang() || 'en';

/* ---------- Icons ---------- */
/* An icon is <span class="icon" data-icon="name"></span>; Ayni draws it from the icon set in use. The built-in set
   (ayni-icons.js) has the icons the controls need, as symbols with id "i-<name>"; an app adds its own the same way.
   Ayni.icons.use(set) plugs in another set and maps Ayni's names to the set's names:
     { map: { close: 'x', ... },          Ayni name → the set's name; a name left out uses the symbol "i-<name>"
       sprite: '<svg>…</svg>' or a URL,   symbols added to the page (a URL is fetched, so not from file://)
       id: 'icon-{name}',                 symbol id in the sprite (default '{name}')
       stroke: true,                      the set draws with lines, like Ayni's own (default: filled shapes)
       render: (name) => html }           instead of a sprite: any markup, e.g. an icon font's <i class="…">
   Ayni.icons.use(null) goes back to the built-in set. Ayni.icons.add(set) adds the app's own icons (below).
   No SVG is pasted into a page. */
const ICONS = Object.freeze(['arrow-down', 'arrow-up', 'calendar', 'case', 'check', 'clock', 'check-all', 'chev-down', 'chev-right', 'chev-up', 'close', 'copy', 'cut',
  'apps', 'edit', 'error', 'eye', 'eye-off', 'file', 'filter', 'folder', 'help', 'info', 'maximise', 'minimise', 'minus', 'more', 'ok',
  'moon', 'paste', 'play', 'plus', 'restore', 'search', 'sun', 'today', 'trash', 'undo', 'warn']);
let iconSet = null;
const noIcon = new Set();
/* A line icon carries its stroke settings as attributes, not only through CSS: a copy of the svg taken out of its
   span (into a menu, a help card) still draws the same */
const STROKE = ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const iconSvg = (id, stroke) => `<svg${stroke ? ' class="st"' + STROKE : ''}><use href="#${id}"/></svg>`;
const iconInner = (name) => {
  const ext = iconSet?.map[name];
  if (ext) return iconSet.render ? iconSet.render(ext, name) : iconSvg(iconSet.id.replace('{name}', ext), iconSet.stroke);
  if (document.getElementById('i-' + name)) return iconSvg('i-' + name, true);
  /* Warned a moment later, and only if still missing: the page may add its own icons (icons.add) after Ayni drew */
  if (!noIcon.has(name)) {
    noIcon.add(name);
    setTimeout(() => { if (noIcon.has(name) && !document.getElementById('i-' + name)) console.warn(`Ayni icons: no icon named "${name}"`); });
  }
  return '';
};
/* Ayni.icon(name) returns the markup of one icon; extra classes go after "icon" */
const icon = (name, cls = '') => `<span class="icon${cls && ' ' + cls}" data-icon="${name}" aria-hidden="true">${iconInner(name)}</span>`;
const drawIcon = (el) => { el.setAttribute('aria-hidden', 'true'); el.innerHTML = iconInner(el.dataset.icon); };
/* Name of an icon element, also for the old <svg class="icon"><use href="#i-name"/></svg> */
const iconName = (el) => el.dataset.icon || $('use', el)?.getAttribute('href').replace('#i-', '');
/* Ayni.setIcon(el, name) changes the icon of el, or of the first icon inside el (a button, a menu item...) */
const setIcon = (el, name) => {
  let ic = el.matches('.icon') ? el : $('.icon:not(.tw)', el);
  if (!ic) return;
  if (ic.tagName.toLowerCase() === 'svg') { const s = document.createElement('span'); s.className = ic.getAttribute('class'); ic.replaceWith(s); ic = s; }
  ic.dataset.icon = name; drawIcon(ic);
};
const drawIcons = (root, all) => [...(root.matches?.('.icon[data-icon]') ? [root] : []), ...$$('.icon[data-icon]', root)]
  .forEach((el) => { if (all || !el.firstElementChild) drawIcon(el); });
const useIcons = async (set) => {
  document.getElementById('ayni-iconset')?.remove();
  iconSet = null; noIcon.clear();
  if (set) {
    let sprite = set.sprite;
    if (sprite && !sprite.trimStart().startsWith('<')) {
      const r = await fetch(sprite); if (!r.ok) throw new Error(`Ayni icons: could not load ${sprite} (${r.status})`);
      sprite = await r.text();
    }
    if (sprite) document.body.insertAdjacentHTML('afterbegin', `<div id="ayni-iconset" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${sprite}</div>`);
    iconSet = { map: {}, id: '{name}', ...set };
    const missing = ICONS.filter((n) => !iconSet.map[n]);
    if (missing.length) console.warn(`Ayni icons: the set has no icon for ${missing.join(', ')}; Ayni's own is used`);
  }
  drawIcons(document, true);
};
/* Ayni.icons.add({ name: drawing }): the app's own icons, used like Ayni's. A drawing is the inside of a 24x24 icon
   drawn with lines ('<path d="…"/>'), or a whole '<svg viewBox="…" …>…</svg>' for one on another grid or filled;
   the svg's own fill and stroke settings are kept. An icon already added is replaced, and redrawn on the page. */
const ICON_ATTRS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule'];
const addIcons = (set) => {
  let box = document.getElementById('ayni-appicons');
  if (!box) {
    document.body.insertAdjacentHTML('afterbegin', '<svg id="ayni-appicons" width="0" height="0" style="position:absolute" aria-hidden="true"></svg>');
    box = document.getElementById('ayni-appicons');
  }
  Object.entries(set).forEach(([name, drawing]) => {
    const tpl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tpl.innerHTML = drawing.trim();
    const own = tpl.firstElementChild?.tagName === 'svg' && tpl.children.length === 1 ? tpl.firstElementChild : null;
    const sym = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    sym.id = 'i-' + name;
    sym.setAttribute('viewBox', own?.getAttribute('viewBox') || '0 0 24 24');
    if (own) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      ICON_ATTRS.forEach((a) => own.hasAttribute(a) && g.setAttribute(a, own.getAttribute(a)));
      g.append(...own.childNodes); sym.append(g);
    } else sym.append(...tpl.childNodes);
    document.getElementById(sym.id)?.remove();
    box.append(sym); noIcon.delete(name);
    $$(`.icon[data-icon="${CSS.escape(name)}"]`).forEach(drawIcon);
  });
};

/* ---------- Light and dark ----------
   Four modes: System (the default: follows the device), Light, Dark, and Sun (light by day, dark by night where the
   device is). 'ayni-theme' holds the RESOLVED choice, 'light' or 'dark', also in Sun mode, because the one-line
   <head> script of the page reads it before the first paint and knows nothing about the sun; no value = System.
   data-theme on <html> always says which one is showing, 'light' or 'dark', so a page can style either with a plain
   selector (:root[data-theme="light"] …); CSS that runs before any script follows the system.
   A button with data-theme-toggle switches light and dark by hand, which also ends System and Sun modes.
   The user's own schemes ('ayni-schemes': { schemes: [{ id, tokens }], activeLight, activeDark }) set the colours
   in SCHEME_KEYS over the built-in ones. Every change reaches the other tabs of the site through the 'storage'
   event, sets <meta name="theme-color"> to --bg, and fires ayni:theme { theme } on document, so a page can repaint
   what CSS cannot reach. */
const THEME_KEY = 'ayni-theme', SUN_KEY = 'ayni-theme-sun', PLACE_KEY = 'ayni-place', SCHEMES_KEY = 'ayni-schemes';
const SCHEME_KEYS = ['--bg', '--card', '--card2', '--line', '--accent', '--on-accent'];
const darkMq = matchMedia('(prefers-color-scheme: dark)'), themeBtns = [];
const readKey = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeKey = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };
const readJson = (k) => { try { return JSON.parse(readKey(k) || 'null'); } catch { return null; } };
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : darkMq.matches; };
const chosen = () => { const t = readKey(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; };
const isSun = () => readKey(SUN_KEY) === '1';
const themeMode = () => (isSun() ? 'sun' : readKey(THEME_KEY) || null);

/* The active scheme of the user for light or dark, or null */
const activeScheme = (dark) => {
  const d = readJson(SCHEMES_KEY), id = d?.[dark ? 'activeDark' : 'activeLight'];
  return (id && d.schemes?.find((x) => x.id === id)) || null;
};
const showTheme = () => themeBtns.forEach((b) => {
  const d = isDark();
  b.setAttribute('aria-pressed', d); b.dataset.tip = tx(d ? 'theme.toLight' : 'theme.toDark'); b.setAttribute('aria-label', tx('theme.dark'));
  setIcon(b, d ? 'sun' : 'moon');   // what pressing it gives
});
let shownTheme = null;
const applyTheme = () => {
  const root = document.documentElement;
  root.dataset.theme = chosen() || (darkMq.matches ? 'dark' : 'light');
  const dark = isDark(), s = activeScheme(dark);
  SCHEME_KEYS.forEach((k) => (s?.tokens?.[k] ? root.style.setProperty(k, s.tokens[k]) : root.style.removeProperty(k)));
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) {
    let m = $('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.append(m); }
    m.content = bg;
  }
  showTheme();
  /* Only a real change is told: a page may repaint a whole widget on it, and lose half-typed text */
  const now = dark ? 'dark' : 'light';
  if (now !== shownTheme) { const first = shownTheme === null; shownTheme = now; if (!first) fire(document, 'ayni:theme', { theme: now }); }
};

/* ---------- Sun mode ----------
   Light once the sun is LIGHT_AT degrees up, dark once it is DARK_AT degrees down: plain sunrise and sunset are too
   early both ways. The place comes from the page (Ayni.theme.setPlace), rounded to ~10 km and kept on this device:
   it is a fact about where the device is, not about its user. Without one, the main city of the device's time zone
   (tz-geo.json beside ayni.js); only a zone that table lacks falls back to FALLBACK_RISE to FALLBACK_SET. */
const RAD = Math.PI / 180, LIGHT_AT = 5, DARK_AT = -4, FALLBACK_RISE = 7, FALLBACK_SET = 19, MAX_WAIT = 6 * 3600e3;
const TZ_URL = document.currentScript?.src ? new URL('tz-geo.json', document.currentScript.src).href : null;
let sunTimer = null, tzTable = null, tzLoading = false;
const sunPlace = () => { const g = readJson(PLACE_KEY); return typeof g?.lat === 'number' && typeof g?.lon === 'number' ? g : null; };

/* The time zone's main city { lat, lon }, null when unknown, undefined while the table is on its way */
const zonePlace = () => {
  if (!tzTable) {
    if (!TZ_URL || tzLoading === 'failed') return null;
    if (!tzLoading) {
      tzLoading = true;
      fetch(TZ_URL).then((r) => { if (!r.ok) throw new Error('tz-geo'); return r.json(); })
        .then((t) => { tzTable = t; }).catch(() => { tzLoading = 'failed'; }).then(sunTick);
    }
    return undefined;
  }
  let zone; try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; }
  const c = zone && tzTable[zone];
  return c ? { lat: c[0], lon: c[1] } : null;
};

/* NOAA's sunrise equation in its short form: about a minute of error, no table, no network. dayOffset picks the
   local solar day (0 = the one `now` is in); height is the sun's height in degrees the times are for.
   Returns { rise, set } as Dates, or 'up' / 'down' when the sun stays above / below that height all day. */
const sunTimes = (now, lat, lon, dayOffset, height) => {
  const jd = now.getTime() / 86400000 + 2440587.5;
  /* Whole days since 2000-01-01 of the LOCAL solar day: lon/360 picks the noon nearest `now` at this longitude */
  const n = Math.round(jd - 2451545.0 + 0.0008 + lon / 360) + (dayOffset || 0);
  const jStar = n - lon / 360;   // the formula counts longitude west-positive; places are east-positive
  const M = (357.5291 + 0.98560028 * jStar) % 360;                               // solar mean anomaly
  const C = 1.9148 * Math.sin(M * RAD) + 0.0200 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;                                       // ecliptic longitude
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);   // solar noon
  const sinDec = Math.sin(L * RAD) * Math.sin(23.44 * RAD), cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(height * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  if (cosW > 1) return 'down';
  if (cosW < -1) return 'up';
  const w = Math.acos(cosW) / RAD;   // half the day, as an hour angle
  return { rise: new Date((jTransit - w / 360 - 2440587.5) * 86400000), set: new Date((jTransit + w / 360 - 2440587.5) * 86400000) };
};

/* { mode, next }: the mode for now and when it stops being right (null: no edge, look again later).
   null while the time zone table loads: guessing meanwhile could flip the wrong way for a moment. */
const sunState = (now) => {
  const g = sunPlace() || zonePlace();
  if (g === undefined) return null;
  if (!g) {
    const h = now.getHours() + now.getMinutes() / 60, edge = new Date(now); edge.setMinutes(0, 0, 0);
    if (h < FALLBACK_RISE) { edge.setHours(FALLBACK_RISE); return { mode: 'dark', next: edge }; }
    if (h < FALLBACK_SET) { edge.setHours(FALLBACK_SET); return { mode: 'light', next: edge }; }
    edge.setHours(FALLBACK_RISE); edge.setTime(edge.getTime() + 86400000);
    return { mode: 'dark', next: edge };
  }
  const light = sunTimes(now, g.lat, g.lon, 0, LIGHT_AT), dark = sunTimes(now, g.lat, g.lon, 0, DARK_AT);
  if (light === 'up' || dark === 'up') return { mode: 'light', next: null };
  if (light === 'down' || dark === 'down') return { mode: 'dark', next: null };
  if (now < light.rise) return { mode: 'dark', next: light.rise };
  if (now < dark.set) return { mode: 'light', next: dark.set };
  const tomorrow = sunTimes(now, g.lat, g.lon, 1, LIGHT_AT);
  return { mode: 'dark', next: tomorrow.rise && tomorrow.rise > now ? tomorrow.rise : null };
};

/* Work out the mode, apply it, book the next look. Called often (every focus, every wake): it only acts on a change.
   A timer does not survive a sleeping phone, so focus, visibilitychange and pageshow look again too. */
const sunTick = () => {
  clearTimeout(sunTimer); sunTimer = null;
  if (!isSun()) return;
  const st = sunState(new Date());
  if (!st) return;   // the zone table is loading; it calls back
  if (st.mode !== readKey(THEME_KEY)) { writeKey(THEME_KEY, st.mode); applyTheme(); }
  const wait = st.next ? st.next.getTime() - Date.now() + 1000 : MAX_WAIT;   // +1 s: land just past the edge
  sunTimer = setTimeout(sunTick, Math.max(wait, 1000));
};

/* setTheme('light' | 'dark' | 'sun' | null): null follows the system */
const setTheme = (t) => {
  writeKey(SUN_KEY, t === 'sun' ? '1' : null);
  if (t === 'light' || t === 'dark') writeKey(THEME_KEY, t);
  else if (t !== 'sun') writeKey(THEME_KEY, null);
  applyTheme(); sunTick();
};
const initThemeToggle = (b) => {
  themeBtns.push(b);
  b.addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));
  showTheme();
};
const theme = {
  mode: themeMode,
  /* The device's place for Sun mode, rounded to one decimal (~10 km): all a sunrise needs, and not an address */
  setPlace: (lat, lon) => { writeKey(PLACE_KEY, JSON.stringify({ lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10 })); sunTick(); },
  hasPlace: () => !!sunPlace(),
  get schemes() { return readJson(SCHEMES_KEY); },
  set schemes(d) { writeKey(SCHEMES_KEY, d == null ? null : JSON.stringify(d)); applyTheme(); },
};
const initTheme = () => {
  applyTheme(); sunTick();
  darkMq.addEventListener('change', applyTheme);
  addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === SCHEMES_KEY) applyTheme();
    if (e.key === SUN_KEY || e.key === PLACE_KEY) { applyTheme(); sunTick(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sunTick(); });
  addEventListener('focus', sunTick);
  addEventListener('pageshow', sunTick);
};

/* ---------- Browser check ----------
   Ayni.supported() is false on a browser older than the target (Chrome 119, Firefox 128, Safari 18): it lacks the
   popover element or relative colours, so the page can ask the user to update */
const supported = () => {
  try {
    return CSS.supports('color', 'oklch(from red l c h)') && CSS.supports('color', 'color-mix(in srgb, red, blue)')
      && CSS.supports('container-type', 'inline-size') && 'popover' in HTMLElement.prototype
      && typeof structuredClone === 'function' && typeof Object.hasOwn === 'function';
  } catch { return false; }
};

/* ---------- Touch ---------- */
/* Browsers can't read the system double-click time, so a fixed 250 ms window is used */
const HOLD_MS = 500, DBL_MS = 250, coarse = matchMedia('(pointer: coarse)');
let touchPreview = false;
const isTouch = () => coarse.matches || touchPreview;
/* html.touch marks a touch device; every touch rule follows it. ayni:touch on document tells the families it changed */
const applyTouch = () => {
  const on = isTouch(), was = document.documentElement.classList.contains('touch');
  document.documentElement.classList.toggle('touch', on);
  if (on !== was) fire(document, 'ayni:touch', { on });
};
/* Ayni.setTouchPreview(true) gives the touch layout with a mouse: a preview, or a tablet with a mouse plugged in */
const setTouchPreview = (on) => { touchPreview = !!on; applyTouch(); };

/* ---------- The search rule: one for every search field, list filter and type-ahead (guidelines 4.5) ---------- */
/* Text for searching: accent- and case-blind ("jose" finds "José", "nino" finds "Niño"); "strasse" finds "Straße",
   "oeuvre" finds "œuvre", and a typed ' finds the typographic ’. Both sides of a comparison go through it. A server
   that searches for the page must fold the same way */
const FOLD_MORE = { ß: 'ss', œ: 'oe', æ: 'ae', '\u2018': "'", '\u2019': "'" };
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[ßœæ\u2018\u2019]/g, (c) => FOLD_MORE[c]);
/* A text with its umlauts spelt the German way, folded: "Müller" -> "mueller". Tried on both sides, so "Mueller" finds
   "Müller" and back ("Muller" finds both, by fold). Only umlauts are spelt out: folding every "ue" would make "fue" find
   "fumar". null when there is no umlaut (most texts) */
const foldUmlauts = (s) => {
  const n = String(s ?? '').normalize('NFC');
  return /[äöüÄÖÜ]/.test(n) ? fold(n.replace(/[äöüÄÖÜ]/g, (c) => c.normalize('NFD')[0] + 'e')) : null;
};
/* Ayni.matcher(text): a search field's text as a test. Words in any order (bill light), "an exact phrase", -word to
   leave out; a "-" inside a word (e-mail) or alone is a letter. null when nothing is asked, else m(itemText) -> true or
   false, with m.terms (the words and phrases to find, as typed: to mark the hits) and m.not (those left out) */
const matcher = (raw) => {
  const want = [], skip = [], wantF = [], skipF = [];
  String(raw ?? '').replace(/(-?)"([^"]*)"?|(\S+)/g, (all, neg, phrase, word) => {
    const not = word ? word.length > 1 && word[0] === '-' : !!neg;
    const w = (word ? (not ? word.slice(1) : word) : phrase).replace(/\s+/g, ' ').trim(), f = fold(w);
    if (!f) return '';
    (not ? skip : want).push(w); (not ? skipF : wantF).push([f, foldUmlauts(w)]);
    return '';
  });
  if (!want.length && !skip.length) return null;
  const m = (text) => {
    const t = fold(text).replace(/\s+/g, ' '), de = foldUmlauts(text)?.replace(/\s+/g, ' ');   // a phrase spans any run of spaces
    const has = ([f, u]) => t.includes(f) || (!!u && t.includes(u)) || (!!de && (de.includes(f) || (!!u && de.includes(u))));
    return wantF.every(has) && !skipF.some(has);
  };
  m.terms = want; m.not = skip;
  return m;
};

/* ---------- Tooltips: data-tip on any element ---------- */
let tip, tipTimer, tipEl = null;
const showTip = (el) => {
  tip.textContent = el.dataset.tip; tip.showPopover();
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  let y = r.bottom + 6; if (y + t.height > innerHeight - 8) y = r.top - t.height - 6;
  tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8)) + 'px';
  tip.style.top = y + 'px';
};
const hideTip = () => { clearTimeout(tipTimer); tipEl = null; if (tip.matches(':popover-open')) tip.hidePopover(); };

/* After the element's tooltip text changed: show the new one if its tooltip is open */
const retip = (el) => { if (tipEl === el) showTip(el); };
/* Ayni.setTip(el, 'Pause'): a new tooltip for el, at once if it is showing; a round button's name follows it */
const setTip = (el, text) => {
  el.dataset.tip = text;
  if (el.matches('.btn:not(.text)')) el.setAttribute('aria-label', text);
  retip(el);
};

const setupTips = () => {
  tip = layer('ayni-tip', '<div class="tooltip" popover="manual" role="tooltip" id="ayni-tip"></div>');
  /* Tooltips: after half a second of hover, at once on keyboard focus; Esc hides them; none on touch */
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip]'); if (el === tipEl) return;
    hideTip(); if (e.pointerType === 'touch' || document.documentElement.classList.contains('touch')) return; // touch: the Help dialog replaces tooltips
    if (el) { tipEl = el; tipTimer = setTimeout(() => showTip(el), 500); }
  });
  /* Shown a moment later: the focus may come back while a popup is still closing, when no other popup can open.
     A text field's tooltip (how to search) shows on hover only: on focus it would cover what the user is typing for */
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]'); hideTip();
    if (el && el.matches(':focus-visible') && !el.matches('input, textarea')) { tipEl = el; setTimeout(() => { if (tipEl === el && document.activeElement === el) showTip(el); }); }
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip);
  document.addEventListener('input', hideTip);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
};

/* ---------- Labels: clicking a label focuses its control; a list is focused through its current item ---------- */
const focusCtl = (c) => (c.matches('[tabindex], input, select, textarea, button') ? c : $('[tabindex="0"]', c) || c).focus();
const setupLabels = () => addEventListener('click', (e) => {
  const l = e.target.closest('label[for]'); if (l && !l.control) { const c = document.getElementById(l.htmlFor); if (c) focusCtl(c); }
});

/* ---------- Start-up ----------
   The families register here; Ayni starts once the page is parsed and its texts are in, runs every family's setup,
   then wires the page. Ayni.ready resolves then: code that builds controls, or calls Ayni, waits for it
   ("await Ayni.ready" in a module, or Ayni.ready.then(...)) */
const families = [];
let started = false;
const init = (root = document) => {
  drawIcons(root);
  each(root, '[data-theme-toggle]', 'theme', initThemeToggle);
  families.forEach((f) => f.init?.(root));
};
const family = (f) => { families.push(f); if (started) { f.setup?.(); f.init?.(document); } };

Object.assign(window.Ayni ??= {}, {
  version: '0.1.0', init, $, $$, icon, setIcon, isDark, setTheme, theme, supported, isMac, isTouch, setTouchPreview, setTip, fold, matcher,
  icons: { use: useIcons, add: addIcons, names: ICONS, get set() { return iconSet; } },
  /* For Ayni's own family files */
  core: { fire, wired, once, each, tx, txf, LOCALE, iconName, drawIcons, family, isRO, layer, isTouch, HOLD_MS, DBL_MS, retip, fold },
});
window.Ayni.ready = new Promise((go) => {
  const start = async () => {
    await window.Ayni.i18n?.ready;
    initTheme(); setupTips(); setupLabels(); applyTouch(); coarse.addEventListener('change', applyTouch);
    families.forEach((f) => f.setup?.());
    started = true; init(document); go();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
});
})();
