/* Ayni library 0.2.0, lists family: pick lists (list box), item lists that pick like a file manager (Ayni.list, with
   the picked items' group in the title row), drag and drop onto rows (Ayni.dropZone), the tree view (editable, or
   navigation beside a list) and Move to… (Ayni.pickNode). Shared with the list picker: type-ahead (Ayni.makeTypeAhead).
   Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-menus.js (menus, long tap, fitBar) and
   ayni-dialogs.js (Move to…):
     <script src="ayni-menus.js" defer></script>
     <script src="ayni-dialogs.js" defer></script>
     <script src="ayni-lists.js" defer></script>
   The look is in ayni-lists.css; the rules are chapters 8 (lists) and 16 (tree view) of the guidelines. */
(() => {
'use strict';
const { $, $$, isMac, icon, setIcon, esc } = Ayni;
const { fire, wired, once, each, tx, txf, iconName, isRO, isTouch, retip, fold } = Ayni.core;
const { initMenu, initToolbar, contextMenu, iconHtml } = Ayni.core.menus;

/* ---------- Lists: shared type-ahead and multi-selection ---------- */
/* Shared type-ahead (lists, the drop-down list and the tree): letters typed within 500 ms build one search ("me" reaches México),
   folded as in search (Ayni.fold, ayni-base.js); after a pause a new search starts; repeating one letter cycles through its items */
const makeTypeAhead = (textOf = (el) => el.textContent.trim()) => {
  let buf = '', timer;
  return {
    busy: () => buf !== '',
    find(key, items, current) {
      if (key.length !== 1 || (key === ' ' && !buf)) return null;
      clearTimeout(timer); buf += fold(key); timer = setTimeout(() => { buf = ''; }, 500);
      const same = [...buf].every((c) => c === buf[0]), q = same ? buf[0] : buf, cur = items.indexOf(current);
      const from = same ? cur + 1 : Math.max(cur, 0);
      return [...items.slice(from), ...items.slice(0, from)].find((o) => fold(textOf(o)).startsWith(q)) || null;
    },
  };
};
const plainKey = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
/* Alt+N makes a new item (Mac keyboards have no Insert key) */
const isNewKey = (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyN' || e.key?.toLowerCase() === 'n');

/* Shared multi-selection helper (lists and the tree): Shift+click and Shift+arrows select a range from the
   anchor, Ctrl+A (Cmd+A on Mac) selects all, Page Up / Page Down jump one visible page */
const multiSelect = ({ box, items, set, done }) => ({
  range(a, b) { const lo = Math.min(a, b), hi = Math.max(a, b); items().forEach((o, j) => set(o, j >= lo && j <= hi)); done(); },
  all() { items().forEach((o) => set(o, true)); done(); },
  page(from, dir) {
    const its = items(), top = its[from].offsetTop; let i = from;
    while (its[i + dir] && Math.abs(its[i + dir].offsetTop - top) < box.clientHeight - its[from].offsetHeight) i += dir;
    return i === from ? Math.max(0, Math.min(its.length - 1, from + dir)) : i;
  },
  isSelectAll: (e) => e.key.toLowerCase() === 'a' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey,
});

/* List box (class "lb"): fires ayni:change with { selected: [texts] } whenever the selection changes */
const initListbox = (lb) => {
  const multi = lb.getAttribute('aria-multiselectable') === 'true';
  const opts = $$('[role="option"]', lb);
  opts.forEach((o, i) => { o.id = lb.id + '-o' + i; if (!o.hasAttribute('aria-selected')) o.setAttribute('aria-selected', 'false'); });
  let active = Math.max(0, opts.findIndex((o) => o.getAttribute('aria-selected') === 'true')), anchor = active;
  const report = () => fire(lb, 'ayni:change', { selected: opts.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent.trim()) });
  const setActive = (i) => {
    active = Math.max(0, Math.min(i, opts.length - 1));
    opts.forEach((o, j) => o.classList.toggle('active', j === active && document.activeElement === lb));
    lb.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
    if (!multi) { opts.forEach((o, j) => o.setAttribute('aria-selected', j === active)); report(); }
  };
  const toggle = (i) => { const o = opts[i]; o.setAttribute('aria-selected', o.getAttribute('aria-selected') !== 'true'); report(); };
  const ta = makeTypeAhead();
  const ms = multiSelect({ box: lb, items: () => opts, set: (o, on) => o.setAttribute('aria-selected', on), done: report });
  /* Disabled or read-only: the focus may still walk the items, nothing changes */
  const off = () => lb.getAttribute('aria-disabled') === 'true' || isRO(lb);
  lb.addEventListener('focus', () => setActive(active));
  lb.addEventListener('blur', () => opts.forEach((o) => o.classList.remove('active')));
  lb.addEventListener('mousedown', (e) => {
    const i = opts.indexOf(e.target.closest('[role="option"]')); if (i < 0 || off()) return;
    e.preventDefault(); lb.focus();
    if (multi && e.shiftKey) ms.range(anchor, i);
    else if (multi) { toggle(i); anchor = i; }
    setActive(i);
  });
  lb.addEventListener('keydown', (e) => {
    if (off() && (!multi || e.key === ' ' || ms.isSelectAll(e) || e.shiftKey)) return;
    if (multi && ms.isSelectAll(e)) { e.preventDefault(); ms.all(); return; }
    const n = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: opts.length - 1,
      PageDown: ms.page(active, 1), PageUp: ms.page(active, -1) }[e.key];
    if (n !== undefined) {
      e.preventDefault(); setActive(n);
      if (multi && e.shiftKey) ms.range(anchor, active); else anchor = active;
      return;
    }
    if (multi && e.key === ' ' && !ta.busy()) { e.preventDefault(); toggle(active); anchor = active; return; }
    if (plainKey(e)) { const hit = ta.find(e.key, opts, opts[active]); if (hit) { e.preventDefault(); setActive(opts.indexOf(hit)); anchor = active; } }
  });
};


/* ---------- Keys: "Ctrl+Shift+X" against a keydown (Ctrl is ⌘ on a Mac) ---------- */
const KEY_NAMES = { del: 'Delete', delete: 'Delete', enter: 'Enter', esc: 'Escape', escape: 'Escape', space: ' ', tab: 'Tab',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', backspace: 'Backspace' };
const parseKey = (spec) => {
  const parts = String(spec).split('+'), k = { ctrl: false, shift: false, alt: false, key: '' };
  parts.forEach((p, i) => {
    const low = p.toLowerCase();
    if (i < parts.length - 1 || (parts.length > 1 && !p)) {
      if (low === 'ctrl' || low === 'cmd') k.ctrl = true; else if (low === 'shift') k.shift = true; else if (low === 'alt') k.alt = true;
      return;
    }
    k.key = KEY_NAMES[low] || (p.length === 1 ? p.toLowerCase() : p);
  });
  return k;
};
/* e.key is what the keyboard LAYOUT types: Ctrl+C on a Cyrillic keyboard reads "с", Mac's ⌥N a dead "˜". With Ctrl or
   Alt held and no Latin letter, the key's place (e.code "KeyC") names it; a Latin letter keeps e.key (AZERTY's A) */
const keyOf = (e) => {
  const key = e.key?.length === 1 ? e.key.toLowerCase() : e.key;
  if ((e.ctrlKey || e.metaKey || e.altKey) && !/^[a-z]$/.test(key) && /^Key[A-Z]$/.test(e.code || '')) return e.code.charAt(3).toLowerCase();
  return key;
};
/* Ayni.keyMatches('Ctrl+C', e), or an array of specs: the same spelling as Ayni.keyLabel. A letter's Shift is part of it */
const keyMatches = (spec, e) => (Array.isArray(spec) ? spec : [spec]).some((s) => {
  const k = parseKey(s);
  if ((isMac ? e.metaKey : e.ctrlKey) !== k.ctrl || e.altKey !== k.alt || (isMac ? e.ctrlKey : e.metaKey)) return false;
  return e.shiftKey === k.shift && keyOf(e) === k.key;
});
const inTextField = (el) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
/* Something owns the screen (a dialog, or a viewer marked aria-modal): the lists behind it take no keys */
const blocked = () => !!$('dialog[open]') || $$('[aria-modal="true"]:not(dialog)').some((el) => el.checkVisibility());
const menuOpen = () => !!$('.panel.menu:popover-open');
const closeMenus = () => $$('.panel.menu:popover-open').forEach((m) => m.hidePopover());
/* Was something modal open when this Escape was pressed? Read before any other listener: a dialog that shuts on Esc
   must not let the same key also clear the picks */
let escHadDialog = false;
/* What the last press was made with: a mouse click picks, a finger's tap opens. Read on pointerdown, before its click */
let lastPointer = 'mouse';
const MQ_PHONE = matchMedia('(max-width: 640px)'), MQ_HOVERLESS = matchMedia('(hover: none), (pointer: coarse)'), MQ_MOUSE = matchMedia('(hover: hover) and (pointer: fine)');
const byFinger = () => lastPointer === 'touch' || (lastPointer === 'pen' && MQ_HOVERLESS.matches);
const isPhone = () => MQ_PHONE.matches;
/* The box that scrolls an element (for Page Up / Page Down), or null for the page */
const scrollerOf = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p; } return null; };

/* ---------- Drag and drop: rows (list and tree) carry their ids; Ayni.dropZone marks and takes them ----------
   RULE: only a mouse or pen drags a list row (a draggable row fights a finger's scroll on some tablets; Move to… is the
   touch way). The browser's own drag carries the ids, so files from the computer drop on the same places.
     Ayni.dropZone(host, { sel, target: el => id, can: (ids, id, el, e) => 'inside' | 'before' | 'after' | false
                           | { zone, ok: false }, drop: (ids, id, zone, e, ok) => {}, copy })
   A place that refuses ({ ok: false }) gets no marker, but the drop still comes, so the page can say why */
const drag = { ids: null, from: null };
const clearDropMarks = (keep) => $$('.drop-in, .drop-before, .drop-after').forEach((el) => { if (el !== keep) el.classList.remove('drop-in', 'drop-before', 'drop-after'); });
const startDrag = (e, ids, text, from) => {
  drag.ids = ids; drag.from = from || null;
  closeMenus();
  e.dataTransfer.effectAllowed = 'copyMove';
  try { e.dataTransfer.setData('text/plain', text || ''); } catch {}
  try { e.dataTransfer.setData('application/x-ayni-ids', JSON.stringify(ids)); } catch {}
};
const dropZone = (host, cfg) => {
  const hit = (e) => {
    const el = e.target.closest?.(cfg.sel); if (!el || !host.contains(el)) return null;
    const id = cfg.target(el); return id == null ? null : { el, id };
  };
  const verdict = (h, e) => {
    const v = cfg.can ? cfg.can(drag.ids, h.id, h.el, e) : 'inside';
    if (!v) return null;
    return typeof v === 'string' ? { zone: v, ok: true } : { zone: v.zone || 'inside', ok: v.ok !== false };
  };
  host.addEventListener('dragover', (e) => {
    if (!drag.ids) return;
    const h = hit(e); clearDropMarks(h?.el); if (!h) return;
    const v = verdict(h, e);
    if (!v) { h.el.classList.remove('drop-in', 'drop-before', 'drop-after'); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.altKey) && cfg.copy ? 'copy' : 'move';
    h.el.classList.toggle('drop-in', v.ok && v.zone === 'inside');
    h.el.classList.toggle('drop-before', v.ok && v.zone === 'before');
    h.el.classList.toggle('drop-after', v.ok && v.zone === 'after');
  });
  host.addEventListener('dragleave', (e) => { const h = hit(e); if (h && !h.el.contains(e.relatedTarget)) h.el.classList.remove('drop-in', 'drop-before', 'drop-after'); });
  host.addEventListener('drop', (e) => {
    if (!drag.ids) return;
    const h = hit(e); if (!h) return;
    const v = verdict(h, e); if (!v) return;
    e.preventDefault(); e.stopPropagation();
    const ids = drag.ids; drag.ids = null; clearDropMarks(null);
    cfg.drop(ids, h.id, v.zone, e, v.ok);
  });
};

