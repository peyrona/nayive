/* Ayni library 0.1.0, dialogs family: dialog.panel opened from markup or code, Esc, the first field, moving a
   dialog, confirmation / message / question dialogs built in code, and fields saved as they change.
   Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-base.js and ayni-buttons.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-buttons.js" defer></script>
     <script src="ayni-dialogs.js" defer></script>
   The look is in ayni-dialogs.css; the rules are chapter 10 of the guidelines. */
(() => {
'use strict';
const { $, $$, icon } = Ayni;
const { each, tx, txf } = Ayni.core;

const FOCUS_WAIT_MS = 4000;     // how long a dialog waits for a field that comes after loading
const DRAG_SLOP = 4;            // px of travel before a press on the title row counts as a drag
const DRAG_MARGIN = 8;          // px of window edge a moved dialog may not cross
const DRAG_PHONE = 640;         // at or below this width dialogs do not move

const opened = [];              // the open dialogs, the newest last
let askN = 0;                   // ids for the fields of Ayni.ask

/* ---------- Esc ---------- */
/* RULE: Esc closes the innermost dialog as if its Close button were pressed, so the app's own close work runs; a
   dialog without one just closes. An open popup or menu takes the Esc first, and a search field clears first (it
   marks the key handled). The browser's own Esc is stopped, so a dialog always closes this one way. */
const closeButton = (d) => $$('[data-close]', d).find((b) => b.closest('dialog') === d);
const onEsc = (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  if ($$('[popover]:popover-open').some((p) => p.popover === 'auto')) return;
  if ($('dialog.lock:modal')) return;                 // a lock screen owns the keys: nothing under it closes
  const d = e.target.closest?.('dialog.panel[open]') || opened.filter((x) => x.open).at(-1);
  if (!d) return;
  e.preventDefault();
  const b = closeButton(d);
  if (b && b.getAttribute('aria-disabled') !== 'true') b.click(); else if (!b) d.close();
};

/* A click on a dialog's Close button (data-close) closes the dialog, after the page's own handler for it has run.
   A handler that calls preventDefault() keeps the dialog open (to ask about unsaved changes first). A page that
   closed it itself is left alone: it may already have opened it again. */
const onCloseClick = (e) => {
  const b = e.target.closest?.('button[data-close]'), d = b?.closest('dialog.panel');
  if (!d || b.closest('[role="tab"]') || b.closest('dialog') !== d) return;
  let closed = false;
  const mark = () => { closed = true; };
  d.addEventListener('close', mark, { once: true });
  setTimeout(() => { d.removeEventListener('close', mark); if (!closed && !e.defaultPrevented && d.open) d.close(); });
};

/* ---------- The first field ---------- */
/* RULE: a dialog opens with the caret in its first field, so the user can type at once. Never on a button: a stray
   Enter on Close would close the dialog. A field in the title row (a switch) is skipped unless it is the only one.
   A field that only comes after loading takes the focus when it shows up (for FOCUS_WAIT_MS). With no field the
   dialog itself takes the focus (Enter then runs its default button). A focus the page chose is kept: an element
   marked autofocus, or one the page focused right after opening. The browser's own pick happens inside
   showModal(), before the page's: it is the first focus the dialog gets while opening (counted by onFocusIn). */
const isField = (el) => {
  if (el.disabled || el.readOnly || el.getAttribute('aria-hidden') === 'true') return false;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && +ti < 0) return false;
  if (el.tagName === 'INPUT') { if (/^(hidden|button|submit|reset|image)$/.test(el.type)) return false; }
  else if (el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') { const ce = el.getAttribute('contenteditable'); if (ce === null || ce === 'false') return false; }
  return el.getClientRects().length > 0;
};
const firstField = (d) => {
  let head = null;
  for (const el of $$('input, select, textarea, [contenteditable]', d)) {
    if (!isField(el)) continue;
    if (el.closest('header')?.parentElement === d || el.closest('header')?.parentElement?.parentElement === d) { head ||= el; continue; }
    return el;
  }
  return head;
};
/* true = done with this dialog: focused, or the app chose */
const focusFirst = (d, first = false) => {
  if (!d.open) return true;
  const a = document.activeElement, inside = a !== d && d.contains(a);
  if (inside && (!first || d.ayniFocusIns > 1 || a.hasAttribute('autofocus'))) return true;
  const f = firstField(d);
  if (!f) { if (first && inside) { if (!d.hasAttribute('tabindex')) d.tabIndex = -1; d.focus({ preventScroll: true }); } return false; }
  f.focus({ preventScroll: true });
  /* A text field opens with the caret after its text; a dialog that means "replace it" selects it itself */
  if (f.tagName === 'TEXTAREA' || /^(text|search|url|tel|password)$/.test(f.type || '')) try { f.setSelectionRange(f.value.length, f.value.length); } catch {}
  else if (/^(number|email)$/.test(f.type || '') && f.value !== '') { const v = f.value; f.value = ''; f.value = v; }
  return true;
};
const waitForField = (d) => {
  const mo = new MutationObserver(() => { if (focusFirst(d)) stop(); });
  const timer = setTimeout(() => stop(), FOCUS_WAIT_MS);
  const stop = () => { mo.disconnect(); clearTimeout(timer); };
  mo.observe(d, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'class', 'style', 'hidden'] });
};

