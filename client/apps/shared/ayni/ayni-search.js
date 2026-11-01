/* Ayni library 0.1.0, search family: the one search field (.input-group.search-field), folded behind its Search
   button in a title row (.fold), with its count, filter button and up / down pair. The search rule itself
   (Ayni.matcher, Ayni.fold) is in ayni-base.js: lists and pickers use it too.
   Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-base.js and ayni-buttons.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-buttons.js" defer></script>
     <script src="ayni-search.js" defer></script>
   The look is in ayni-search.css; the rules are chapters 4.5 (search field) and 4.6 (find bar) of the guidelines. */
(() => {
'use strict';
const { $, $$, icon, setTip, isMac, matcher } = Ayni;
const { fire, each, tx, txf } = Ayni.core;

const fields = new WeakMap();      // .search-field -> its controller
const bars = new Set();            // the find bars Ayni.findBar made, for Ctrl+F / Ctrl+H

/* A round button for inside the field */
const button = (cls, name, tip) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = ('btn ' + cls).trim(); b.innerHTML = icon(name); setTip(b, tip);
  return b;
};

/* RULE: every search field is the same control. Inside it, at the right end: the count, the filter button, the up /
   down pair, then Close (×). A folded field (.fold) shows only its Search button ([data-search], next to it) at rest;
   its × is always there and clears and folds it in one press. A plain field (in a dialog, a popup) has a clear button
   instead, shown only while there is text. Esc: with text, the first Esc only clears it; on an empty field it folds a
   folded one, or reaches the popup or dialog around a plain one. Its tooltip says how to search (tip: false drops it:
   the words go to a server with rules of its own). It filters as the user types and fires ayni:search { text, test }
   after each change; a field marked data-enter searches only on Enter or its Go button (a magnifier inside, the only
   field that has one) */
const make = (field) => {
  const input = $('input', field), folded = field.classList.contains('fold'), onEnter = field.hasAttribute('data-enter');
  const o = {};
  const steps = [];
  let toggle = null, made = null, filter = $('.filter-btn', field);

  const clear = $('[data-clear]', field) || field.appendChild(button('', 'close', ''));
  clear.setAttribute('data-clear', '');
  setTip(clear, tx(folded ? 'close' : 'clear'));
  const count = $('.search-count', field) || document.createElement('span');
  if (!count.parentNode) { count.className = 'search-count'; count.hidden = true; input.after(count); }
  count.setAttribute('aria-live', 'polite');

  const isOpen = () => !folded || field.classList.contains('is-open');
  const sync = () => { if (!folded) clear.hidden = input.value === ''; };
  const setCount = (text) => { count.textContent = text || ''; count.hidden = !text; };
  const canStep = (on) => steps.forEach((b) => b.setAttribute('aria-disabled', !on));
  const changed = () => input.dispatchEvent(new Event('input', { bubbles: true }));
  const search = () => fire(field, 'ayni:search', { text: input.value, test: matcher(input.value) });
  /* The text goes, the field stays, with the cursor in it. An Enter-only field tells at once: its results are stale */
  const empty = () => { input.value = ''; setCount(''); sync(); changed(); if (onEnter) search(); input.focus(); };
  /* open(true): a search the app opened itself (from a link) unfolds without the cursor, so no phone keyboard */
  const open = (quiet) => { field.classList.add('is-open'); if (quiet !== true) input.focus(); };
  /* close(true) folds it without telling anyone (the app is about to show something else) */
  const close = (quiet) => {
    if (!folded) { empty(); return; }
    const had = field.contains(document.activeElement);
    field.classList.remove('is-open');
    input.value = ''; setCount('');
    if (had) toggle?.focus();
    if (quiet === true) return;
    fire(field, 'ayni:searchclose');
    if (o.onClose) o.onClose(); else { changed(); if (onEnter) search(); }
  };

  /* The folded field's Search button: the page's, next to it, or one made before it */
  const adopt = (b) => {
    if (b === toggle) return;
    made?.remove(); made = null;
    toggle = b; toggle.setAttribute('data-search', '');
    toggle.addEventListener('click', () => open());
  };
  if (folded) {
    const near = [field.previousElementSibling, field.nextElementSibling].find((x) => x?.matches('[data-search]'));
    if (near) adopt(near);
    else { const b = button('', 'search', tx('search')); field.before(b); adopt(b); made = b; }
  }

  const setTipOf = () => {
    if (o.tip === false) { if (input.dataset.tip === tx('searchTip')) delete input.dataset.tip; }
    else if (!input.dataset.tip && !input.title) input.dataset.tip = tx('searchTip');
  };
  setTipOf();

  /* The Go button of an Enter-only field: the page's ([data-go]) or one made at the end */
  const go = !onEnter ? null : $('[data-go]', field) || field.appendChild(button('', 'search', tx('search')));
  go?.setAttribute('data-go', '');
  go?.addEventListener('click', () => { search(); input.focus(); });

  input.addEventListener('input', () => { sync(); if (!onEnter) search(); });
  /* The up / down pair leaves the cursor in the field: Enter goes on from there */
  field.addEventListener('mousedown', (e) => { if (e.target.closest('.search-step') && field.contains(document.activeElement)) e.preventDefault(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && steps.length && !e.isComposing) {
      e.preventDefault();
      if (steps[0].getAttribute('aria-disabled') !== 'true') o.step(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Enter' && onEnter && !e.isComposing) { e.preventDefault(); search(); return; }
    if (e.key !== 'Escape' || e.isComposing) return;
    if (input.value !== '') { e.preventDefault(); e.stopPropagation(); empty(); }
    else if (folded && isOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
  });
  clear.addEventListener('click', () => close());
  sync();

  /* Ayni.searchField(field, options) adds what the markup cannot say */
  const set = (opts = {}) => {
    Object.assign(o, opts);
    if (opts.toggle && folded) adopt(opts.toggle);
    if (opts.filter && !filter) { filter = button('filter-btn', 'filter', o.filterTip || tx('filter')); count.after(filter); }
    if (opts.filter && filter && !filter.ayniFilter) { filter.ayniFilter = true; filter.addEventListener('click', () => o.filter()); }
    if (opts.step && !steps.length) {
      [[-1, 'chev-up', 'prev'], [1, 'chev-down', 'next']].forEach(([d, name, key]) => {
        const b = button('search-step', name, tx(key));
        b.setAttribute('aria-disabled', 'true');
        b.addEventListener('click', () => { if (b.getAttribute('aria-disabled') !== 'true') o.step(d); });
        clear.before(b); steps.push(b);
      });
    }
    if ('tip' in opts) setTipOf();
    Ayni.init(field);
    return api;
  };
  /* filtered(what): which filter is on. Nothing (or 0) = none: grey, the plain tooltip; a number = how many ("Filters: 2");
     a text = its name ("Filter: fruits"). Either way the icon turns Accent */
  const filtered = (what) => {
    if (!filter) return;
    filter.classList.toggle('is-active', !!what);
    setTip(filter, !what ? o.filterTip || tx('filter') : typeof what === 'number' ? txf('filters', { n: what }) : txf('filterOn', { name: what }));
  };
  const api = { open, close, isOpen, count: setCount, canStep, clear: empty, filtered };
  const ctl = { set, api, toggle: () => toggle };
  fields.set(field, ctl);
  Ayni.init(field);             // the buttons made here get the buttons family's wiring
  if (made) Ayni.init(made);
  return ctl;
};

/* Ayni.searchField(field, { filter, filterTip, step, onClose, tip, toggle }) -> { open, close, isOpen, count, canStep, clear,
   filtered }.
   filter(): the filter button was pressed (a filter button in the markup with popovertarget needs none); step(d): go to
   the previous (-1) or next (+1) hit, also Enter / Shift+Enter; onClose(): the folded field was emptied and folded
   (without it the field fires "input"); toggle: the page's own Search button for a folded field */
const searchField = (field, opts) => (fields.get(field) || make(field)).set(opts);

const init = (root) => each(root, '.search-field', 'search', (f) => { if (!fields.has(f)) make(f); });

/* ---------- Find bar (4.6): a strip above a document ---------- */
const textButton = (key) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn text'; b.textContent = tx(key);
  return b;
};

/* RULE: finding inside a document is a strip above it, never a dialog: the document stays in view and editable. Find
   row: the search field with "3 / 12" and the up / down pair, Match case (Aa), the ▾ that shows the replace row, and
   Close. Replace row: the replacement, Replace and Replace all. Enter steps (Shift+Enter back) or, in the replacement,
   replaces; the buttons never take the cursor out of the field it was in. Esc clears, then closes. The page finds,
   marks, steps and replaces; Ayni draws the bar and keeps its keys.
   Ayni.findBar(bar, { find(text, { matchCase }), step(d), replace(text, all), selected(), onClose })
   -> { open(withReplace, text), close(), isOpen(), count(at, total) }.
   find: after each change of the words or of Match case ('' = nothing asked: drop the marks); step: -1 / +1; replace:
   once (all false) or every match (all true), as one undoable action; without replace the bar has no replace row;
   selected(): the document's selected words, put in the field when the bar opens; onClose: drop the marks and put the
   cursor back in the document, on the last match */
const findBar = (bar, o = {}) => {
  bar.classList.add('find-bar'); bar.setAttribute('role', 'search');
  if (!bar.hasAttribute('aria-label')) bar.setAttribute('aria-label', tx('find'));
  bar.hidden = true; bar.textContent = '';

  const row = document.createElement('div'); row.className = 'find-row';
  const field = document.createElement('div'); field.className = 'input-group search-field';
  const input = document.createElement('input');
  Object.assign(input, { type: 'search', className: 'input', placeholder: tx('find'), autocomplete: 'off', spellcheck: false });
  input.setAttribute('aria-label', tx('find'));
  field.append(input);
  const caseBtn = button('', 'case', tx('matchCase')); caseBtn.setAttribute('aria-pressed', 'false');
  const more = button('find-more', 'chev-down', tx('replaceShow')); more.setAttribute('aria-expanded', 'false');
  const shut = button('', 'close', tx('close'));
  row.append(field, caseBtn, ...(o.replace ? [more] : []), shut);

  const repRow = document.createElement('div'); repRow.className = 'find-row find-replace'; repRow.hidden = true;
  const rep = document.createElement('input');
  Object.assign(rep, { type: 'text', className: 'input', placeholder: tx('replaceWith'), autocomplete: 'off', spellcheck: false });
  rep.setAttribute('aria-label', tx('replaceWith'));
  const one = textButton('replace'), all = textButton('replaceAll');
  repRow.append(rep, one, all);
  bar.append(row, ...(o.replace ? [repRow] : []));

  let matchCase = false;
  const sf = searchField(field, { step: (d) => o.step?.(d), tip: false });
  const asked = () => o.find?.(input.value, { matchCase });
  const isOpen = () => !bar.hidden;
  const showReplace = (on) => {
    if (!o.replace) return;
    repRow.hidden = !on; more.setAttribute('aria-expanded', on);
  };
  /* open(withReplace, text): with no text given, the document's selection (one line, up to 100 letters) is looked for */
  const open = (withReplace, text) => {
    const sel = text ?? o.selected?.() ?? '';
    if (sel && sel.length <= 100 && !sel.includes('\n')) input.value = sel;
    const was = isOpen();
    bar.hidden = false; showReplace(!!withReplace);
    (withReplace && was ? rep : input).focus();
    if (!withReplace || !was) input.select();
    asked();
  };
  const close = () => {
    if (!isOpen()) return;
    bar.hidden = true;
    o.onClose?.();
  };
  /* count(at, total): "3 / 12", "– / 12" before a match is picked, a red "0" when nothing matches */
  const count = (at, total) => {
    sf.count(!input.value ? '' : total ? `${at || '–'} / ${total}` : '0');
    sf.canStep(total > 0);
    bar.classList.toggle('is-empty', !!input.value && !total);
  };

  input.addEventListener('input', asked);
  rep.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); o.replace(rep.value, false); } });
  /* Esc that the field did not take (it clears first) closes the bar */
  bar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close(); } });
  /* The bar's buttons never take the cursor from the field the user typed in */
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button') && bar.contains(document.activeElement)) e.preventDefault(); });
  caseBtn.addEventListener('click', () => { matchCase = !matchCase; caseBtn.setAttribute('aria-pressed', matchCase); asked(); });
  more.addEventListener('click', () => { const on = repRow.hidden; showReplace(on); (on ? rep : input).focus(); });
  shut.addEventListener('click', close);
  one.addEventListener('click', () => o.replace(rep.value, false));
  all.addEventListener('click', () => o.replace(rep.value, true));
  Ayni.init(bar);

  const api = { open, close, isOpen, count };
  bars.add({ bar, api, o });
  return api;
};