/* ---------- Item list: Ayni.list(element, options) ----------
   RULE (guidelines 8.4, 8.5): the main list of a view picks like a file manager. Mouse: a click picks that row alone,
   Ctrl+click adds or removes one, Shift+click a range (Ctrl+Shift+click adds it), double-click or Enter opens, a click on
   empty space clears. The tick square at the start of a row shows on hover and on picked rows; a click on it adds or
   removes. Touch: a tap opens; a long tap starts picking (ticks on every row, each tap adds or removes); Esc or the × of
   the count stops. While rows are picked the title row group (bar) shows the count with × (the number scrolls to the
   next pick), Select all / Unselect all, then every action as a button. Right-click (Shift+F10, Menu key) opens the full
   menu; on a row that is not picked it picks only that row first; on empty space it gives the area actions.
   ONE list of actions feeds the buttons, the menu and the keys:
     { id, label, icon, key, rank, group, danger, noBar, hideOff, where, when, why, run }
   label: text or fn(ids) (Star / Unstar); icon: an icon name, markup (an <svg>) or fn(ids); key: 'Del', 'F2', 'Ctrl+C', 'S' or an array
   (the first is shown); rank: 1 = the last button to leave a narrow title row (Select all is 4); group: menu section;
   noBar: menu and key only; hideOff: hidden, not disabled, when `when` says no; where(): false hides it in this view;
   when(ids): false disables it, why(ids) says why; run(ids, event) does it.
   Options: row (selector, default [data-id]), idOf, bar, actions, area (actions with nothing picked: New, Paste),
   open(id, e), preview(id, e) (a plain click), clickOpens(id, e) (a click opens instead of picking), openMiddle(id, e),
   pickable(id), count (false: no count), ticks (false: none), grid() (rows flow as cards: arrows by place), drag
   ({ text(ids), can(id) }), tree (the navigation tree beside it), main (true: the view's main list, whose keys work
   while the focus is on the title row's buttons too), active() (false: not now, a sub-view), onSelect(ids),
   contextmenu (false: none). The page never redraws the list on a pick: the list paints aria-selected in place */
/* The tick square of a row, for a page that draws it in its own place in the row (else the list puts it first) */
const tickHtml = () => `<button type="button" class="pick-tick" data-tick tabindex="-1" data-tip="${tx('pick')}" aria-label="${tx('pick')}">${icon('check')}</button>`;
const list = (el, cfg = {}) => {
  const box = typeof el === 'string' ? $(el) : el;
  const rowSel = cfg.row || '[data-id]', idOf = cfg.idOf || ((r) => r.dataset.id);
  const bar = cfg.bar ? (typeof cfg.bar === 'string' ? $(cfg.bar) : cfg.bar) : null;
  let actions = cfg.actions || [];
  let sel = [], anchor = null, cursor = null, picking = false;

  const rows = () => $$(rowSel, box).filter((r) => !cfg.pickable || cfg.pickable(idOf(r)));
  const rowOf = (id) => rows().find((r) => idOf(r) === id) || null;
  const idsShown = () => rows().map(idOf);

  /* ---- Picks ---- */
  const has = (id) => sel.includes(id);
  const changed = () => { if (!sel.length && picking) picking = false; paint(); drawBar(); cfg.onSelect?.(sel.slice()); };
  const set = (ids, keepAnchor) => {
    sel = (ids || []).filter((id, i, a) => id != null && a.indexOf(id) === i);
    if (!keepAnchor) anchor = sel.length ? sel.at(-1) : null;
    if (sel.length) cursor = sel.at(-1);
    changed();
  };
  const toggle = (id) => { if (has(id)) sel.splice(sel.indexOf(id), 1); else sel.push(id); anchor = cursor = id; changed(); };
  const range = (to, add) => {
    const all = idsShown(); let a = all.indexOf(anchor != null ? anchor : to); const b = all.indexOf(to);
    if (a < 0) a = b;
    const span = all.slice(Math.min(a, b), Math.max(a, b) + 1);
    sel = add ? sel.concat(span.filter((id) => !has(id))) : span;
    cursor = to; changed();
  };
  const clear = () => {
    picking = false;
    if (!sel.length) { paint(); drawBar(); return; }
    sel = []; anchor = null; changed();
  };
  /* Every row on screen picked: Select all turns into Unselect all */
  const allPicked = () => { const shown = idsShown(); return shown.length > 0 && shown.every(has); };
  const selectAll = () => { sel = idsShown(); if (byFinger() && isPhone()) picking = true; changed(); };
  /* The rows changed (a redraw): forget picks that are gone, put the ticks back */
  const refresh = () => {
    const shown = idsShown(), before = sel.length;
    sel = sel.filter((id) => shown.includes(id));
    if (cursor != null && !shown.includes(cursor)) cursor = null;
    if (sel.length !== before) changed(); else { paint(); drawBar(); }
    if (seekRows != null && rows().length !== seekRows) { seekRows = null; jump(false); }
  };

  /* ---- Finding the picks: jump(false) shows the first one, jump(true) the next; the row flashes once ---- */
  let lastJump = null;
  const jump = (next) => {
    const picked = rows().filter((r) => has(idOf(r))); if (!picked.length) return;
    const ids = picked.map(idOf), r = picked[next ? (ids.indexOf(lastJump) + 1) % ids.length : 0];
    lastJump = cursor = idOf(r); paint();
    r.scrollIntoView({ block: 'center', inline: 'nearest' });
    r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash');
    setTimeout(() => r.classList.remove('flash'), 1300);
  };
  /* A search closed: the whole list comes back (at once, or when the server answers); then the first pick shows */
  let seekRows = null;
  document.addEventListener('ayni:searchclose', () => {
    if (!sel.length || !box.getClientRects().length) return;
    seekRows = rows().length;
    setTimeout(() => { if (seekRows != null && rows().length !== seekRows) { seekRows = null; jump(false); } }, 0);
    setTimeout(() => { seekRows = null; }, 4000);
  });

  /* ---- Paint ---- */
  let painting = false;
  const paint = () => {
    painting = true;
    box.classList.toggle('picking', picking); box.classList.add('item-list');
    box.classList.toggle('ticks-shown', !!cfg.grid?.() && !Ayni.frame.windowed);     // icons: no long tap needed to find the ticks
    rows().forEach((r) => {
      const id = idOf(r), on = has(id);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
      r.classList.toggle('active', id === cursor);
      if (!r.hasAttribute('tabindex')) r.tabIndex = -1;
      if (cfg.ticks !== false && !$(':scope > .pick-tick, :scope > * > .pick-tick', r)) r.insertAdjacentHTML('afterbegin', tickHtml());
      if (cfg.drag) r.draggable = MQ_MOUSE.matches && (!cfg.drag.can || cfg.drag.can(id));
    });
    painting = false;
  };
  /* A redraw of the list by the page puts the ticks and states back on its own */
  /* Only rows and ticks count: a tile swapping its icon for a thumbnail would otherwise lay out the whole list, once per tile */
  let pending = false;
  const rowChange = (n) => n.nodeType === 1 && (n.matches(`${rowSel}, .pick-tick`) || !!n.querySelector(`${rowSel}, .pick-tick`));
  new MutationObserver((recs) => {
    if (painting || pending || !recs.some((m) => [...m.addedNodes, ...m.removedNodes].some(rowChange))) return;
    pending = true; Promise.resolve().then(() => { pending = false; refresh(); });
  }).observe(box, { childList: true, subtree: true });

  /* ---- Actions ---- */
  const here = (a) => !a.where || a.where();
  const enabled = (a, ids) => !!ids.length && here(a) && (!a.when || a.when(ids));
  const labelOf = (a, ids) => (typeof a.label === 'function' ? a.label(ids) : a.label);
  const iconOf = (a, ids) => (typeof a.icon === 'function' ? a.icon(ids) : a.icon);
  const run = (a, ids, e) => { if (enabled(a, ids)) a.run(ids.slice(), e); };
  const actionItems = (ids) => {
    const out = []; let g = null;
    actions.filter(here).slice().sort((a, b) => (a.group || 0) - (b.group || 0)).forEach((a) => {
      if (g !== null && (a.group || 0) !== g) out.push({ sep: true });
      g = a.group || 0;
      out.push({ id: a.id, label: labelOf(a, ids), icon: iconOf(a, ids), key: a.key, danger: a.danger,
        disabled: !enabled(a, ids), why: a.why ? a.why(ids) : '', run: (e) => run(a, ids, e) });
    });
    return out;
  };
  const areaItems = () => {
    const out = (cfg.area || []).filter(here).map((a) => ({ id: a.id, label: labelOf(a, []), icon: iconOf(a, []), key: a.key,
      disabled: a.when ? !a.when([]) : false, run: (e) => { if (!a.when || a.when([])) a.run([], e); } }));
    if (idsShown().length) { if (out.length) out.push({ sep: true }); out.push({ id: 'selectAll', label: tx('selectAll'), icon: 'check-all', key: 'Ctrl+A', run: selectAll }); }
    return out;
  };
  /* The menu for the picks (or for empty space), at a point */
  const openMenu = (x, y, opts = {}) => Ayni.menuAt(sel.length ? actionItems(sel.slice()) : areaItems(), { x, y, keyboard: opts.keyboard });

  /* ---- The picked group in the title row ---- */
  const btn = (attrs, tip, label, inner) => `<button type="button" class="btn" ${attrs} data-tip="${esc(tip)}" aria-label="${esc(label)}">${inner}</button>`;
  function drawBar() {
    if (!bar) return;
    const n = sel.length, head = bar.closest('.topbar, .header, header') || bar.parentNode;
    bar.closest('[role="toolbar"], .topbar, .header, header')?.classList.toggle('has-selection', n > 0);
    bar.classList.add('pick-group');
    const fitter = Ayni.fitBar(head);
    if (!n) { bar.hidden = true; bar.innerHTML = ''; fitter?.fit(); return; }
    const ids = sel.slice(), all = allPicked(), allKey = all ? 'unselectAll' : 'selectAll';
    let html = cfg.count === false ? '' : `<span class="pick-count">${btn('data-pick="clear"', `${tx('clearSel')} (${Ayni.keyLabel('Esc')})`, tx('clearSel'), icon('close'))}${btn('data-pick="jump"', tx('showSel'), tx('showSel'), n)}</span>`;
    html += btn('data-pick="all" data-act="all" data-rank="4"', `${tx(allKey)} (${Ayni.keyLabel(all ? 'Esc' : 'Ctrl+A')})`, tx(allKey), icon('check-all'));
    let g = null;
    actions.map((a, i) => ({ a, i }))
      .filter(({ a }) => a.id !== 'open' && !a.noBar && here(a) && !(a.hideOff && !enabled(a, ids)))
      .sort((x, y) => (x.a.group || 0) - (y.a.group || 0) || x.i - y.i)
      .forEach(({ a, i }) => {
        const l = labelOf(a, ids), gap = g !== null && (a.group || 0) !== g; g = a.group || 0;
        html += `<button type="button" class="btn${a.danger ? ' danger' : ''}${gap ? ' pick-gap' : ''}" data-pick-act="${esc(a.id)}" data-rank="${a.rank || 40 + i}" data-group="${g}"` +
          ` data-tip="${esc(l + (a.key ? ` (${Ayni.keyLabel(a.key)})` : ''))}" aria-label="${esc(l)}"${enabled(a, ids) ? '' : ' aria-disabled="true"'}>${iconHtml(iconOf(a, ids) || '')}</button>`;
      });
    bar.innerHTML = html; bar.hidden = false;
    fitter?.fit();
  }
  /* More's row for a picked-group button that did not fit (Ayni.fitBar asks the group) */
  if (bar) {
    bar.ayniMenuRow = (b) => { const id = b.dataset.pickAct; return id ? actionItems(sel.slice()).find((it) => it.id === id) || null : null; };
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled || b.ariaDisabled === 'true') return;
      const p = b.dataset.pick;
      if (p === 'clear') clear();
      else if (p === 'jump') jump(true);
      else if (p === 'all') { if (allPicked()) clear(); else selectAll(); }
      else if (b.dataset.pickAct) { const a = actions.find((x) => x.id === b.dataset.pickAct); if (a) run(a, sel.slice(), e); }
    });
  }

  /* ---- Pointer ---- */
  const off = () => !!(cfg.active && !cfg.active());
  const rowFrom = (e) => {
    if (off()) return null;
    const r = e.target.closest?.(rowSel); if (!r || !box.contains(r)) return null;
    return cfg.pickable && !cfg.pickable(idOf(r)) ? null : r;
  };
  /* A button, link or field inside a row does its own job (a tag, a star, a play button): the list leaves it alone */
  const ownControl = (e, r) => { const c = e.target.closest('button, a[href], input, select, textarea, label, [data-no-pick]'); return !!c && r.contains(c) && c !== r && !c.hasAttribute('data-tick'); };
  box.addEventListener('mousedown', (e) => {
    /* The second press of a double-click, or a Shift+click, must not start selecting text */
    if ((e.detail > 1 || e.shiftKey) && rowFrom(e)) e.preventDefault();
  });
  box.addEventListener('click', (e) => {
    if (off()) return;
    const r = rowFrom(e);
    if (!r) {
      /* Empty space, with a mouse, clears (a finger's stray tap between rows does nothing) */
      if (!byFinger() && box.contains(e.target) && !e.target.closest('button, a, input, select, textarea, label') && sel.length) clear();
      return;
    }
    const id = idOf(r);
    if (e.target.closest('[data-tick]')) { e.preventDefault(); if (byFinger()) picking = true; toggle(id); return; }
    if (ownControl(e, r)) return;
    if (byFinger()) {
      if (picking) { toggle(id); return; }
      if (sel.length) { sel = []; anchor = null; changed(); }
      cursor = id; cfg.open?.(id, e); return;
    }
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey) range(id, mod);
    else if (mod) toggle(id);
    else if (cfg.clickOpens?.(id, e)) { if (sel.length) { sel = []; changed(); } cursor = anchor = id; cfg.open?.(id, e); }
    else { set([id]); cfg.preview?.(id, e); }
  });
  box.addEventListener('dblclick', (e) => {
    const r = rowFrom(e); if (!r || byFinger() || ownControl(e, r) || e.target.closest('[data-tick]')) return;
    e.preventDefault(); getSelection()?.removeAllRanges();
    cfg.open?.(idOf(r), e);
  });
  /* Middle click: open, as a link would (in a new tab) */
  box.addEventListener('auxclick', (e) => { if (e.button !== 1 || !cfg.openMiddle) return; const r = rowFrom(e); if (r) { e.preventDefault(); cfg.openMiddle(idOf(r), e); } });
  box.addEventListener('contextmenu', (e) => {
    if (cfg.contextmenu === false || off() || e.target.closest('input, textarea')) return;
    const r = rowFrom(e);
    if (byFinger() && r) { e.preventDefault(); return; }       // a finger uses the long tap
    e.preventDefault();
    if (r) { const id = idOf(r); if (!has(id)) set([id]); cursor = id; paint(); }
    else if (sel.length && !byFinger()) clear();
    openMenu(e.clientX, e.clientY);
  });
  Ayni.longTap(box, rowSel, (r) => {
    const id = idOf(r); if (cfg.pickable && !cfg.pickable(id)) return;
    picking = true; if (!has(id)) { sel.push(id); anchor = id; }
    cursor = id; changed();
  });
  if (cfg.drag) box.addEventListener('dragstart', (e) => {
    const r = rowFrom(e); if (!r) return;
    const id = idOf(r), ids = has(id) ? sel.slice() : [id];
    startDrag(e, ids, cfg.drag.text ? cfg.drag.text(ids) : '', api);
    ids.forEach((x) => rowOf(x)?.classList.add('dragged'));
  });

  /* ---- Keys ---- */
  const ours = () => {
    if (off() || blocked() || menuOpen()) return false;
    const a = document.activeElement;
    if (inTextField(a) || cfg.tree?.element.contains(a)) return false;
    /* The focus is in another list, tree or menu: its keys are its own */
    if (!box.contains(a) && a?.closest?.('.item-list, [role="listbox"], [role="tree"], [role="grid"], [role="menu"], [role="tablist"]')) return false;
    /* The view's main list also takes its keys while a title row button has the focus */
    return cfg.main ? true : box.contains(a);
  };
  const focusRow = (id, scroll) => {
    cursor = id; const r = rowOf(id); paint(); if (!r) return;
    r.focus({ preventScroll: true });
    if (scroll !== false) r.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  /* The row next to `from` in a direction; in a grid, by place on the screen. Page Up / Page Down: the furthest row
     still on the same screenful (in a grid, the one nearest the same column) */
  const neighbour = (from, key) => {
    const all = rows(); if (!all.length) return null;
    const i = from != null ? all.map(idOf).indexOf(from) : -1;
    if (key === 'Home') return idOf(all[0]);
    if (key === 'End') return idOf(all.at(-1));
    if (i < 0) return idOf(all[0]);
    if (key === 'PageDown' || key === 'PageUp') {
      const me = all[i].getBoundingClientRect(), down = key === 'PageDown', h = scrollerOf(all[i])?.clientHeight || innerHeight;
      const lim = down ? me.top + h - me.height : me.top - h + me.height;
      let best = null, bt = 0;
      all.forEach((r) => {
        const b = r.getBoundingClientRect();
        if (down ? !(b.top > me.top + 2 && b.top <= lim) : !(b.top < me.top - 2 && b.top >= lim)) return;
        const t = down ? b.top : -b.top;
        if (!best || t > bt + 2 || (Math.abs(t - bt) <= 2 && Math.abs(b.left - me.left) < Math.abs(best.getBoundingClientRect().left - me.left))) { best = r; bt = t; }
      });
      return idOf(best || all[Math.max(0, Math.min(all.length - 1, i + (down ? 1 : -1)))]);
    }
    if (!cfg.grid?.() || key === 'ArrowLeft' || key === 'ArrowRight') {
      const d = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
      return idOf(all[Math.max(0, Math.min(all.length - 1, i + d))]);
    }
    const me = all[i].getBoundingClientRect(), cx = me.left + me.width / 2, down = key === 'ArrowDown';
    let best = null, bestScore = Infinity;
    all.forEach((r) => {
      const b = r.getBoundingClientRect(), dy = down ? b.top - me.bottom : me.top - b.bottom;
      if (dy < -2) return;
      const score = dy * 1000 + Math.abs(b.left + b.width / 2 - cx);
      if (score < bestScore) { bestScore = score; best = r; }
    });
    return best ? idOf(best) : idOf(all[i]);
  };
  /* The action with this key, run on ids. True: the key was one (even when the action cannot run on them) */
  const actionByKey = (e, ids) => {
    const a = actions.find((x) => x.key && here(x) && keyMatches(x.key, e)); if (!a) return false;
    if (enabled(a, ids)) { e.preventDefault(); run(a, ids, e); }
    return true;
  };
  /* Type-ahead: only in a list whose actions use no plain letter as their key (S stars, R replies) */
  const ta = makeTypeAhead((r) => (cfg.text ? cfg.text(idOf(r)) : r.dataset.name || r.textContent.trim()));
  const specs = (a) => (Array.isArray(a.key) ? a.key : a.key ? [a.key] : []);
  const lettersRunActions = () => [...actions, ...(cfg.area || [])].some((a) => specs(a).some((s) => String(s).length === 1));
  const onKey = (e) => {
    if (e.defaultPrevented || !ours()) return;
    const mod = isMac ? e.metaKey : e.ctrlKey, k = e.key, inList = box.contains(document.activeElement);
    const onButton = !inList && document.activeElement?.closest?.('button, a');
    if (k === 'Escape') { if (escHadDialog || (!sel.length && !picking)) return; e.preventDefault(); clear(); return; }
    if (mod && !e.shiftKey && !e.altKey && keyOf(e) === 'a') { if (!idsShown().length) return; e.preventDefault(); selectAll(); return; }
    const flat = !cfg.grid?.();
    if ((k === 'ArrowLeft' && !mod && !e.altKey && !e.shiftKey && flat || k === 'Tab' && !mod && !e.altKey && !e.shiftKey) && cfg.tree && inList) { e.preventDefault(); cfg.tree.focus(); return; }
    if ((k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End' || k === 'PageDown' || k === 'PageUp' || (!flat && (k === 'ArrowLeft' || k === 'ArrowRight'))) && !e.altKey) {
      if (onButton && (k === 'Home' || k === 'End')) return;
      const to = neighbour(cursor != null ? cursor : sel.length ? sel.at(-1) : null, k); if (to == null) return;
      e.preventDefault();
      if (e.shiftKey) { if (anchor == null) anchor = cursor != null ? cursor : to; range(to, false); focusRow(to); }
      else if (mod) focusRow(to);
      else { set([to]); focusRow(to); cfg.preview?.(to, e); }
      return;
    }
    if (plainKey(e) && !lettersRunActions() && (k !== ' ' || ta.busy())) {
      const hit = ta.find(k, rows(), cursor != null ? rowOf(cursor) : null);
      if (hit) { e.preventDefault(); const to = idOf(hit); set([to]); focusRow(to); cfg.preview?.(to, e); }
      if (hit || k !== ' ') return;
    }
    if (k === ' ' && !mod && inList && cursor != null) { e.preventDefault(); toggle(cursor); return; }
    if (k === 'Enter' && !mod && !e.shiftKey && !e.altKey && (inList || !onButton)) {
      const target = cursor != null && (has(cursor) || !sel.length) ? cursor : sel.length === 1 ? sel[0] : null;
      if (target == null || !cfg.open) return;
      e.preventDefault(); cfg.open(target, e); return;
    }
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = (cursor != null && rowOf(cursor) || box).getBoundingClientRect();
      openMenu(r.left + 24, r.top + Math.min(r.height, 24), { keyboard: true }); return;
    }
    /* Enter and Space on a button are the button's own */
    if (onButton && (k === 'Enter' || k === ' ')) return;
    /* The actions' own keys work on the picks; the area's (Paste, New) with nothing picked */
    if (actionByKey(e, sel.slice())) return;
    const b = (cfg.area || []).find((x) => x.key && here(x) && keyMatches(x.key, e));
    if (b && (!b.when || b.when([]))) { e.preventDefault(); b.run([], e); }
  };
  document.addEventListener('keydown', onKey);

  const api = {
    element: box,
    ids: () => sel.slice(), has,
    set: (ids, pick) => { if (pick) picking = true; set(ids); },      // pick: touch picking on (ticks)
    clear, selectAll, toggle,
    refresh,                                                          // after the rows changed (also on its own)
    redraw: () => { paint(); drawBar(); },                            // after the page's state changed (an action's `when`)
    focus: (id) => { if (id == null) id = cursor != null ? cursor : sel[0] != null ? sel[0] : neighbour(null, 'Home'); if (id != null) focusRow(id); },
    menu: openMenu,
    picking: () => picking,
    actions: () => actions,
    setActions: (l) => { actions = l || []; drawBar(); },
    run: (id, ids) => { const a = actions.find((x) => x.id === id); if (a) run(a, ids || sel.slice()); },
    key: (e, ids) => actionByKey(e, ids),                             // a tree's keys (tree option keys: true)
    items: actionItems,                                               // the menu rows for these ids (a tree folder's menu)
  };
  if (cfg.tree) cfg.tree.peer = api;
  refresh();
  return api;
};

