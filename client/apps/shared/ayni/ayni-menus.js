/* Ayni library 0.1.0, menus family: menus and pop-up menus (markup or built in code), one level of submenus, the
   menu bar, the long tap, toolbars (one Tab stop, tools that leave an overfull row by rank into one More menu), tool
   groups and popups with controls, placing them and closing them on scroll, resize and window blur.
   Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-base.js and ayni-buttons.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-buttons.js" defer></script>
     <script src="ayni-menus.js" defer></script>
   The look is in ayni-menus.css; the rules are chapter 9 of the guidelines. */
(() => {
'use strict';
const { $, $$, isMac, icon } = Ayni;
const { fire, once, each, tx, iconName, layer, isTouch, HOLD_MS, retip } = Ayni.core;

const PAD_SLACK = 8;            // the most a touch hit area sticks out past a 30 px tool: (44 - 30) / 2, rounded up
const MOVE_SLOP = 10;           // px a finger may move before a long tap is cancelled
/* A short buzz when a long tap takes; the browser refuses it (and says so) before the user has interacted with the page */
const buzz = () => { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(15); };

/* ---------- Who opened what ---------- */
/* invoker is the button that opened the current popup (any [popovertarget]); ctxPoint is set for pop-up menus.
   byKeys says whether the last thing the user did was a key: only then does a menu take the focus when it opens */
let invoker = null, ctxPoint = null, ctxName = null, ctxReturn = null, ctxMenu = null, byKeys = false;

/* Ayni.place(popup, at): below its button (above when there is no room), or at the pointer for a pop-up menu, kept on
   screen. at (optional) is the element or rectangle to hang it from, or a point { x, y }.
   RULE: what opens from the taskbar opens off it, on the desktop's side (17.1): one taller than the room it has scrolls */
const offBar = (menu, r, from) => {
  const bar = from?.closest?.('.taskbar'), edge = bar?.closest('.desktop')?.dataset.edge || 'bottom';
  if (!bar) return null;
  const b = bar.getBoundingClientRect();
  /* The room it has limits it; it never lifts the popup's own cap */
  menu.style.maxHeight = '';
  const cap = parseFloat(getComputedStyle(menu).maxHeight) || Infinity;
  menu.style.maxHeight = Math.min(cap, Math.max(120, edge === 'top' ? innerHeight - b.bottom - 12 : edge === 'bottom' ? b.top - 12 : innerHeight - 16)) + 'px';
  const m = menu.getBoundingClientRect();
  if (edge === 'left') return { x: b.right + 4, y: r.top };
  if (edge === 'right') return { x: b.left - m.width - 4, y: r.top };
  return { x: r.left + r.width / 2 > innerWidth / 2 ? r.right - m.width : r.left, y: edge === 'top' ? b.bottom + 4 : b.top - m.height - 4 };
};
const place = (menu, at) => {
  let m = menu.getBoundingClientRect();
  let x, y;
  const pt = at ? ('getBoundingClientRect' in at || 'bottom' in at ? null : at) : ctxPoint;
  if (pt) { x = pt.x; y = pt.y; }
  else {
    /* RULE: a popup lines up with the edge of its button on the side the button sits: a button in the right half of
       the screen (a title row's More) gets a popup that ends where the button ends */
    const r = at ? (at.getBoundingClientRect?.() || at) : invoker.getBoundingClientRect();
    const off = offBar(menu, r, at?.getBoundingClientRect ? at : invoker);
    if (off) { ({ x, y } = off); m = menu.getBoundingClientRect(); }
    else {
      x = r.left + r.width / 2 > innerWidth / 2 ? r.right - m.width : r.left;
      y = r.bottom + 4; if (y + m.height > innerHeight) y = r.top - m.height - 4;
    }
  }
  const edge = innerWidth < 360 ? 4 : 8; // very narrow phones: popups may come closer to the edge
  menu.style.left = Math.max(edge, Math.min(x, innerWidth - m.width - edge)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - m.height - 8)) + 'px';
};
/* A submenu: right of its item, or left of it when there is no room, its first item level with the item. On a screen
   too narrow for either (a phone) it opens just below its item, so the item stays in sight */
const placeSub = (sub, item) => {
  const r = item.getBoundingClientRect(), m = sub.getBoundingClientRect();
  let x = r.right - 2, y = r.top - 4;
  if (x + m.width > innerWidth - 8) x = r.left - m.width + 2;
  if (x < 8) { x = Math.min(r.left + 16, innerWidth - m.width - 8); y = r.bottom + 2; }
  sub.style.left = Math.max(8, x) + 'px';
  sub.style.top = Math.max(8, Math.min(y, innerHeight - m.height - 8)) + 'px';
};

/* RULE: a menu or popup opened while a modal dialog is open lives in that dialog. Everything outside the topmost modal
   dialog is inert, the top layer too, so a menu left in the page would show but take no press. It goes back to the
   page when no dialog is open. A submenu travels inside its menu */
const host = (pop) => {
  if (!pop || pop.parentElement?.closest('.panel.menu')) return pop;
  const d = $$('dialog[open]').filter((x) => x.matches(':modal')).at(-1);
  if (d) { if (!d.contains(pop)) d.append(pop); }
  else if (pop.parentElement?.closest('dialog:not([open])')) document.body.append(pop);
  return pop;
};

/* ---------- Menus ---------- */
const inBar = (b) => b?.parentElement?.getAttribute('role') === 'menubar';
const barItemsOf = (b) => $$(':scope > button', b.parentElement).filter((x) => x.getClientRects().length);
const openMenu = (btn) => { invoker = btn; ctxPoint = null; host($('#' + btn.getAttribute('popovertarget'))).showPopover(); };
/* Ayni.showPopup(popup, button): opens a popup from code as its button would: placed by it, the focus coming back to it.
   Called while a button or a finger is down (a long tap), it opens on release, or that release would close it as an
   outside click; a phone's own long-press gesture may cancel the pointer instead */
const showPopup = (pop, btn) => {
  const show = () => { invoker = btn; ctxPoint = null; ctxName = null; host(pop).showPopover(); };
  if (!down) { show(); return; }
  const go = () => { removeEventListener('pointerup', go, true); removeEventListener('pointercancel', go, true); setTimeout(show); };
  addEventListener('pointerup', go, true); addEventListener('pointercancel', go, true);
};
const ownItems = (menu) => $$('[role^="menuitem"]', menu).filter((x) => x.closest('.panel.menu') === menu);
const subOf = (it) => it?.dataset.submenu && document.getElementById(it.dataset.submenu);
const rootOf = (menu) => { let m = menu; while (m.parentElement?.closest('.panel.menu')) m = m.parentElement.closest('.panel.menu'); return m; };
const openSub = (it, keys) => {
  const sub = subOf(it); if (!sub || it.getAttribute('aria-disabled') === 'true') return;
  if (sub.matches(':popover-open')) { if (keys) ownItems(sub).find((x) => x.getAttribute('aria-disabled') !== 'true')?.focus(); return; }
  sub.ayniItem = it; sub.ayniKeys = keys; sub.showPopover();
};
const closeSubs = (menu, except) => ownItems(menu).forEach((x) => { const s = subOf(x); if (s && s !== except && s.matches(':popover-open')) s.hidePopover(); });
/* RULE: the page keeps its focus. A menu opened by the mouse or a finger leaves the focus where it is (an editor's
   caret, a sheet's selected cells), and a press inside it does not take it; opened from the keyboard, its first item
   takes the focus. Closing gives the focus back to what opened it only when the focus was in the menu */
const takesFocus = (menu) => (menu.ayniItem ? menu.ayniKeys : byKeys);

/* RULE: every row of a menu lines up. When any row has an icon, a row without one keeps an empty icon slot; when any
   row can be ticked (check and radio items), every row gets the tick column, before the icon, and the icon stays */
const SLOT = '<span class="icon none" aria-hidden="true"></span>';
const TICK = () => `<span class="tick" aria-hidden="true">${icon('check')}</span>`;
const shapeRows = (menu) => {
  const rows = ownItems(menu), isIcon = (x) => $(':scope > .icon:not(.none)', x);
  const ticks = rows.some((x) => /^menuitem(checkbox|radio)$/.test(x.getAttribute('role')));
  const icons = rows.some(isIcon);
  rows.forEach((x) => {
    if (ticks && !$(':scope > .tick', x)) x.insertAdjacentHTML('afterbegin', TICK());
    if (!ticks) $(':scope > .tick', x)?.remove();
    const none = $(':scope > .icon.none', x);
    if (icons && !isIcon(x) && !none) { const tk = $(':scope > .tick', x); if (tk) tk.insertAdjacentHTML('afterend', SLOT); else x.insertAdjacentHTML('afterbegin', SLOT); }
    if (!icons) none?.remove();
  });
};

/* A menu fires ayni:action with { item, menu, act } when an item is chosen (menu is the menu's name, or the name of
   the thing a pop-up menu was opened on), and ayni:choose with the item when a menuitemradio is picked */
const initMenu = (menu) => {
  /* The rows the keys move through: not disabled, and showing (a page may hide a row) */
  const items = () => ownItems(menu).filter((x) => x.getAttribute('aria-disabled') !== 'true' && x.getClientRects().length);
  /* One level of submenus: an item with data-submenu="id" opens that menu, which moves inside this one, so that the
     browser keeps this one open while it shows */
  ownItems(menu).forEach((it) => { const s = subOf(it); if (s) { it.setAttribute('aria-haspopup', 'menu'); it.setAttribute('aria-expanded', 'false'); if (s.parentElement !== menu) menu.append(s); } });
  shapeRows(menu);
  menu.addEventListener('beforetoggle', (e) => { if (e.target === menu && e.newState === 'open') shapeRows(menu); });
  menu.addEventListener('toggle', (e) => {
    if (e.target !== menu) return;
    const open = e.newState === 'open', item = menu.ayniItem;
    if (item) {
      item.setAttribute('aria-expanded', open);
      if (open) { placeSub(menu, item); if (takesFocus(menu)) items()[0]?.focus(); }
      else if (menu.contains(document.activeElement) && item.closest('.panel.menu')?.matches(':popover-open')) item.focus();
      if (!open) menu.ayniItem = null;
      return;
    }
    const bar = inBar(invoker) ? invoker : null;
    if (bar) bar.setAttribute('aria-expanded', open);
    if (open) { place(menu); if (takesFocus(menu)) items()[0]?.focus(); return; }
    const a = document.activeElement;
    if (!menu.dataset.switching && (menu.contains(a) || a === document.body)) (ctxPoint ? ctxReturn : invoker)?.focus();
  });
  menu.addEventListener('keydown', (e) => {
    /* A control in a menu row (a list picker) handled the key itself */
    if (e.target.closest('.panel.menu') !== menu || e.defaultPrevented) return;
    const list = items(), i = list.indexOf(document.activeElement), cur = list[i];
    const n = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (n !== undefined) { e.preventDefault(); list[(n + list.length) % list.length].focus(); return; }
    if (e.key === 'Tab') { e.preventDefault(); rootOf(menu).hidePopover(); return; }
    if (e.key === 'ArrowRight' && subOf(cur)) { e.preventDefault(); e.stopPropagation(); openSub(cur, true); return; }
    if (e.key === 'ArrowLeft' && menu.ayniItem) { e.preventDefault(); e.stopPropagation(); menu.hidePopover(); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && inBar(invoker) && !menu.ayniItem) {
      e.preventDefault();
      const barItems = barItemsOf(invoker), j = barItems.indexOf(invoker), next = barItems[(j + (e.key === 'ArrowRight' ? 1 : -1) + barItems.length) % barItems.length];
      menu.dataset.switching = '1'; menu.hidePopover(); delete menu.dataset.switching; invoker.setAttribute('aria-expanded', 'false');
      openMenu(next);
    }
  });
  /* The pointer resting on an item opens its submenu, and closes any other */
  menu.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const it = e.target.closest('[role^="menuitem"]'); if (!it || it.closest('.panel.menu') !== menu) return;
    closeSubs(menu, subOf(it)); if (subOf(it)) openSub(it, false);
  });
  menu.addEventListener('mousedown', (e) => { if (!e.target.closest('input, select, textarea')) e.preventDefault(); });
  menu.addEventListener('click', (e) => {
    const it = e.target.closest('[role^="menuitem"]'); if (!it || it.closest('.panel.menu') !== menu) return;
    if (it.getAttribute('aria-disabled') === 'true') return;
    if (subOf(it)) { openSub(it, e.detail === 0); return; }
    if (it.getAttribute('role') === 'menuitemradio') {
      ownItems(menu).filter((x) => x.getAttribute('role') === 'menuitemradio').forEach((x) => x.setAttribute('aria-checked', x === it));
      fire(menu, 'ayni:choose', it);
    }
    if (it.getAttribute('role') === 'menuitemcheckbox') it.setAttribute('aria-checked', it.getAttribute('aria-checked') !== 'true');
    /* The menu closes first; then the page hears of the pick and the row runs, at once (code that clicks a row and
       goes on finds it done). The focus goes back to the opener only if nothing the row did took it */
    const top = rootOf(menu), row = it.ayniRow;
    it.ayniRect = it.getBoundingClientRect();
    top.hidePopover();
    fire(menu, 'ayni:action', { item: it, menu: top === ctxMenu && ctxName ? ctxName : menu.getAttribute('aria-label'), act: it.dataset.act });
    row?.run?.(e);
  });
};

