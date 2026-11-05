/* Ayni library 0.1.0, fields family: text fields and text areas, password show / hide, the number field (spin
   button), the date and date-and-time fields with the calendar, sliders and field errors. Plain JavaScript, no build
   step, evergreen browsers 2024+. Load it after ayni-base.js, ayni-buttons.js and ayni-menus.js (the date popups are
   placed by it):
     <script src="ayni-base.js" defer></script>
     <script src="ayni-buttons.js" defer></script>
     <script src="ayni-menus.js" defer></script>
     <script src="ayni-fields.js" defer></script>
   The look is in ayni-fields.css (the field box itself, .input and .input-group, is in ayni-base.css); the rules are
   chapters 4.1-4.4, 4.7, 4.8, 5.4 and 6 of the guidelines. */
(() => {
'use strict';
const { $, $$, icon, setIcon } = Ayni;
const { fire, once, each, tx, txf, LOCALE, isRO, layer, retip } = Ayni.core;
/* Popups are placed by ayni-menus.js, which loads before this file */
const place = (p) => Ayni.core.menus.place(p);
const invoker = () => Ayni.core.menus.invoker();

/* The shared popup of field errors, made at setup */
let errPop;
/* Each typed field that can hold a wrong value registers its check here: Ayni.focusFirstError() runs them first, so a
   value typed and sent with Enter (the field never lost the focus) is checked too */
const checks = new Map();

/* A value the page puts in from code (input.value = ...) runs fn too, so a field never keeps a stale error */
const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
const onCodeValue = (inp, fn) => Object.defineProperty(inp, 'value', {
  configurable: true, get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); fn(); },
});

/* ---------- Text fields ---------- */
/* Optional count for a text area with a limit (opt-in per field): the count sits on the field's bottom border (.ta-wrap > textarea[maxlength] + .ta-count) */
const initCount = (w) => {
  const t = $('textarea', w), c = $('.ta-count', w); if (!t || !c) return;
  const count = () => { c.textContent = `${t.value.length} / ${t.maxLength}`; };
  t.addEventListener('input', count); count();
};
/* Optional auto-grow (opt-in per field, textarea[data-autogrow]): the field grows with its text, from its normal minimum
   height up to --autogrow-max, then scrolls. It has no resize grip, since the height follows the text. */