/* ---------- Tree view ---------- */
/* RULE (Frasquito, 2026-10-25, points T1-T12 of the tree proposal):
   - A tree only browses unless the page switches editing on, one feature at a time: data-edit="move insert delete
     rename hide". data-lock on an item stops moving, deleting and renaming it; aria-readonly on the tree stops everything.
   - Optional root: one top item with data-root. It opens and closes, but is never moved, deleted or hidden.
   - Any item can hold children, except the ones marked data-leaf (a drop or insert on a leaf goes after it).
   - data-hidden items are not shown and the keyboard skips them. With data-show-hidden on the tree they show muted and
     in italics, and work as usual.
   - Selection like the lists: single by default (it follows the focus), aria-multiselectable for the check squares,
     Shift ranges and Ctrl+A. Type-ahead, Page Up/Down, * opens every folder at the same level. A folder opens and
     closes with its triangle, a double-click, Enter, or Right and Left; a double-click or Enter on a leaf fires ayni:open.
   - Moving: drag (a line between rows means before/after, an outlined row means inside; 0.7 s over a closed folder
     opens it; Esc cancels; dragging only moves). Ctrl+Shift+arrows (⌘ on Mac) move one step; Ctrl+X / C / V cut or
     copy and paste. On touch, hold until the ring is full: lift for the pop-up menu, or move to drag.
   - Insert (Alt+N, menu, toolbar) puts a new item inside the focused folder or after the focused leaf and starts
     renaming it; Esc removes it. Delete has no confirmation: an Undo notification. F2 renames in place; an empty name,
     or with data-unique a name a sibling already has, shows the usual red "!".
   - data-lazy on an item loads its children the first time it opens: ayni:load with { item, done(items), fail(text) }.
   Every change fires a cancelable event first (ayni:move, ayni:insert, ayni:delete, ayni:rename, ayni:hide); calling
   preventDefault() stops it. Ayni.tree(el, { root, items }) builds a tree from data and returns its controller. */
