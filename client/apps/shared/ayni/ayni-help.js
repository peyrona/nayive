/* Ayni library 0.2.0, help family: the Help button (?) and its card, the guided tour, first-visit marks and the
   info label ("i"). Plain JavaScript, no build step, evergreen browsers 2024+. Load it after ayni-base.js,
   ayni-buttons.js and ayni-dialogs.js:
     <script src="ayni-base.js" defer></script>
     <script src="ayni-buttons.js" defer></script>
     <script src="ayni-dialogs.js" defer></script>
     <script src="ayni-help.js" defer></script>
   The look is in ayni-help.css; the rules are chapters 14.2 (info label) and 15 (help, tour, first-visit marks) of
   the guidelines. */
(() => {
'use strict';
const { $, $$, icon, setTip } = Ayni;
const { each, tx, txf, layer } = Ayni.core;

const onScreen = (el) => { if (!el?.getBoundingClientRect) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const firstShown = (sel) => (sel ? $$(sel).find(onScreen) || null : null);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return '1'; } },   // no storage: never nag
  set: (k) => { try { localStorage.setItem(k, '1'); } catch { /* private window */ } },
};
const dialogOpen = () => !!$('dialog.panel[open]');

/* The tour and the marks keep their layer on its targets: `place` runs on resize, turn and scroll, `onKey` gets every
   key first. `on` false takes them off again */
const follow = (on, place, onKey) => {
  const f = on ? 'addEventListener' : 'removeEventListener';
  document[f]('keydown', onKey, true);
  window[f]('resize', place); window[f]('orientationchange', place); window[f]('scroll', place, true);
};

/* The × of a bubble: the tour's, and the marks' once their count is over */
const closeButton = (tip) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'coach-close'; b.innerHTML = icon('close'); setTip(b, tip); b.setAttribute('aria-label', tip);
  return b;
};

/* ---------- Info label (14.2) ---------- */
/* RULE: a small "i" after a label opens a popup with a sentence or two. With a mouse it opens on hover and stays while
   the pointer is on the "i" or the popup; a click pins it. On touch, and pinned: a second tap, a tap elsewhere, Esc, a
   scroll or a resize closes it. Esc closes only the popup. Line breaks are kept, a web address becomes a link. Inside a
   dialog the popup lives in that dialog, so it can be read and its links pressed. */