/* Menu bar: arrows move, Down opens, hovering switches while a menu is open; F10 focuses the visible menu bar */
const initMenubar = (bar) => {
  /* Read each time: a page may build its bar again (another language, another set of menus) */
  const items = () => $$(':scope > button', bar).filter((b) => b.getClientRects().length);
  items().forEach((b, i) => { b.tabIndex = i ? -1 : 0; });
  new MutationObserver(() => { const l = items(); if (!l.some((b) => b.tabIndex === 0)) l.forEach((b, i) => { b.tabIndex = i ? -1 : 0; }); }).observe(bar, { childList: true });
  bar.addEventListener('keydown', (e) => {
    const barItems = items(), i = barItems.indexOf(document.activeElement);
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: barItems.length - 1 }[e.key];
    if (n !== undefined) { e.preventDefault(); barItems.forEach((b) => (b.tabIndex = -1)); const t = barItems[(n + barItems.length) % barItems.length]; t.tabIndex = 0; t.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(barItems[i]); }
  });
  bar.addEventListener('pointerover', (e) => {
    const b = e.target.closest('button'); if (!b || b.parentElement !== bar) return;
    const open = items().find((x) => x.getAttribute('aria-expanded') === 'true');
    if (open && open !== b) { const m = $('#' + open.getAttribute('popovertarget')); m.dataset.switching = '1'; m.hidePopover(); delete m.dataset.switching; open.setAttribute('aria-expanded', 'false'); openMenu(b); }
  });
};