/* ---------- Opening and closing ---------- */
/* One observer for the page sees every dialog.panel open and close, by markup, Ayni's builders or the app's own
   showModal() / close(). It runs as a microtask, still inside the user's gesture: the only moment iOS lets a
   programmatic focus raise the keyboard. */
const onOpen = (d) => {
  if (opened.includes(d)) return;
  opened.push(d);
  if (d.matches(':modal') && !d.classList.contains('lock')) { liftToasts(); liftLock(); }
  if (!focusFirst(d, true)) waitForField(d);
};
const onFocusIn = (e) => {
  const d = e.target.closest?.('dialog.panel');
  if (d?.open && !opened.includes(d)) d.ayniFocusIns = (d.ayniFocusIns || 0) + 1;
};
const onClose = (d) => {
  const i = opened.indexOf(d); if (i >= 0) opened.splice(i, 1);
  d.ayniFocusIns = 0;
  moveTo(d, 0, 0);                               // dialogs always open centred
};
const watch = () => new MutationObserver((recs) => {
  for (const r of recs) {
    const d = r.target;
    if (!d.matches?.('dialog.panel')) continue;
    if (d.open) onOpen(d); else onClose(d);       // the live state: an open-and-close in one tick arrives closed
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true });

/* ---------- What stays above a dialog ---------- */
/* The top layer stacks in the order things open, so a dialog opened later covers what was already there.
   RULE: notifications show above dialogs: the stack is shown again over a new modal dialog. While a modal dialog is
   open the browser keeps everything outside it from being clicked, the notifications too; they still show.
   RULE: a lock screen (dialog.lock, a Panel or not) stays above all: a dialog or a notification that opens while it shows goes
   under it. The lock is closed and shown again at once; the page's own `close` handlers never hear about it. */
const liftToasts = () => {
  const t = document.getElementById('ayni-toasts');
  if (t?.matches(':popover-open')) { t.hidePopover(); t.showPopover(); }
};
const liftLock = () => {
  const lock = $('dialog.lock:modal');
  if (!lock) return;
  lock.ayniLifting = (lock.ayniLifting || 0) + 1;     // one queued `close` event per lift
  lock.close(); lock.showModal();
};
const onLockClose = (e) => { if (e.target.ayniLifting) { e.target.ayniLifting--; e.stopImmediatePropagation(); } };
const onToastsShown = (e) => { if (e.target.id === 'ayni-toasts' && e.newState === 'open') liftLock(); };

/* ---------- Moving ---------- */
/* RULE: on a computer or tablet a floating modal dialog moves by its title row (not by its buttons or fields), stays
   inside the window and opens centred every time. Phones and full-screen dialogs do not move. The dialog is centred
   by the browser, so it moves with a transform; nothing moves before DRAG_SLOP px, and the click that ends a drag is
   swallowed. */
const DRAG_SKIP = 'button, a, input, select, textarea, label, summary, [contenteditable], [role="button"], [role="switch"], [role="tab"]';
let drag = null, dragEnded = false;
const moveTo = (d, x, y) => { d.ayniDragX = x; d.ayniDragY = y; d.style.translate = x || y ? `${x}px ${y}px` : ''; };
/* The edge has to stay between MARGIN and (window - size - MARGIN); `base` is where it sits with no offset */
const clamp = (v, base, size, win) => {
  const a = DRAG_MARGIN - base, b = win - DRAG_MARGIN - size - base;
  return Math.min(Math.max(a, b), Math.max(Math.min(a, b), v));
};
const fullScreen = (d) => d.getBoundingClientRect().width >= document.documentElement.clientWidth;
const onDragDown = (e) => {
  dragEnded = false;
  if (drag || e.button || innerWidth <= DRAG_PHONE || e.target.closest?.(DRAG_SKIP)) return;
  const head = e.target.closest?.('dialog.panel > header, dialog.panel > form > header'), d = head?.closest('dialog');
  if (!d || !d.matches(':modal') || fullScreen(d)) return;
  const x = d.ayniDragX || 0, y = d.ayniDragY || 0, r = d.getBoundingClientRect();
  drag = { d, id: e.pointerId, moving: false, px: e.clientX, py: e.clientY, x, y, baseL: r.left - x, baseT: r.top - y, w: r.width, h: r.height };
  addEventListener('pointermove', onDragMove, true);
  addEventListener('pointerup', onDragUp, true);
  addEventListener('pointercancel', onDragUp, true);
};
const onDragMove = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
  if (!drag.moving) {
    if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
    drag.moving = true; drag.d.classList.add('dragging');
    getSelection()?.removeAllRanges();
  }
  const de = document.documentElement;
  moveTo(drag.d, clamp(drag.x + dx, drag.baseL, drag.w, de.clientWidth), clamp(drag.y + dy, drag.baseT, drag.h, de.clientHeight));
  e.preventDefault();
};
const onDragUp = (e) => {
  if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
  if (drag.moving) { drag.d.classList.remove('dragging'); dragEnded = true; }
  drag = null;
  removeEventListener('pointermove', onDragMove, true);
  removeEventListener('pointerup', onDragUp, true);
  removeEventListener('pointercancel', onDragUp, true);
};
const onDragClick = (e) => { if (dragEnded) { dragEnded = false; e.stopPropagation(); e.preventDefault(); } };
/* A smaller window (or the phone layout) must not leave a moved dialog off screen */
const reclamp = () => {
  const de = document.documentElement;
  for (const d of opened) {
    if (!d.ayniDragX && !d.ayniDragY) continue;
    if (innerWidth <= DRAG_PHONE || fullScreen(d)) { moveTo(d, 0, 0); continue; }
    const r = d.getBoundingClientRect();
    moveTo(d, clamp(d.ayniDragX, r.left - d.ayniDragX, r.width, de.clientWidth), clamp(d.ayniDragY, r.top - d.ayniDragY, r.height, de.clientHeight));
  }
};