let infoPop = null, infoFor = null, infoByHover = false, infoTimer = 0;
const hoverable = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const infoCancel = () => { clearTimeout(infoTimer); infoTimer = 0; };
const infoSoon = () => { infoCancel(); infoTimer = setTimeout(() => { infoTimer = 0; if (infoByHover) infoClose(); }, 180); };
const infoOutside = (e) => { if (!infoPop?.contains(e.target) && !infoFor?.contains(e.target)) infoClose(); };
const infoKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); infoClose(); } };
const infoListen = (on) => {
  const f = on ? 'addEventListener' : 'removeEventListener';
  document[f]('pointerdown', infoOutside, true); document[f]('keydown', infoKey, true);
  window[f]('scroll', infoClose, true); window[f]('resize', infoClose, true);
};
function infoClose() {
  infoCancel(); infoByHover = false;
  if (!infoFor) return;
  infoFor.setAttribute('aria-expanded', 'false'); infoFor = null;
  if (infoPop?.matches(':popover-open')) infoPop.hidePopover();
  infoListen(false);
}
/* The text, with every https:// address made a link (new tab); text nodes only, never innerHTML */
const infoText = (text) => {
  infoPop.replaceChildren();
  text.split(/(https:\/\/\S+)/).forEach((part, i) => {
    if (i % 2 === 0) { if (part) infoPop.append(part); return; }
    const a = document.createElement('a');
    a.href = part; a.target = '_blank'; a.rel = 'noopener'; a.textContent = part; infoPop.append(a);
  });
};
const infoOpen = (dot) => {
  infoPop ||= (() => {
    const p = layer('ayni-info', '<div class="info-pop" id="ayni-info" popover="manual" role="tooltip"></div>');
    p.addEventListener('mouseenter', infoCancel);
    p.addEventListener('mouseleave', () => { if (infoByHover) infoSoon(); });
    return p;
  })();
  /* Inside an open dialog the popup lives in it: outside, a modal dialog would keep it from the pointer */
  const host = dot.closest('dialog[open]') || document.body;
  if (infoPop.parentNode !== host) { if (infoPop.matches(':popover-open')) infoPop.hidePopover(); host.append(infoPop); }
  if (host !== document.body) host.addEventListener('close', infoClose, { once: true });
  infoByHover = false;
  infoText(dot.dataset.help || '');
  if (!infoPop.matches(':popover-open')) infoPop.showPopover();
  Object.assign(infoPop.style, { visibility: 'hidden', left: '0px', top: '0px' });
  const r = dot.getBoundingClientRect(), pw = infoPop.offsetWidth, ph = infoPop.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, GAP = 6, PAD = 8;
  const left = Math.max(PAD, Math.min(r.left, vw - PAD - pw));
  let top = r.bottom + GAP;
  if (top + ph > vh - PAD && r.top - GAP - ph >= PAD) top = r.top - GAP - ph;   // above when there is no room below
  Object.assign(infoPop.style, { left: left + 'px', top: top + 'px', visibility: 'visible' });
  infoFor = dot; dot.setAttribute('aria-expanded', 'true');
  infoListen(true);
};
const initInfo = (dot) => {
  if (!dot.querySelector('.icon')) dot.innerHTML = icon('info');
  if (!dot.hasAttribute('aria-label')) dot.setAttribute('aria-label', tx('whatIsThis'));
  dot.removeAttribute('popovertarget');
  if (dot.tagName === 'BUTTON' && !dot.hasAttribute('type')) dot.type = 'button';
  dot.setAttribute('aria-expanded', 'false');
  dot.addEventListener('mouseenter', () => {
    if (!hoverable()) return;
    infoCancel();
    if (infoFor === dot) return;
    infoClose(); infoOpen(dot); infoByHover = true;
  });
  dot.addEventListener('mouseleave', () => { if (infoByHover) infoSoon(); });
  dot.addEventListener('click', (e) => {
    e.preventDefault();
    if (infoFor !== dot) { infoClose(); infoOpen(dot); return; }
    /* A click on a popup opened by hover pins it (the pointer is still on the dot: closing would look like a miss) */
    if (infoByHover) { infoByHover = false; infoCancel(); } else infoClose();
  });
};

/* ---------- Help card (15.2) ---------- */
let card = null;           // the options of the view's card (Ayni.help)
let held = false;          // Ayni.help.hold(): something more important owns this page load

/* A row's glyph: a small copy of the round button (its icon, its colour, the triangle of a popup button); `svg` or
   `icon` on the row win (a row with no button, or two buttons that look alike); a button with only text shows its
   text when short, else a dot */
const COLOURS = ['primary', 'danger', 'ok', 'warn'];
const glyph = (it, el) => {
  const b = el && (el.matches('button, [role="button"]') ? el : $('button', el)) || el;
  const g = document.createElement('span');
  g.setAttribute('aria-hidden', 'true');
  g.className = 'btn help-ico' + (b ? COLOURS.filter((c) => b.classList.contains(c)).map((c) => ' ' + c).join('') : '');
  if (b?.hasAttribute('popovertarget') && !b.classList.contains('fit-more')) g.setAttribute('aria-haspopup', 'true');
  if (b?.dataset.alt != null) g.dataset.alt = '';
  if (it.svg) { g.innerHTML = it.svg; return g; }
  if (it.icon) { g.innerHTML = icon(it.icon); return g; }
  const ic = el && ($('.icon:not(.tw)', el) || $('svg', el));
  if (ic) {
    const c = ic.cloneNode(true);
    if (c.tagName.toLowerCase() === 'svg') { c.removeAttribute('width'); c.removeAttribute('height'); const s = document.createElement('span'); s.className = 'icon'; s.append(c); g.append(s); }
    else g.append(c);
    return g;
  }
  const t = el?.textContent.trim();
  g.textContent = t && t.length <= 2 ? t : '•';
  return g;
};

const dismissKey = (o) => o.key || 'ayni-help-dismiss:' + location.pathname;