const ask = (el, type, detail) => el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, cancelable: true }));
const TW = () => icon('chev-right', 'tw');
const trees = new WeakMap();
let treeClip = null, treeMenuOwner = null, treeMenus = 0; // Cut / Copy keep { tree, items, cut } here until Paste
const nameOf = (it) => ($(':scope > .ti > .tn', it) || $(':scope > .ti', it)).textContent.trim();
/* One tree item from data: { name, id, icon (false for none), leaf, hidden, lock, disabled, open, lazy, root, children } */
const treeItem = (d, icons = true) => {
  const name = d.icon ?? (icons ? (d.leaf ? 'file' : 'folder') : false);
  const li = document.createElement('li'), ic = name ? icon(name) : '';
  li.setAttribute('role', 'treeitem');
  li.innerHTML = `<div class="ti">${TW()}${ic}<span class="tn"></span></div>`;
  $('.tn', li).textContent = d.name;
  if (d.id != null) li.dataset.id = d.id;
  [['leaf', 'data-leaf'], ['hidden', 'data-hidden'], ['lock', 'data-lock'], ['lazy', 'data-lazy'], ['root', 'data-root']].forEach(([k, a]) => d[k] && li.setAttribute(a, ''));
  if (d.disabled) li.setAttribute('aria-disabled', 'true');
  if (d.children?.length) { const g = document.createElement('ul'); g.setAttribute('role', 'group'); g.append(...d.children.map((c) => treeItem(c, icons))); li.append(g); }
  if (d.children?.length || d.lazy) li.setAttribute('aria-expanded', d.open && !d.lazy ? 'true' : 'false');
  return li;
};
const treeData = (li, icons = true) => {
  const d = { name: nameOf(li) }, ic = $(':scope > .ti > .icon:not(.tw)', li), nm = ic ? iconName(ic) : false;
  if (li.dataset.id) d.id = li.dataset.id;
  if (nm !== (icons ? (li.hasAttribute('data-leaf') ? 'file' : 'folder') : false)) d.icon = nm; // only when it is not the usual one
  [['leaf', 'data-leaf'], ['hidden', 'data-hidden'], ['lock', 'data-lock'], ['lazy', 'data-lazy']].forEach(([k, a]) => { if (li.hasAttribute(a)) d[k] = true; });
  if (li.getAttribute('aria-disabled') === 'true') d.disabled = true;
  if (li.getAttribute('aria-expanded') === 'true') d.open = true;
  const kids = $$(':scope > [role="group"] > [role="treeitem"]', li); if (kids.length) d.children = kids.map((k) => treeData(k, icons));
  return d;
};
/* { root, items, icons }: icons false leaves out the usual folder and file icons */
const treeNodes = ({ root, items = [], icons = true }) => root
  ? [treeItem({ open: true, ...(typeof root === 'string' ? { name: root } : root), root: true, children: items }, icons)]
  : items.map((d) => treeItem(d, icons));
/* Markup trees: the triangle and the name span are added when missing */
const normaliseItem = (li) => {
  const ti = $(':scope > .ti', li);
  if (!$(':scope > .tw', ti)) ti.insertAdjacentHTML('afterbegin', TW());
  if (!$(':scope > .tn', ti)) {
    const tn = document.createElement('span'); tn.className = 'tn';
    [...ti.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('.icon'))).forEach((n) => tn.append(n));
    tn.textContent = tn.textContent.trim(); ti.append(tn);
  }
  const g = $(':scope > [role="group"]', li);
  if (g?.children.length || li.hasAttribute('data-lazy')) { if (!li.hasAttribute('aria-expanded')) li.setAttribute('aria-expanded', 'false'); }
  else { g?.remove(); li.removeAttribute('aria-expanded'); }
};