/* ---------- Ctrl+F (⌘F): the view's search, from anywhere, even a text field (2.5) ---------- */
/* Where to look: the open popup or dialog the cursor is in, else the top modal dialog, else the page. In it: a find bar
   (Ctrl+H opens its replace row), else the first folded search whose Search button shows, else the first plain search
   field that shows. Nothing there: the browser's own find runs. A page that handles the key itself prevents its default
   first, and Ayni leaves it alone */
const shows = (el) => !!el?.isConnected && el.checkVisibility() && !el.closest('[inert]');
const scope = () => {
  const a = document.activeElement?.closest?.('dialog[open], [popover]:popover-open');
  if (a && $$('.search-field, .find-bar', a).length) return a;
  const modals = $$('dialog:modal');
  return modals.find((d) => d.contains(document.activeElement)) || modals.at(-1) || document;
};
const findKey = (e) => {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.shiftKey || e.defaultPrevented || e.isComposing) return;
  const key = (e.key || '').toLowerCase(), k = e.code === 'KeyF' || key === 'f' ? 'f' : e.code === 'KeyH' || key === 'h' ? 'h' : '';
  if (!k) return;
  const where = scope(), inside = (el) => where === document ? !el.closest('dialog:not([open]), [popover]:not(:popover-open)') : where.contains(el);
  const bar = [...bars].find((b) => inside(b.bar) && shows(b.bar.parentElement));
  if (bar) { e.preventDefault(); bar.api.open(k === 'h' && !!bar.o.replace); return; }
  if (k !== 'f') return;
  const all = $$('.search-field', where).filter((f) => !f.closest('.find-bar') && inside(f));
  const fold = all.find((f) => f.classList.contains('fold') && shows(f.classList.contains('is-open') ? f : fields.get(f)?.toggle()));
  const field = fold || all.find((f) => !f.classList.contains('fold') && shows(f));
  if (!field) return;
  e.preventDefault();
  const input = $('input', field);
  if (fold) fields.get(fold).api.open();
  input.focus(); input.select();
};
const setup = () => addEventListener('keydown', findKey);

Object.assign(Ayni, { searchField, findBar });
Ayni.core.family({ setup, init });
})();