const buildCard = (o) => {
  const d = Ayni.dialog({ title: o.title, cls: 'help-card' }), body = d.body;
  [].concat(o.lead || []).forEach((line) => {
    if (!line) return;
    const p = document.createElement('p'); p.className = 'text'; p.textContent = String(line); body.append(p);
  });
  /* The tour, first thing under the lead; with a Help menu its row is in the menu instead */
  if (o.tour && !o.menu) {
    const tb = document.createElement('button');
    tb.type = 'button'; tb.className = 'btn text primary sm help-tour';
    tb.innerHTML = icon('play') + '<span class="label"></span>'; tb.lastChild.textContent = tx('tour.open');
    tb.addEventListener('click', () => { d.close(); setTimeout(() => runTour(o.tour, o), 250); });
    body.append(tb);
  }
  let ul = null;
  const list = () => ul || (ul = body.appendChild(Object.assign(document.createElement('ul'), { className: 'help-list' })));
  (o.rows || []).forEach((it) => {
    if (it.section) {
      ul = null;
      body.append(Object.assign(document.createElement('hr'), { className: 'help-sep' }));
      const h = document.createElement('h3'); h.className = 'help-group'; h.textContent = it.section; body.append(h);
      return;
    }
    const el = it.sel ? document.querySelector(it.sel) : null;
    if (it.sel && !el) return;                      // the button is not in this layout
    const li = document.createElement('li'), t = document.createElement('div');
    t.className = 'help-t';
    const name = it.name || (el && (el.dataset.tip || el.getAttribute('title') || el.getAttribute('aria-label'))) || '';
    if (name) { const b = document.createElement('b'); b.textContent = name; t.append(b); }
    const s = document.createElement('span'); s.textContent = it.text || ''; t.append(s);
    li.append(glyph(it, el), t); list().append(li);
  });
  if (o.tip) { const p = document.createElement('p'); p.className = 'text help-tip'; p.textContent = String(o.tip); body.append(p); }
  d.header.append(Ayni.dialogButton('close', tx('close'), 'close'));
  /* A home page's card: Don't show again, alone in the bottom row */
  if (o.autoShow) {
    const db = document.createElement('button');
    db.type = 'button'; db.className = 'btn text bordered help-dismiss'; db.textContent = tx('dontShowAgain');
    db.addEventListener('click', () => { store.set(dismissKey(o)); d.close(); });
    d.footer.append(db);
  }
  d.show();
  return d;
};

const showCard = (o = card, wait = false) => {
  if (!o || held) return;
  /* Never on top of another dialog (a folder picker on a first visit): it waits */
  if (wait && dialogOpen()) { setTimeout(() => showCard(o, false), 800); return; }
  buildCard(o);
};

/* Ayni.help(options): the view's card; calling it again replaces it (a view with two screens) */
const help = (o = {}) => {
  card = o;
  if (o.autoShow && store.get(dismissKey(o)) !== '1') setTimeout(() => showCard(o, true), 400);
  return help;
};
help.show = (o) => showCard(o || card);
help.hold = () => { held = true; $('dialog.help-card[open] [data-close]')?.click(); };
/* The rows a Help menu takes for the card and the tour (options.menu: the "?" opens the page's own menu) */
help.items = () => [
  { id: 'help-card', label: tx('help.card'), icon: 'help', run: () => showCard() },
  ...(card?.tour ? [{ id: 'help-tour', label: tx('tour.open'), icon: 'play', run: () => runTour() }] : []),
];

/* ---------- Guided tour (15.3) ---------- */
let tourOpen = false;

/* An opener whose menu or popup is not showing (any more) */
const shut = (o) => {
  const id = o.getAttribute('popovertarget'), p = id && document.getElementById(id);
  return p ? !p.matches(':popover-open') : o.getAttribute('aria-expanded') === 'false';
};

/* RULE: the steps every view has, with one text for all of them; a page adds its own (Ayni.tour.add), and one added
   with 'first' starts every tour */
const SHARED = {
  search: () => ({ sel: '[data-search]', text: tx('tour.search') }),
  more:   () => ({ sel: '.fit-more', text: tx('tour.more'), optional: true }),
  pick:   () => ({ sel: '.pick-tick', ghost: '[aria-selected]', tap: true, text: tx('tour.pick') }),
  picked: () => ({ sel: '.pick-group:not([hidden])', text: tx('tour.picked'), picked: true }),
  help:   () => ({ sel: '[data-help-open]', text: tx('tour.helpAgain'), optional: true }),
};
const FIRST = [];