/* ---------- Dialogs built in code ---------- */
/* A dialog button made in code, as the markup writes it: role 'close' (marked data-close: Esc presses it),
   'primary' (the default, check), 'danger' (bin) or '' (a plain round button); `ic` overrides the role's icon */
const dialogButton = (role, tip, ic) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = role === 'primary' || role === 'danger' ? 'btn ' + role : 'btn';
  if (role === 'close') b.setAttribute('data-close', '');
  b.innerHTML = icon(ic || { close: 'close', primary: 'check', danger: 'trash' }[role]);
  b.dataset.tip = tip; b.setAttribute('aria-label', tip);
  return b;
};

/* Ayni.dialog({ title, big, cls, id }) -> { dialog, body, footer, show(), close() }. show() adds it to the page and
   opens it as modal; close() closes and removes it, and answers true only the first time. A dialog closed some other
   way is removed too. place(buttons) puts a lone Close in the title row, any other set in the bottom row. An empty
   title row or bottom row does not show (it may be filled after the dialog opens). */
const dialog = ({ title, big = false, cls = '', id } = {}) => {
  const d = document.createElement('dialog');
  d.className = 'panel' + (big ? ' big' : '') + (cls ? ' ' + cls : '');
  if (id) d.id = id;
  d.setAttribute('autofocus', ''); d.tabIndex = -1;
  d.innerHTML = '<header></header><div class="body"></div><footer></footer>';
  const [header, body, footer] = d.children;
  if (title) { const h = document.createElement('h2'); h.textContent = title; header.append(h); d.setAttribute('aria-label', title); }
  let done = false;
  const close = () => { if (done) return false; done = true; if (d.open) d.close(); d.remove(); return true; };
  d.addEventListener('close', () => d.remove());
  const place = (buttons) => {
    if (buttons.length === 1 && buttons[0].hasAttribute('data-close')) { header.append(buttons[0]); footer.remove(); }
    else footer.append(...buttons);
  };
  const show = () => { document.body.append(d); Ayni.init(d); d.showModal(); };
  return { dialog: d, header, body, footer, place, show, close };
};

const text = (s) => { const p = document.createElement('p'); p.className = 'text'; p.textContent = s; return p; };

/* await Ayni.confirm({ title, body, confirm, danger, other, otherIcon, cancel }) -> true, false, or 'other' for the
   third choice. A danger action is never the default: the focus starts on Cancel. Esc presses Cancel. */
