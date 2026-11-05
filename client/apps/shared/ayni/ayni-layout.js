/* Ayni library 0.1.0, layout family: tabs, the splitter, the status bar and More fields. Plain JavaScript, no build step, evergreen
   browsers 2024+. Load it after ayni-base.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-layout.js" defer></script>
   The look is in ayni-layout.css; the rules are chapters 11.4, 12 and 13 of the guidelines.
   RULE: tabs change the page below them (a filter is a choice row, another look at the same content the view switch).
   A tab row, a .split or a More fields line written in the page is wired when it loads; Ayni.tabs, Ayni.splitter and
   Ayni.moreFields wire one from code and return its controller. Setting a value from code fires nothing; a user's pick
   fires ayni:tabselect, a closed tab ayni:tabclose (on the tablist), a user's action on a bar ayni:split (bubbles from
   the bar) and a press on More fields ayni:more. */
(() => {
'use strict';
const { $, $$ } = Ayni;
const { fire, tx, txf, isTouch, DBL_MS } = Ayni.core;

/* Status bar: Ayni.status(text) writes into the cell marked data-ayni-status */
const status = (msg) => { const el = $('[data-ayni-status]'); if (el) el.textContent = msg; };

/* localStorage may be blocked: a size that is not kept is no error */
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };

/* ---------- Tabs: roving focus, arrows, Home/End, Ctrl+Page Up/Down, #hash (data-hash on the tablist) ---------- */
const tabsOf = new WeakMap();
const TAB = ':scope > [role="tab"]';
const isOff = (t) => t.getAttribute('aria-disabled') === 'true';
const tabValue = (t) => t.dataset.value ?? t.getAttribute('aria-controls');
const panelOf = (t) => { const id = t.getAttribute('aria-controls'); return id ? document.getElementById(id) : null; };
let seq = 0;

/* A tab's name sits in .tab-text, so a long one can end in an ellipsis; its panel knows its tab */
const dress = (t) => {
  t.id ||= 'ayni-tab-' + (++seq);
  if (!t.hasAttribute('type')) t.type = 'button';
  const bare = [...t.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
  if (bare.length && !$('.tab-text', t)) { const x = document.createElement('span'); x.className = 'tab-text'; bare[0].replaceWith(x); x.append(bare[0]); }
  const panel = panelOf(t); if (panel) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', t.id); }
};
/* A tab from a list item: { value, label, icon, tip, panel, closable, disabled, why } */
const fillTab = (t, it) => {
  t.dataset.value = it.value; t.hidden = false;
  t.innerHTML = (it.icon ? Ayni.icon(it.icon) : '') + '<span class="tab-text"></span>' + (it.closable ? `<span class="tab-close" data-close>${Ayni.icon('close')}</span>` : '');
  $('.tab-text', t).textContent = it.label;
  const x = $('.tab-close', t);
  if (x) { x.dataset.tip = txf('tab.close', { name: it.label }); t.setAttribute('data-closable', ''); t.setAttribute('aria-keyshortcuts', 'Delete'); }
  else { t.removeAttribute('data-closable'); t.removeAttribute('aria-keyshortcuts'); }
  if (it.disabled) t.setAttribute('aria-disabled', 'true'); else t.removeAttribute('aria-disabled');
  const tip = (it.disabled && it.why) || it.tip;
  if (tip) t.dataset.tip = tip; else delete t.dataset.tip;
  if (it.panel) { it.panel.id ||= 'ayni-panel-' + (++seq); t.setAttribute('aria-controls', it.panel.id); } else t.removeAttribute('aria-controls');
  dress(t);
};
const newTab = (it) => { const t = document.createElement('button'); t.setAttribute('role', 'tab'); t.tabIndex = -1; fillTab(t, it); return t; };

const initTabs = (list, o = {}) => {
  const all = () => $$(TAB, list);
  const shown = () => all().filter((t) => !t.hidden);
  const live = () => shown().filter((t) => !isOff(t));
  const current = () => all().find((t) => t.getAttribute('aria-selected') === 'true') ?? null;
  const find = (v) => (typeof v === 'string' ? all().find((t) => tabValue(t) === v) : v) ?? null;
  const tips = new WeakMap();    /* A disabled tab's own tooltip, while "why" stands in for it */

  const show = (tab, focus) => {
    all().forEach((t) => {
      const on = t === tab, panel = panelOf(t);
      t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
      if (panel) panel.hidden = !on;
    });
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) tab.focus();
    if (o.hash ?? list.hasAttribute('data-hash')) try { history.replaceState(null, '', '#' + tab.getAttribute('aria-controls')); } catch {}
  };
  const neighbour = (tab) => { const row = shown(), i = row.indexOf(tab); return row.slice(i + 1).find((t) => !isOff(t)) || row.slice(0, i).reverse().find((t) => !isOff(t)); };
  /* The user's pick; one on the selected tab says nothing new */
  const pick = (tab) => {
    if (tab === current()) { tab.focus(); return; }
    show(tab, true); fire(list, 'ayni:tabselect', tab); o.onSelect?.(tabValue(tab), tab);
  };
  /* Closable tabs: the round (x), Delete, or a middle click. The neighbour takes over. */
  const close = (tab) => {
    const was = tab === current(), next = neighbour(tab);
    tab.hidden = true; tab.setAttribute('aria-selected', false);
    const panel = panelOf(tab); if (panel) panel.hidden = true;
    /* Focus always goes to the selected tab after a close (item 65) */
    if (was && next) pick(next); else current()?.focus();
    fire(list, 'ayni:tabclose', tab); o.onClose?.(tabValue(tab), tab);
  };
  const tabOf = (e) => { const t = e.target.closest?.('[role="tab"]'); return t?.parentElement === list ? t : null; };

  /* The tooltip of a name cut short gives it in full; a tab's own tooltip stays */
  const fullName = (e) => {
    const t = tabOf(e), x = t && $('.tab-text', t); if (!x) return;
    const name = x.textContent;
    if (x.scrollWidth > x.clientWidth) { if (!t.dataset.tip) t.dataset.tip = name; } else if (t.dataset.tip === name) delete t.dataset.tip;
  };
  list.addEventListener('pointerover', fullName, true);
  list.addEventListener('focusin', fullName, true);

  list.addEventListener('click', (e) => {
    const t = tabOf(e); if (!t || isOff(t)) return;
    if (e.target.closest('[data-close]')) { e.stopPropagation(); close(t); } else pick(t);
  });
  list.addEventListener('auxclick', (e) => {
    const t = tabOf(e); if (t && e.button === 1 && t.hasAttribute('data-closable')) { e.preventDefault(); close(t); }
  });
  list.addEventListener('keydown', (e) => {
    if (!e.target.matches('[role="tab"]') || e.ctrlKey || e.altKey || e.metaKey) return;
    const row = live(), i = row.indexOf(e.target);
    if (e.key === 'Delete' && row[i]?.hasAttribute('data-closable')) { e.preventDefault(); close(row[i]); return; }
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: row.length - 1 }[e.key];
    if (n !== undefined && row.length) { e.preventDefault(); pick(row[(n + row.length) % row.length]); }
  });
  /* Many tabs (item 64): the mouse wheel over the tab row scrolls it sideways */
  list.addEventListener('wheel', (e) => {
    if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault(); list.scrollLeft += e.deltaY;
  }, { passive: false });

  /* Ctrl+Page Down / Ctrl+Page Up switch to the next / previous tab from anywhere inside the scope (item 66).
     The innermost tab set around the focus wins; Ctrl+Tab stays with the browser. */
  let scope = null;
  const onPage = (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || (e.key !== 'PageDown' && e.key !== 'PageUp')) return;
    if (e.target.closest('.tabscope') !== scope || e.target.closest('[popover]')) return;
    const row = live(); if (!row.length) return;
    e.preventDefault(); e.stopPropagation();
    pick(row[(row.indexOf(current()) + (e.key === 'PageDown' ? 1 : -1) + row.length) % row.length]);
  };
  const setScope = (el) => {
    if (scope) { scope.removeEventListener('keydown', onPage, true); scope.classList.remove('tabscope'); }
    scope = el; scope.classList.add('tabscope'); scope.addEventListener('keydown', onPage, true);
  };
  setScope(o.scope ?? list.parentElement);

  const api = {
    get tabs() { return all(); },
    get value() { const t = current(); return t ? tabValue(t) : null; },
    set value(v) { api.select(v); },
    select(v) { const t = find(v); if (t) show(t, false); },
    /* Tabs that stay keep their element, so a focus, a drag and the row's scroll survive a redraw */
    set(items, value) {
      const old = new Map(all().map((t) => [tabValue(t), t]));
      const next = items.map((it) => { const was = old.get(String(it.value)); if (was) fillTab(was, it); return was ?? newTab(it); });
      all().filter((t) => !next.includes(t)).forEach((t) => { const p = panelOf(t); if (p) p.hidden = true; t.remove(); });
      next.forEach((t, i) => { if (list.children[i] !== t) list.insertBefore(t, list.children[i] ?? null); });
      const start = (value != null && find(String(value))) || current() || live()[0];
      if (start) show(start, false);
    },
    add(item, index) {
      const t = newTab(item); list.insertBefore(t, all()[index] ?? null);
      if (!current()) show(t, false); else if (panelOf(t)) panelOf(t).hidden = true;
      return t;
    },
    close(v) { const t = find(v); if (t) close(t); },
    /* A disabled tab says why in its tooltip; the row moves off it when it was the selected one */
    setTabEnabled(v, on, why) {
      const t = find(v); if (!t) return;
      if (on) { t.removeAttribute('aria-disabled'); if (tips.has(t)) { if (tips.get(t) == null) delete t.dataset.tip; else t.dataset.tip = tips.get(t); tips.delete(t); } return; }
      t.setAttribute('aria-disabled', 'true');
      if (why != null) { if (!tips.has(t)) tips.set(t, t.dataset.tip); t.dataset.tip = why; }
      if (t === current()) { const n = neighbour(t); if (n) show(n, false); }
    },
  };
  tabsOf.set(list, { api, o, setScope });

  if (o.items) api.set(o.items, o.value);
  all().forEach(dress);
  const hashed = (o.hash ?? list.hasAttribute('data-hash')) && all().find((t) => '#' + t.getAttribute('aria-controls') === location.hash);
  const start = (o.value != null && find(o.value)) || hashed || current() || live()[0];
  if (start) show(start, false);
  return api;
};