/* "picked" with nothing picked (Next on a phone, where the ticks show only while picking): pick the first row the way
   its tick would, and let it go afterwards */
const pickOne = () => { if (!firstShown('.pick-group:not([hidden])')) $('[aria-selected] .pick-tick')?.click(); };
const unpick = () => firstShown('.pick-group [data-pick="clear"]')?.click();

/* The card's rows as steps: a row with `sel` lights that button with the row's text (its name as the title); a row
   with no `sel` joins only with a `tour: { … }` of its own; `tour: false` keeps a row out */
const rowSteps = (rows) => (rows || []).flatMap((r) => {
  if (!r || r.section || r.tour === false || (!r.sel && !r.tour)) return [];
  const st = { sel: r.sel, text: r.text, title: r.name || '', optional: !r.tour };
  if (r.icon) st.icon = r.icon;
  return [Object.assign(st, r.tour || {})];
});

/* The menu row standing for a hidden button: a row with data-menu="<the button's id>" */
const menuTwin = (sel) => {
  for (const b of sel ? $$(sel) : []) { const r = b.id && firstShown(`.panel.menu [data-menu="${CSS.escape(b.id)}"]`); if (r) return r; }
  return null;
};

/* A tool that Ayni.fitBar moved into More for lack of room: { opener: More, row: () => its row once open } */
const inMore = (sel) => {
  for (const el of sel ? $$(sel) : []) {
    const out = el.closest('.fit-out'); if (!out) continue;
    let h = out; while (h && !h.ayniFitBar) h = h.parentElement;
    const more = h?.ayniFitBar.button; if (!more || !onScreen(more)) continue;
    const b = el.matches('button') ? el : $('button:not([hidden])', out) || out;
    const id = b.id || b.dataset.pickAct || b.dataset.act || '', label = (b.getAttribute('aria-label') || b.title || '').trim();
    return {
      opener: more,
      row: () => {
        const r = $$("#ayni-menu:popover-open [role^='menuitem']").find((x) => {
          const t = ($('.label', x) || x).textContent.trim();
          return id ? x.dataset.act === id : label && label.indexOf(t) === 0;
        });
        return r && onScreen(r) ? r : null;
      },
    };
  }
  return null;
};

/* src: the steps (or a function returning them; true = the card's rows); o: the card, whose rows 'rows' expands */
const tourSteps = (src, o) => {
  let s = typeof src === 'function' ? src() : src;
  if (s === true) s = ['rows'];
  let list = [];
  [...FIRST, ...(s || []), 'help'].forEach((it) => {
    if (it === 'rows') { list = list.concat(rowSteps(o?.rows)); return; }
    if (!it) return;
    if (typeof it === 'string') { if (SHARED[it]) list.push(SHARED[it]()); return; }
    if (!it.use || !SHARED[it.use]) { list.push(it); return; }
    const { use, ...rest } = it;
    list.push(Object.assign(SHARED[use](), rest));
  });
  /* The Help button ends every tour, once: a row naming it gives way */
  const last = list.length - 1;
  list = list.filter((it, i) => i === last || it.sel !== '[data-help-open]');
  /* Only what this layout has at all: an optional step needs its button on screen or in More */
  return list.filter((it) => it && (!it.optional || it.open || firstShown(it.sel) || inMore(it.sel)));
};