const initTree = (tree) => {
  const multi = () => tree.getAttribute('aria-multiselectable') === 'true';
  const can = (f) => !isRO(tree) && (tree.dataset.edit || '').split(/\s+/).includes(f);
  const all = () => $$('[role="treeitem"]', tree);
  const rowOf = (it) => $(':scope > .ti', it);
  const parentOf = (it) => { const p = it.parentElement.closest('[role="treeitem"], [role="tree"]'); return p?.matches('[role="treeitem"]') ? p : null; };
  const groupOf = (p, make) => {
    if (!p) return tree;
    let g = $(':scope > [role="group"]', p);
    if (!g && make) { g = document.createElement('ul'); g.setAttribute('role', 'group'); p.append(g); }
    return g;
  };
  const kids = (p) => { const g = groupOf(p); return g ? $$(':scope > [role="treeitem"]', g) : []; };
  const putIn = (p, it, ref) => {
    const g = groupOf(p, true); g.insertBefore(it, ref?.parentElement === g ? ref : null);
    if (p && !p.hasAttribute('aria-expanded')) p.setAttribute('aria-expanded', 'true');
  };
  /* A folder whose last child went away loses its triangle */
  const tidy = (p) => { const g = p && groupOf(p); if (g && !g.children.length) { g.remove(); if (!p.hasAttribute('data-lazy')) p.removeAttribute('aria-expanded'); } };
  const rootItem = () => $(':scope > [role="treeitem"][data-root]', tree);
  const isRoot = (it) => it.hasAttribute('data-root'), locked = (it) => it.hasAttribute('data-lock');
  const off = (it) => it.getAttribute('aria-disabled') === 'true';
  const shown = (it) => rowOf(it).getClientRects().length > 0;
  const nav = () => all().filter((it) => shown(it) && !off(it));
  const pathOf = (it) => { const p = []; for (let n = it; n; n = parentOf(n)) p.unshift(nameOf(n)); return p; };
  const topMost = (its) => its.filter((x) => !its.some((y) => y !== x && y.contains(x)));
  const isOpen = (it) => it.getAttribute('aria-expanded') === 'true';
  const label = () => tree.getAttribute('aria-label') || document.getElementById(tree.getAttribute('aria-labelledby'))?.textContent.trim() || tx('tree.name');

  /* ---- Focus and selection ---- */
  let current = null, anchor = null;
  const selected = () => all().filter((x) => x.getAttribute('aria-selected') === 'true');
  const report = () => { fire(tree, 'ayni:select', { item: current, items: selected(), path: current ? pathOf(current) : [] }); syncBars(); };
  const ensureStop = () => {
    const n = nav();
    if (!current?.isConnected || !n.includes(current)) current = n.find((x) => x.getAttribute('aria-selected') === 'true') || n[0] || null;
    all().forEach((x) => (x.tabIndex = x === current ? 0 : -1));
    if (!current && tree.dataset.edit) tree.tabIndex = 0; else tree.removeAttribute('tabindex');
  };
  const setCurrent = (it, focus = true) => {
    if (!it) return;
    current = it; ensureStop();
    if (focus) it.focus({ preventScroll: true });
    rowOf(it).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncBars();
  };
  const selectOnly = (it) => {
    if (isRO(tree)) return;
    const before = selected();
    all().forEach((x) => x.setAttribute('aria-selected', x === it));
    if (before.length !== 1 || before[0] !== it) report();
  };
  const ms = multiSelect({ box: tree, items: nav, set: (o, on) => !isRO(tree) && o.setAttribute('aria-selected', on), done: report });
  const range = (to) => { const n = nav(); ms.range(Math.max(0, n.indexOf(anchor ?? to)), n.indexOf(to)); };
  /* Moves the focus; a single-selection tree selects what has the focus, Shift extends a multiple selection */
  const go = (it, e) => {
    if (!it) return;
    setCurrent(it);
    if (!multi()) selectOnly(it); else if (e?.shiftKey) range(it); else anchor = it;
  };
  const flip = (it) => { if (isRO(tree)) return; it.setAttribute('aria-selected', it.getAttribute('aria-selected') !== 'true'); anchor = it; report(); };
  /* What an action works on: the selection when the item is part of it, otherwise the item alone */
  const targetsFor = (it) => (!it ? [] : multi() && it.getAttribute('aria-selected') === 'true' ? topMost(selected()) : [it]);

  /* ---- Opening, closing and loading ---- */
  const expand = (it) => {
    if (it.getAttribute('aria-expanded') !== 'false') return;
    it.setAttribute('aria-expanded', 'true');
    if (it.hasAttribute('data-lazy') && !kids(it).length) load(it);
  };
  const collapse = (it) => {
    if (!isOpen(it)) return;
    it.setAttribute('aria-expanded', 'false');
    if (current && current !== it && it.contains(current)) go(it); else ensureStop();
  };
  const toggle = (it) => (isOpen(it) ? collapse(it) : expand(it));
  const reveal = (it) => { for (let p = parentOf(it); p; p = parentOf(p)) if (p.getAttribute('aria-expanded') === 'false') expand(p); };
  /* Children loaded on demand: a spinner row until the page calls done(items) or fail(text) */
  const load = (it) => {
    const g = groupOf(it, true); let settled = false;
    g.innerHTML = '<li role="none" class="state-msg"><span class="busy" aria-hidden="true"></span>Loading…</li>';
    it.setAttribute('aria-busy', 'true');
    const done = (items = []) => {
      if (settled) return; settled = true;
      it.removeAttribute('aria-busy'); it.removeAttribute('data-lazy');
      $(':scope > .state-msg', g)?.remove(); g.prepend(...items.map((d) => treeItem(d, !!$('.ti > .icon:not(.tw)', tree)))); tidy(it); ensureStop(); syncBars();
    };
    const fail = (text = tx('tree.loadFailed')) => {
      if (settled) return; settled = true;
      it.removeAttribute('aria-busy'); const m = $(':scope > .state-msg', g); if (m) m.textContent = text;
    };
    fire(tree, 'ayni:load', { item: it, id: it.dataset.id, path: pathOf(it), done, fail });
  };

  /* ---- Why an action cannot run now ('' when it can); the toolbar shows it in the tooltip ---- */
  const NEED = { new: 'insert', rename: 'rename', hide: 'hide', showhidden: 'hide', delete: 'delete', cut: 'move', up: 'move', down: 'move', copy: 'insert' };
  const reason = (act, its) => {
    if (isRO(tree)) return tx('tree.why.readOnly');
    if (act === 'paste') {
      const c = treeClip;
      if (!c || c.tree !== tree || !c.items.some((x) => x.isConnected)) return tx('tree.why.noClip');
      return can(c.cut ? 'move' : 'insert') ? '' : tx('tree.why.notHere');
    }
    if (!can(NEED[act])) return tx('tree.why.notHere');
    if (act === 'new' || act === 'showhidden') return '';
    if (!its.length) return tx('tree.why.pickOne');
    if ((act === 'rename' || act === 'up' || act === 'down') && its.length > 1) return tx('tree.why.onlyOne');
    if (act !== 'rename' && its.some(isRoot)) return tx('tree.why.root');
    const l = its.find(locked); if (l && act !== 'hide' && act !== 'copy') return txf('tree.why.locked', { name: nameOf(l) });
    if ((act === 'up' || act === 'down') && !stepRef(its[0], act)) return tx(act === 'up' ? 'tree.why.atTop' : 'tree.why.atBottom');
    return '';
  };
  /* Where a dragged or pasted item may go: not inside itself, not into a leaf or a disabled item, not beside the root */
  const canDrop = (its, p) => (p ? !its.some((x) => x.contains(p)) && !p.hasAttribute('data-leaf') && !off(p) : !rootItem());

  /* ---- Changes: each one asks the page first ---- */
  const moveTo = (its, p, ref) => {
    const sibs = kids(p).filter((x) => !its.includes(x)), index = ref ? sibs.indexOf(ref) : sibs.length;
    if (!ask(tree, 'ayni:move', { items: its, parent: p, index })) return false;
    const from = its.map(parentOf);
    its.forEach((it) => putIn(p, it, ref)); from.forEach(tidy);
    reveal(its[0]); setCurrent(its[0]);
    return true;
  };
  /* Ctrl+Shift+arrows: one step among the siblings, out of the folder, or into the folder above */
  const siblingsShown = (it) => kids(parentOf(it)).filter((x) => x === it || shown(x));
  const stepRef = (it, dir) => {
    const s = siblingsShown(it), i = s.indexOf(it);
    if (dir === 'up') return s[i - 1] ? { p: parentOf(it), ref: s[i - 1] } : null;
    if (dir === 'down') return s[i + 1] ? { p: parentOf(it), ref: s[i + 1].nextElementSibling } : null;
    const p = parentOf(it);
    if (dir === 'out') return p && !isRoot(p) ? { p: parentOf(p), ref: p.nextElementSibling } : null;
    const above = s[i - 1]; return above && canDrop([it], above) ? { p: above, ref: null } : null;
  };
  const step = (it, dir) => {
    if (reason('cut', [it])) return;
    const t = stepRef(it, dir); if (t) moveTo([it], t.p, t.ref);
  };
  const insertAt = (at) => {
    if (!at) return { p: rootItem(), ref: null };
    return at.hasAttribute('data-leaf') ? { p: parentOf(at), ref: at.nextElementSibling } : { p: at, ref: null };
  };
  const insertNew = (at) => {
    if (reason('new', [])) return;
    const { p, ref } = insertAt(at), icons = !!$('.ti > .icon:not(.tw)', tree);
    const it = treeItem({ name: tree.dataset.newName || tx('tree.newItem'), icon: icons ? tree.dataset.newIcon || 'folder' : false });
    if (p) expand(p);
    putIn(p, it, ref); if (p) p.setAttribute('aria-expanded', 'true');
    reveal(it); setCurrent(it); rename(it, true);
  };
  let editing = null;
  const rename = (it, isNew = false) => {
    if (editing || (!isNew && reason('rename', [it]))) return;
    const tn = $(':scope > .ti > .tn', it), old = tn.textContent;
    const inp = document.createElement('input'), err = document.createElement('span');
    Object.assign(inp, { className: 'input tree-edit', value: old, spellcheck: false, autocomplete: 'off' });
    err.className = 'error'; err.hidden = true; err.id = `ayni-tree-err-${++treeMenus}`;
    inp.setAttribute('aria-label', tx('tree.itemName')); inp.setAttribute('aria-describedby', err.id);
    tn.hidden = true; tn.after(inp, err);
    Ayni.core.errors?.init(inp); setCurrent(it, false); inp.focus(); inp.select();
    const check = () => {
      const v = inp.value.trim();
      const msg = !v ? tx('tree.typeName')
        : tree.hasAttribute('data-unique') && kids(parentOf(it)).some((x) => x !== it && fold(nameOf(x)) === fold(v)) ? txf('tree.nameUsed', { name: v }) : '';
      err.textContent = msg; err.hidden = !msg; inp.setAttribute('aria-invalid', !!msg);
      return !msg;
    };
    /* Enter or leaving the field saves; a wrong name keeps the field open with its "!"; Esc cancels (a new item goes away) */
    const finish = (save, refocus = true) => {
      if (save && !check()) { if (refocus) inp.focus(); return; }
      const v = inp.value.trim();
      Ayni.core.errors?.forget(inp);
      (inp.closest('.err-wrap') || inp).remove(); err.remove(); tn.hidden = false; editing = null;
      if (isNew) {
        tn.textContent = v || old;
        if (!save || !ask(tree, 'ayni:insert', { items: [it], parent: parentOf(it), index: kids(parentOf(it)).indexOf(it), name: v })) {
          const next = neighbour([it]), p = parentOf(it); it.remove(); tidy(p); current = null; if (next) go(next); else ensureStop();
          if (!next && refocus) tree.focus();
          return;
        }
      } else if (save && v !== old && ask(tree, 'ayni:rename', { item: it, from: old, to: v })) tn.textContent = v;
      if (refocus) setCurrent(it);
      syncBars();
    };
    editing = { it, finish };
    inp.addEventListener('input', () => { if (inp.getAttribute('aria-invalid') === 'true') check(); });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (editing?.it === it && document.activeElement !== inp) finish(true, false); }));
    ['click', 'dblclick', 'pointerdown'].forEach((t) => inp.addEventListener(t, (e) => e.stopPropagation()));
  };
  /* After a delete or hide the focus goes to the next sibling, else the previous one, else the parent */
  const neighbour = (its) => {
    const gone = (x) => its.some((y) => y.contains(x)), first = its[0], s = kids(parentOf(first)), i = s.indexOf(first);
    const ok = (x) => !gone(x) && shown(x) && !off(x);
    return s.slice(i + 1).find(ok) || s.slice(0, i).reverse().find(ok) || parentOf(first) || nav().find(ok) || null;
  };
  const del = (its) => {
    its = topMost(its); if (reason('delete', its) || !ask(tree, 'ayni:delete', { items: its })) return;
    const next = neighbour(its), spots = its.map((it) => ({ it, p: parentOf(it), next: it.nextElementSibling }));
    its.forEach((it) => it.remove()); spots.forEach((s) => tidy(s.p));
    current = null; if (next) go(next); else { ensureStop(); tree.focus(); }
    if (multi()) report();
    const what = its.length === 1 ? nameOf(its[0]) : txf('tree.nItems', { n: its.length });
    Ayni.toast('ok', txf('tree.deleted', { what }), { undo: () => restore(spots) });
  };
  const restore = (spots) => {
    const its = spots.map((s) => s.it);
    if (!ask(tree, 'ayni:insert', { items: its, undo: true })) return;
    [...spots].reverse().forEach(({ it, p, next }) => { if (!p || tree.contains(p)) putIn(p, it, next); });
    reveal(its[0]); go(its[0]);
  };
  const hide = (its, on) => {
    its = topMost(its); if (reason('hide', its) || !ask(tree, 'ayni:hide', { items: its, hidden: on })) return;
    const next = on && !tree.hasAttribute('data-show-hidden') ? neighbour(its) : null;
    its.forEach((it) => it.toggleAttribute('data-hidden', on));
    if (next) go(next); else ensureStop();
    syncBars();
  };
  const showHidden = (on) => { tree.toggleAttribute('data-show-hidden', on); fire(tree, 'ayni:showhidden', { on }); ensureStop(); syncBars(); };
  const clip = (its, cut) => {
    its = topMost(its); if (reason(cut ? 'cut' : 'copy', its)) return;
    $$('.cut').forEach((x) => x.classList.remove('cut'));
    treeClip = { tree, items: its, cut };
    if (cut) its.forEach((x) => x.classList.add('cut'));
    syncBars();
  };
  const unclip = () => { $$('.cut').forEach((x) => x.classList.remove('cut')); treeClip = null; syncBars(); };
  const paste = (at) => {
    if (reason('paste', [])) return;
    const its = treeClip.items.filter((x) => x.isConnected);
    let { p, ref } = insertAt(at);
    if (!canDrop(its, p)) return;
    while (ref && its.includes(ref)) ref = ref.nextElementSibling;
    if (treeClip.cut) { if (moveTo(its, p, ref)) unclip(); return; }
    const copies = its.map((x) => {
      const c = x.cloneNode(true);
      [c, ...$$('[role="treeitem"]', c)].forEach((y) => { y.removeAttribute('data-id'); y.removeAttribute('data-root'); y.setAttribute('aria-selected', 'false'); y.tabIndex = -1; y.classList.remove('cut', 'dragged'); });
      return c;
    });
    const sibs = kids(p), index = ref ? sibs.indexOf(ref) : sibs.length;
    if (!ask(tree, 'ayni:insert', { items: copies, parent: p, index, copy: true, from: its })) return;
    copies.forEach((c) => putIn(p, c, ref)); reveal(copies[0]); go(copies[0]);
  };
  const run = (act, at) => {
    const its = targetsFor(at);
    if (reason(act, its)) return;
    ({
      new: () => insertNew(at), rename: () => rename(its[0]), delete: () => del(its), cut: () => clip(its, true), copy: () => clip(its, false),
      paste: () => paste(at), up: () => step(at, 'up'), down: () => step(at, 'down'),
      hide: () => hide(its, !its.every((x) => x.hasAttribute('data-hidden'))), showhidden: () => showHidden(!tree.hasAttribute('data-show-hidden')),
    })[act]?.();
  };

  /* ---- Drag and drop (mouse and pen at once; touch after a long tap) ---- */
  let drag = null, justDropped = false;
  const dropAt = (x, y) => {
    const ti = document.elementFromPoint(x, y)?.closest('.ti'), it = ti?.parentElement;
    if (!it || !tree.contains(it) || drag.its.some((d) => d.contains(it))) return null;
    const r = ti.getBoundingClientRect(), f = (y - r.top) / r.height, leaf = it.hasAttribute('data-leaf') || off(it);
    const zone = isRoot(it) ? 'in' : leaf ? (f < 0.5 ? 'before' : 'after') : f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'in';
    if (zone === 'in') return { p: it, ref: null, row: it, zone };
    if (zone === 'before') return { p: parentOf(it), ref: it, row: it, zone };
    const inner = isOpen(it) && kids(it).find((k) => !drag.its.includes(k));
    if (inner) return { p: it, ref: inner, row: it, zone, indent: rowOf(inner).getBoundingClientRect().left };
    let ref = it.nextElementSibling; while (ref && drag.its.includes(ref)) ref = ref.nextElementSibling;
    return { p: parentOf(it), ref, row: it, zone };
  };
  const mark = (t) => {
    $$('.drop-in', tree).forEach((x) => x.classList.remove('drop-in')); drag.line.hidden = true;
    if (!t) return;
    if (t.zone === 'in') { rowOf(t.row).classList.add('drop-in'); return; }
    const r = rowOf(t.row).getBoundingClientRect(), tr = tree.getBoundingClientRect(), left = t.indent ?? r.left;
    const y = Math.max(tr.top + 1, Math.min(tr.bottom - 1, t.zone === 'before' ? r.top : r.bottom));
    Object.assign(drag.line.style, { left: left + 'px', top: y - 1 + 'px', width: Math.max(24, tr.right - left - 6) + 'px' });
    drag.line.hidden = false;
  };
  const dragUpdate = () => {
    let t = dropAt(drag.x, drag.y); if (t && !canDrop(drag.its, t.p)) t = null;
    drag.target = t; mark(t);
    const wait = t?.zone === 'in' && t.row.getAttribute('aria-expanded') === 'false' ? t.row : null;
    if (wait !== drag.wait) { clearTimeout(drag.timer); drag.wait = wait; if (wait) drag.timer = setTimeout(() => { expand(wait); drag && dragUpdate(); }, 700); }
  };
  const dragMove = (e) => {
    drag.x = e.clientX; drag.y = e.clientY;
    drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px';
    dragUpdate();
  };
  /* Near the top or bottom edge the tree scrolls by itself */
  const autoScroll = () => {
    if (!drag) return;
    const r = tree.getBoundingClientRect(), dy = drag.y < r.top + 24 ? -8 : drag.y > r.bottom - 24 ? 8 : 0;
    if (dy && drag.x > r.left && drag.x < r.right) { const before = tree.scrollTop; tree.scrollTop += dy; if (tree.scrollTop !== before) dragUpdate(); }
    drag.raf = requestAnimationFrame(autoScroll);
  };
  const dragEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endDrag(); } };
  const endDrag = () => {
    if (!drag) return;
    clearTimeout(drag.timer); cancelAnimationFrame(drag.raf);
    drag.ghost.remove(); drag.line.remove(); $$('.drop-in', tree).forEach((x) => x.classList.remove('drop-in'));
    drag.its.forEach((x) => x.classList.remove('dragged')); tree.classList.remove('dragging');
    removeEventListener('pointermove', dragMove); removeEventListener('pointerup', dragDrop); removeEventListener('pointercancel', endDrag);
    removeEventListener('keydown', dragEsc, true);
    drag = null; justDropped = true; setTimeout(() => { justDropped = false; });
  };
  const dragDrop = () => { const d = drag; endDrag(); if (d.target) moveTo(d.its, d.target.p, d.target.ref); };
  const startDrag = (it, e) => {
    if (editing || drag || off(it)) return;
    const its = multi() && it.getAttribute('aria-selected') === 'true' ? topMost(selected()) : [it];
    if (reason('cut', its)) return;
    const ghost = document.createElement('div'), line = document.createElement('div');
    ghost.className = 'tree-ghost'; ghost.textContent = its.length > 1 ? `${its.length} items` : nameOf(its[0]);
    line.className = 'tree-drop'; line.hidden = true;
    document.body.append(ghost, line);
    its.forEach((x) => x.classList.add('dragged')); tree.classList.add('dragging');
    drag = { its, ghost, line, target: null, wait: null, timer: 0, x: e.clientX, y: e.clientY };
    addEventListener('pointermove', dragMove); addEventListener('pointerup', dragDrop); addEventListener('pointercancel', endDrag);
    addEventListener('keydown', dragEsc, true);
    dragMove(e); drag.raf = requestAnimationFrame(autoScroll);
  };
  tree.addEventListener('pointerdown', (e) => {
    const ti = e.target.closest('.ti');
    if (!ti || e.button !== 0 || e.target.closest('.tw') || !(e.pointerType === 'pen' || (e.pointerType === 'mouse' && !isTouch()))) return;
    const it = ti.parentElement, sx = e.clientX, sy = e.clientY;
    const watch = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) { stop(); startDrag(it, ev); } };
    const stop = () => { removeEventListener('pointermove', watch); removeEventListener('pointerup', stop); };
    addEventListener('pointermove', watch); addEventListener('pointerup', stop);
  });
  tree.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

  /* ---- Pointer and keyboard ---- */
  tree.addEventListener('click', (e) => {
    const ti = e.target.closest('.ti'); if (justDropped || !ti) return;
    const it = ti.parentElement; if (off(it)) return;
    const tw = $(':scope > .tw', ti), folder = it.hasAttribute('aria-expanded');
    /* The triangle opens and closes; on touch the area around it counts too */
    if (folder && (e.target.closest('.tw') || (isTouch() && e.clientX <= tw.getBoundingClientRect().right + 14))) { toggle(it); setCurrent(it); return; }
    if (!multi()) go(it);
    else { if (e.shiftKey) range(it); else flip(it); setCurrent(it); }
  });
  tree.addEventListener('dblclick', (e) => {
    const ti = e.target.closest('.ti'); if (!ti || e.target.closest('.tw')) return;
    const it = ti.parentElement; if (off(it)) return;
    if (it.hasAttribute('aria-expanded')) toggle(it); else fire(tree, 'ayni:open', { item: it, path: pathOf(it) });
  });
  const ta = makeTypeAhead(nameOf);
  tree.addEventListener('keydown', (e) => {
    if (e.target.closest('.tree-edit') || drag) return;
    const it = e.target.closest('[role="treeitem"]'), k = e.key, mod = isMac ? e.metaKey : e.ctrlKey;
    if (!it) { // an empty editable tree has the focus itself
      if (isNewKey(e)) { e.preventDefault(); insertNew(null); } else if (mod && k.toLowerCase() === 'v') { e.preventDefault(); paste(null); }
      return;
    }
    if (mod && e.shiftKey && !e.altKey && k.startsWith('Arrow')) { e.preventDefault(); step(it, { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'out', ArrowRight: 'in' }[k]); return; }
    if (isNewKey(e)) { e.preventDefault(); run('new', it); return; }
    if (mod && !e.shiftKey && !e.altKey) {
      const c = k.toLowerCase(), act = { x: () => clip(targetsFor(it), true), c: () => clip(targetsFor(it), false), v: () => paste(it), a: () => multi() && ms.all() }[c];
      if (act) { e.preventDefault(); act(); }
      return;
    }
    const n = nav(), i = n.indexOf(it);
    const page = (dir) => { const rows = Math.max(1, Math.floor(tree.clientHeight / rowOf(it).offsetHeight) - 1); return n[Math.max(0, Math.min(n.length - 1, i + dir * rows))]; };
    switch (k) {
      case 'ArrowDown': go(n[i + 1], e); break;
      case 'ArrowUp': go(n[i - 1], e); break;
      case 'Home': go(n[0], e); break;
      case 'End': go(n[n.length - 1], e); break;
      case 'PageDown': go(page(1), e); break;
      case 'PageUp': go(page(-1), e); break;
      case 'ArrowRight': if (it.getAttribute('aria-expanded') === 'false') expand(it); else if (isOpen(it)) go(kids(it).find((x) => shown(x) && !off(x))); break;
      case 'ArrowLeft': if (isOpen(it)) collapse(it); else if (parentOf(it)) go(parentOf(it)); break;
      case 'Enter': if (it.hasAttribute('aria-expanded')) toggle(it); else fire(tree, 'ayni:open', { item: it, path: pathOf(it) }); break;
      case ' ': if (ta.busy()) go(ta.find(' ', n, it)); else if (multi()) flip(it); else go(it); break;
      case '*': kids(parentOf(it)).forEach((x) => !off(x) && expand(x)); break;
      case 'F2': run('rename', it); break;
      case 'Delete': run('delete', it); break;
      case 'Escape': if (treeClip?.tree === tree && treeClip.cut) unclip(); else return; break;
      default:
        if (plainKey(e)) { const hit = ta.find(k, n, it); if (hit) { e.preventDefault(); go(hit); } }
        return;
    }
    e.preventDefault();
  });
  tree.addEventListener('focusin', (e) => { const it = e.target.closest('[role="treeitem"]'); if (it && it !== current && e.target === it) setCurrent(it, false); });

  /* ---- Pop-up menu: the page's (data-menu="id") or, on an editable tree, one built here ---- */
  const own = !tree.dataset.menu && !!tree.dataset.edit;
  const menu = own ? document.createElement('div') : tree.dataset.menu && document.getElementById(tree.dataset.menu);
  let pending = null, menuFor = null;
  const fillMenu = () => {
    const allowed = (act) => (act === 'paste' ? can('move') || can('insert') : can(NEED[act]));
    const key = isMac ? '⌘' : 'Ctrl+', row = (act, ic, text, kbd) => (!allowed(act) ? ''
      : `<button role="menuitem" data-tree-act="${act}" data-act="${text}">${icon(ic)}${text}${kbd ? `<kbd>${kbd}</kbd>` : ''}</button>`);
    const its = targetsFor(menuFor), shownNow = its.length && its.every((x) => x.hasAttribute('data-hidden'));
    const groups = [
      [row('new', 'plus', tx('tree.new'), Ayni.keyLabel('Alt+N')), row('rename', 'edit', tx('tree.rename'), 'F2'), row('hide', shownNow ? 'eye' : 'eye-off', tx(shownNow ? 'tree.show' : 'tree.hide'))],
      [row('cut', 'cut', tx('cut'), key + 'X'), row('copy', 'copy', tx('copy'), key + 'C'), row('paste', 'paste', tx('paste'), key + 'V')],
      [row('up', 'arrow-up', tx('tree.moveUp'), key + '⇧↑'), row('down', 'arrow-down', tx('tree.moveDown'), key + '⇧↓')],
      [can('hide') ? `<button role="menuitemcheckbox" aria-checked="${tree.hasAttribute('data-show-hidden')}" data-tree-act="showhidden" data-act="${tx('tree.showHidden')}">${tree.hasAttribute('data-show-hidden') ? icon('check') : ''}${tx('tree.showHidden')}</button>` : ''],
      [row('delete', 'trash', tx('delete'), 'Del')],
    ].map((g) => g.join('')).filter(Boolean);
    menu.innerHTML = groups.join('<div role="separator"></div>');
  };
  if (menu) {
    if (own) {
      Object.assign(menu, { className: 'panel menu', id: `ayni-tree-menu-${++treeMenus}` });
      menu.setAttribute('popover', ''); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', txf('tree.actions', { name: label() }));
      document.body.append(menu); if (once('menu', menu)) initMenu(menu);
    }
    const target = (e) => {
      if (editing || drag) return null;
      const ti = e.target.closest('.ti'), it = ti?.parentElement;
      treeMenuOwner = tree;
      if (it) { if (off(it)) return null; pending = it; return { name: nameOf(it), back: it, at: ti }; }
      if (!tree.dataset.edit) return null;
      pending = null; return { name: label(), back: current || tree };
    };
    const keyTarget = (e) => {
      const it = e.target.closest('[role="treeitem"]');
      treeMenuOwner = tree;
      if (it) { pending = it; return { name: nameOf(it), back: it, at: rowOf(it) }; }
      if (e.target === tree && tree.dataset.edit) { pending = null; return { name: label(), back: tree }; }
      return null;
    };
    contextMenu(tree, { menu, target, keyTarget, onDrag: (f, e) => f.back.matches?.('[role="treeitem"]') && startDrag(f.back, e) });
    menu.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'open' || treeMenuOwner !== tree) return;
      menuFor = pending;
      /* The menu acts on the item it was opened on: it joins the selection, or becomes it */
      if (menuFor && menuFor.getAttribute('aria-selected') !== 'true') { if (multi() && !isRO(tree)) { all().forEach((x) => x.setAttribute('aria-selected', x === menuFor)); anchor = menuFor; report(); } else selectOnly(menuFor); }
      if (menuFor) setCurrent(menuFor, false);
      if (own) fillMenu();
      $$('[data-tree-act]', menu).forEach((b) => { if (reason(b.dataset.treeAct, targetsFor(menuFor))) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); });
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tree-act]'); if (!b || treeMenuOwner !== tree) return;
      /* After the menu has closed and given the focus back, so that a rename keeps its field focused */
      const act = b.dataset.treeAct, at = menuFor;
      menu.addEventListener('toggle', () => run(act, at), { once: true });
    });
  }

  /* ---- Toolbar: [role="toolbar"][data-tree="tree id"] with buttons data-tree-act="new | rename | hide | delete | ..." ----
     Buttons that cannot act now are disabled, and their tooltip says why */
  const bars = tree.id ? $$(`[role="toolbar"][data-tree="${tree.id}"]`) : [];
  function syncBars() {
    bars.forEach((bar) => $$('[data-tree-act]', bar).forEach((b) => {
      const act = b.dataset.treeAct, its = targetsFor(current), r = reason(act, its);
      b.dataset.baseTip ??= b.dataset.tip || b.getAttribute('aria-label');
      let base = b.dataset.baseTip;
      if (act === 'hide') {
        const show = its.length > 0 && its.every((x) => x.hasAttribute('data-hidden'));
        base = tx(show ? 'tree.show' : 'tree.hide'); b.setAttribute('aria-label', base); setIcon(b, show ? 'eye' : 'eye-off');
      }
      if (r) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      b.dataset.tip = r ? `${base}: ${r}` : base;
      retip(b);
    }));
  }
  bars.forEach((bar) => {
    if (once('toolbar', bar)) initToolbar(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tree-act]'); if (!b) return;
      run(b.dataset.treeAct, current);
      if (!editing && current?.isConnected && !document.activeElement?.closest('.toasts')) current.focus();
    });
  });
  new MutationObserver(() => syncBars()).observe(tree, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'data-hidden', 'class', 'data-lock'] });

  /* ---- Controller: Ayni.tree(el) returns it; its calls change the tree without asking the page ---- */
  const refresh = () => { all().forEach(normaliseItem); all().forEach((x) => x.hasAttribute('aria-selected') || x.setAttribute('aria-selected', 'false')); current = null; ensureStop(); syncBars(); };
  trees.set(tree, {
    element: tree, refresh,
    build: (opts) => { if (editing) editing.finish(false, false); tree.replaceChildren(...treeNodes(opts)); refresh(); },
    data: () => {
      const icons = !!$('.ti > .icon:not(.tw)', tree), r = rootItem(), out = (d) => ({ ...(icons ? {} : { icons: false }), ...d });
      if (!r) return out({ root: null, items: kids(null).map((k) => treeData(k, icons)) });
      const { children = [], ...root } = treeData(r, icons); return out({ root, items: children });
    },
    add: (parent, d, index) => { const it = treeItem(d, !!$('.ti > .icon:not(.tw)', tree) || !all().length); putIn(parent || rootItem(), it, kids(parent || rootItem())[index] || null); normaliseItem(it); ensureStop(); return it; },
    remove: (it) => { const p = parentOf(it); it.remove(); tidy(p); ensureStop(); },
    rename: (it, name) => { $(':scope > .ti > .tn', it).textContent = name; },
    move: (it, parent, index) => { const p = parentOf(it), ref = kids(parent).filter((x) => x !== it)[index] || null; putIn(parent, it, ref); tidy(p); ensureStop(); },
    hide: (it, on = true) => { it.toggleAttribute('data-hidden', on); ensureStop(); },
    showHidden, expand, collapse, reveal,
    select: (it) => { if (multi()) { it.setAttribute('aria-selected', 'true'); report(); } else selectOnly(it); setCurrent(it, false); },
    selected, path: pathOf, current: () => current,
  });
  refresh();
};
/* Ayni.tree(el, { root, items }): builds the tree from data (or wires a markup tree) and returns its controller;
   Ayni.tree(el, { nav: true, ... }) makes a navigation tree (below) */