const confirm = (o = {}) => new Promise((resolve) => {
  if (typeof o === 'string') o = { body: o };
  const dl = dialog({ title: o.title });
  if (o.body != null && o.body !== '') dl.body.append(text(String(o.body)));
  const finish = (v) => { if (dl.close()) resolve(v); };
  const cancel = dialogButton('close', o.cancel || tx('cancel'));
  const other = o.other ? dialogButton('', o.other, o.otherIcon || 'check') : null;
  const ok = dialogButton(o.danger ? 'danger' : 'primary', o.confirm || tx('accept'));
  dl.place([cancel, ...(other ? [other] : []), ok]);
  cancel.addEventListener('click', () => finish(false));
  other?.addEventListener('click', () => finish('other'));
  ok.addEventListener('click', () => finish(true));
  dl.dialog.addEventListener('close', () => finish(false));
  if (o.danger) cancel.autofocus = true;      // the safe choice starts focused
  dl.show();
});

/* await Ayni.alert({ title, body }): a message; Close sits in the title row */
const alert = (o = {}) => new Promise((resolve) => {
  if (typeof o === 'string') o = { body: o };
  const dl = dialog({ title: o.title });
  if (o.body != null && o.body !== '') dl.body.append(text(String(o.body)));
  const x = dialogButton('close', o.confirm || tx('close'));
  dl.place([x]);
  const finish = () => { if (dl.close()) resolve(); };
  x.addEventListener('click', finish);
  dl.dialog.addEventListener('close', finish);
  dl.show();
});

/* await Ayni.ask({ title, label, placeholder, value, hint, max, okTip, ids: { input, ok, cancel }, check }) -> the
   trimmed text, or null when cancelled. The text it starts with is selected. An empty field is never an answer: the
   Accept button stays faded until there is text.
   check(text) returns the answer, or false to keep the dialog open (check says why); the field is then selected. */
/* Ayni.ask({ password: true, title, lead, label, verify, min, okTip, noTip }): the password, exactly as typed, or null.
   Nothing is kept: the dialog is gone before the promise resolves. verify asks for a NEW password twice (there is no way
   back from a typo) and refuses one shorter than min (8); else only an empty box is refused. Fields are ayni-ask-pw and
   ayni-ask-repeat; their eye needs the fields family */
const askPassword = (o) => new Promise((resolve) => {
  const dl = dialog({ title: o.title }), min = o.min || 8;
  if (o.lead) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = o.lead; dl.body.append(p); }
  const field = (text, id) => {
    const box = document.createElement('div'), l = document.createElement('label'), g = document.createElement('div'), i = document.createElement('input');
    box.className = 'field'; g.className = 'input-group'; l.textContent = text; l.htmlFor = id;
    i.className = 'input'; i.type = 'password'; i.id = id;
    /* The browser's password manager offers to make a new one, or to fill the one that exists */
    i.autocomplete = o.verify ? 'new-password' : 'current-password';
    g.append(i);
    if (Ayni.dateField) { const eye = document.createElement('button'); eye.type = 'button'; eye.className = 'btn'; eye.setAttribute('data-reveal', ''); g.append(eye); }
    box.append(l, g); dl.body.append(box);
    return i;
  };
  const one = field(o.label || tx('password'), 'ayni-ask-pw'), two = o.verify ? field(tx('password.repeat'), 'ayni-ask-repeat') : null;
  const warn = document.createElement('p'); warn.className = 'form-error'; warn.hidden = true; dl.body.append(warn);
  const no = dialogButton('close', o.noTip || tx('cancel')), ok = dialogButton('primary', o.okTip || tx('accept'));
  dl.place([no, ok]);
  const say = (text) => { warn.textContent = text; warn.hidden = false; };
  const finish = (v) => { if (dl.close()) resolve(v); };
  ok.addEventListener('click', () => {
    const pw = one.value;
    /* The length rule belongs to a new password: one that exists is whatever it is */
    if (two) {
      if (pw.length < min) { say(txf('password.tooShort', { n: min })); one.focus(); return; }
      if (two.value !== pw) { say(tx('password.noMatch')); two.value = ''; two.focus(); return; }
    } else if (!pw) { one.focus(); return; }
    finish(pw);
  });
  no.addEventListener('click', () => finish(null));
  dl.dialog.addEventListener('close', () => finish(null));
  Ayni.init(dl.dialog);
  dl.show();
});