/* ---------- Menus built in code ---------- */
/* Rows from a list: { id, label, icon, key, danger, disabled, why, checked, sub, run }, { sep: true }, { caption }.
   icon is an icon name or markup (an <svg>, or an icon span); checked true / false makes a check item; why is the
   tooltip (a disabled item says why); sub is a list of items, or a function that returns one when the submenu opens
   (one level); run(event) runs as soon as the menu has closed (the row's place is kept in row.ayniRect for a popup that
   must hang from it) */
let codeMenu = null, codeState = null, closed = { anchor: null, at: 0 }, lastDown = { el: null, at: 0 }, subN = 0, down = false;
const iconHtml = (ic) => !ic.trim().startsWith('<') ? icon(ic) : /^<span[^>]*\bclass="[^"]*\bicon\b/.test(ic.trim()) ? ic : `<span class="icon" aria-hidden="true">${ic}</span>`;
/* A menu's own submenu, made the first time one of its rows has one, and filled from that row when it opens */
const subFor = (menu) => {
  if (menu.ayniSub) return menu.ayniSub;
  const sub = document.createElement('div');
  sub.className = 'panel menu'; sub.id = (menu.id || 'ayni-menu') + '-sub' + (menu.id ? '' : ++subN);
  sub.setAttribute('popover', ''); sub.setAttribute('role', 'menu');
  sub.addEventListener('beforetoggle', (e) => {
    if (e.target !== sub || e.newState !== 'open') return;
    const row = sub.ayniItem?.ayniRow, list = typeof row?.sub === 'function' ? row.sub() : row?.sub;
    fillMenu(sub, list, false); sub.setAttribute('aria-label', row?.label || '');
  });
  menu.append(sub); once('menu', sub); initMenu(sub);
  return (menu.ayniSub = sub);
};
const fillMenu = (menu, list, subs = true) => {
  const rows = (list || []).filter((it) => it && !it.hidden);
  menu.replaceChildren();
  let lastSep = true;
  rows.forEach((it) => {
    if (it.sep) { if (!lastSep) menu.insertAdjacentHTML('beforeend', '<div role="separator"></div>'); lastSep = true; return; }
    lastSep = false;
    if (it.caption) { const c = document.createElement('div'); c.className = 'caption'; c.textContent = it.caption; menu.append(c); return; }
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', it.checked == null ? 'menuitem' : 'menuitemcheckbox');
    if (it.checked != null) b.setAttribute('aria-checked', !!it.checked);
    if (it.danger) b.classList.add('danger');
    if (it.id) b.dataset.act = it.id;
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    if (it.why) b.dataset.tip = it.why;
    b.innerHTML = (it.icon ? iconHtml(it.icon) : '') + '<span class="label"></span>' + (it.key ? '<kbd></kbd>' : '');
    $('.label', b).textContent = it.label;
    if (it.key) $('kbd', b).textContent = keyLabel(it.key);
    if (it.sub && subs) { b.dataset.submenu = subFor(menu).id; b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
    b.ayniRow = it;
    menu.append(b);
  });
  $$(':scope > [role="separator"]:last-child', menu).forEach((x) => x.remove());
  if (menu.ayniSub) menu.append(menu.ayniSub);           // the submenu stays last, after the rows
  shapeRows(menu);
  return ownItems(menu).length > 0;
};
/* Ayni.menuBar(bar, { menus }): a menu bar built from a list. menus is [{ key | label, items }] (or a function that gives
   it), key being a text key, items the rows of Ayni.menuAt (or a function that gives them). Each menu is filled every time
   it opens, so its rows show what is true now. Returns { build() (a new list), openAt(i), close(), isOpen() } */
const menuBar = (bar, o = {}) => {
  if (typeof bar === 'string') bar = $(bar);
  const list = () => (typeof o.menus === 'function' ? o.menus() : o.menus) || [];
  const close = () => $$('.panel.menu:popover-open').forEach((m) => m.hidePopover());
  const build = () => {
    $$(':scope > button[data-menu]', bar).forEach((b) => b.remove());
    $$(`.panel.menu[data-bar="${bar.id}"]`).forEach((m) => m.remove());
    bar.setAttribute('role', 'menubar');
    list().forEach((m, i) => {
      const b = document.createElement('button'), menu = document.createElement('div');
      b.type = 'button'; b.dataset.menu = i; b.setAttribute('popovertarget', `${bar.id}-${i}`);
      b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
      if (m.key) { b.setAttribute('data-i18n', m.key); b.textContent = Ayni.t(m.key); } else b.textContent = m.label || '';
      bar.append(b);
      menu.className = 'panel menu'; menu.id = `${bar.id}-${i}`; menu.dataset.bar = bar.id;
      menu.setAttribute('popover', ''); menu.setAttribute('role', 'menu');
      menu.addEventListener('beforetoggle', (e) => {
        if (e.newState !== 'open' || e.target !== menu) return;
        const items = list()[i]?.items;
        fillPage(menu, (typeof items === 'function' ? items() : items) || []);
        menu.setAttribute('aria-label', b.textContent);
      });
      document.body.append(menu);
    });
    Ayni.init(bar);
  };
  build();
  return { build, close, isOpen: () => !!$('.panel.menu:popover-open'),
    openAt: (i) => { const b = $(`:scope > [data-menu="${i}"]`, bar), m = $(`#${bar.id}-${i}`); if (b && m && !m.matches(':popover-open')) b.click(); } };
};

/* Ayni.fillMenu(menu, items): fills a .panel.menu of the page from a list (as Ayni.menuAt), for a menu that is built
   when it opens (a menu bar's menu: listen for its beforetoggle) */
const fillPage = (menu, list) => { if (once('menu', menu)) initMenu(menu); return fillMenu(menu, list); };
const ensureCodeMenu = () => {
  if (codeMenu) return;
  codeMenu = layer('ayni-menu', '<div class="panel menu" popover id="ayni-menu" role="menu"></div>');
  once('menu', codeMenu); initMenu(codeMenu);
  /* Noted the moment it closes (beforetoggle comes at once, toggle a moment later): code that opens it again right after
     a press outside closed it must find it closed */
  codeMenu.addEventListener('beforetoggle', (e) => {
    if (e.target !== codeMenu || e.newState !== 'closed' || !codeState) return;
    const st = codeState; codeState = null;
    st.anchor?.setAttribute('aria-expanded', 'false');
    /* Closed by a press on its own button: that press's click must not open it again */
    if (!st.toggled && st.anchor?.contains(lastDown.el) && performance.now() - lastDown.at < 1000) closed = { anchor: st.anchor, at: performance.now() };
    if (st.onClose) codeMenu.addEventListener('toggle', () => st.onClose(), { once: true });
  });
};
/* Ayni.menuAt(items, { anchor, x, y, keyboard, onClose }): one shared menu, filled from a list (rows as above). Under
   anchor (its button), or at x, y. Opened while a button or a finger is down (a right-click, a long tap), it shows when
   that is lifted: the release would close it at once. Returns { close() }, or null when nothing was shown */
const menuAt = (list, o = {}) => {
  ensureCodeMenu();
  /* A press on the button of the open menu closed it (outside the menu): it must not open it again */
  if (o.anchor && o.anchor === closed.anchor && performance.now() - closed.at < 400) { closed.anchor = null; return null; }
  /* ...or its menu is still open: it closes */
  if (o.anchor && codeState?.anchor === o.anchor) { codeState.toggled = true; if (codeMenu.matches(':popover-open')) codeMenu.hidePopover(); return null; }
  if (codeMenu.matches(':popover-open')) codeMenu.hidePopover();
  if (!fillMenu(codeMenu, list)) return null;
  const st = codeState = { anchor: o.anchor || null, onClose: o.onClose || null };
  const back = document.activeElement;
  const show = () => {
    if (codeState !== st) return;
    if (o.keyboard != null) byKeys = !!o.keyboard;
    if (o.anchor) { invoker = o.anchor; ctxPoint = null; ctxReturn = o.anchor; o.anchor.setAttribute('aria-expanded', 'true'); }
    else { ctxPoint = { x: o.x || 0, y: o.y || 0 }; ctxReturn = back; invoker = back; }
    ctxName = null; ctxMenu = codeMenu;
    host(codeMenu).showPopover();
  };
  if (down) addEventListener('pointerup', () => setTimeout(show), { once: true, capture: true }); else show();
  return { close: () => { if (codeMenu.matches(':popover-open')) codeMenu.hidePopover(); else if (codeState === st) codeState = null; } };
};

/* Ayni.keyLabel('Ctrl+C'): a shortcut as menus and tooltips show it: "Ctrl+C", or "⌘C" on Mac, in the page's language.
   An array gives the first one */
const keyLabel = (spec) => {
  if (!spec) return '';
  const s = String(Array.isArray(spec) ? spec[0] : spec);
  const words = { ctrl: isMac ? '⌘' : tx('key.ctrl'), cmd: isMac ? '⌘' : tx('key.ctrl'), shift: isMac ? '⇧' : tx('key.shift'),
    alt: isMac ? '⌥' : tx('key.alt'), del: tx('key.del'), delete: tx('key.del'), enter: tx('key.enter'), esc: tx('key.esc') };
  return s.split('+').map((p) => words[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p)).join(isMac ? '' : '+');
};

/* ---------- Long tap and pop-up menus ---------- */
/* RULE: a long tap means "more for this thing": on a button with a dot it runs the second action, on an area or a tree
   item it opens that element's pop-up menu, on a list item it starts picking. iOS Safari sends no contextmenu, so the
   hold is timed here, with the same ring as the buttons. */
const openCtx = (menu, x, y, name, back) => { ctxPoint = { x, y }; invoker = back; ctxReturn = back; ctxName = name; ctxMenu = menu; host(menu).showPopover(); };
let swallowUntil = 0, swallowIn = [], swallowOne = false; // after a long tap, ignore the click / mousedown its release may produce on the held element, or on the menu that opened under the finger
const holdRing = (x, y) => {
  const r = document.createElement('div'); r.className = 'hold-ring'; r.style.left = x + 'px'; r.style.top = y + 'px';
  r.style.setProperty('--hold-ms', HOLD_MS + 'ms'); document.body.append(r); return r;
};
/* Ayni.contextMenu(area, { menu, target, keyTarget, onDrag }): target(e) returns { name, back, at? } for the element under
   the event, or null; keyTarget(e) does the same for Shift+F10 and the Menu key (default: target). With onDrag(t, e),
   moving the finger once the ring is full drags instead of opening the menu (the tree uses it) */
const contextMenu = (root, { menu, target, keyTarget = target, onDrag }) => {
  let rightDown = false, timer, ring, fired = null, start;
  const stop = () => { clearTimeout(timer); ring?.remove(); ring = null; };
  root.addEventListener('pointerdown', (e) => {
    rightDown = e.button === 2;
    if (e.pointerType === 'mouse' && !isTouch()) return;
    const t = target(e); if (!t || e.button !== 0) return;
    fired = null; start = { x: e.clientX, y: e.clientY }; ring = holdRing(e.clientX, e.clientY);
    timer = setTimeout(() => { ring?.remove(); ring = null; fired = { ...t, ...start }; buzz(); }, HOLD_MS);
  });
  root.addEventListener('pointermove', (e) => {
    const far = Math.hypot(e.clientX - start?.x, e.clientY - start?.y) > MOVE_SLOP;
    if (ring && far) stop();
    else if (fired && onDrag && far) { const f = fired; fired = null; onDrag(f, e); }
  });
  /* While the ring is full the page must not scroll, so that the finger can still drag */
  if (onDrag) root.addEventListener('touchmove', (e) => { if (fired) e.preventDefault(); }, { passive: false });
  root.addEventListener('pointercancel', stop);
  /* The menu opens on release, otherwise that release would close it as an outside click */
  root.addEventListener('pointerup', () => {
    stop(); if (!fired) return;
    const f = fired; fired = null; swallowUntil = performance.now() + 600; swallowIn = [root, menu]; swallowOne = false;
    setTimeout(() => openCtx(menu, f.x, f.y, f.name, f.back));
  });
  root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') stop(); });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (ring || fired || e.pointerType === 'touch') return; // touch holds are timed above
    const t = target(e); if (!t) return;
    const { clientX: x, clientY: y } = e;
    if (rightDown) addEventListener('pointerup', () => { rightDown = false; setTimeout(() => openCtx(menu, x, y, t.name, t.back)); }, { once: true });
    else openCtx(menu, x, y, t.name, t.back);
  });
  root.addEventListener('keydown', (e) => {
    if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return;
    const t = keyTarget(e); if (!t) return;
    e.preventDefault(); const r = (t.at || t.back).getBoundingClientRect(); openCtx(menu, r.left + 16, r.top + r.height / 2, t.name, t.back);
  });
};
/* Ayni.longTap(area, selector, fn(el, x, y)): a finger held still on an element matching selector inside area for the
   hold time (the ring fills) runs fn while the finger is still down, as picking in a list does. The click and the
   contextmenu the finger leaves behind are swallowed. A finger is read from touch events: a phone's own long-press
   gesture may cancel the pointer at about the same time. A pen, or a mouse in touch mode, is read from pointer events */
