/* Ayni library 0.2.0, helpers: the small jobs every app writes again. Plain JavaScript, no build step, evergreen
   browsers 2024+. It needs nothing, and every page loads it, because Ayni's own files use it. Load it right after
   ayni-i18n.js, without defer:
     <script src="ayni-i18n.js"></script>
     <script src="ayni-util.js"></script>
   It does nothing on loading but define these functions, so a service worker can load it too. */
(() => {
'use strict';

/* ---------- Nodes ---------- */
const addKid = (el, kid) => {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach((k) => addKid(el, k)); return; }
  el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
};
/* h('div', { class, text, html, on: { click }, attrs, data, anyProperty }, kid, ...), or h('div', 'its-class', kid, ...).
   A null or false prop or attr is skipped ('' is not). html is for your own icons only, never for data. */
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  if (typeof props === 'string') { if (props) el.className = props; }
  else for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') Object.entries(v).forEach(([e, fn]) => el.addEventListener(e, fn));
    else if (k === 'attrs') { Object.entries(v).forEach(([a, x]) => { if (x != null && x !== false) el.setAttribute(a, x); }); }
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else el[k] = v;
  }
  addKid(el, kids);
  return el;
};

/* An icon as text, for code that runs before ayni-base.js loads; the base's own takes over when it loads. The drawing may
   arrive later: the browser draws it when it comes. */
const icon = (name, cls = '', size) => `<span class="icon${cls && ' ' + cls}" data-icon="${name}" aria-hidden="true"${size ? ` style="--icon:${size}px"` : ''}><svg class="st" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-${name}"/></svg></span>`;

/* ---------- Text into HTML and CSS ---------- */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
const cssUrl = (u) => `url("${cssEsc(u)}")`;

/* ---------- Paths and names ---------- */
const extOf = (name) => /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1].toLowerCase() ?? '';
const baseName = (path) => String(path || '').split('/').pop();
const dirOf = (path) => { const p = String(path || ''), i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const stripExt = (name) => String(name).replace(/\.[a-z0-9]+$/i, '');
/* Where `path` is after the moves in `pairs` ([old, new]): the same place, or the new one when it is, or lives inside,
   a moved item */
const followPath = (path, pairs) => {
  for (const [from, to] of pairs) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  }
  return path;
};
/* "photo.jpg" -> "photo (2).jpg", "photo (3).jpg"... while `taken` (a Set) has the name */
const uniqueName = (name, taken) => {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (taken.has(`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
};
/* "Córdoba 2026" -> "cordoba-2026": accents go, the letters stay, anything else becomes one "-" */
const slugify = (s, fallback, max) => {
  let out = Ayni.fold(s || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (max) out = out.slice(0, max);
  return out || fallback || 'item';
};

/* ---------- Amounts ---------- */
const lang = () => globalThis.Ayni?.i18n?.lang() || 'en';
const oneDecimal = new Map();
const decimal = (n) => {
  const l = lang();
  if (!oneDecimal.has(l)) oneDecimal.set(l, new Intl.NumberFormat(l, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  return oneDecimal.get(l).format(n);
};
/* "1.5 KB", "15 MB": one decimal only under 10 */
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  n = Math.max(0, n || 0);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? decimal(n) : Math.round(n)} ${u[i]}`;
};
/* 65 -> "1:05", 3725 -> "1:02:05" */
const fmtClock = (seconds) => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = pad(s % 60);
  return hh > 0 ? `${hh}:${pad(m)}:${r}` : `${m}:${r}`;
};
/* 5400 -> "1 h 30 min" */
const fmtRuntime = (seconds) => {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const mins = Math.round(seconds / 60), hh = Math.floor(mins / 60), m = mins % 60;
  return hh > 0 ? `${hh} h ${m} min` : `${m} min`;
};

/* ---------- Colour from a name ---------- */
/* The same name always gives the same number, on every device. With mod the sum stays under it at every step. */
const hash = (text, mod = 2 ** 32) => {
  const s = String(text ?? '');
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % mod;
  return n;
};
/* A hue for a name: a page paints with it as it likes */
const hueOf = (text) => hash(text) % 360;
/* One of eight tile colours for a name: white reads on all of them */
const PALETTE = ['#2E6B8A', '#3E86AE', '#6B5B95', '#8A3E3E', '#2E8A78', '#8A6A2E', '#5E4B8A', '#3E6B4A'];
const colorFor = (text) => PALETTE[Math.abs(hash(text || '') | 0) % PALETTE.length];

/* ---------- Waiting ---------- */
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/* Runs worker(item) over items, at most n at a time */
const pool = async (items, n, worker) => {
  let i = 0;
  const run = async () => { while (i < items.length) await worker(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
};

/* ---------- Leaving the page ---------- */
/* navigator.clipboard is absent on plain HTTP and may refuse; then a hidden field and execCommand. The field goes into
   an open modal dialog, because a modal makes the rest of the page dead, and the focus comes back afterwards. */
const copyByHand = (value) => {
  const was = document.activeElement, ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ([...document.querySelectorAll('dialog:modal')].pop() || document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* falls to the throw below */ }
  ta.remove();
  was?.focus?.({ preventScroll: true });
  if (!ok) throw new Error('copy failed');
};
const copyText = (value) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value).catch(() => copyByHand(value));
  return new Promise((resolve) => { copyByHand(value); resolve(); });
};
const clickLink = (url, name) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  return a;
};
/* A Blob or a text, to this device as a download. The throwaway link goes after 1 s. */
const saveFile = (data, name, type) => {
  const a = clickLink(URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })), name);
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};
/* The same with an address: the browser fetches it itself */
const saveUrl = (url, name) => { clickLink(url, name).remove(); };

/* ---------- The device ---------- */
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
/* An iPad may call itself a Mac: it is the one with a touch screen */
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------- Dates (ayni-fields.js adds the formatters) ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(+m[1], m[2] - 1, +m[3]);
  return iso(d) === s.trim() ? d : null;
};
/* The device's day, never the UTC day */
const today = () => iso(new Date());
const zone = (fallback = 'UTC') => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback; } catch { return fallback; }
};
/* An old browser has no supportedValuesOf: it gets the common zones */
const zones = () => {
  try { return Intl.supportedValuesOf('timeZone'); } catch {
    return ['UTC', 'Europe/Madrid', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Lisbon',
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
      'America/Mexico_City', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Dubai',
      'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland'];
  }
};

const Ayni = (globalThis.Ayni ??= {});
Object.assign(Ayni, {
  h, icon, esc, cssEsc, cssUrl, extOf, baseName, dirOf, stripExt, followPath, uniqueName, slugify,
  fmtBytes, fmtClock, fmtRuntime, hash, hueOf, colorFor, sleep, pool, copyText, saveFile, saveUrl, isMac, isIOS,
  dates: { pad, iso, parseIso, today, zone, zones },
});
})();