const tabs = (el, opts = {}) => {
  if (typeof el === 'string') el = $(el);
  if (!el) return null;
  el.setAttribute('role', 'tablist');
  const have = tabsOf.get(el);
  if (!have) return initTabs(el, opts);
  Object.assign(have.o, opts);
  if (opts.scope) have.setScope(opts.scope);
  if (opts.items) have.api.set(opts.items, opts.value); else if ('value' in opts) have.api.select(opts.value);
  return have.api;
};

/* ---------- Splitter (item 69): drag, arrows, Home/End; Enter collapses/restores the first pane; double-click resets ---------- */
const barsOf = new WeakMap();

/* A bar between two panes, in the page's own layout (.split below is built on it). `first` and `last` are the panes
   before and after the bar; o.side says which of them o.pane is. Sizes are in o.unit; a collapsed pane is `hidden` and
   the other one fills the room (.split-fill), so size itself never changes by collapsing. */
const initBar = (bar, o) => {
  const rows = o.rows ?? (bar.classList.contains('rows') || bar.getAttribute('aria-orientation') === 'horizontal');
  bar.classList.toggle('rows', rows);
  const lastSide = o.side === 'last', sign = lastSide ? -1 : 1, dim = rows ? 'height' : 'width';
  const pct = o.unit === '%';
  const pane = o.pane ?? (lastSide ? bar.nextElementSibling : bar.previousElementSibling);
  const other = o.other ?? (lastSide ? bar.previousElementSibling : bar.nextElementSibling);
  const paneAt = (which) => ((which === 'last') === lastSide ? pane : other);
  const [first, last] = rows ? ['top', 'bottom'] : ['left', 'right'];
  const lo = () => o.min ?? (pct ? 15 : 80), hi = () => o.max ?? (pct ? 85 : Infinity);
  const clamp = (v) => Math.max(lo(), Math.min(hi(), v));
  const key = () => (typeof o.key === 'function' ? o.key() : o.key);
  const whole = () => { const r = pane.parentElement.getBoundingClientRect(); return rows ? r.height : r.width; };
  const measure = () => { const r = pane.getBoundingClientRect(); return rows ? r.height : r.width; };
  const inUnit = (px) => (pct ? Math.round((px / (whole() || 1)) * 1000) / 10 : Math.round(px));

  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', rows ? 'horizontal' : 'vertical');
  if (!bar.hasAttribute('tabindex')) bar.tabIndex = 0;
  if (!bar.hasAttribute('aria-label')) bar.setAttribute('aria-label', tx('split.drag'));
  if (!bar.dataset.tip && !bar.title) bar.dataset.tip = tx('split.drag');

  /* The glyphs: two small arrows and the reset dot */
  let toStart = null, toEnd = null;
  if (o.glyphs !== false) {
    const tri = (dir) => `<span class="tri ${dir}"></span>`;
    const ctl = document.createElement('span'); ctl.className = 'split-ctl';
    ctl.innerHTML = `<button type="button" tabindex="-1" data-to="first" aria-label="${tx('split.collapse.' + first)}" data-tip="${tx('split.collapse.' + first)}">${tri(rows ? 'up' : 'left')}</button>`
      + `<button type="button" tabindex="-1" data-to="reset" aria-label="${tx('split.reset')}" data-tip="${tx('split.resetTip')}"><span class="dot"></span></button>`
      + `<button type="button" tabindex="-1" data-to="last" aria-label="${tx('split.collapse.' + last)}" data-tip="${tx('split.collapse.' + last)}">${tri(rows ? 'down' : 'right')}</button>`;
    bar.append(ctl);
    [toStart, , toEnd] = $$('button', ctl);
    /* Too short a bar for three targets: only the reset dot shows */
    new ResizeObserver(() => {
      const len = rows ? bar.clientWidth : bar.clientHeight, need = isTouch() ? 3 * 10 + 68 + 16 : 3 * 10 + 16;
      ctl.classList.toggle('short', len < need);
    }).observe(bar);
    ctl.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
      if (b.dataset.to === 'reset') userReset();
      else { const name = b.dataset.to === 'first' ? first : last; fold = b.dataset.to; paint(); keep(); tell('collapse', name, tx('split.collapsed.' + name)); }
    });
    ctl.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  let size = null, fold = null, offNow = false, hid = null, filled = null;
  const aria = () => {
    bar.setAttribute('aria-valuemin', lo());
    if (hi() < Infinity) bar.setAttribute('aria-valuemax', hi()); else bar.removeAttribute('aria-valuemax');
    bar.setAttribute('aria-valuenow', size ?? inUnit(measure()));
  };
  const paint = () => {
    offNow = !!o.off?.();
    const shownFold = offNow ? null : fold;           /* A phone layout has no collapsed pane */
    if (o.set) o.set(size, shownFold); else pane.style[dim] = size == null ? '' : size + o.unit;
    /* Only what the fold hid comes back: a pane the page hides itself stays the page's */
    const gone = shownFold && paneAt(shownFold), filler = shownFold && paneAt(shownFold === 'first' ? 'last' : 'first');
    if (hid && hid !== gone) hid.hidden = false;
    filled?.classList.remove('split-fill');
    if (gone) gone.hidden = true;
    filler?.classList.add('split-fill');
    hid = gone || null; filled = filler || null;
    aria();
    toStart?.setAttribute('aria-disabled', fold === 'first'); toEnd?.setAttribute('aria-disabled', fold === 'last');
  };
  const persist = () => {
    if (o.save) { o.save(size, fold); return; }
    const k = key(); if (k) { store(k, size); store(k + '.fold', fold); }
  };
  const keep = () => { persist(); o.onChange?.(size, fold); };
  const tell = (action, name, message) => fire(bar, 'ayni:split', { action, pane: name, message });
  const setSize = (v) => { size = clamp(v); fold = null; paint(); };
  const read = () => {
    const k = key(); if (!k) return {};
    const n = parseFloat(load(k)), f = load(k + '.fold');
    return { size: n >= lo() && n <= hi() ? n : null, fold: f === 'first' || f === 'last' ? f : null };
  };

  let resetAt = 0;
  function userReset() { resetAt = Date.now(); fold = null; size = o.def ?? null; paint(); keep(); tell('reset', null, tx('split.wasReset')); }

  let lastTap = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || o.off?.() || e.target.closest('.split-ctl button')) return;
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch {}
    const from = rows ? e.clientY : e.clientX, start = measure();
    let moved = false;
    document.documentElement.classList.add('ayni-dragging'); bar.classList.add('dragging');
    const move = (ev) => {
      const d = (rows ? ev.clientY : ev.clientX) - from;
      if (!moved && Math.abs(d) < 2) return;
      moved = true; setSize(inUnit(start + d * sign));
    };
    const end = () => {
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', end); bar.removeEventListener('pointercancel', end);
      document.documentElement.classList.remove('ayni-dragging'); bar.classList.remove('dragging');
      if (moved) { keep(); return; }
      if (e.pointerType === 'mouse') return;
      /* A double tap resets too: a finger on a bar that takes every touch may never give a dblclick */
      const now = Date.now(); if (now - lastTap < DBL_MS) { lastTap = 0; userReset(); } else lastTap = now;
    };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
  });
  bar.addEventListener('dblclick', () => { if (!o.off?.() && Date.now() - resetAt > 500) userReset(); });
  bar.addEventListener('keydown', (e) => {
    if (o.off?.()) return;
    if (e.key === 'Enter') {
      if (o.glyphs === false) return;                  /* The view has its own button for that */
      e.preventDefault();
      const back = fold === 'first'; fold = back ? null : 'first'; paint(); keep();
      tell(back ? 'restore' : 'collapse', first, tx(back ? 'split.restored' : 'split.collapsed')); return;
    }
    const step = pct ? 5 : 20, now = size ?? inUnit(measure());
    const toward = rows ? { ArrowUp: -1, ArrowDown: 1 }[e.key] : { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    let v;
    if (toward) v = now + toward * sign * step;
    else if (e.key === 'Home' || e.key === 'End') {
      const small = (e.key === 'Home') !== lastSide;    /* Home takes the bar to the start of the row */
      v = small ? lo() : Math.min(hi(), pct ? 100 : whole() - lo());
    } else return;
    e.preventDefault(); setSize(v); keep();
  });

  if (o.off) addEventListener('resize', () => { if (!!o.off() !== offNow) paint(); });

  const reload = () => { const s = read(); size = s.size ?? o.def ?? null; fold = s.fold ?? null; paint(); };
  const api = {
    get orientation() { return rows ? 'rows' : 'columns'; },
    get size() { return size; },
    set size(v) { if (v == null) { size = null; paint(); } else setSize(v); persist(); },
    get defaultSize() { return o.def ?? null; },
    set defaultSize(v) { o.def = v; },
    get collapsed() { return fold; },
    collapse(which) { fold = which; paint(); persist(); },
    restore() { fold = null; paint(); persist(); },
    reset() { fold = null; size = o.def ?? null; paint(); persist(); },
    reload,
  };
  barsOf.set(bar, { api, o });

  const s = read();
  size = s.size ?? o.size ?? null; fold = s.fold ?? o.collapsed ?? null;
  /* Nothing saved or asked for: the page's CSS keeps the size */
  if (size != null || fold) paint(); else { offNow = !!o.off?.(); aria(); }
  return api;
};