const longTap = (root, sel, fn) => {
  let timer = null, ring, start, el = null, held = false;
  const stop = () => { clearTimeout(timer); timer = null; ring?.remove(); ring = null; };
  const begin = (target, x, y) => {
    stop(); held = false;
    el = target.closest?.(sel);
    if (!el || !root.contains(el) || target.closest('input, textarea, select, [contenteditable="true"]')) return;
    start = { x, y }; ring = holdRing(x, y);
    timer = setTimeout(() => {
      timer = null; ring?.remove(); ring = null; held = true;
      swallowUntil = Infinity; swallowIn = [root]; swallowOne = false;   // until the finger lifts
      buzz(); fn(el, start.x, start.y);
    }, HOLD_MS);
  };
  const move = (x, y) => { if (timer && Math.hypot(x - start.x, y - start.y) > MOVE_SLOP) stop(); };
  /* Lifted after the hold: its one click is swallowed, the next tap counts */
  const lift = () => { stop(); if (held) { held = false; swallowUntil = performance.now() + 350; swallowOne = true; } };
  root.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { stop(); return; } const t = e.touches[0]; begin(e.target, t.clientX, t.clientY); }, { passive: true });
  root.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY); }, { passive: true });
  root.addEventListener('touchend', lift);
  root.addEventListener('touchcancel', lift);
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || (e.pointerType === 'mouse' && !isTouch()) || e.button !== 0 || !e.isPrimary) return;
    begin(e.target, e.clientX, e.clientY);
  });
  root.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e.clientX, e.clientY); });
  ['pointerup', 'pointercancel'].forEach((t) => root.addEventListener(t, (e) => { if (e.pointerType !== 'touch') lift(); }));
};

