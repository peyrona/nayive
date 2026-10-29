/* Ayni library 0.1.0, buttons family: round buttons, toggles, the second action, busy and disabled buttons, switches,
   check boxes and radio buttons. Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-base.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-buttons.js" defer></script>
   The look is in ayni-buttons.css; the rules are chapters 3 and 5 of the guidelines. */
(() => {
'use strict';
const { $, $$ } = Ayni;
const { fire, each, tx, txf, isRO, isTouch, HOLD_MS, DBL_MS, retip } = Ayni.core;

/* Busy buttons: setBusy(b, 'Saving…') swaps the icon for a spinner; setBusy(b, false) brings the icon and tooltip back
   (a button that had no tooltip has none again) */
const setBusy = (b, label) => {
  if (label) {
    if (!('idleTip' in b.dataset)) b.dataset.idleTip = b.dataset.tip ?? '';
    b.dataset.tip = label; b.setAttribute('aria-busy', 'true');
    if (!$('.btn-spin', b)) b.insertAdjacentHTML('beforeend', '<span class="btn-spin" aria-hidden="true"></span>');
  } else {
    b.removeAttribute('aria-busy'); $('.btn-spin', b)?.remove();
    if ('idleTip' in b.dataset) { if (b.dataset.idleTip) b.dataset.tip = b.dataset.idleTip; else delete b.dataset.tip; delete b.dataset.idleTip; }
  }
  retip(b);
};

/* ---------- Second action: double-click, long tap (touch/pen), Shift+Enter ---------- */
/* A button with data-alt="what the second action does" fires ayni:press with { second, label } instead of acting on
   its own click: the first action has second false and label = data-tip, the second has second true. */
const initAlt = (b) => {
  const base = b.dataset.tip, alt = b.dataset.alt;
  /* The tooltip names every way to reach the second action on this device */
  b.setTip = () => { b.dataset.tip = txf('alt.tip', { base, how: tx(isTouch() ? 'alt.hold' : 'alt.keys'), alt }); };
  b.setTip();
  b.setAttribute('aria-description', `Shift+Enter: ${alt}`);
  b.style.setProperty('--hold-ms', HOLD_MS + 'ms');
  const run = (second) => fire(b, 'ayni:press', { second, label: second ? alt : base });
  let timer, held = false;
  const cancel = () => { clearTimeout(timer); b.classList.remove('holding'); };
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !isTouch()) return;
    held = false; b.classList.add('holding');
    timer = setTimeout(() => { held = true; b.classList.remove('holding'); navigator.vibrate?.(15); run(true); }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => b.addEventListener(t, cancel));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  /* With a mouse, a single click waits DBL_MS to see whether a second click follows; a double-click runs only the
     second action. Taps (touch) and Enter/Space (detail 0) act at once. */
  let clickTimer;
  b.addEventListener('click', (e) => {
    if (held) { held = false; return; }
    if (e.detail === 0 || isTouch()) { run(false); return; }
    clearTimeout(clickTimer);
    if (e.detail === 1) clickTimer = setTimeout(() => run(false), DBL_MS);
  });
  b.addEventListener('dblclick', () => { if (!isTouch()) { clearTimeout(clickTimer); run(true); } });
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); run(true); } });
};

/* ---------- Default button ---------- */
/* RULE: Enter inside a Panel clicks that Panel's default button (the .primary one in its own header or footer).
   Not in a text area (new line), not on another button or item (Enter presses or picks that), and not while a list or
   menu is open (the control handles Enter first and marks it handled). */
const defaultButton = (panel) => $$(':scope > footer .btn.primary, :scope > form > footer .btn.primary, :scope > header .btn.primary, :scope > form > header .btn.primary', panel)[0];
const onEnter = (e) => {
  if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t.closest('textarea, [contenteditable], button, a[href], summary, [role="button"], [role="tab"], [role^="menuitem"], [role="option"], [role="treeitem"], [role="listbox"], [role="tree"], [role="combobox"][aria-expanded="true"]')) return;
  const panel = t.closest('.panel'), b = panel && defaultButton(panel);
  if (!b || b.getAttribute('aria-disabled') === 'true') return;
  e.preventDefault(); b.click();
};

/* ---------- Set up once ---------- */
const setup = () => {
  document.addEventListener('keydown', onEnter);
  /* Disabled buttons (aria-disabled) stay focusable but do nothing: clicks, Enter and Space are stopped here */
  addEventListener('click', (e) => { if (e.target.closest('button[aria-disabled="true"], button[aria-busy="true"]')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  /* Read-only check boxes, radios and switches show their value but cannot change */
  addEventListener('click', (e) => { const l = e.target.closest('label'), i = e.target.matches('input') ? e.target : l?.control; if (isRO(i) && /checkbox|radio/.test(i.type)) e.preventDefault(); }, true);
  addEventListener('keydown', (e) => { if (isRO(e.target) && e.target.type === 'radio' && /^(Arrow|Page|Home|End)/.test(e.key)) e.preventDefault(); }, true);

  /* Two-sided switch (.switch-pair): two radios around one track. A click on the track or Space flips to the other side;
     Left/Up pick the first side and Right/Down the second (no wrapping); clicking a label picks that side (native) */
  const pickSide = (pair, i) => {
    const r = $$(':scope > label > input', pair)[i ?? ($(':scope > label:first-of-type > input', pair).checked ? 1 : 0)];
    if (!r || r.disabled || isRO(r)) return;
    r.focus();
    if (r.checked) return;
    r.checked = true; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true }));
  };
  addEventListener('click', (e) => { const t = e.target.closest('.switch-pair > .track'); if (t) pickSide(t.parentElement); });
  addEventListener('keydown', (e) => {
    const pair = e.target.closest?.('.switch-pair'); if (!pair || !e.target.matches('input') || e.altKey || e.ctrlKey || e.metaKey) return;
    const side = { ' ': null, ArrowLeft: 0, ArrowUp: 0, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (side === undefined) return;
    e.preventDefault(); pickSide(pair, side ?? undefined);
  });

  /* On a touch device the second action is a hold: its tooltip (the Help dialog's text) says so */
  document.addEventListener('ayni:touch', () => $$('.btn[data-alt]').forEach((b) => b.setTip?.()));
};

/* ---------- Wire up ---------- */
const init = (root) => {
  /* Rule check: a danger button is never the default (no .primary, no autofocus) */
  each(root, '.btn.danger.primary, .btn.danger[autofocus]', 'danger', (b) => {
    console.warn('Ayni rule: a danger button cannot be the default button', b);
    b.classList.remove('primary'); b.removeAttribute('autofocus');
  });
  each(root, '.btn[popovertarget]:not([aria-haspopup])', 'haspopup', (b) => b.setAttribute('aria-haspopup', 'true'));
  /* Rule check: a button that opens a popup (menu, popover, dialog) has no second action */
  each(root, '.btn[data-alt][popovertarget], .btn[data-alt][data-open-dialog], .btn[data-alt][aria-haspopup]', 'altrule', (b) => {
    console.warn('Ayni rule: a button that opens a popup cannot have a second action', b);
    b.removeAttribute('data-alt');
  });
  each(root, '[data-toggle]', 'toggle', (b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true')));
  each(root, '.btn[data-alt]', 'alt', initAlt);
  /* A round button's accessible name is its tooltip when the page gives none (a text button's is its label) */
  each(root, '.btn[data-tip]:not([aria-label]):not(.text)', 'label', (b) => b.setAttribute('aria-label', b.dataset.tip));
};

Object.assign(Ayni, { setBusy });
Ayni.core.family({ setup, init });
})();