const tree = (el, opts) => {
  if (opts?.nav) return el.hasAttribute('data-nav') && trees.get(el) ? trees.get(el) : navTree(el, opts);
  if (opts && !wired.get(el)?.has('tree')) el.replaceChildren(...treeNodes(opts));
  if (once('tree', el)) initTree(el); else if (opts) trees.get(el).build(opts);
  return trees.get(el);
};

/* ---------- Navigation tree: Ayni.tree(element, { nav: true, ... }) ----------
   RULE (guidelines 16.4): a tree that goes somewhere, beside an item list. A click, Enter or Space goes to the item and
   the tree marks it as where you are (aria-current, full Accent); the arrows only move the focus, so walking down the
   tree never loads a folder at each key. The triangle (or a double-click) opens and closes; → opens then steps in,
   ← closes then steps up; Home / End; Tab goes to the list beside it. The page keeps the data and the open folders and
   calls build() after a change; the tree draws Ayni's tree markup from it.
     items: () => [item]   item = { id, name, icon, children, count, tail: { icon, tip, on }, heading, noMenu, noDrag, tip, cls }
     isOpen(id), setOpen(id, open), current() (where you are), go(id, e), menu(id, x, y) (right-click, long tap, Menu
     key; a tree row has no ⋮), drag(id) -> ids | null, drop: { can, drop, copy } (see Ayni.dropZone), tail(id) (the
     row's end button), keys (true: the item list's keys, F2, Delete..., act on the focused folder), sheet (the side
     pane that slides in on phones), pick (true: Move to…: a click lights, a double-click or Enter confirms(id)),
     disabled(id) */