/* ---------- Toolbars ---------- */
/* Every [role="toolbar"]: one Tab stop, arrow keys move between tools (roving tabindex). A field inside, with its own
   buttons, is a Tab stop of its own. Tools the page adds, hides or shows later keep the one Tab stop */
const toolsOf = (bar) => $$('button', bar).filter((t) => !t.closest('.input-group') && t.closest('[role="toolbar"]') === bar);
const initToolbar = (bar) => {
  let fixing = false;
  const fix = (keep) => {
    fixing = true;
    const all = toolsOf(bar), shown = all.filter((t) => t.getClientRects().length);
    const stop = keep && shown.includes(keep) ? keep : shown.find((t) => t.tabIndex === 0) || shown[0];
    all.forEach((t) => { const v = t === stop ? 0 : -1; if (t.tabIndex !== v) t.tabIndex = v; });
    fixing = false;
  };
  fix();
  bar.addEventListener('focusin', (e) => { if (toolsOf(bar).includes(e.target)) fix(e.target); });
  new MutationObserver(() => { if (!fixing) fix(); }).observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  bar.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || !toolsOf(bar).includes(e.target)) return;
    const tools = toolsOf(bar).filter((t) => t.getClientRects().length), i = tools.indexOf(document.activeElement);
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tools.length - 1 }[e.key];
    if (n !== undefined) { e.preventDefault(); const t = tools[(n + tools.length) % tools.length]; fix(t); t.focus(); }
  });
};