const initGrow = (t) => {
  const fit = () => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + t.offsetHeight - t.clientHeight}px`; };
  t.addEventListener('input', fit); fit();
};
/* Password: a button with data-reveal inside the field shows and hides the text; the cursor stays in the field. A bare
   button gets its eye, tooltip and pressed state from Ayni */
const initReveal = (b) => {
  if (!b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
  if (!b.getAttribute('aria-label')) { const l = tx('password.show'); b.setAttribute('aria-label', l); b.dataset.tip = l; }
  if (!b.querySelector('svg, .icon')) b.innerHTML = icon('eye');
  if (!b.getAttribute('type')) b.type = 'button';
  b.addEventListener('click', () => {
  const show = b.getAttribute('aria-pressed') !== 'true', pw = $('input', b.closest('.input-group'));
  pw.type = show ? 'text' : 'password'; b.setAttribute('aria-pressed', show);
  const label = tx(show ? 'password.hide' : 'password.show'); b.setAttribute('aria-label', label); b.dataset.tip = label;
  setIcon(b, show ? 'eye-off' : 'eye'); retip(b); pw.focus();
  });
};



/* RULE: number field (spin button). Arrows step, Page Up/Down step 10 times, Home/End go to min/max. Holding − or +
   repeats, slowly and then faster. − is disabled at the minimum and + at the maximum. A typed value out of range shows the
   usual field error instead of being corrected. Both "," and "." are accepted as the decimal separator.
   The page may write only the .spin group and its input (type="number" with min, max and step is fine: Ayni turns it into
   a text box and keeps the limits); Ayni makes the − and + buttons and the error message. data-optional: empty is a
   value too ("no limit"). A step fires the native input and change events on the input (change once a held button is
   let go), and ayni:change { value } on the .spin with the number itself (null when empty) whenever a valid value changes. */
const initSpin = (g) => {
  const inp = $('.input', g);
  const num = (k, d) => { const v = inp.dataset[k] ?? inp.getAttribute(k); return v == null || v === '' || v === 'any' ? d : +v; };
  /* The limits are read again on each check and step: a page may change them (an image's largest size) */
  let min, max, step;
  const limits = () => { min = num('min', -Infinity); max = num('max', Infinity); step = num('step', 1); };
  limits();
  const places = (String(inp.dataset.step ?? inp.getAttribute('step') ?? '1').split('.')[1] || '').length;
  if (inp.type === 'number') inp.type = 'text';
  inp.setAttribute('role', 'spinbutton'); if (!inp.inputMode) inp.inputMode = step % 1 ? 'decimal' : 'numeric';
  inp.autocomplete ||= 'off';
  const optional = inp.hasAttribute('data-optional');
  const stepBtn = (n) => {
    const b = document.createElement('button'), k = n < 0 ? 'spin.less' : 'spin.more';
    b.type = 'button'; b.className = 'btn'; b.dataset.step = n; b.tabIndex = -1; b.setAttribute('aria-label', tx(k)); b.dataset.tip = tx(k);
    b.innerHTML = icon(n < 0 ? 'minus' : 'plus'); return b;
  };
  if (!$('button[data-step]', g)) { inp.before(stepBtn(-1)); inp.after(stepBtn(1)); }
  const [dec, inc] = $$('button[data-step]', g), err = ensureErr(inp, 'between');
  let sep = inp.value.includes(',') ? ',' : '.';
  const parse = () => { const t = inp.value.trim().replace(',', '.'); return t === '' || !/^-?\d*\.?\d+$|^-?\d+\.$/.test(t) ? NaN : +t; };
  const show = (v) => String(+v.toFixed(places)).replace('.', sep);
  const why = () => (Number.isFinite(min) && Number.isFinite(max) ? txf('between', { min: show(min), max: show(max) })
    : Number.isFinite(min) ? txf('atLeast', { min: show(min) }) : Number.isFinite(max) ? txf('atMost', { max: show(max) }) : tx('needNumber'));
  let last;
  /* quiet: an empty field is not marked wrong yet (on load, or emptied from code); the user's typing and sending are not quiet */
  const check = (quiet) => {
    limits();
    const empty = inp.value.trim() === '', v = empty ? null : parse();
    const bad = empty ? !optional && quiet !== true : Number.isNaN(v) || v < min || v > max;
    /* A required field that is empty has no value to tell, quiet or not */
    if (!bad && v !== last && (v !== null || optional)) { const first = last === undefined; last = v; if (!first) fire(g, 'ayni:change', { value: v }); }
    inp.setAttribute('aria-invalid', bad); err.hidden = !bad; err.textContent = why();
    if (!bad && v !== null) inp.setAttribute('aria-valuenow', v); else inp.removeAttribute('aria-valuenow');
    if (Number.isFinite(min)) inp.setAttribute('aria-valuemin', min);
    if (Number.isFinite(max)) inp.setAttribute('aria-valuemax', max);
    const atMin = !bad && v !== null && v <= min, atMax = !bad && v !== null && v >= max;
    if (atMin) dec.setAttribute('aria-disabled', 'true'); else dec.removeAttribute('aria-disabled');
    if (atMax) inc.setAttribute('aria-disabled', 'true'); else inc.removeAttribute('aria-disabled');
    return !bad;
  };
  let told = inp.value;
  const commit = () => { if (inp.value !== told) { told = inp.value; inp.dispatchEvent(new Event('change', { bubbles: true })); } };
  /* A page may put the value right itself on change or blur (clamp it): look again after its handlers */
  inp.addEventListener('change', () => { told = inp.value; setTimeout(() => check(false)); });
  inp.addEventListener('blur', () => setTimeout(() => check(false)));
  const set = (v) => {
    inp.value = show(Math.min(max, Math.max(min, Math.round(v / step) * step)));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const by = (n) => { limits(); const v = parse(); set((Number.isNaN(v) ? (Number.isFinite(min) ? min : 0) : Math.min(max, Math.max(min, v))) + n * step); };
  inp.addEventListener('input', () => { if (inp.value.includes(',')) sep = ','; else if (inp.value.includes('.')) sep = '.'; check(false); });
  inp.addEventListener('keydown', (e) => {
    if (inp.readOnly || isRO(inp)) return;
    const n = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (n) { e.preventDefault(); by(n); commit(); }
    else if (e.key === 'Home' && (limits(), Number.isFinite(min))) { e.preventDefault(); set(min); commit(); }
    else if (e.key === 'End' && Number.isFinite(max)) { e.preventDefault(); set(max); commit(); }
  });
  /* Holding a button repeats: first after 400 ms, every 150 ms, then every 50 ms after 1.5 s */
  [[dec, -1], [inc, 1]].forEach(([b, n]) => {
    let t1, t2, start, held = false;
    const stop = () => { clearTimeout(t1); clearInterval(t2); if (held) { held = false; commit(); } };
    const tick = () => { if (b.getAttribute('aria-disabled') === 'true') return stop(); by(n); };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || b.getAttribute('aria-disabled') === 'true' || inp.disabled || isRO(inp) || inp.readOnly) return;
      e.preventDefault(); inp.focus(); held = true; tick(); start = performance.now();
      t1 = setTimeout(() => { t2 = setInterval(() => { tick(); if (performance.now() - start > 1500) { clearInterval(t2); t2 = setInterval(tick, 50); } }, 150); }, 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { if (e.detail === 0) { by(n); commit(); } }); // assistive tech activation
  });
  checks.set(inp, () => check(false));
  onCodeValue(inp, () => check(true));
  check(true);
};

/* ---------- Calendar (shared by inline calendars and the date popups) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim()); if (!m) return null; const d = new Date(+m[1], m[2] - 1, +m[3]); return iso(d) === s.trim() ? d : null; };
const sameDay = (a, b) => a && b && iso(a) === iso(b);
const fmtLong = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtMonShort = new Intl.DateTimeFormat(LOCALE, { month: 'short' });
const fmtMonLong = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
/* Two-letter day names, Monday first: "Mo", "Lu"... */
const dayHeads = () => Array.from({ length: 7 }, (_, i) => {
  const n = window.Ayni?.i18n?.weekday(i + 1, 'short') || ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][i];
  return n.slice(0, 2);
});
const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtDT = (d) => `${iso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseDT = (str) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(str.trim()); if (!m) return null;
  const d = parseIso(m[1]), h = +m[2], mi = +m[3]; if (!d || h > 23 || mi > 59) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi);
};
/* The ISO week of a day: week 1 holds the year's first Thursday */
const isoWeek = (d) => {
  const thu = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  return 1 + Math.floor(Math.round((thu - new Date(thu.getFullYear(), 0, 1)) / 864e5) / 7);
};
/* Ayni.calendar(root, onPick) draws a calendar in root and returns { set(date), focus() }.
   Optional limits come from data-min / data-max (YYYY-MM-DD) on the calendar root; data-weeks starts each row with its
   ISO week number. Without onPick it is view only: days take no press and no focus, the rest still moves it.
   The title switches days -> months -> years; picking a month or a year returns to the days. */