const navTree = (host, cfg) => {
  host.setAttribute('role', 'tree'); host.dataset.nav = '';
  once('tree', host);
  let kbd = null, parentOf = {}, nodeOf = {};
  const items = () => (typeof cfg.items === 'function' ? cfg.items() : cfg.items) || [];
  const rowOf = (id) => $(`[role="treeitem"][data-id="${CSS.escape(String(id))}"]`, host);
  const rowsShown = () => $$('[role="treeitem"]', host);
  const build = () => {
    const cur = cfg.current ? cfg.current() : null, html = [];
    parentOf = {}; nodeOf = {};
    (function walk(nodes, parent) {
      (nodes || []).forEach((n) => {
        nodeOf[n.id] = n; parentOf[n.id] = parent;
        const kids = n.children?.length, open = kids && cfg.isOpen(n.id), off = cfg.disabled?.(n.id);
        html.push(`<li role="treeitem" data-id="${esc(n.id)}" tabindex="${n.id === (kbd != null ? kbd : cur) ? 0 : -1}"` +
          (kids ? ` aria-expanded="${open ? 'true' : 'false'}"` : '') + (n.id === cur ? ' aria-current="true"' : '') +
          (off ? ' aria-disabled="true"' : '') + (n.heading ? ' data-heading' : '') + (n.cls ? ` class="${esc(n.cls)}"` : '') + '>' +
          `<div class="ti"${n.tip ? ` data-tip="${esc(n.tip)}"` : ''}>${TW()}${iconHtml(n.icon || 'folder')}<span class="tn">${esc(n.name)}</span>` +
          (n.count ? `<span class="count">${esc(n.count)}</span>` : '') +
          (n.tail ? `<button class="btn sm tail" type="button" data-tail aria-pressed="${n.tail.on ? 'true' : 'false'}" data-tip="${esc(n.tail.tip || '')}" aria-label="${esc(n.tail.tip || '')}">${iconHtml(n.tail.icon)}</button>` : '') +
          '</div>');
        if (open) { html.push('<ul role="group">'); walk(n.children, n.id); html.push('</ul>'); }
        html.push('</li>');
      });
    })(items(), null);
    const had = host.contains(document.activeElement);
    host.innerHTML = html.join('');
    if (MQ_MOUSE.matches && cfg.drag) $$('.ti', host).forEach((ti) => { const n = nodeOf[ti.parentElement.dataset.id]; ti.draggable = !!(n && !n.noDrag && cfg.drag(n.id)); });
    if (had) focus(kbd);
  };
  const focus = (id) => {
    if (id == null) id = kbd != null && rowOf(kbd) ? kbd : cfg.current ? cfg.current() : null;
    const el = (id != null && rowOf(id)) || $('[role="treeitem"]', host); if (!el) return;
    kbd = el.dataset.id;
    rowsShown().forEach((r) => (r.tabIndex = r === el ? 0 : -1));
    el.focus({ preventScroll: true });
    $(':scope > .ti', el).scrollIntoView({ block: 'nearest' });
  };
  const toggleOpen = (id, want) => {
    const n = nodeOf[id]; if (!n?.children?.length) return;
    const open = cfg.isOpen(id); if (want == null) want = !open; if (want === open) return;
    cfg.setOpen(id, want); build();
  };
  const choose = (id, e) => {
    if (cfg.disabled?.(id)) return;
    /* A heading ("Labels") only opens and closes */
    if (nodeOf[id]?.heading && !cfg.pick) { toggleOpen(id); focus(id); return; }
    if (cfg.pick) { kbd = id; cfg.go?.(id, e); build(); return; }
    cfg.go?.(id, e);
    if (cfg.sheet && isPhone()) closeSheet();
  };
  const rowAt = (e) => e.target.closest('.ti')?.parentElement || null;
  host.addEventListener('click', (e) => {
    const r = rowAt(e); if (!r) return;
    const id = r.dataset.id;
    if (e.target.closest('.tw')) { toggleOpen(id); kbd = id; focus(id); return; }
    if (e.target.closest('[data-tail]')) { cfg.tail?.(id); return; }
    kbd = id; choose(id, e);
  });
  host.addEventListener('dblclick', (e) => {
    const r = rowAt(e); if (!r || e.target.closest('.tw, [data-tail]')) return;
    if (cfg.pick) { if (!cfg.disabled?.(r.dataset.id)) cfg.confirm?.(r.dataset.id); return; }
    toggleOpen(r.dataset.id);
  });
  host.addEventListener('contextmenu', (e) => {
    const r = rowAt(e); if (!r || !cfg.menu || cfg.pick) return;
    e.preventDefault();
    if (byFinger()) return;                                      // the long tap does it
    if (!nodeOf[r.dataset.id]?.noMenu) cfg.menu(r.dataset.id, e.clientX, e.clientY);
  });
  if (cfg.menu && !cfg.pick) Ayni.longTap(host, '.ti', (ti, x, y) => { const id = ti.parentElement.dataset.id; if (!nodeOf[id]?.noMenu) cfg.menu(id, x, y); });
  /* A key the tree does not use itself (F2, Delete, Ctrl+C...): the item list's action with that key, on this folder */
  const actionKey = (e, id, n) => { if (cfg.keys && !cfg.pick && api.peer && !n?.noMenu) api.peer.key(e, [id]); };
  /* The keys walk the rows shown, skipping disabled ones (in Move to…: a folder into itself) */
  const off = (r) => r.getAttribute('aria-disabled') === 'true';
  const walkable = () => rowsShown().filter((r) => !off(r));
  const stepFrom = (r, dir, n = 1) => {
    const all = rowsShown(); let j = all.indexOf(r), got = null;
    while (n > 0 && all[j + dir]) { j += dir; if (!off(all[j])) { got = all[j]; n--; } }
    return got;
  };
  const perPage = (r) => { const h = $(':scope > .ti', r).offsetHeight || 30; return Math.max(1, Math.floor((scrollerOf(host)?.clientHeight || innerHeight) / h) - 1); };
  const ta = makeTypeAhead((r) => $(':scope > .ti > .tn', r).textContent.trim());
  host.addEventListener('keydown', (e) => {
    const r = e.target.closest('[role="treeitem"]'); if (!r || e.target.closest('[data-tail]')) return;
    const id = r.dataset.id, n = nodeOf[id], kids = n?.children?.length, go = (x) => x && focus(x.dataset.id);
    if (e.altKey || e.ctrlKey || e.metaKey) { actionKey(e, id, n); return; }
    const open = kids && cfg.isOpen(id);
    switch (e.key) {
      case 'ArrowDown': go(stepFrom(r, 1)); break;
      case 'ArrowUp': go(stepFrom(r, -1)); break;
      case 'PageDown': go(stepFrom(r, 1, perPage(r)) || walkable().at(-1)); break;
      case 'PageUp': go(stepFrom(r, -1, perPage(r)) || walkable()[0]); break;
      case 'Home': go(walkable()[0]); break;
      case 'End': go(walkable().at(-1)); break;
      case '*': {
        const sibs = parentOf[id] != null ? nodeOf[parentOf[id]].children : items();
        sibs.forEach((s) => { if (s.children?.length && !cfg.isOpen(s.id)) cfg.setOpen(s.id, true); });
        build(); focus(id); break;
      }
      case 'ArrowRight': {
        if (!kids) break;
        if (!open) { toggleOpen(id, true); focus(id); break; }
        const first = n.children.map((c) => rowOf(c.id)).find((x) => x && !off(x)); go(first); break;
      }
      case 'ArrowLeft': if (open) { toggleOpen(id, false); focus(id); } else if (parentOf[id] != null) focus(parentOf[id]); break;
      case 'Enter': if (cfg.pick && cfg.confirm) { if (!cfg.disabled?.(id)) cfg.confirm(id); } else choose(id, e); break;
      case ' ': if (ta.busy()) { go(ta.find(' ', walkable(), r)); break; } choose(id, e); break;
      case 'Tab':
        if (!api.peer || e.shiftKey) return;
        api.peer.focus();
        if (host.contains(document.activeElement)) return;      // no row took it (an empty list): the browser's Tab goes on
        break;
      case 'ContextMenu': {
        if (!cfg.menu || cfg.pick || n?.noMenu) return;
        const b = $(':scope > .ti', r).getBoundingClientRect(); cfg.menu(id, b.left + 24, b.bottom); break;
      }
      default:
        /* Letters jump to a folder by name; other keys (F2, Delete...) go to the item list's actions */
        if (plainKey(e)) { const hit = ta.find(e.key, walkable(), r); if (hit) { e.preventDefault(); go(hit); } return; }
        actionKey(e, id, n); return;
    }
    e.preventDefault();
  });
  if (cfg.drag) host.addEventListener('dragstart', (e) => {
    const ti = e.target.closest?.('.ti'); if (!ti) return;
    const id = ti.parentElement.dataset.id, ids = cfg.drag(id);
    if (!ids) { e.preventDefault(); return; }
    startDrag(e, ids, nodeOf[id]?.name || '', null); ti.parentElement.classList.add('dragged');
  });
  if (cfg.drop) {
    dropZone(host, { sel: '.ti', target: (ti) => ti.parentElement.dataset.id, can: cfg.drop.can, drop: cfg.drop.drop, copy: cfg.drop.copy });
    /* Holding a drag over a closed folder for 0.7 s opens it */
    let waitOn = null, timer = 0;
    const stopWait = () => { clearTimeout(timer); waitOn = null; };
    host.addEventListener('dragover', (e) => {
      const li = e.target.closest?.('.ti')?.parentElement, id = li?.getAttribute('aria-expanded') === 'false' ? li.dataset.id : null;
      if (!drag.ids || id === waitOn) return;
      stopWait(); if (id == null) return;
      waitOn = id; timer = setTimeout(() => { if (waitOn === id && drag.ids) toggleOpen(id, true); waitOn = null; }, 700);
    });
    ['dragleave', 'drop', 'dragend'].forEach((t) => host.addEventListener(t, (e) => { if (t !== 'dragleave' || !host.contains(e.relatedTarget)) stopWait(); }));
  }

  /* ---- On a phone the side pane slides in over a dimmed page ---- */
  let back = null;
  const openSheet = () => {
    if (!cfg.sheet) return;
    if (!back) { back = document.createElement('div'); back.className = 'tree-backdrop'; back.addEventListener('click', closeSheet); cfg.sheet.before(back); }
    cfg.sheet.classList.add('tree-sheet', 'open'); back.classList.add('open');
    build(); focus();
  };
  function closeSheet() { if (!cfg.sheet) return; cfg.sheet.classList.remove('open'); back?.classList.remove('open'); }
  if (cfg.sheet) {
    cfg.sheet.classList.add('tree-sheet');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cfg.sheet.classList.contains('open') && isPhone() && !blocked()) { e.preventDefault(); e.stopImmediatePropagation(); closeSheet(); }
    }, true);
  }

  const api = {
    element: host, build, focus, openSheet, closeSheet, toggle: toggleOpen,
    lit: () => kbd, node: (id) => nodeOf[id] || null,
    peer: null,                                                    // the item list beside it: Tab goes there
  };
  trees.set(host, api);
  build();
  return api;
};

/* ---------- Move to…: Ayni.pickNode({ title, items, current, lit, disabled, okLabel, note, extra, openRoots }) ----------
   RULE (guidelines 16.10): the same tree in a box in a dialog, opened down to where the items are now (current), with
   the folder `lit` (default: current; null: none) lit. A click lights a folder; a double-click, Enter or the default
   button picks it. note: a line under the title, or fn(lit id) asked again on each pick; extra(sync): an element put
   under the tree (an on / off row) that calls sync() when it changes. Resolves with the picked id, or null */
const pickNode = (cfg) => new Promise((resolve) => {
  const open = {};
  let lit = 'lit' in cfg ? cfg.lit : cfg.current != null ? cfg.current : null, done = false;
  const all = () => (typeof cfg.items === 'function' ? cfg.items() : cfg.items) || [];
  const d = Ayni.dialog({ title: cfg.title, cls: 'pick-node-dialog' });
  const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
  d.dialog.addEventListener('close', () => finish(null));
  /* Open every folder down to where they are */
  (function walk(nodes, trail) {
    (nodes || []).forEach((n) => {
      if (n.id === cfg.current) trail.forEach((p) => (open[p] = true));
      if (n.children) walk(n.children, trail.concat(n.id));
    });
  })(all(), []);
  if (cfg.openRoots !== false) all().forEach((n) => (open[n.id] = true));
  let noteEl = null;
  if (cfg.note) { noteEl = document.createElement('p'); noteEl.className = 'text'; d.body.append(noteEl); }
  const box = document.createElement('ul'); box.className = 'pick-node';
  d.body.append(box);
  if (cfg.extra) d.body.append(cfg.extra(() => sync()));
  const bad = (id) => !!cfg.disabled?.(id);
  const cancel = Ayni.dialogButton('close', tx('cancel')); cancel.classList.add('pick-cancel');
  cancel.addEventListener('click', () => finish(null));
  const ok = Ayni.dialogButton('primary', cfg.okLabel || tx('moveHere')); ok.classList.add('pick-ok');
  ok.addEventListener('click', () => { if (lit != null && !bad(lit)) finish(lit); });
  d.footer.append(cancel, ok);
  Ayni.init(d.dialog);
  const sync = () => {
    ok.ariaDisabled = lit == null || bad(lit);
    if (noteEl) noteEl.textContent = typeof cfg.note === 'function' ? cfg.note(lit != null && !bad(lit) ? lit : null) : cfg.note;
  };
  d.show();
  const tr = navTree(box, {
    pick: true, items: all,
    isOpen: (id) => !!open[id], setOpen: (id, v) => { open[id] = v; },
    current: () => lit, disabled: bad,
    go: (id) => { lit = id; sync(); }, confirm: (id) => { lit = id; finish(id); },
  });
  sync();
  tr.focus(lit != null ? lit : cfg.current);
});