/* Ayni.fitBar(row, { more, btn }): the title row shows what fits. Every tool that may leave carries data-rank (1 = the
   last to leave). While the row's tools do not fit on the title's line, the highest rank hides (.fit-out; of equal
   ranks the later one first) and ONE More button at the start of the system group (.tb-group.tb-sys) lists the hidden
   ones, in toolbar order, then the app's own items (more: () => menu items). Nothing to list: no More. The order never
   changes; the rest close up. btn: the app's own More button to use. A tool the app hides itself is not ours: it never
   goes into More. Search (a .search-field, or a button marked data-search) never leaves while nothing is picked (.has-selection on the row or inside it); while picking,
   the actions get the room. A group can give the menu item for one of its tools itself: group.ayniMenuRow(button); a
   list picker gives its own (a submenu of its items).
   Calling it again on the same row updates the options */
const fitBar = (header, opts = {}) => {
  if (typeof header === 'string') header = $(header);
  if (!header) return null;
  if (header.ayniFitBar) { header.ayniFitBar.set(opts); return header.ayniFitBar; }
  const holder = $('[role="toolbar"]', header) || header;
  let btn = null, made = false;

  /* The More button: the app's own, else one made at the start of the system group */
  const adopt = (b) => {
    if (btn && b === btn) return;
    if (made && btn) btn.remove();
    made = !b;
    if (!b) {
      let sys = $(':scope > .tb-sys', holder);
      if (!sys) { sys = document.createElement('div'); sys.className = 'tb-group tb-sys'; holder.append(sys); }
      b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.innerHTML = icon('more');
      sys.prepend(b);
    }
    btn = b;
    btn.classList.add('fit-more'); btn.setAttribute('aria-haspopup', 'menu');
    btn.dataset.tip = tx('more'); btn.setAttribute('aria-label', tx('more')); retip(btn);
    btn.hidden = true;
    btn.addEventListener('click', (e) => {
      if (btn !== e.currentTarget) return;
      e.stopPropagation();
      menuAt(items(), { anchor: btn, keyboard: e.detail === 0 });
    });
  };

  let fitting = false, queued = false, lastW = -1, lastH = -1;
  const ranked = () => $$('[data-rank]', header);
  /* Shown, were it not for us: the app has not hidden it or a box around it */
  const shown = (el) => !el.classList.contains('fit-out') && el.getClientRects().length > 0;
  const picking = () => header.classList.contains('has-selection') || !!$('.has-selection', header);
  const SEARCH = '.search-field, [data-search]';   // a search field, or the button that opens a folded one
  const isSearch = (el) => el.matches(SEARCH) || !!$(SEARCH, el);
  const OPEN = '.search-field.fold.is-open';
  const pinned = (el) => (isSearch(el) && !picking()) || !!(el.ayniFitPin || el.matches(OPEN) || $(OPEN, el));
  const ownItems = () => (opts.more ? opts.more() || [] : []).filter((it) => it && !it.hidden);

  /* Wider than its box. Not scrollWidth alone: on touch the invisible 44 px hit areas reach a few px past the last
     tool and count as overflow, though nothing that can be seen spills. An overflow that small is checked against
     the children's own boxes, which leave the hit areas out */
  const spills = (box) => {
    const over = box.scrollWidth - box.clientWidth;
    if (over <= 1) return false;
    if (over > PAD_SLACK) return true;
    const left = box.getBoundingClientRect().left + box.clientLeft, right = left + box.clientWidth;
    return [...box.children].some((k) => { if (!k.getClientRects().length) return false; const r = k.getBoundingClientRect(); return r.right > right + 1 || r.left < left - 1; });
  };
  /* Off the title's line: a child of the row starts below the bottom of the topmost one (the row wrapped), or it scrolls */
  const wrapped = (box) => {
    const rs = [...box.children].filter((k) => k.getClientRects().length && !/absolute|fixed/.test(getComputedStyle(k).position))
      .map((k) => k.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (rs.length < 2) return false;
    const top = rs.reduce((a, r) => (r.top < a.top ? r : a));
    return rs.some((r) => r.top >= top.bottom - 1);
  };
  const crowded = () => spills(header) || (holder !== header && (spills(holder) || wrapped(holder))) || wrapped(header);
  const fit = () => {
    if (fitting) return;
    fitting = true;
    const all = ranked();
    all.forEach((el) => el.classList.remove('fit-out'));
    const own = ownItems().length > 0;
    btn.hidden = !own;
    const order = all.filter((el) => shown(el) && !pinned(el)).map((el, i) => ({ el, r: +el.dataset.rank || 99, i }))
      .sort((a, b) => b.r - a.r || b.i - a.i);
    let n = 0;
    while (n < order.length && crowded()) {
      if (btn.hidden) { btn.hidden = false; continue; }
      order[n++].el.classList.add('fit-out');
    }
    if (!n && !own) btn.hidden = true;
    lastW = header.clientWidth; lastH = header.offsetHeight;
    mo.takeRecords();
    fitting = false;
  };
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fit(); }); };

  /* The menu item for a hidden tool: its group's own, or a copy of the tool */
  const itemFor = (el) => {
    /* A list picker (ayni-pickers.js) gives its own row: a submenu of its items */
    const pk = el.matches('.picker') ? el : $('.picker', el);
    if (pk?.ayniMenuRow) return pk.ayniMenuRow();
    const b = el.matches('button') ? el : $('button:not([hidden])', el);
    if (!b) return null;
    const mine = b.closest('.tb-group')?.ayniMenuRow?.(b); if (mine) return mine;
    const label = (b.getAttribute('aria-label') || b.dataset.tip || b.textContent || '').replace(/\s*[(·][^()]*\)?\s*$/, '').trim();
    const ic = $('.icon', b), svg = $('svg', b);
    const toggle = b.hasAttribute('aria-pressed') || b.classList.contains('is-active');
    return { id: b.id || b.dataset.act || '', label, icon: ic && iconName(ic) ? iconName(ic) : svg ? svg.outerHTML : '', danger: b.classList.contains('danger'),
      disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      checked: toggle ? b.classList.contains('is-active') || b.getAttribute('aria-pressed') === 'true' : null,
      run: () => press(el, b) };
  };
  /* A hidden tool run from More comes back while it is in use (a menu or a field it opens sits under it), until the
     next press elsewhere */
  const press = (el, b) => {
    el.ayniFitPin = true; fit(); b.click();
    setTimeout(() => document.addEventListener('pointerdown', function free(e) {
      if (el.contains(e.target) || codeMenu?.contains(e.target)) return;
      document.removeEventListener('pointerdown', free, true);
      el.ayniFitPin = false; later();
    }, true));
  };
  const items = () => {
    const out = []; let last = null;
    ranked().forEach((el) => {
      if (!el.classList.contains('fit-out')) return;
      el.classList.remove('fit-out');
      const ok = el.getClientRects().length > 0 || !!el.closest('.tb-group')?.ayniMenuRow;
      el.classList.add('fit-out');
      if (!ok) return;
      const it = itemFor(el); if (!it) return;
      const g = el.closest('.tb-group'), key = el.dataset.group != null ? 'g' + el.dataset.group : g;
      if (last !== null && key !== last) out.push({ sep: true });
      last = key; out.push(it);
    });
    const own = ownItems();
    if (out.length && own.length) out.push({ sep: true });
    return out.concat(own);
  };

  /* Refit when the row changes size other than by our own fit (a wider window; a status text on the left that pushed
     the tools down), and when the tools change: the app shows or hides one, a group redraws, a search opens */
  new ResizeObserver(() => { if (!fitting && (header.clientWidth !== lastW || header.offsetHeight !== lastH)) later(); }).observe(header);
  const mo = new MutationObserver((recs) => {
    if (fitting) return;
    if (recs.some((r) => holder.contains(r.target) || r.target === header || (r.type === 'attributes' && r.target.parentNode === header))) later();
  });
  mo.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  document.fonts?.ready.then(later);

  const api = {
    fit, later, items, crowded,
    set: (o) => { for (const k in o) if (k !== 'btn') opts[k] = o[k]; if (o.btn) adopt(typeof o.btn === 'string' ? $(o.btn) : o.btn); fit(); },
    get button() { return btn; },
  };
  ensureCodeMenu();
  adopt(opts.btn ? (typeof opts.btn === 'string' ? $(opts.btn) : opts.btn) : null);
  header.ayniFitBar = api;
  fit();
  return api;
};