/* The panes the bar owns: .split > .pane + .splitter + .pane, in percent */
const initSplit = (split, opts = {}) => {
  const bar = $(':scope > .splitter', split), [a, b] = $$(':scope > .pane', split);
  const def = +(opts.def ?? split.dataset.default ?? 35);
  return initBar(bar, { unit: '%', rows: split.classList.contains('rows'), def, size: def, pane: a, other: b,
    set: (v) => split.style.setProperty('--split', (v ?? def) + '%'), ...opts });
};

const splitter = (el, opts = {}) => {
  if (typeof el === 'string') el = $(el);
  if (!el) return null;
  const owned = el.classList.contains('split');
  const bar = owned ? $(':scope > .splitter', el) : el;
  const have = barsOf.get(bar);
  if (!have) return owned ? initSplit(el, opts) : initBar(bar, { unit: 'px', ...opts });
  Object.assign(have.o, opts);
  if ('key' in opts) have.api.reload();
  return have.api;
};

/* ---------- More fields: the line that folds the rarely used half of a long form away ---------- */
const moreOf = new WeakMap();

const initMore = (btn, o = {}) => {
  if (!btn.children.length) btn.innerHTML = '<span class="more-pill"><span class="more-chevron">\u203a</span><span class="more-label"></span></span><span class="more-line"></span>';
  const label = $('.more-label', btn);
  const set = (on) => {
    btn.setAttribute('aria-expanded', on);
    const target = document.getElementById(btn.getAttribute('aria-controls')); if (target) target.hidden = !on;
    if (label) label.textContent = on ? o.less ?? tx('more.hide') : o.more ?? tx('more.show');
  };
  const api = { get open() { return btn.getAttribute('aria-expanded') === 'true'; }, set };
  btn.addEventListener('click', () => { const on = !api.open; set(on); fire(btn, 'ayni:more', { open: on }); o.onToggle?.(on); });
  moreOf.set(btn, { api, o });
  set(api.open);
  return api;
};

const moreFields = (el, opts = {}) => {
  if (typeof el === 'string') el = $(el);
  if (!el) return null;
  el.classList.add('more-toggle');
  const have = moreOf.get(el);
  if (!have) return initMore(el, opts);
  Object.assign(have.o, opts); have.api.set(have.api.open);
  return have.api;
};

/* A class named .split with no bar of its own is not ours */
const init = (root) => {
  const among = (sel) => [...(root.matches?.(sel) ? [root] : []), ...$$(sel, root)];
  among('[role="tablist"]').forEach((l) => { if (!tabsOf.has(l)) initTabs(l); });
  among('.split:has(> .splitter)').forEach((s) => { if (!barsOf.has($(':scope > .splitter', s))) initSplit(s); });
  among('button.more-toggle[aria-controls]').forEach((b) => { if (!moreOf.has(b)) initMore(b); });
};

Object.assign(Ayni, { status, tabs, splitter, moreFields });
Ayni.core.family({ init });
})();