const ask = (o = {}) => o.password ? askPassword(o) : new Promise((resolve) => {
  const ids = o.ids || {};
  const dl = dialog({ title: o.title });
  const field = document.createElement('div'); field.className = 'field';
  const input = document.createElement('input');
  input.type = 'text'; input.autocomplete = 'off'; input.className = 'input'; input.value = o.value || '';
  input.id = ids.input || 'ayni-ask-' + ++askN;
  if (o.max) input.maxLength = o.max;
  if (o.label) { const l = document.createElement('label'); l.textContent = o.label; l.htmlFor = input.id; field.append(l); }
  if (o.placeholder) { input.placeholder = o.placeholder; input.setAttribute('aria-label', o.placeholder); }
  field.append(input);
  dl.body.append(field);
  if (o.hint) { const h = document.createElement('p'); h.className = 'hint'; h.textContent = o.hint; dl.body.append(h); }
  const tip = o.okTip || tx('accept');
  const no = dialogButton('close', tx('cancel')), ok = dialogButton('primary', tip);
  if (ids.cancel) no.id = ids.cancel;
  if (ids.ok) ok.id = ids.ok;
  dl.place([no, ok]);
  const finish = (v) => { if (dl.close()) resolve(v); };
  const submit = () => {
    let v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (o.check) { const r = o.check(v); if (r === false) { input.select(); return; } v = r; }
    finish(v);
  };
  /* RULE: the default button stays faded (but focusable) while the field is empty, and its tooltip says why */
  const sync = () => {
    const empty = !input.value.trim();
    ok.setAttribute('aria-disabled', empty);
    Ayni.setTip(ok, empty ? txf('needText', { what: tip }) : tip);
  };
  input.addEventListener('input', sync); sync();
  no.addEventListener('click', () => finish(null));
  ok.addEventListener('click', submit);
  dl.dialog.addEventListener('close', () => finish(null));
  input.autofocus = true;
  dl.show();
  input.select();                             // the text it starts with is replaced by typing
});

/* ---------- A field saved as it changes ---------- */
/* Ayni.autoSave(field, save, { wait, msg, done }) for dialogs without Accept: save(value) runs on change, and after
   `wait` ms (700) of typing in a text field; one save at a time, in order. A failed save puts the last good value
   back (switches, lists, list pickers) and shows "Could not save." in `msg`, an element inside the dialog. Returns
   { saved(value) } to tell it a value the app stored itself. */
const autoSave = (field, save, o = {}) => {
  /* A list picker (ayni-pickers.js): its value, its ayni:change, faded while it saves */
  const pk = field.matches?.('.picker') && Ayni.picker ? Ayni.picker(field) : null;
  const box = field.type === 'checkbox';
  const typed = !pk && (field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && !box && field.type !== 'radio'));
  const get = () => (pk ? pk.value : box ? field.checked : field.value);
  const put = (v) => { if (pk) pk.set(v); else if (box) field.checked = v; else field.value = v; };
  const lock = (on) => { if (pk) pk.disabled = on; else field.disabled = on; };
  const say = (s) => { if (o.msg) { o.msg.textContent = s || ''; o.msg.hidden = !s; } };
  let good = get(), timer = 0, queue = Promise.resolve();
  const run = () => {
    clearTimeout(timer); timer = 0;
    queue = queue.then(() => {
      const v = get();
      if (v === good) return;
      if (!typed) lock(true);
      say('');
      return Promise.resolve().then(() => save(v))
        .then(() => { good = v; o.done?.(v); }, () => { if (!typed) put(good); say(o.fail || tx('saveFailed')); })
        .then(() => { lock(false); });
    });
  };
  field.addEventListener(pk ? 'ayni:change' : 'change', run);
  if (typed) field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, o.wait || 700); });
  return { saved: (v) => { good = v; } };
};

/* ---------- Page-wide behaviour, set up once ---------- */
const setup = () => {
  watch();
  $$('dialog.panel[open]').forEach(onOpen);
  /* Any element with data-open-dialog="id" opens that dialog as modal. RULE: only the dialog's own buttons and Esc
     close it; a click on the dimmed page around it does nothing. */
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-open-dialog]'); if (b) $('#' + b.dataset.openDialog)?.showModal(); });
  document.addEventListener('keydown', onEsc);
  document.addEventListener('click', onCloseClick);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('close', onLockClose, true);
  document.addEventListener('toggle', onToastsShown, true);
  addEventListener('pointerdown', onDragDown, true);
  addEventListener('click', onDragClick, true);
  addEventListener('resize', reclamp);
};

/* Every dialog in the page: the browser focuses the dialog itself on open (see The first field) */
const init = (root) => each(root, 'dialog.panel', 'dialog', (d) => { if (!d.hasAttribute('autofocus')) d.setAttribute('autofocus', ''); if (!d.hasAttribute('tabindex')) d.tabIndex = -1; });

Object.assign(Ayni, { dialog, dialogButton, confirm, alert, ask, autoSave });
Ayni.core.family({ setup, init });
})();