const makeCalendar = (root, onPick) => {
  const viewOnly = typeof onPick !== 'function', weeks = () => 'weeks' in root.dataset;
  const min = parseIso(root.dataset.min || ''), max = parseIso(root.dataset.max || '');
  let sel = day0(new Date()), cur = day0(new Date()), view = 'days';
  const dayOk = (d) => !(min && d < min) && !(max && d > max);
  const monthOk = (y, m) => !(min && new Date(y, m + 1, 0) < min) && !(max && new Date(y, m, 1) > max);
  const yearOk = (y) => !(min && y < min.getFullYear()) && !(max && y > max.getFullYear());
  const clamp = (d) => (min && d < min ? new Date(min) : max && d > max ? new Date(max) : d);
  const moveMonth = (n) => { const d = cur.getDate(); cur = new Date(cur.getFullYear(), cur.getMonth() + n, 1); cur.setDate(Math.min(d, new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate())); };
  const off = (ok) => (ok ? '' : ' aria-disabled="true"');
  const render = (focus) => {
    const y = cur.getFullYear(), m = cur.getMonth(), today = day0(new Date()), base = y - (y % 12);
    let title, body, prevOk, nextOk, unit;
    if (view === 'days') {
      const first = new Date(y, m, 1), start = new Date(y, m, 1 - ((first.getDay() + 6) % 7));
      let rows = '';
      for (let w = 0; w < 6; w++) {
        rows += '<tr>';
        if (weeks()) rows += `<th scope="row" class="cal-wk">${isoWeek(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7))}</th>`;
        for (let d = 0; d < 7; d++) {
          const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
          const cls = [day.getMonth() !== m ? 'out' : '', sameDay(day, today) ? 'today' : ''].join(' ').trim();
          if (viewOnly) { rows += `<td><span class="${cls}">${day.getDate()}</span></td>`; continue; }
          rows += `<td><button type="button" data-d="${iso(day)}" class="${cls}" tabindex="${sameDay(day, cur) ? 0 : -1}" aria-selected="${sameDay(day, sel)}" aria-label="${dayOk(day) ? fmtLong.format(day) : txf('cal.dayOff', { date: fmtLong.format(day) })}"${off(dayOk(day))}>${day.getDate()}</button></td>`;
        }
        rows += '</tr>';
      }
      title = fmtMonLong.format(cur); unit = 'month';
      prevOk = monthOk(y, m - 1); nextOk = monthOk(y, m + 1);
      body = `<table role="grid" aria-label="${title}"><thead><tr>${weeks() ? '<th scope="col" class="cal-wk"></th>' : ''}${dayHeads().map((x) => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    } else if (view === 'months') {
      title = String(y); unit = 'year';
      prevOk = yearOk(y - 1); nextOk = yearOk(y + 1);
      body = `<div class="cal-grid" role="grid" aria-label="${txf('cal.monthsOf', { year: y })}">${Array.from({ length: 12 }, (_, i) => {
        const cls = y === today.getFullYear() && i === today.getMonth() ? 'today' : '';
        return `<button type="button" data-mo="${i}" class="${cls}" tabindex="${i === m ? 0 : -1}" aria-selected="${y === sel.getFullYear() && i === sel.getMonth()}" aria-label="${fmtMonLong.format(new Date(y, i, 1))}"${off(monthOk(y, i))}>${fmtMonShort.format(new Date(y, i, 1))}</button>`;
      }).join('')}</div>`;
    } else {
      title = txf('cal.yearSpan', { from: base, to: base + 11 }); unit = 'years';
      prevOk = yearOk(base - 1); nextOk = yearOk(base + 12);
      body = `<div class="cal-grid" role="grid" aria-label="${txf('cal.years', { span: title })}">${Array.from({ length: 12 }, (_, i) => {
        const yy = base + i;
        return `<button type="button" data-yr="${yy}" class="${yy === today.getFullYear() ? 'today' : ''}" tabindex="${yy === y ? 0 : -1}" aria-selected="${yy === sel.getFullYear()}"${off(yearOk(yy))}>${yy}</button>`;
      }).join('')}</div>`;
    }
    const titleEl = view === 'years' ? `<span class="cal-title" aria-live="polite">${title}</span>`
      : `<button type="button" class="cal-title" data-view aria-live="polite" data-tip="${tx(view === 'days' ? 'cal.chooseMonth' : 'cal.chooseYear')}">${title}${icon('chev-down')}</button>`;
    root.innerHTML = `<div class="cal-head">
      <button type="button" class="btn icon-btn" data-nav="-1" aria-label="${tx('cal.prev.' + unit)}" data-tip="${tx('cal.prev.' + unit)}"${off(prevOk)}>${icon('chev-right', 'flip')}</button>
      ${titleEl}
      <button type="button" class="btn icon-btn" data-nav="1" aria-label="${tx('cal.next.' + unit)}" data-tip="${tx('cal.next.' + unit)}"${off(nextOk)}>${icon('chev-right')}</button></div>
      <div class="cal-body">${body}</div>
      <div class="cal-foot"><button type="button" class="btn" data-today aria-label="${tx('cal.today')}" data-tip="${dayOk(today) ? txf('cal.todayIs', { date: fmtLong.format(today) }) : tx('cal.todayOff')}"${off(dayOk(today))}>${icon('today')}</button></div>`;
    if (focus === 'title') $('.cal-title', root).focus?.({ preventScroll: true });
    else if (focus) ($('.cal-body [tabindex="0"]', root) || $('.cal-title', root)).focus?.({ preventScroll: true });
  };
  const pick = (d) => { sel = cur = d; view = 'days'; render(true); onPick(sel); };
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t || t.getAttribute('aria-disabled') === 'true') return;
    if (t.dataset.nav) { moveMonth(+t.dataset.nav * (view === 'days' ? 1 : view === 'months' ? 12 : 144)); render(false); }
    else if ('view' in t.dataset) { view = view === 'days' ? 'months' : 'years'; render('title'); }
    else if (t.dataset.mo) { moveMonth(+t.dataset.mo - cur.getMonth()); cur = clamp(cur); view = 'days'; render(true); }
    else if (t.dataset.yr) { moveMonth((+t.dataset.yr - cur.getFullYear()) * 12); cur = clamp(cur); view = 'days'; render(true); }
    else if (t.dataset.d) pick(parseIso(t.dataset.d));
    else if ('today' in t.dataset) { if (viewOnly) { cur = day0(new Date()); view = 'days'; render(false); } else pick(day0(new Date())); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view !== 'days') { e.preventDefault(); e.stopPropagation(); view = 'days'; render(true); return; }
    if (viewOnly && view === 'days') { if (e.key !== 'PageUp' && e.key !== 'PageDown') return; moveMonth(e.key === 'PageUp' ? -1 : 1); e.preventDefault(); render('title'); return; }
    if (!e.target.closest('.cal-body button')) return;
    if (view === 'days') {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + step);
      else if (e.key === 'PageUp' || e.key === 'PageDown') moveMonth(e.key === 'PageUp' ? -1 : 1);
      else if (e.key === 'Home') cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - ((cur.getDay() + 6) % 7));
      else if (e.key === 'End') cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 6 - ((cur.getDay() + 6) % 7));
      else return;
    } else {
      const k = view === 'months' ? 1 : 12;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -12, PageDown: 12 }[e.key];
      if (!step) return;
      moveMonth(step * k);
    }
    e.preventDefault(); render(true);
  });
  render(false);
  return { set: (d) => { sel = cur = d ? day0(d) : day0(new Date()); view = 'days'; render(false); }, focus: () => $('.cal-body [tabindex="0"]', root).focus({ preventScroll: true }) };
};
/* ---------- Date and time fields ----------
   The page may write only the .input-group and its input: Ayni makes what is missing (the button, the popup, the
   error message, the placeholder), in the page's language. Focusing inside a popup never scrolls the page: a scroll
   would close the popup it is in. */
let autoId = 0;
const idOf = (el) => el.id || (el.id = `ayni-f${++autoId}`);
const errOf = (inp) => errSrc(inp);
/* The field's error source: the page's .error, else one made with Ayni's own message; the "!" is wired at once */
const ensureErr = (inp, key) => {
  let err = errOf(inp);
  if (!err) {
    err = document.createElement('span'); err.className = 'error'; err.id = idOf(inp) + '-err'; err.hidden = true; err.textContent = tx(key);
    (inp.closest('.input-group') || inp).after(err);
    inp.setAttribute('aria-describedby', [inp.getAttribute('aria-describedby'), err.id].filter(Boolean).join(' '));
  }
  if (once('error', inp)) initError(inp);
  return err;
};
/* The button at the end of the field, made when the page has none */
const fieldBtn = (g, iconName, key) => {
  let b = $(':scope > button:not(.err-mark)', g);
  if (!b) {
    b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
    b.setAttribute('aria-label', tx(key)); b.dataset.tip = tx(key); b.innerHTML = icon(iconName); g.append(b);
  }
  return b;
};
/* The popup the button opens, made right after the field (so it lives inside the dialog the field is in) */
const fieldPopup = (g, btn, label, html) => {
  const known = btn.getAttribute('popovertarget') && document.getElementById(btn.getAttribute('popovertarget'));
  if (known) return known;
  const p = document.createElement('div');
  p.className = 'panel popup'; p.popover = 'auto'; p.id = idOf(g) + '-pop'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', label);
  p.innerHTML = html; g.after(p); btn.setAttribute('popovertarget', p.id); btn.setAttribute('aria-haspopup', 'dialog');
  Ayni.init(p);
  return p;
};
/* An hour and a minute spinner (minutes step by 5), for the time popups */
const timeRowHtml = () => {
  const step = (d, key, ic) => `<button class="btn" type="button" data-tstep="${d}" aria-label="${tx(key)}" data-tip="${tx(key)}" tabindex="-1">${icon(ic)}</button>`;
  const box = (unit, key, minus, plus) => `<div class="input-group">${step(minus[0], minus[1], 'minus')}<input class="input" inputmode="numeric" maxlength="2" aria-label="${tx(key)}" data-unit="${unit}">${step(plus[0], plus[1], 'plus')}</div>`;
  return `<div class="time-row"><label>${tx('time.label')}</label>${box('h', 'time.hours', ['h,-1', 'time.hourEarlier'], ['h,1', 'time.hourLater'])}`
    + `<span aria-hidden="true">:</span>${box('m', 'time.minutes', ['m,-5', 'time.minEarlier'], ['m,5', 'time.minLater'])}</div>`;
};
/* Up and Down in an hour or minute box step it like its − and + */
const timeRowKeys = (row, by) => $$('.input', row).forEach((f, i) => f.addEventListener('keydown', (e) => {
  const n = { ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!n) return;
  const unit = f.dataset.unit || (i ? 'm' : 'h'); e.preventDefault(); by(unit, unit === 'h' ? n : n * 5);
}));
const prepare = (inp, cls, ph) => {
  const g = inp.closest('.input-group'); g.classList.add(cls);
  if (!inp.placeholder) inp.placeholder = tx(ph);
  if (!inp.inputMode) inp.inputMode = 'numeric';
  inp.autocomplete ||= 'off';
  if (once('datekeys', g)) initDateKeys(g);
  return g;
};
/* When a field's popup closes, the focus goes back to its button */
const backToButton = (e) => { if (e.newState !== 'open') invoker()?.focus({ preventScroll: true }); };

/* A date without a year (a birthday) is kept as --MM-DD and shown as MM-DD */
const parseMD = (t) => {
  const m = /^(?:--)?(\d{2})-(\d{2})$/.exec(t.trim()); if (!m) return null;
  const d = new Date(2000, m[1] - 1, +m[2]); return d.getMonth() === m[1] - 1 && d.getDate() === +m[2] ? d : null;   // 2000: 02-29 is a day
};
const md = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inYear = (d, y) => { const x = new Date(y, d.getMonth(), d.getDate()); return x.getMonth() === d.getMonth() ? x : new Date(y, d.getMonth(), 28); };

/* Ayni.dateField(input, { popup, onChange, noYear }): a YYYY-MM-DD field whose popup holds a .cal; onChange(date, value)
   runs on a pick, and when a typed date is taken (the field is left, or Ayni.focusFirstError checks it). noYear: MM-DD is accepted too and the popup has a "No year" switch; the value is then --MM-DD.
   Returns { check(), value, set(value) }: value is 'YYYY-MM-DD', '--MM-DD' or '' */
const dateField = (inp, { popup, onChange, noYear = false } = {}) => {
  const g = prepare(inp, 'date-field', noYear ? 'date.placeholderNoYear' : 'date.placeholder');
  const btn = fieldBtn(g, 'calendar', 'date.choose');
  const nyHtml = `<label class="switch end no-year">${tx('date.noYear')}<input type="checkbox" role="switch"></label>`;
  popup ||= fieldPopup(g, btn, tx('date.choose'), '<div class="cal"></div>' + (noYear ? nyHtml : ''));
  if (noYear && !$('.no-year', popup)) { popup.insertAdjacentHTML('beforeend', nyHtml); Ayni.init(popup); }
  const err = ensureErr(inp, noYear ? 'date.formatNoYear' : 'date.format'), ny = noYear ? $('.no-year input', popup) : null;
  /* { date, year } for what is typed, '' when empty, null when it is not a date */
  const read = () => {
    const t = inp.value.trim(); if (t === '') return '';
    const d = parseIso(t); if (d) return { date: d, year: true };
    const m = noYear && parseMD(t); return m ? { date: m, year: false } : null;
  };
  const value = () => { const r = read(); return !r ? '' : r.year ? iso(r.date) : '--' + md(r.date); };
  const check = () => { const bad = read() === null; inp.setAttribute('aria-invalid', bad); err.hidden = !bad; return !bad; };
  const write = (d, year) => { inp.value = year ? iso(d) : md(d); check(); };
  /* What the page last saw: a value it put in itself (input.value = ...) counts as seen once the user comes to the field */
  let last = value();
  inp.addEventListener('focus', () => { if (inp.getAttribute('aria-invalid') !== 'true') last = value(); });
  const told = (d) => { const v = value(); if (v !== last) { last = v; onChange?.(d, v); } };
  const tidy = () => { const r = read(); if (r) { write(r.date, r.year); told(r.date); } else if (r === '') { check(); told(null); } else check(); return r !== null; };
  inp.addEventListener('blur', tidy); checks.set(inp, tidy);
  onCodeValue(inp, () => { if (inp.getAttribute('aria-invalid') === 'true' && read() !== null) check(); });
  /* Told before the popup closes: closing gives the focus back to the field, which counts what it holds as seen */
  const cal = makeCalendar($('.cal', popup), (d) => { write(d, !ny?.checked); told(d); popup.hidePopover(); });
  ny?.addEventListener('change', () => {
    const r = read(); if (!r) return;
    write(ny.checked ? r.date : inYear(r.date, new Date().getFullYear()), !ny.checked); told(read().date);
  });
  popup.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const r = read(); if (r !== null) last = value(); if (ny) ny.checked = !!r && !r.year;
    cal.set(r ? (r.year ? r.date : inYear(r.date, new Date().getFullYear())) : null); place(popup); cal.focus();
  });
  popup.addEventListener('toggle', backToButton);
  return {
    check, get value() { return value(); },
    set(v) { const d = parseIso(v || ''), m = !d && noYear && parseMD(v || ''); if (d) write(d, true); else if (m) write(m, false); else { inp.value = ''; check(); } last = value(); },
  };
};

/* Ayni.timeField(input, { popup, onChange }): an HH:MM field (24 hours) whose popup holds an hour and a minute spinner;
   the time applies as it changes; onChange('HH:MM') runs on every change. Returns { value, set(value) } */
const parseHM = (t) => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(t.trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
const fmtHM = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const timeField = (inp, { popup, onChange } = {}) => {
  const g = prepare(inp, 'time-field', 'time.placeholder');
  const btn = fieldBtn(g, 'clock', 'time.choose');
  popup ||= fieldPopup(g, btn, tx('time.choose'), timeRowHtml());
  const err = ensureErr(inp, 'time.format'), [hIn, mIn] = $$('.time-row .input', popup);
  const now5 = () => { const d = new Date(); return Math.ceil((d.getHours() * 60 + d.getMinutes()) / 5) * 5 % 1440; };
  let t = parseHM(inp.value);
  const fill = () => { const v = t ?? now5(); hIn.value = pad(Math.floor(v / 60)); mIn.value = pad(v % 60); };
  const set = (n, tell = true) => {
    const was = inp.value; t = ((n % 1440) + 1440) % 1440; inp.value = fmtHM(t); fill();
    inp.setAttribute('aria-invalid', 'false'); err.hidden = true;
    if (tell && inp.value !== was) onChange?.(inp.value);
  };
  const by = (unit, n) => set((t ?? now5()) + (unit === 'h' ? n * 60 : n));
  $$('[data-tstep]', popup).forEach((b) => b.addEventListener('click', () => { const [u, n] = b.dataset.tstep.split(','); by(u, +n); }));
  timeRowKeys($('.time-row', popup), by);
  [hIn, mIn].forEach((f) => f.addEventListener('change', () => {
    const h = Math.min(23, Math.max(0, Math.round(+hIn.value || 0))), mi = Math.min(59, Math.max(0, Math.round(+mIn.value || 0)));
    set(h * 60 + mi);
  }));
  const tidy = () => {
    if (inp.value.trim() === '') { t = null; inp.setAttribute('aria-invalid', 'false'); err.hidden = true; return true; }
    const n = parseHM(inp.value);
    if (n !== null) { set(n); return true; } inp.setAttribute('aria-invalid', 'true'); err.hidden = false; return false;
  };
  inp.addEventListener('blur', tidy); checks.set(inp, tidy);
  onCodeValue(inp, () => { const n = parseHM(valueDesc.get.call(inp)); if (n !== null || valueDesc.get.call(inp).trim() === '') { t = n; inp.setAttribute('aria-invalid', 'false'); err.hidden = true; } });
  popup.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const n = parseHM(inp.value); if (n !== null) t = n;
    fill(); place(popup); hIn.focus({ preventScroll: true }); hIn.select();
  });
  popup.addEventListener('toggle', backToButton);
  if (t !== null) inp.value = fmtHM(t);
  return { get value() { const n = parseHM(inp.value); return n === null ? '' : fmtHM(n); }, set: (v) => { const n = parseHM(v || ''); if (n === null) { t = null; inp.value = ''; } else set(n, false); } };
};

/* Ayni.dateTimeField(input, { popup, value, onChange }): one value, edited by typing (YYYY-MM-DD HH:MM) or in the
   popup (a .cal plus hour and minute fields in a .time-row), applied live; onChange(date) runs on every change */
const dateTimeField = (inp, { popup, value = new Date(), onChange } = {}) => {
  const g = prepare(inp, 'date-field', 'date.placeholder');
  if (inp.placeholder === tx('date.placeholder')) inp.placeholder = `${tx('date.placeholder')} ${tx('time.placeholder')}`;
  const btn = fieldBtn(g, 'calendar', 'date.choose');
  popup ||= fieldPopup(g, btn, tx('date.choose'), '<div class="cal"></div>' + timeRowHtml());
  const err = ensureErr(inp, 'date.format'), [hIn, mIn] = $$('.time-row .input', popup);
  let dt = value;
  const show = () => { inp.value = fmtDT(dt); hIn.value = pad(dt.getHours()); mIn.value = pad(dt.getMinutes()); inp.setAttribute('aria-invalid', 'false'); err.hidden = true; };
  const cal = makeCalendar($('.cal', popup), (d) => { dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), dt.getHours(), dt.getMinutes()); show(); onChange?.(dt); });
  const set = (d) => { dt = d; show(); cal.set(dt); onChange?.(dt); };
  const by = (unit, n) => { const y = dt.getFullYear(), mo = dt.getMonth(), da = dt.getDate();
    set(unit === 'h' ? new Date(y, mo, da, dt.getHours() + n, dt.getMinutes()) : new Date(y, mo, da, dt.getHours(), dt.getMinutes() + n)); };
  $$('[data-tstep]', popup).forEach((b) => b.addEventListener('click', () => { const [u, n] = b.dataset.tstep.split(','); by(u, +n); }));
  timeRowKeys($('.time-row', popup), by);
  [hIn, mIn].forEach((f) => f.addEventListener('change', () => {
    const h = Math.min(23, Math.max(0, Math.round(+hIn.value || 0))), mi = Math.min(59, Math.max(0, Math.round(+mIn.value || 0)));
    set(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), h, mi));
  }));
  const tidy = () => {
    if (inp.value.trim() === '') return true;
    const d = parseDT(inp.value);
    if (d) { set(d); return true; } inp.setAttribute('aria-invalid', 'true'); err.hidden = false; return false;
  };
  inp.addEventListener('blur', tidy); checks.set(inp, tidy);
  popup.addEventListener('toggle', (e) => {
    if (e.newState === 'open') { const d = parseDT(inp.value); if (d) dt = d; show(); cal.set(dt); place(popup); cal.focus(); }
  });
  popup.addEventListener('toggle', backToButton);
  show();
  return { set, get: () => dt };
};
/* Alt+Down or F4 in a date or time field opens its popup, like the list picker */
const initDateKeys = (g) => {
  const inp = $('.input', g);
  inp.addEventListener('keydown', (ev) => {
    if (!((ev.altKey && ev.key === 'ArrowDown') || ev.key === 'F4')) return;
    ev.preventDefault();
    const btn = $(':scope > button:not(.err-mark)', g);
    if (btn && !inp.disabled && btn.getAttribute('aria-disabled') !== 'true') btn.click();
  });
};

/* ---------- Field errors: Danger border + small red "!" inside the field; the message floats in a popup ----------
   RULE (Frasquito, 2026-10-22): any control whose aria-describedby points at a .error gets this. The .error element
   stays as the (hidden) message source, so code keeps setting aria-invalid, its text and its hidden flag as usual. */
const errMarks = new Map();
let errFor = null, errPinned = false;
/* The message by id; in a form built in code and not on the page yet, next to the field */
const byId = (c, id) => !id ? null : (document.getElementById(id) || (c.closest('.input-group') || c).parentElement?.querySelector(`[id="${CSS.escape(id)}"]`));
const errSrc = (c) => (c.getAttribute('aria-describedby') || '').split(/\s+/).map((id) => byId(c, id)).find((e) => e?.classList.contains('error'));
const errGroup = (c) => c.matches('fieldset, [role="listbox"], [role="tree"], [role="radiogroup"]');
const errBad = (c) => c.getAttribute('aria-invalid') === 'true';
const hideErr = () => { errFor = null; errPinned = false; if (errPop.matches(':popover-open')) errPop.hidePopover(); };
const showErr = (c, pin = false) => {
  const src = errSrc(c), m = errMarks.get(c); if (!src || !errBad(c)) return;
  errFor = c; errPinned = pin; errPop.textContent = src.textContent.trim();
  if (!errPop.matches(':popover-open')) errPop.showPopover();
  const box = (errGroup(c) ? m : c.closest('.input-group, .err-wrap') || c).getBoundingClientRect(), p = errPop.getBoundingClientRect();
  let y = box.bottom + 4; if (y + p.height > innerHeight - 8) y = box.top - p.height - 4;
  const x = errGroup(c) ? box.left - 8 : box.right - p.width;
  errPop.style.left = Math.max(8, Math.min(x, innerWidth - p.width - 8)) + 'px'; errPop.style.top = Math.max(8, y) + 'px';
};
const errSync = (c) => {
  const m = errMarks.get(c); if (!m) return; // the field has gone (a tree item's name editor)
  const bad = errBad(c); m.hidden = !bad;
  const focused = c === document.activeElement || (errGroup(c) && c.contains(document.activeElement));
  if (bad && (focused || errFor === c)) showErr(c, errPinned && errFor === c); else if (errFor === c) hideErr();
};
const initError = (c) => {
  const src = errSrc(c); if (!src) return;
  src.dataset.errSrc = '';
  const m = document.createElement('button');
  Object.assign(m, { type: 'button', className: 'err-mark', tabIndex: -1, textContent: '!' }); m.setAttribute('aria-hidden', 'true');
  if (errGroup(c)) {
    const lab = c.matches('fieldset') ? $(':scope > legend', c) : document.getElementById(c.getAttribute('aria-labelledby'));
    if (lab || c.matches('fieldset')) (lab || c).append(m);
    /* A list with no visible label: the "!" sits inside its top-right corner, as inside a text field */
    else { const w = document.createElement('span'); w.className = 'err-wrap err-corner'; c.before(w); w.append(c, m); }
  } else if (c.parentElement.matches('.input-group, .spin, .picker')) c.after(m);
  else { const w = document.createElement('span'); w.className = 'err-wrap'; c.before(w); w.append(c, m); }
  errMarks.set(c, m);
  m.addEventListener('pointerdown', (e) => e.preventDefault());
  m.addEventListener('click', () => (errFor === c && errPinned ? hideErr() : showErr(c, true)));
  m.addEventListener('mouseenter', () => { if (errFor !== c) showErr(c); });
  m.addEventListener('mouseleave', () => { const f = c === document.activeElement || c.contains(document.activeElement); if (errFor === c && !errPinned && !f) hideErr(); });
  new MutationObserver(() => errSync(c)).observe(c, { attributes: true, attributeFilter: ['aria-invalid'] });
  new MutationObserver(() => { if (errFor === c) showErr(c, errPinned); }).observe(src, { childList: true, characterData: true, subtree: true });
  errSync(c);
};
/* The tree's rename field (ayni-lists.js) and the filtered list (ayni-pickers.js) use the same "!"; check(field, fn)
   registers a field's own check, which Ayni.focusFirstError runs first */
Ayni.core.errors = { init: initError, forget: (c) => { errMarks.delete(c); if (errFor === c) hideErr(); }, check: (c, fn) => checks.set(c, fn) };
/* Ayni.focusFirstError(root): on sending a form, true when a field is wrong: the focus goes to the first one, so its message
   shows. Typed date, time and number fields are checked again first */
const focusFirstError = (root = document) => {
  checks.forEach((fn, f) => { if (!f.isConnected) checks.delete(f); else if (root.contains(f) && !f.disabled) fn(); });
  const c = [...errMarks.keys()].find((k) => root.contains(k) && errBad(k)); if (!c) return false;
  (errGroup(c) ? $('input:not([disabled]), [tabindex="0"], [role="option"]', c) || c : c).focus(); return true;
};

/* ---------- Page-wide behaviour, set up once ---------- */
const setup = () => {
  errPop = layer('ayni-err', '<div class="panel popup err-pop" popover="manual" id="ayni-err" aria-hidden="true"></div>');

  /* Read-only sliders show their value but cannot change (radios, check boxes and switches: ayni-buttons.js) */
  addEventListener('keydown', (e) => { if (isRO(e.target) && e.target.type === 'range' && /^(Arrow|Page|Home|End)/.test(e.key)) e.preventDefault(); }, true);
  addEventListener('pointerdown', (e) => { if (isRO(e.target) && e.target.type === 'range') e.preventDefault(); }, true);

  /* Field errors */
  document.addEventListener('focusin', (e) => {
    const c = [...errMarks.keys()].find((k) => k === e.target || (errGroup(k) && k.contains(e.target)));
    if (c && errBad(c)) showErr(c); else if (errFor && !errPinned) hideErr();
  });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!errFor || errPinned) return;
    const a = document.activeElement; if (a !== errFor && !(errGroup(errFor) && errFor.contains(a))) hideErr();
  }));
  document.addEventListener('pointerdown', (e) => { if (errPinned && !e.target.closest('.err-mark, #ayni-err')) hideErr(); }, true);
  /* Page scroll or resize: a focused field's message follows the field; a hovered or clicked one closes */
  errPop.addEventListener('ayni:dismiss', (e) => {
    e.preventDefault(); const c = errFor, a = document.activeElement;
    if (c && !errPinned && (a === c || (errGroup(c) && c.contains(a)))) showErr(c); else hideErr();
  });
};

/* ---------- Ayni.init(root): wire up the fields inside root ---------- */
const init = (root) => {
  each(root, '.ta-wrap', 'count', initCount);
  each(root, 'textarea[data-autogrow]', 'grow', initGrow);
  each(root, '[data-reveal]', 'reveal', initReveal);
  each(root, '.spin', 'spin', initSpin);
  each(root, '.date-field, .time-field', 'datekeys', initDateKeys);
  each(root, '[aria-describedby]', 'error', initError);
};

Object.assign(Ayni, {
  focusFirstError,
  calendar: makeCalendar, dateField, timeField, dateTimeField,
  dates: { pad, iso, parseIso, formatLong: (d) => fmtLong.format(d), formatDateTime: fmtDT, parseDateTime: parseDT },
});
Ayni.core.family({ setup, init });
})();
