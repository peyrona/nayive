/* Ayni library 0.2.0, pickers family: the list picker (drop-down list, filtered list and combo box, one component). Plain JavaScript,
   no build step, evergreen browsers 2024+. Load it after ayni-base.js, ayni-menus.js (placing) and ayni-lists.js
   (type-ahead), and after ayni-fields.js for the filtered list's "!":
     <script src="ayni-base.js" defer></script>
     <script src="ayni-menus.js" defer></script>
     <script src="ayni-lists.js" defer></script>
     <script src="ayni-pickers.js" defer></script>
   The look is in ayni-pickers.css (the option rows are the list box's, in ayni-lists.css); the rules are chapter 7 of
   the guidelines.
   RULE: one list picker serves every drop-down list, filtered list and combo box, on every device. A filtered list
   (data-picker="filter", for long lists) narrows as you type but only takes an item of the list: other text gets the
   field's "!" and the value stays. It shows the chosen item's text;
   the page gets the item's value. Fires ayni:change on the .picker with { value, text, name, field, input } when the
   user picks or types a value (never when the page sets one). */
(() => {
'use strict';
const { $, $$, esc } = Ayni;
const { fire, once, isRO, isTouch, tx, fold } = Ayni.core;
/* Type-ahead comes from ayni-lists.js, which loads before this file */
const { makeTypeAhead } = Ayni.core.lists;

let seq = 0;

/* An item of the list: { value, text, short, disabled } (a plain string is value and text), or a heading { heading }.
   A disabled item shows, faded, but cannot be picked; the keys pass over it */
const norm = (o) => {
  if (o == null) return null;
  if (typeof o !== 'object') return { value: String(o), text: String(o) };
  if (o.heading != null) return { heading: String(o.heading) };
  const value = String(o.value ?? o.text ?? ''), text = String(o.text ?? value), it = { value, text };
  if (o.short != null && o.short !== '') it.short = String(o.short);
  if (o.disabled) it.disabled = true;
  return it;
};
/* The items written in the page: li[role=option] (data-value when the value is not the text, data-short), li.heading */
const fromMarkup = (list) => $$(':scope > li', list).map((li) => (li.classList.contains('heading')
  ? { heading: li.textContent.trim() }
  : norm({ value: li.dataset.value ?? li.textContent.trim(), text: li.textContent.trim(), short: li.dataset.short, disabled: li.getAttribute('aria-disabled') === 'true' })));

/* The parts a .picker needs and the page may leave out: the hidden input, the field and the popup with its list */
const build = (root, mode) => {
  const typing = mode !== 'list';
  let hidden = $(':scope > input[type="hidden"]', root);
  if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; root.prepend(hidden); }
  let field = $(':scope > .input', root);
  if (!field) {
    field = document.createElement(typing ? 'input' : 'div'); field.className = 'input';
    if (typing) { field.type = 'text'; field.autocomplete = 'off'; field.spellcheck = false; } else field.tabIndex = 0;
    hidden.after(field);
  }
  /* A label may name the .picker itself (label for="its id"): it then names the field Ayni made */
  const outer = root.id && !field.id ? document.querySelector(`label[for="${CSS.escape(root.id)}"]`) : null;
  field.id ||= root.id ? root.id + '-field' : `ayni-pk${++seq}`;
  if (outer) outer.htmlFor = field.id;
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-expanded', 'false');
  field.setAttribute('aria-haspopup', 'listbox');
  if (typing) field.setAttribute('aria-autocomplete', 'list');
  let pop = $(':scope > .picker-pop', root);
  if (!pop) { pop = document.createElement('div'); pop.className = 'panel popup picker-pop'; pop.setAttribute('popover', 'manual'); root.append(pop); }
  let list = $('[role="listbox"]', pop);
  if (!list) { list = document.createElement('ul'); list.setAttribute('role', 'listbox'); pop.prepend(list); }
  list.id ||= field.id + '-list';
  field.setAttribute('aria-controls', list.id);
  let empty = $('.picker-empty', pop);
  if (typing && !empty) { empty = document.createElement('p'); empty.className = 'picker-empty'; empty.hidden = true; pop.append(empty); }
  if (empty && !empty.textContent.trim()) empty.textContent = tx(mode === 'combo' ? 'picker.keepTyped' : 'picker.noMatch');
  /* A filtered list refuses text that names no item: the field's "!" (ayni-fields.js) with its message */
  let err = null;
  if (mode === 'filter') {
    const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    err = ids.map((id) => document.getElementById(id) || root.querySelector(`[id="${CSS.escape(id)}"]`)).find((e) => e?.classList.contains('error'));
    if (!err) {
      err = document.createElement('span'); err.className = 'error'; err.id = field.id + '-err'; err.hidden = true; root.append(err);
      field.setAttribute('aria-describedby', [...ids, err.id].join(' '));
    }
    if (once('error', field)) Ayni.core.errors?.init(field);
  }
  return { hidden, field, pop, list, empty, err };
};

/* Its name: the label, else the picker's own aria-label or tooltip (a picker in a toolbar or a menu row has no label) */
const nameOf = (root, field) => {
  const label = $(`label[for="${CSS.escape(field.id)}"]`);
  if (label) {
    label.id ||= field.id + '-l';
    if (!field.hasAttribute('aria-labelledby')) field.setAttribute('aria-labelledby', label.id);
    return { label, name: () => label.textContent.trim() };
  }
  const name = () => (root.getAttribute('aria-label') || root.dataset.tip || field.getAttribute('aria-label') || '').trim();
  if (!field.hasAttribute('aria-labelledby') && name()) field.setAttribute('aria-label', name());
  return { label: null, name };
};

const ctl = new WeakMap();

const initPicker = (root, opts = {}) => {
  const mode = opts.mode || (opts.combo ? 'combo' : root.dataset.picker || 'list');
  root.dataset.picker = mode;
  const typing = mode !== 'list', strict = mode === 'filter';
  const { hidden, field, pop, list, empty, err } = build(root, mode);
  /* In a toolbar the picker never keeps the focus: it goes back where it was (a document and its caret) */
  const bar = root.closest('[role="toolbar"]');
  let back = null;
  const { label, name } = nameOf(root, field);
  if (opts.placeholder != null) field.dataset.placeholder = opts.placeholder;
  if (typing && field.dataset.placeholder) field.placeholder = field.dataset.placeholder;

  let items = [], all = [], cur = { value: hidden.value, text: null };
  /* A page-wide listener that leaves once the picker has left the page (a list redrawn with new pickers) */
  let seen = root.isConnected;
  const onPage = (target, type, fn, capture) => {
    const h = (e) => {
      if (root.isConnected) seen = true; else if (seen) { target.removeEventListener(type, h, capture); return; }
      fn(e);
    };
    target.addEventListener(type, h, capture);
  };
  /* Draw the list from items; the rows are the list box's (ayni-lists.css) */
  const draw = () => {
    list.innerHTML = items.map((o, i) => (o.heading != null
      ? `<li class="heading" role="presentation">${esc(o.heading)}</li>`
      : `<li role="option" id="${field.id}-o${i}" data-value="${esc(o.value)}"${o.short ? ` data-short="${esc(o.short)}"` : ''}${o.disabled ? ' aria-disabled="true"' : ''}>${esc(o.text)}</li>`)).join('');
    all = $$('[role="option"]', list);
    const its = options(); all.forEach((li, i) => { li.ayniItem = its[i]; });
  };
  const setItems = (arr) => { items = (arr || []).map(norm).filter(Boolean); draw(); show(); };
  const options = () => items.filter((o) => o.heading == null);
  const itemOf = (v) => options().find((o) => o.value === v);

  /* What the field shows: the item's short text (or its text), a text the page gave for a value the list does not hold,
     the value itself, or the placeholder when there is none */
  const show = () => {
    const it = itemOf(cur.value);
    const txt = cur.text ?? (it ? it.short || it.text : cur.value);
    all.forEach((li) => li.setAttribute('aria-selected', li.ayniItem.value === cur.value && !!it));
    if (typing) field.value = txt; else field.textContent = txt;
    root.classList.toggle('is-empty', !txt);
  };
  const shownText = () => { const it = itemOf(cur.value); return cur.text ?? (it ? it.text : cur.value); };
  /* The page sets a value: no event. text shows a value the list does not hold (a font the document uses) */
  const set = (v, text) => { cur = { value: v == null ? '' : String(v), text: text == null ? null : String(text) }; hidden.value = cur.value; setBad(false); show(); };
  /* The user picks or types one: the event and onChange */
  const choose = (v, text) => {
    set(v, text);
    const detail = { value: cur.value, text: shownText(), name: name(), field, input: hidden };
    fire(root, 'ayni:change', detail);
    opts.onChange?.(detail.value, detail.text);
  };

  const setBad = (on) => {
    if (!err) return;
    if (on) { err.textContent = tx('picker.pickFromList'); field.setAttribute('aria-invalid', 'true'); } else field.removeAttribute('aria-invalid');
    err.hidden = !on;
  };
  /* After a pick, Enter or Esc: in a toolbar the focus goes back; elsewhere it stays in the field */
  const done = () => {
    if (!bar) { field.focus(); return; }
    const b = back; back = null;
    if (b && b.isConnected && b !== document.body && !root.contains(b)) b.focus({ preventScroll: true });
    else if (root.contains(document.activeElement)) document.activeElement.blur();
  };
  const shown = () => all.filter((o) => !o.hidden && o.getAttribute('aria-disabled') !== 'true');
  const isOpen = () => pop.matches(':popover-open');
  const activeOpt = () => all.find((o) => o.classList.contains('active'));
  const setActive = (o) => {
    all.forEach((x) => x.classList.toggle('active', x === o));
    if (o) { field.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); } else field.removeAttribute('aria-activedescendant');
  };
  /* Headings with no shown item under them hide while the list is filtered */
  const tidyHeadings = () => $$('li.heading', list).forEach((h) => {
    let n = h.nextElementSibling, any = false;
    while (n && !n.classList.contains('heading')) { if (!n.hidden) { any = true; break; } n = n.nextElementSibling; }
    h.hidden = !any;
  });
  const place = () => {
    const r = field.getBoundingClientRect(), sheet = isTouch() && innerWidth < 600;
    pop.classList.toggle('sheet', sheet);
    if (sheet) { // bottom sheet, kept above the on-screen keyboard; the field scrolls up so the sheet never hides it
      const vv = visualViewport, kb = vv ? Math.max(0, innerHeight - vv.offsetTop - vv.height) : 0;
      Object.assign(pop.style, { top: 'auto', left: '', width: '', minWidth: '', bottom: kb + 'px', maxHeight: `min(50dvh, ${Math.max(160, (vv ? vv.height : innerHeight) - 16)}px)` });
      const over = r.bottom + 8 - pop.getBoundingClientRect().top;
      if (over > 0) {
        let q = root.parentElement;
        while (q && !(q.scrollHeight > q.clientHeight && /auto|scroll/.test(getComputedStyle(q).overflowY))) q = q.parentElement;
        (q || document.scrollingElement).scrollTop += over;
      }
      return;
    }
    /* At least as wide as the field; a narrow one (a font size in a toolbar) lets its list grow to its longest item */
    Object.assign(pop.style, { bottom: '', width: '', minWidth: r.width + 'px' });
    const w = Math.min(pop.getBoundingClientRect().width, innerWidth - 8);
    const below = innerHeight - r.bottom - 12, above = r.top - 12, want = Math.min(280, list.scrollHeight + 10);
    const up = want > below && above > below;
    Object.assign(pop.style, { left: Math.max(4, Math.min(r.left, innerWidth - w - 4)) + 'px', maxHeight: Math.max(120, Math.min(280, up ? above : below)) + 'px' });
    pop.style.top = (up ? r.top - 4 - pop.getBoundingClientRect().height : r.bottom + 4) + 'px';
  };
  const blocked = () => isRO(field) || field.getAttribute('aria-disabled') === 'true';
  const open = () => {
    if (isOpen() || blocked()) return;
    pop.showPopover(); field.setAttribute('aria-expanded', 'true'); place();
    setActive(shown().find((o) => o.getAttribute('aria-selected') === 'true') || shown()[0]);
  };
  const close = () => {
    if (!isOpen()) return;
    pop.hidePopover(); field.setAttribute('aria-expanded', 'false'); setActive(null);
    all.forEach((o) => { o.hidden = false; }); $$('li.heading', list).forEach((h) => { h.hidden = false; });
    if (empty) empty.hidden = true;
  };
  const pick = (o) => { if (o.getAttribute('aria-disabled') === 'true') return; choose(o.ayniItem.value); close(); done(); };
  /* Typed text when the field is left or Enter is pressed: a combo box keeps it; a filtered list takes the item it
     names (case and accents aside) and refuses anything else with its "!". True when the text is fine */
  const keepTyped = () => {
    if (!typing) return true;
    const t = field.value.trim(); if (t === (shownText() ?? '')) { setBad(false); show(); return true; }
    const f = fold(t), hit = options().find((o) => o.text === t || o.value === t)
      || (strict && options().find((o) => fold(o.text) === f || fold(o.value) === f || (o.short && fold(o.short) === f)));
    if (hit) { choose(hit.value); return true; }
    if (!strict) { choose(t); return true; }
    if (!t) { show(); return true; }       // emptied: the value stays as it was
    setBad(true); return false;
  };
  if (strict) Ayni.core.errors?.check?.(field, keepTyped);
  root.addEventListener('ayni:dismiss', (e) => { e.preventDefault(); close(); keepTyped(); });
  /* Type-ahead (typing off), shared helper; works while closed too */
  const ta = makeTypeAhead((o) => o.ayniItem.text);
  const typeAhead = (ch) => {
    const hit = ta.find(ch, shown(), isOpen() ? activeOpt() : all.find((o) => o.ayniItem.value === cur.value));
    if (hit && !isRO(field)) isOpen() ? setActive(hit) : choose(hit.ayniItem.value);
  };
  /* A click in the popup is not a click on the field. Asked of the click's path, not of pop.contains(e.target): a page
     that sets new items on ayni:change redraws the list during the pick, the clicked row leaves the popup, and
     contains() would then say "outside" and open the list again */
  root.addEventListener('click', (e) => { if (e.composedPath().includes(pop)) return; if (!isOpen()) open(); else if (!typing) close(); });
  if (bar) {
    /* The pointer: a drop-down list never takes the focus from the document; a typing field does, to be typed in */
    root.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target) && !root.contains(document.activeElement)) back = document.activeElement; });
    root.addEventListener('mousedown', (e) => { if (!typing && !pop.contains(e.target)) e.preventDefault(); });
    field.addEventListener('focusin', (e) => { if (e.relatedTarget && !root.contains(e.relatedTarget)) back = e.relatedTarget; });
  }
  /* The menu, popup or dialog holding the picker closes: so does its list */
  onPage(document, 'toggle', (e) => { if (e.newState === 'closed' && e.target !== pop && e.target.contains?.(root)) close(); }, true);
  label?.addEventListener('click', () => field.focus());
  list.addEventListener('click', (e) => { const o = e.target.closest('[role="option"]'); if (o) pick(o); });
  list.addEventListener('pointermove', (e) => { const o = e.target.closest('[role="option"]:not([aria-disabled="true"])'); if (o && e.pointerType === 'mouse') setActive(o); });
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // the focus stays in the field
  onPage(document, 'pointerdown', (e) => { if (isOpen() && !root.contains(e.target)) { close(); keepTyped(); } }, true);
  field.addEventListener('blur', () => setTimeout(() => { if (!root.contains(document.activeElement)) { close(); keepTyped(); } }));
  onPage(window, 'resize', () => isOpen() && place()); if (window.visualViewport) onPage(visualViewport, 'resize', () => isOpen() && place());
  onPage(window, 'scroll', (e) => { if (isOpen() && !pop.contains(e.target)) place(); }, true);
  field.addEventListener('keydown', (e) => {
    const opts2 = shown(), at = opts2.indexOf(activeOpt()), go = (i) => setActive(opts2[Math.max(0, Math.min(opts2.length - 1, i))]);
    if ((e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) || e.key === 'F4') { e.preventDefault(); isOpen() ? close() : open(); return; }
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp': e.preventDefault(); if (!isOpen()) open(); else go(at + (e.key === 'ArrowDown' ? 1 : -1)); return;
      case 'PageDown': case 'PageUp': if (isOpen()) { e.preventDefault(); go(at + (e.key === 'PageDown' ? 8 : -8)); } return;
      case 'Home': case 'End': if (isOpen() && !typing) { e.preventDefault(); go(e.key === 'Home' ? 0 : opts2.length - 1); } return;
      case 'Enter':
        if (isOpen()) { e.preventDefault(); const a = activeOpt(); if (a) pick(a); else { close(); if (keepTyped()) done(); } }
        else if (!typing) { e.preventDefault(); open(); }
        else if (strict) { e.preventDefault(); if (keepTyped()) done(); }
        else if (keepTyped() && bar) { e.preventDefault(); done(); }
        return;
      case 'Escape':
        if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(); if (typing) { setBad(false); show(); } if (bar) done(); }
        else if (bar) { e.preventDefault(); if (typing) { setBad(false); show(); } done(); }
        return;
      case 'Tab': close(); keepTyped(); return;
      case ' ': if (!typing && !ta.busy()) { e.preventDefault(); const a = activeOpt(); isOpen() ? a && pick(a) : open(); return; }
    }
    if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeAhead(e.key); }
  });
  if (typing) field.addEventListener('input', () => {
    setBad(false);
    const m = Ayni.matcher(field.value);      // the search rule (4.5): words in any order, "phrase", -word
    all.forEach((o) => { o.hidden = !!m && !m(o.ayniItem.text); });
    tidyHeadings();
    if (empty) empty.hidden = shown().length > 0;
    if (!isOpen()) open(); else place();
    setActive(m ? shown()[0] || null : null);
  });

  /* Disabled: faded, not focusable, never opens */
  const setDisabled = (on) => {
    on = !!on;
    if (on) field.setAttribute('aria-disabled', 'true'); else field.removeAttribute('aria-disabled');
    if (typing) field.disabled = on; else field.tabIndex = on ? -1 : 0;
    if (on) close();
  };

  const api = {
    get mode() { return mode; },
    get value() { return cur.value; },
    set value(v) { set(v); },
    get text() { return shownText(); },
    get options() { return options().map((o) => ({ ...o })); },
    set options(arr) { setItems(arr); },
    /* The items with their headings, as given */
    get items() { return items.map((o) => ({ ...o })); },
    set,
    /* Picks a value as the user would (a menu that mirrors the picker): ayni:change and onChange, as on a pick */
    choose: (v, text) => choose(v == null ? '' : String(v), text),
    get disabled() { return field.getAttribute('aria-disabled') === 'true'; },
    set disabled(on) { setDisabled(on); },
    get isOpen() { return isOpen(); },
    open, close,
    get name() { return name(); },
    field, input: hidden, element: root,
    /* The More row for a picker that left an overfull toolbar (Ayni.fitBar): a submenu of its items, the chosen one ticked */
    menuRow: () => ({
      id: root.id || '', label: name(), disabled: api.disabled,
      sub: () => items.map((o) => (o.heading != null ? { caption: o.heading }
        : { label: o.text, checked: o.value === cur.value, disabled: !!o.disabled, run: () => choose(o.value) })),
    }),
  };
  root.ayniMenuRow = api.menuRow;
  ctl.set(root, api);
  setItems(opts.options || fromMarkup(list));
  if (opts.value != null) set(opts.value); else set(hidden.value);
  if (opts.disabled != null) setDisabled(opts.disabled);
  return api;
};

/* Ayni.picker(element, { mode, options, value, placeholder, disabled, onChange }): the controller of a picker, made on
   an empty .picker (Ayni writes its parts) or on one written in the page. Called again on a wired picker, it gives
   the same controller, with any options given applied */
const picker = (el, opts = {}) => {
  if (typeof el === 'string') el = $(el);
  if (!el) return null;
  el.classList.add('picker');
  const have = ctl.get(el);
  if (have) {
    if ('options' in opts) have.options = opts.options;
    if ('value' in opts) have.set(opts.value);
    if ('disabled' in opts) have.disabled = opts.disabled;
    return have;
  }
  return initPicker(el, opts);
};

/* A picker written in the page (with its list) is wired here; an empty .picker waits for Ayni.picker, which gives it
   its mode and items */
const init = (root) => [...(root.matches?.('.picker') ? [root] : []), ...$$('.picker', root)].forEach((el) => {
  if (!ctl.has(el) && $('[role="listbox"]', el) && once('picker', el)) initPicker(el);
});

Object.assign(Ayni, { picker });
Ayni.core.family({ init });
})();