/* ---------- Page-wide, set up once ---------- */
const setup = () => {
  addEventListener('keydown', (e) => { if (e.key === 'Escape') escHadDialog = blocked(); }, true);
  document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
  document.addEventListener('dragend', () => {
    drag.ids = null; drag.from = null;
    $$('.dragged').forEach((el) => el.classList.remove('dragged'));
    clearDropMarks(null);
  });
};
const init = (root = document) => {
  each(root, '.lb', 'listbox', initListbox);
  each(root, '[role="tree"]:not([data-nav])', 'tree', initTree);
};

Ayni.core.lists = { makeTypeAhead };
/* ---------- Choose a folder: Ayni.pickFolder(o) -> the folder's id, or null ----------
   A dialog with the folders in a tree: the arrow opens and closes, a click lights a folder, a double click or Enter
   chooses it. In its corner three buttons delete, rename and create folders, so nobody has to leave for that; while a
   name is typed the same dialog is the name form (× drops the name, no second dialog). The app owns the data:
     load() -> [{ id, name, children }]      read again after every change: the app's data is the truth
     create(parent, name) -> the new id      rename(id, name) -> the id it has now      remove(id)
   all may be promises; failed(err) says what went wrong (a toast by default). root: the id new folders go in with nothing
   lit; rootName shows it as a row. note: a line on top; noFolders: what to say with none. onOpen(ctl) gets { task(promise),
   rekey(from, to), isOpen() } for what comes later (an Undo: task(p) shows the tree busy, then reads it again; rekey keeps
   what was open under a folder that moved) */
const pickFolder = (o = {}) => new Promise((resolve) => {
  let done = false, nodes = null, failed = false, open = {}, selected = null;
  let nameMode = null, nameTarget = null, nameVal = '', namePicked = false, busy = false;
  const d = Ayni.dialog({ title: o.title || tx('fp.pickFolder') }), sheet = d.body;
  const fail = o.failed || ((err) => Ayni.toast('warn', String(err?.message || err)));
  const finish = (val) => { if (!d.close()) return; done = true; resolve(val || null); };
  d.dialog.addEventListener('close', () => finish(null));
  const load = () => Promise.resolve().then(() => o.load()).then((n) => { nodes = n || []; failed = false; }, () => { failed = true; });
  const find = (list, id) => { for (const n of list || []) { if (n.id === id) return n; const hit = find(n.children, id); if (hit) return hit; } return null; };
  const task = (p) => {
    busy = true; nameMode = null; render();
    return Promise.resolve(p).then((sel) => { selected = sel || null; }, fail).then(load).then(() => {
      busy = false;
      if (selected && selected !== o.root && !find(nodes, selected)) selected = null;
      if (!done) render();
    });
  };
  const rekey = (from, to) => {
    const next = {};
    Object.keys(open).forEach((k) => { next[k === from || k.startsWith(from + '/') ? to + k.slice(from.length) : k] = open[k]; });
    open = next;
  };
  const startName = (mode) => {
    nameMode = mode; namePicked = false;
    nameTarget = mode === 'create' ? selected || o.root : selected;
    nameVal = mode === 'create' ? '' : find(nodes, selected)?.name || '';
    render();
  };
  const cancelName = () => { nameMode = null; nameTarget = null; nameVal = ''; render(); };
  /* A folder's name is one segment: not empty, no "/", not "." or ".." */
  const nameOk = () => { const nm = String(nameVal || '').trim(); return !!nm && !nm.includes('/') && nm !== '.' && nm !== '..'; };
  const commitName = () => {
    if (!nameOk()) return;
    const nm = String(nameVal).trim(), target = nameTarget;
    if (nameMode === 'create') { open[target] = true; task(Promise.resolve().then(() => o.create(target, nm))); return; }
    if (nm === find(nodes, target)?.name) { cancelName(); return; }
    task(Promise.resolve().then(() => o.rename(target, nm)));
  };
  const remove = () => { const gone = selected; task(Promise.resolve().then(() => o.remove(gone)).then(() => null)); };
  const msg = (text) => { const p = document.createElement('p'); p.className = 'fp-msg'; p.textContent = text; return p; };
  const act = (role, ic, tip, off, fn) => { const b = Ayni.dialogButton(role, tip, ic); b.ariaDisabled = !!off; b.addEventListener('click', fn); return b; };
  function render() {
    /* The tree stays scrolled where it was across a redraw, and keeps the keys */
    const was = $('.fp-tree', sheet), scroll = was ? was.scrollTop : 0, hadFocus = !!was && was.contains(document.activeElement);
    sheet.innerHTML = ''; d.footer.innerHTML = '';
    if (o.note) { const p = document.createElement('p'); p.className = 'text'; p.textContent = o.note; sheet.append(p); }
    const box = document.createElement('div'); box.className = 'fp-tree'; sheet.append(box);
    if (failed) box.append(msg(tx('fp.loadError')));
    else if (nodes === null) box.append(msg(tx('fp.loading')));
    else {
      const roots = o.rootName ? [{ id: o.root, name: o.rootName, children: nodes }] : nodes;
      if (o.rootName) open[o.root] = open[o.root] !== false;
      if (!roots.length) box.append(msg(o.noFolders || tx('fp.noFolders')));
      else {
        const host = document.createElement('ul'); box.append(host);
        const tr = tree(host, { nav: true, pick: true, items: () => roots, isOpen: (id) => !!open[id], setOpen: (id, v) => { open[id] = v; },
          current: () => selected, disabled: () => busy, go: (id) => { selected = id; render(); },
          confirm: (id) => { if (!busy && !nameMode) finish(id); } });
        if (hadFocus) tr.focus(selected);
      }
    }
    box.scrollTop = scroll;
    let input = null;
    if (nameMode) {
      const fld = document.createElement('div'), lab = document.createElement('label'); fld.className = 'field';
      lab.textContent = tx(nameMode === 'create' ? 'fp.newFolder' : 'fp.rename'); fld.append(lab);
      input = document.createElement('input'); input.className = 'input'; input.type = 'text'; input.autocomplete = 'off'; input.value = nameVal;
      input.addEventListener('input', () => { nameVal = input.value; ok.ariaDisabled = !nameOk(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); } });
      fld.append(input); sheet.append(fld);
    }
    if (!nameMode) {
      /* In the corner: delete or rename the lit folder, create one inside it (with nothing lit, in the root) */
      const ready = !busy && nodes !== null && !failed, onOne = ready && !!selected && selected !== o.root;
      const left = document.createElement('div'); left.className = 'extra';
      left.append(act('danger', null, tx('fp.delete'), !onOne, remove), act('', 'edit', tx('fp.rename'), !onOne, () => startName('rename')),
        act('', 'folder-plus', tx('fp.newFolder'), !ready, () => startName('create')));
      d.footer.append(left);
    }
    const cancel = Ayni.dialogButton('close', tx('cancel'));
    const ok = Ayni.dialogButton('primary', tx(!nameMode ? 'fp.choose' : nameMode === 'create' ? 'fp.newFolder' : 'fp.rename'));
    d.footer.append(cancel, ok);
    Ayni.init(d.dialog);
    /* While a name is open the × only drops it: the dialog stays */
    cancel.addEventListener('click', (e) => { if (nameMode) { e.preventDefault(); cancelName(); } else finish(null); });
    if (nameMode) {
      ok.ariaDisabled = !nameOk(); ok.addEventListener('click', commitName);
      input.focus(); if (!namePicked) { namePicked = true; input.select(); }
    } else {
      ok.ariaDisabled = !selected || busy;
      ok.addEventListener('click', () => { if (selected) finish(selected); });
    }
  }
  o.onOpen?.({ task, rekey, isOpen: () => !done });
  render(); d.show();
  load().then(render);
});

/* ---------- Choose a file: Ayni.pickFile(o) -> the file's node, or null ----------
   One folder at a time: the crumb on top goes back up, folders first, then the files with their size. A click opens a
   folder and lights a file; the button or a double click chooses it. The app owns the data: list(dir) -> [{ id, name, dir,
   size }], dir true for a folder (may be a promise); ids are paths, "/" between folders. o.dir: where it opens; rootName:
   the first crumb; sizeText(n): how a size reads; okTip: the button's tooltip */
const pickFile = (o = {}) => new Promise((resolve) => {
  let dir = o.dir, nodes = null, failed = false, selected = null, seq = 0;
  const d = Ayni.dialog({ title: o.title || tx('fp.pickFile') }), sheet = d.body;
  const finish = (node) => { if (d.close()) resolve(node || null); };
  d.dialog.addEventListener('close', () => finish(null));
  const openDir = (path) => {
    dir = path; nodes = null; failed = false; selected = null;
    const my = ++seq;
    render();
    Promise.resolve().then(() => o.list(path)).then((list) => {
      if (my !== seq) return;
      nodes = (list || []).slice().sort((a, b) => (!!a.dir !== !!b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
      render();
    }, () => { if (my === seq) { failed = true; render(); } });
  };
  const msg = (text) => { const p = document.createElement('p'); p.className = 'fp-msg'; p.textContent = text; return p; };
  const row = (n) => {
    const r = document.createElement('div'); r.className = 'fp-row' + (selected === n ? ' sel' : '');
    r.setAttribute('role', 'option'); r.setAttribute('aria-selected', selected === n ? 'true' : 'false');
    const part = (cls, text) => { const s = document.createElement('span'); s.className = cls; if (text != null) s.textContent = text; r.append(s); return s; };
    part('fp-caret', n.dir ? '▸' : '');
    part('fp-ic').innerHTML = Ayni.icon(n.dir ? 'folder' : 'file');
    part('fp-name', n.name);
    if (!n.dir) part('fp-size', o.sizeText ? o.sizeText(n.size || 0) : String(n.size || 0));
    r.addEventListener('click', () => { if (n.dir) { openDir(n.id); return; } selected = n; render(); });
    if (!n.dir) r.addEventListener('dblclick', () => finish(n));
    return r;
  };
  function render() {
    sheet.innerHTML = ''; d.footer.innerHTML = '';
    /* Home > photos > 2024: every step but the last goes back there */
    const crumbs = document.createElement('div'); crumbs.className = 'fp-crumbs';
    const parts = String(dir).split('/');
    parts.forEach((part, i) => {
      if (i) crumbs.append('›');
      const label = i === 0 && o.rootName ? o.rootName : part, last = i === parts.length - 1;
      const el = document.createElement(last ? 'b' : 'button'); el.textContent = label;
      if (!last) { el.type = 'button'; el.addEventListener('click', () => openDir(parts.slice(0, i + 1).join('/'))); }
      crumbs.append(el);
    });
    sheet.append(crumbs);
    const box = document.createElement('div'); box.className = 'fp-tree'; box.setAttribute('role', 'listbox'); sheet.append(box);
    if (failed) box.append(msg(tx('fp.loadError')));
    else if (nodes === null) box.append(msg(tx('fp.loading')));
    else if (!nodes.length) box.append(msg(tx('fp.emptyFolder')));
    else nodes.forEach((n) => box.append(row(n)));
    const cancel = Ayni.dialogButton('close', tx('cancel')); cancel.addEventListener('click', () => finish(null));
    const ok = Ayni.dialogButton('primary', o.okTip || tx('fp.chooseFile')); ok.ariaDisabled = !selected;
    ok.addEventListener('click', () => { if (selected) finish(selected); });
    d.footer.append(cancel, ok);
    Ayni.init(d.dialog);
  }
  d.show();
  openDir(dir);
});

Object.assign(Ayni, { list, tree, pickNode, pickFolder, pickFile, dropZone, makeTypeAhead, keyMatches, dragIds: () => drag.ids, pickTick: tickHtml });
Ayni.core.family({ setup, init });
})();