function runTour(src, o) {
  o ||= card;
  const steps = tourSteps(src ?? o?.tour, o);
  if (tourOpen || !steps.length) return false;
  tourOpen = true;

  const el = (parent, tag, cls) => { const n = parent.appendChild(document.createElement(tag)); if (cls) n.className = cls; return n; };
  const over = document.createElement('div');
  over.className = 'tour-overlay';
  over.setAttribute('role', 'dialog'); over.setAttribute('aria-modal', 'true'); over.setAttribute('aria-label', tx('tour.open'));
  /* Four dim panes around the hole, a clear lid over it (gone on a tap step, so the tap reaches the real button),
     the ring and the bubble */
  const panes = [0, 1, 2, 3].map(() => el(over, 'div', 'tour-pane'));
  const lid = el(over, 'div', 'tour-lid'), ring = el(over, 'div', 'coach-ring tour-ring');
  const bub = el(over, 'div', 'coach-bubble tour-bubble'), arrow = el(bub, 'span', 'coach-arrow');
  const xb = bub.appendChild(closeButton(tx('tour.quit')));
  const head = el(bub, 'div', 'tour-head'), mark = el(head, 'span', 'btn help-ico'), title = el(head, 'b');
  const para = el(bub, 'p'), note = el(bub, 'p', 'tour-note');
  const row = el(bub, 'div', 'tour-row'), count = el(row, 'span', 'tour-count');
  const back = el(row, 'button', 'btn text bordered sm'), next = el(row, 'button', 'btn text primary sm');
  mark.setAttribute('aria-hidden', 'true');
  back.type = next.type = 'button'; back.textContent = tx('tour.back');

  let idx = -1, cur = null, token = 0, ended = false;

  /* What a step opened, shut again from the last: an opener is pressed again only while what it showed (the next
     opener, or for the last one the lit row) is still out. The next step opening the same thing keeps it open */
  const leave = (to) => {
    if (!cur) return [];
    const c = cur; cur = null;
    if (c.s.picked && !steps[to]?.picked) unpick();
    if (c.s.after) try { c.s.after(); } catch { /* the page's own */ }
    if (steps[to] && c.s.open && JSON.stringify(steps[to].open) === JSON.stringify(c.s.open)) return c.opened;
    for (let i = c.opened.length - 1; i >= 0; i--) {
      const shown = i === c.opened.length - 1 ? c.find() : onScreen(c.opened[i + 1]);
      if (shown && onScreen(c.opened[i])) c.opened[i].click();
    }
    return [];
  };

  const go = (i) => {
    const carried = leave(i);
    if (i >= steps.length) { finish(); return; }
    idx = Math.max(0, i);
    const my = ++token, s = steps[idx];
    cur = { s, el: null, opened: carried, find: () => firstShown(s.sel) || (s.open ? menuTwin(s.sel) : null) };
    if (s.picked) pickOne();
    if (s.before) try { s.before(); } catch { /* the page's own */ }
    const e = cur.find();
    if (e || !s.sel) { show(e); return; }
    /* Not on screen: open what hides it (the step's `open`, one opener or a chain, each showing the next; else the More
       menu fitBar put it in), or give a tap or a redraw a moment to bring it in */
    let chain = [].concat(s.open || []);
    const fm = !chain.some((x) => firstShown(x)) && inMore(s.sel);
    if (fm) { chain = [fm.opener]; cur.find = fm.row; }
    if (!chain.length && firstShown(s.ghost)) { show(null); return; }
    bub.hidden = true;
    let end = Date.now() + 500;
    (function poll() {
      if (my !== token) return;
      const f = cur.find();
      if (f) { show(f); return; }
      /* The next opener that is out and not pressed yet, or pressed but shut since (a press on the tour's Next is a
         press outside a menu, and closes it) */
      for (let k = 0; k < chain.length; k++) {
        const x = typeof chain[k] === 'string' ? firstShown(chain[k]) : (onScreen(chain[k]) ? chain[k] : null);
        if (!x || cur.find()) continue;
        const was = cur.opened.includes(x);
        if (was ? shut(x) : k >= cur.opened.length) {
          x.click();
          if (!was) cur.opened.push(x);
          end = Date.now() + 1500;
          break;
        }
      }
      if (Date.now() >= end) { show(null); return; }
      setTimeout(poll, 80);
    })();
  };

  function show(target) {
    const s = cur.s;
    cur.el = target; cur.ghost = target ? null : firstShown(s.ghost);
    (target || cur.ghost)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const tap = !!(target && s.tap);
    over.classList.toggle('is-tap', tap);
    ring.classList.toggle('is-ghost', !!cur.ghost);
    mark.hidden = !(cur.ghost && s.icon);
    if (!mark.hidden) mark.innerHTML = icon(s.icon);
    title.textContent = s.title || '';
    head.hidden = mark.hidden && !s.title;
    para.textContent = s.text || '';
    note.textContent = tap ? tx('tour.tapIt') : cur.ghost ? tx('tour.ghost')
      : target && cur.opened[0]?.classList.contains('fit-more') ? tx('tour.inMore') : '';
    note.hidden = !note.textContent;
    count.textContent = txf('tour.step', { n: idx + 1, m: steps.length });
    back.hidden = idx === 0;
    next.textContent = idx === steps.length - 1 ? tx('tour.done') : tx('tour.next');
    bub.hidden = false;
    place(); requestAnimationFrame(place);
    try { next.focus({ preventScroll: true }); } catch { /* gone */ }
  }

  const box = (n, l, t, w, h) => Object.assign(n.style, { left: l + 'px', top: t + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px' });

  /* The tour is a popover in the top layer, over the menus and popups it points into. Above an open modal dialog it
     lives in the innermost one (outside it the dialog would cover it and keep its presses). A menu or popup opened
     after it would cover it, so it is shown again, on top (`lift`). Checked on every placing, when a dialog closes,
     and when a menu or popup opens */
  const hostOver = (lift) => {
    if (ended) return;
    const host = $$('dialog[open]').filter((d) => d.matches(':modal')).pop() || document.body;
    if (over.parentNode !== host) { if (over.matches(':popover-open')) over.hidePopover(); host.append(over); }
    if (over.popover !== 'manual') over.popover = 'manual';
    if (lift && over.matches(':popover-open')) {
      const f = document.activeElement;
      over.hidePopover(); over.showPopover();
      if (f && over.contains(f)) try { f.focus({ preventScroll: true }); } catch { /* gone */ }
    }
    if (!over.matches(':popover-open')) over.showPopover();
  };
  const onDialogClose = () => setTimeout(() => { hostOver(); place(); });
  const onPopOpen = (e) => {
    if (e.newState !== 'open' || e.target === over || !e.target.matches?.('.panel.menu, .panel.popup')) return;
    setTimeout(() => { hostOver(true); place(); });
  };

  function place() {
    hostOver();
    if (!cur || bub.hidden) return;
    const vw = innerWidth, vh = innerHeight, PAD = 8;
    const target = cur.el && onScreen(cur.el) ? cur.el : cur.ghost && onScreen(cur.ghost) ? cur.ghost : null;
    const bw = bub.offsetWidth, bh = bub.offsetHeight;
    if (!target) {                                   // nothing to point at: in the middle
      box(panes[0], 0, 0, vw, vh); for (let k = 1; k < 4; k++) box(panes[k], 0, 0, 0, 0);
      lid.hidden = ring.hidden = arrow.hidden = true;
      bub.style.left = Math.max(PAD, (vw - bw) / 2) + 'px'; bub.style.top = Math.max(PAD, (vh - bh) / 2) + 'px';
      return;
    }
    lid.hidden = ring.hidden = arrow.hidden = false;
    /* The hole: the target plus a margin, kept inside the viewport */
    const r = target.getBoundingClientRect();
    const L = Math.max(0, r.left - 5), T = Math.max(0, r.top - 5), R = Math.min(vw, r.right + 5), B = Math.min(vh, r.bottom + 5);
    box(panes[0], 0, 0, vw, T); box(panes[1], 0, B, vw, vh - B); box(panes[2], 0, T, L, B - T); box(panes[3], R, T, vw - R, B - T);
    box(lid, L, T, R - L, B - T); box(ring, L, T, R - L, B - T);
    /* Bubble under the hole, else over it, else inside its lower part (a big area such as a month grid) */
    const cx = (L + R) / 2;
    let top, up = false;
    if (B + 14 + bh + PAD <= vh) top = B + 14;
    else if (T - 14 - bh >= PAD) { top = T - 14 - bh; up = true; }
    else top = vh - bh - PAD;
    const left = Math.max(PAD, Math.min(cx - bw / 2, vw - bw - PAD));
    bub.style.left = left + 'px'; bub.style.top = top + 'px';
    bub.classList.toggle('up', up);
    arrow.hidden = top < B && top + bh > T;          // sits on the target
    arrow.style.left = Math.max(12, Math.min(cx - left, bw - 12)) + 'px';
  }

  /* A tap on the lit target of a tap step: the page acts, then the tour goes on */
  const onTap = (e) => {
    if (!cur?.el || !cur.s.tap || !cur.el.contains(e.target)) return;
    const want = idx + 1;
    setTimeout(() => { if (!ended && idx === want - 1) go(want); });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next.click(); }
    else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); go(idx - 1); }
  };
  /* Presses on the dim panes and the lid end here: the page never sees them (they would close a menu the tour opened) */
  ['click', 'pointerdown', 'mousedown', 'touchstart'].forEach((t) => over.addEventListener(t, (e) => e.stopPropagation()));
  xb.addEventListener('click', () => finish());
  back.addEventListener('click', () => go(idx - 1));
  next.addEventListener('click', () => { if (cur?.el && cur.s.tap && onScreen(cur.el)) cur.el.click(); else go(idx + 1); });

  function finish() {
    if (ended) return;
    ended = true; token++;
    leave();
    document.removeEventListener('click', onTap, true);
    document.removeEventListener('close', onDialogClose, true);
    document.removeEventListener('toggle', onPopOpen, true);
    follow(false, place, onKey);
    over.remove();
    tourOpen = false;
  }

  document.body.append(over);
  document.addEventListener('click', onTap, true);
  document.addEventListener('close', onDialogClose, true);
  document.addEventListener('toggle', onPopOpen, true);
  follow(true, place, onKey);
  go(0);
  return true;
}