/* ---------- Popups ---------- */
/* Popup with controls (.panel.popup.controls): placed next to its button, the focus goes to its first control and
   comes back to the button when it closes */
const initControlsPopup = (pop) => pop.addEventListener('toggle', (e) => {
  if (e.newState === 'open') { place(pop); $('input:not([type="hidden"]), select, textarea, [tabindex="0"]', pop)?.focus(); return; }
  /* It went because the focus went elsewhere (another field, a frame): the focus stays there */
  const now = document.activeElement;
  if (!now || now === document.body || pop.contains(now)) invoker?.focus();
});
/* Tool group (.panel.popup.tools): the real tools of a group, under the one button that stands for them. Pressing a
   tool (a button, or a link) runs it and closes the popup; a press inside never takes the page's focus. The button names, in data-lit-by,
   the toggles inside that light it while one of them is on */
const initToolsPopup = (pop) => {
  pop.addEventListener('toggle', (e) => {
    const trig = $$(`[popovertarget="${pop.id}"]`); trig.forEach((b) => b.setAttribute('aria-expanded', e.newState === 'open'));
    if (e.newState === 'open') { place(pop); if (byKeys) $('button:not([aria-disabled="true"])', pop)?.focus(); }
    else if (pop.contains(document.activeElement)) invoker?.focus();
  });
  pop.addEventListener('mousedown', (e) => { if (!e.target.closest('input, select, textarea')) e.preventDefault(); });
  pop.addEventListener('click', (e) => { if (e.target.closest('button, a[href]')) pop.hidePopover(); });
};
const initLitBy = (btn) => {
  const watch = btn.dataset.litBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
  const sync = () => btn.setAttribute('aria-pressed', watch.some((el) => el.getAttribute('aria-pressed') === 'true'));
  const mo = new MutationObserver(sync); watch.forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ['aria-pressed'] }));
  sync();
};

