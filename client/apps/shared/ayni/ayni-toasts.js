/* Ayni library 0.2.0, notifications family: notifications (toasts) with Undo, and progress notifications.
   Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-base.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-toasts.js" defer></script>
   The look is in ayni-toasts.css; the rules are chapter 11.2 and 11.3 of the guidelines. */
(() => {
'use strict';
const { $, $$, isMac, icon } = Ayni;
const { tx, txf, layer } = Ayni.core;

let toasts;
const TIME_MS = 6000, PROGRESS_WAIT_MS = 600, MAX_SHOWN = 3;

/* The stack, made the first time it is needed: a page may show a notification before Ayni has started */
const stack = () => toasts || (toasts = layer('ayni-toasts', `<div class="toasts" popover="manual" role="region" aria-label="${tx('notifications')}" id="ayni-toasts"></div>`));

/* The stack is shown while it holds anything */
const show = () => { if (!stack().matches(':popover-open')) toasts.showPopover(); };
const hideIfEmpty = () => { if (!stack().children.length && toasts.matches(':popover-open')) toasts.hidePopover(); };

/* RULE: at most 3 notifications show (progress notifications do not count). A fourth makes the oldest leave; errors
   and the Undo are the last to go. */
const trim = () => {
  const shown = $$(':scope > .toast:not(.progress)', stack());
  while (shown.length > MAX_SHOWN) {
    const out = shown.find((x) => !x.matches('.err, .undo')) || shown.find((x) => !x.matches('.undo')) || shown[0];
    shown.splice(shown.indexOf(out), 1); out.leave();
  }
};

/* ---------- Undo ---------- */
/* RULE: one Undo at a time. The Undo on show becomes FINAL when its time is up, the user closes it, a newer Undo
   takes its place, the page calls Ayni.settleUndo() (an editor or a game on its next key), or the page closes.
   Then its `final` runs, once. News never makes it final: other notifications stack beside it. */
let pending = null;                 // { close, final, keepOnLeave } of the Undo on show

/* Cleared BEFORE the call: a `final` that shows a notification must not settle itself again */
const settle = (leaving = false) => {
  const p = pending; if (!p) return;
  pending = null;
  if (!leaving) p.close();
  if (p.final && !(leaving && p.keepOnLeave)) {
    try { if (leaving) withKeepalive(p.final); else p.final(); } catch (e) { console.error(e); }
  }
};

/* A fetch started while the page is going away is cancelled with it unless it carries keepalive (small bodies only:
   browsers cap them at 64 KB). So while a closing page runs its last `final`, every fetch gets the flag. Only the
   fetches started in that same tick: one after an await is lost. */
const withKeepalive = (fn) => {
  const real = window.fetch;
  if (!real) { fn(); return; }
  window.fetch = (url, init) => {
    const o = { ...init }, body = o.body;
    if (body == null || (typeof body === 'string' && body.length < 60000)) o.keepalive = true;
    return real.call(window, url, o);
  };
  try { fn(); } finally { window.fetch = real; }
};

/* ---------- Notifications ---------- */
/* Ayni.toast(kind, text, { undo, final, keepOnLeave, action: { label, icon, run }, persist }) -> { close() }
   kind is info, ok, warn or err; an err stays until closed. `undo` adds the Undo button; `final` runs when that Undo
   is final; keepOnLeave: a closing page does not run `final` (a sent mail whose draft keeps it). */
const toast = (kind, text, { undo, final, keepOnLeave = false, action, persist = kind === 'err' } = {}) => {
  if (undo) action = { label: tx('undo'), icon: 'undo', run: undo };
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = `${icon({ info: 'info', ok: 'ok', warn: 'warn', err: 'error' }[kind])}<p></p>`
    + (action ? `<button class="btn text sm act">${icon(action.icon)}<span class="label"></span></button>` : '')
    + `<button class="btn dismiss" aria-label="${tx('dismiss')}" data-tip="${tx('dismiss')}">${icon('close')}</button>`;
  $('p', t).textContent = text;

  let timer, gone = false, hovered = false, focused = false;
  const close = () => { if (gone) return; gone = true; clearTimeout(timer); t.remove(); hideIfEmpty(); };
  const mine = undo ? { close, final, keepOnLeave } : null;
  /* Closing an Undo, or its time running out, makes it final */
  const leave = () => { if (mine && pending === mine) settle(); else close(); };
  /* The time stops while the pointer is on it or the focus is inside it */
  const arm = () => { clearTimeout(timer); if (!persist && !hovered && !focused) timer = setTimeout(leave, TIME_MS); };

  if (undo) {
    settle();                       // one Undo at a time: the older one is final now
    pending = mine; t.classList.add('undo');
    const hint = document.createElement('small'); hint.className = 'undo-key'; hint.textContent = txf('undoKey', { key: isMac ? '⌘Z' : 'Ctrl+Z' });
    $('p', t).append(hint);
  }
  if (action) {
    const b = $('.act', t);
    $('.label', b).textContent = action.label;
    b.onclick = () => {
      if (mine) { if (pending !== mine) return; pending = null; }   // taken back: `final` never runs
      close(); action.run();
    };
  }
  $('.dismiss', t).onclick = leave;
  t.addEventListener('pointerenter', () => { hovered = true; arm(); });
  t.addEventListener('pointerleave', () => { hovered = false; arm(); });
  t.addEventListener('focusin', () => { focused = true; arm(); });
  t.addEventListener('focusout', (e) => { if (!t.contains(e.relatedTarget)) { focused = false; arm(); } });
  t.leave = leave;
  show(); toasts.append(t); arm(); trim();
  return { close: leave };
};

/* Ayni.settleUndo(): the Undo on show (if any) is final now */
const settleUndo = () => settle();

/* ---------- Progress notifications ---------- */
/* Ayni.progress(text, { pct, onStop }) -> { set(text, pct), end() }. pct null: no end known, the fill slides.
   onStop adds a Stop button. It shows only once the job has run 600 ms, and stays until end(). */
const progress = (text, { pct = null, onStop } = {}) => {
  const t = document.createElement('div');
  t.className = 'toast progress'; t.setAttribute('role', 'progressbar');
  t.setAttribute('aria-valuemin', '0'); t.setAttribute('aria-valuemax', '100');
  t.innerHTML = '<p></p><span class="toast-track"><span class="toast-fill"></span></span>'
    + (onStop ? `<button class="btn stop" aria-label="${tx('stop')}" data-tip="${tx('stop')}">${icon('close')}</button>` : '');
  if (onStop) { const b = $('.stop', t); b.onclick = () => { if (b.ariaDisabled === 'true') return; b.ariaDisabled = 'true'; onStop(); }; }

  let ended = false;
  const set = (txt, p) => {
    if (ended) return;
    $('p', t).textContent = txt; t.setAttribute('aria-valuetext', txt);
    const sliding = p == null; t.classList.toggle('sliding', sliding);
    if (sliding) { t.removeAttribute('aria-valuenow'); $('.toast-fill', t).style.width = ''; return; }
    p = Math.max(0, Math.min(100, Math.floor(p)));
    t.setAttribute('aria-valuenow', String(p)); $('.toast-fill', t).style.width = p + '%';
  };
  set(text, pct);
  const timer = setTimeout(() => { if (!ended) { show(); toasts.prepend(t); } }, PROGRESS_WAIT_MS);
  const end = () => { if (ended) return; ended = true; clearTimeout(timer); t.remove(); hideIfEmpty(); };
  return { set, end };
};

/* ---------- Wire up ---------- */
const setup = () => {
  stack().setAttribute('aria-label', tx('notifications'));   // the texts are in now

  /* Ctrl+Z (⌘Z) runs the Undo on show, outside text fields; a page that handles the key itself calls preventDefault */
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !pending || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;   // text fields keep their own undo
    e.preventDefault(); $$('.toast.undo .act', toasts).at(-1)?.click();
  });

  /* A closing page: the Undo on show is final */
  addEventListener('pagehide', () => settle(true));
};

Object.assign(Ayni, { toast, settleUndo, progress });
Ayni.core.family({ setup });
})();