/* Ayni.tour(steps, card): the given steps, or the card's ('rows' reads `card`, default the view's card);
   Ayni.tour.add(name, () => step, 'first') adds a shared step */
const tour = (steps, from) => runTour(steps, from);
tour.add = (name, fn, where) => { SHARED[name] = fn; if (where === 'first' && !FIRST.includes(name)) FIRST.push(name); };

/* ---------- First-visit marks (15.4) ---------- */
/* RULE: the first time anyone opens a page of the site, a dim layer rings the few things a newcomer never finds alone
   and hangs a bubble off each. The × of each bubble counts down first (9 s), Esc is held for that time too. Seen when
   the count ends, not when they open or close. They wait while a dialog holds the screen, and a page without their
   targets does not use up the flag */
let coachOpen = false;

const unionBox = (els) => els.filter(onScreen).map((e) => e.getBoundingClientRect()).reduce((a, r) => (!a ? r : {
  left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
}), null);
const boxOf = (r) => r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top };
const targetsOf = (it) => (it.els ? [].concat(it.els) : it.sel ? $$(it.sel) : []).filter(onScreen);

const buildCoach = (items, key, secsAll) => {
  const over = document.createElement('div');
  over.className = 'coach-overlay';
  over.setAttribute('role', 'dialog'); over.setAttribute('aria-modal', 'true');
  /* Rings and lines below, bubbles above, so a later ring never draws over an earlier bubble. Nothing behind the layer
     takes a press (a tap on the very "?" it points at must not open the card under the bubble) */
  const back = over.appendChild(document.createElement('div')), front = over.appendChild(document.createElement('div'));
  back.className = front.className = 'coach-layer';

  const marks = items.map((it) => {
    const mk = (cls) => { const n = document.createElement('div'); n.className = cls; return n; };
    const ring = mk('coach-ring'), line = mk('coach-line'), bub = mk('coach-bubble');
    const arrow = bub.appendChild(document.createElement('span')); arrow.className = 'coach-arrow';
    const btn = bub.appendChild(document.createElement('button'));
    btn.type = 'button'; btn.className = 'coach-close'; btn.ariaDisabled = 'true';
    setTip(btn, tx('coach.wait')); btn.setAttribute('aria-label', tx('coach.wait'));
    const p = bub.appendChild(document.createElement('p')); p.textContent = it.text;
    back.append(ring, line); front.append(bub);
    const m = { it, ring, line, bub, arrow, btn, alive: true };
    btn.addEventListener('click', () => closeMark(m));
    return m;
  });

  /* Lay the rings and bubbles out over the live page; again on every resize, scroll and close */
  const place = () => {
    const vw = innerWidth, vh = innerHeight, PAD = 8, taken = [];
    /* The ringed things are obstacles too: a bubble over the other target hides what it points at */
    const boxes = marks.map((m) => (m.alive ? boxOf(unionBox(targetsOf(m.it))) : null));
    boxes.forEach((b) => b && taken.push({ left: b.left - 6, top: b.top - 6, w: b.width + 12, h: b.height + 12 }));
    marks.forEach((m, i) => {
      if (!m.alive) return;
      const r = boxes[i];
      m.ring.hidden = m.line.hidden = m.bub.hidden = !r;     // the target went away (a mode switch)
      if (!r) return;
      Object.assign(m.ring.style, { left: r.left - 5 + 'px', top: r.top - 5 + 'px', width: r.width + 10 + 'px', height: r.height + 10 + 'px' });
      const bw = m.bub.offsetWidth, bh = m.bub.offsetHeight, cx = r.left + r.width / 2;
      const below = r.bottom + 16 + bh + PAD <= vh;
      let top = below ? r.bottom + 16 : r.top - 16 - bh;
      const left = Math.max(PAD, Math.min(cx - bw / 2, vw - bw - PAD));
      /* Pushed under anything already claimed (top only grows, so the walk ends) */
      for (let k = 0; k < taken.length; k++) {
        const o = taken[k];
        if (left < o.left + o.w + 6 && o.left < left + bw + 6 && top < o.top + o.h + 6 && o.top < top + bh + 6) { top = o.top + o.h + 14; k = -1; }
      }
      top = Math.max(PAD, Math.min(top, vh - bh - PAD));
      taken.push({ left, top, w: bw, h: bh });
      m.bub.style.left = left + 'px'; m.bub.style.top = top + 'px';
      m.bub.classList.toggle('up', !below);
      m.arrow.style.left = Math.max(12, Math.min(cx - left, bw - 12)) + 'px';
      /* A thin line joins bubble and ring when the bubble had to move away */
      const lTop = below ? r.bottom + 5 : top + bh, lBot = below ? top : r.top - 5;
      Object.assign(m.line.style, { left: cx - 1 + 'px', top: lTop + 'px', height: Math.max(0, lBot - lTop) + 'px' });
    });
  };

  let secs = secsAll, timer = 0, done = false;
  const paint = () => {
    marks.forEach(({ btn }) => {
      if (secs > 0) { btn.textContent = String(secs); return; }
      btn.innerHTML = icon('close'); btn.ariaDisabled = 'false';
      setTip(btn, tx('close')); btn.setAttribute('aria-label', tx('close'));
    });
    /* Count over = read: remembered here, so whoever leaves after 3 s meets them again on the next page */
    if (secs <= 0) store.set(key);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();     // no page shortcut runs either
    if (secs <= 0) finish();
  };
  function closeMark(m) {
    if (!m.alive || secs > 0) return;
    m.alive = false; m.ring.remove(); m.line.remove(); m.bub.remove();
    if (marks.some((x) => x.alive)) place(); else finish();
  }
  function finish() {
    if (done) return;
    done = true; clearInterval(timer);
    follow(false, place, onKey);
    over.remove(); coachOpen = false;
  }
  document.body.append(over);
  paint(); place(); requestAnimationFrame(place);
  over.classList.add('open');
  timer = setInterval(() => { secs--; paint(); if (secs <= 0) clearInterval(timer); }, 1000);
  follow(true, place, onKey);
};

/* Ayni.coach(items, { key, secs, force }): false when already seen; else it shows them once their targets are on
   screen and no dialog holds it, trying for a while (a header built late, a picker on a first visit) */
const coach = (items, { key = 'ayni-coach-seen', secs = 9, force = false } = {}) => {
  if (coachOpen || held || (!force && store.get(key) === '1')) return false;
  const tryShow = (tries) => {
    if (coachOpen || held || (!force && store.get(key) === '1')) return;
    const busy = dialogOpen();
    if (!busy && items.every((it) => targetsOf(it).length)) { coachOpen = true; buildCoach(items, key, secs); return; }
    if (tries < (busy ? 100 : 15)) setTimeout(() => tryShow(tries + 1), 600);
  };
  tryShow(0);
  return true;
};

/* ---------- Start-up ---------- */
const setup = () => {
  /* The Help button opens the card; with a Help menu (options.menu) its own popovertarget does the job */
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-help-open]') || !card || card.menu) return;
    e.preventDefault(); showCard();
  }, true);
};
const init = (root) => each(root, '.info-tip', 'info', initInfo);

Object.assign(Ayni, { help, tour, coach });
Ayni.core.family({ setup, init });
})();