/* ---------- Open menus and popups close when the page scrolls or the window resizes (item 56) ----------
   Scrolling inside the popup itself does not close it. Dialogs and bottom sheets are not affected. A popup that
   wants to handle it itself listens for ayni:dismiss and calls preventDefault(). */
let poppedAt = 0;
const dismissPopups = (src) => {
  if (performance.now() - poppedAt < 300) return;
  $$('.panel.menu:popover-open, .panel.popup:popover-open').forEach((p) => {
    if (p.classList.contains('sheet') || (src && p.contains(src))) return;
    if (p.dispatchEvent(new Event('ayni:dismiss', { bubbles: true, cancelable: true }))) p.hidePopover();
  });
};

/* ---------- Page-wide behaviour, set up once ---------- */
const setup = () => {
  addEventListener('keydown', () => { byKeys = true; }, true);
  /* down: a real button or finger is pressed now (a pointer event made by a script never holds a menu back) */
  addEventListener('pointerdown', (e) => { byKeys = false; down = e.isTrusted; lastDown = { el: e.target, at: performance.now() }; }, true);
  ['pointerup', 'pointercancel', 'click'].forEach((t) => addEventListener(t, () => { down = false; }, true));
  addEventListener('blur', () => { down = false; });
  document.addEventListener('click', (e) => { const b = e.target.closest('[popovertarget]'); if (b) { invoker = b; ctxPoint = null; ctxName = null; host(document.getElementById(b.getAttribute('popovertarget'))); } }, true);
  /* A press on a button that opens a menu or a tool group does not take the page's focus either */
  document.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[popovertarget]'), t = b && document.getElementById(b.getAttribute('popovertarget'));
    if (t?.matches('.panel.menu, .panel.popup.tools')) e.preventDefault();
  });
  /* A menu opened by the pointer: Down or Up moves into it */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const m = $$('.panel.menu:popover-open').at(-1); if (!m || m.contains(document.activeElement)) return;
    const list = ownItems(m).filter((x) => x.getAttribute('aria-disabled') !== 'true' && x.getClientRects().length); if (!list.length) return;
    e.preventDefault(); (e.key === 'ArrowDown' ? list[0] : list.at(-1)).focus();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F10' || e.shiftKey) return;
    const bar = $$('[role="menubar"]').find((m) => m.getClientRects().length); if (!bar) return;
    e.preventDefault(); $('button', bar).focus();
  });
  ['click', 'mousedown', 'contextmenu'].forEach((t) => addEventListener(t, (e) => {
    if (performance.now() >= swallowUntil || !swallowIn.some((el) => el.contains(e.target))) return;
    e.stopPropagation(); e.preventDefault();
    if (swallowOne && t === 'click') { swallowUntil = 0; swallowOne = false; }   // after a long tap: only its own click
  }, true));

  document.addEventListener('toggle', (e) => { if (e.newState === 'open') poppedAt = performance.now(); }, true);
  addEventListener('scroll', (e) => dismissPopups(e.target instanceof Element ? e.target : null), true);
  let lastW = innerWidth;
  addEventListener('resize', () => {
    const typing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    /* On touch, a height-only change while typing is the on-screen keyboard: keep the popup */
    if (innerWidth === lastW && typing && isTouch()) return;
    lastW = innerWidth; dismissPopups(null);
  });
  /* The window lost the focus (another window or frame was clicked): open menus and popups close */
  addEventListener('blur', () => $$('.panel.menu:popover-open, .panel.popup:popover-open').forEach((p) => { if (!p.classList.contains('sheet')) p.hidePopover(); }));
};

const init = (root) => {
  each(root, '.panel.menu', 'menu', initMenu);
  each(root, '[role="menubar"]', 'menubar', initMenubar);
  each(root, '[role="toolbar"]', 'toolbar', initToolbar);
  each(root, '.panel.popup.controls', 'controls', initControlsPopup);
  each(root, '.panel.popup.tools', 'tools', initToolsPopup);
  each(root, '[data-lit-by]', 'litby', initLitBy);
};

Ayni.core.menus = { initMenu, initToolbar, contextMenu, place, iconHtml, invoker: () => invoker };
Object.assign(Ayni, {
  place, showPopup, menuAt, menuBar, fillMenu: fillPage, keyLabel, contextMenu, longTap, fitBar,
  toolbar: (el) => { if (once('toolbar', el)) initToolbar(el); },
});
Ayni.core.family({ setup, init });
})();
