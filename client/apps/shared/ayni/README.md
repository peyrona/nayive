<div align="center">

# Ayni : Modern web CUA

**One way of working, on every screen.**

A consistent, modern and intuitive user-interface library where every control follows the same rules.
Plain HTML, CSS and JavaScript. No framework, no build step, nothing to install.

[**Open the gallery**](https://peyrona.github.io/ayni/gallery/) · [Read the design guidelines](docs/guidelines.md) · [Quick start](#quick-start)

</div>

![The Ayni gallery in light mode: round icon buttons, radio buttons, check boxes, switches and the second-action dot](docs/gallery-light.png)

## Why Ayni

Most interfaces grow one screen at a time, and every screen invents its own little habits. Ayni starts from the other end: first the rules, then the controls that obey them. The result is an interface that feels the same everywhere.

- **Consistent.** One look per state across every control. Disabled is always faded, read-only is always a soft tint, an error is always a red border with a small "!".
- **Congruent.** Each sign means one thing. A filled button is the default, and nothing else. A small dot means "this button has a second action". A small triangle means "this opens something".
- **Intuitive.** Things work the way people already expect: Esc closes, Enter runs the default button, typing jumps to a match in any list, and a long tap means "more for this thing".

## What makes it different

**Round, icon-only buttons.** Every button is a circle with an icon and a tooltip; it stays quiet (no border, dim icon) until the pointer reaches it. Colour carries meaning (red for danger, green for success, amber for warning), and a danger button is never the default.

**A second action, clearly marked.** A small dot on a button says it also takes a double-click, a long tap on touch screens, or Shift+Enter. The tooltip names both actions, and a ring fills in while you hold.

**Colours with a job each.** Every colour has one named job: `--bg`, `--card`, `--text`, `--accent`, `--danger`, `--ok`, `--warn`, `--busy`... A few more are worked out from them in the browser. Light and dark follow the system until the user picks one, or follow the sun. Users can make their own schemes.

**Touch-first, not touch-afterwards.** On a touch screen every target grows to at least 44 × 44 px. Tooltips give way to a Help button that lists everything on the screen and explains it. Drop-down lists become bottom sheets that stay above the on-screen keyboard.

**Dialogs without the Cancel/OK dance.** Changes apply as they are made, or when the dialog closes. Esc always closes a dialog, and an extra button appears only when it is really needed. The caret starts in the first field, Enter runs the default button, and a confirmation, message or question is one `await` away.

**Errors that don't push the layout around.** Nothing is added below a field. The border turns red, a small "!" appears inside the field, and the message pops up while you are in the field.

**Every language, no network.** Every text comes from a language file (English, Spanish, Portuguese, French and German ship with Ayni). The system font is used, and nothing is loaded from other sites.

**Nothing to build, take only what you use.** The base (`ayni-i18n.js`, `ayni-base.css`, `ayni-base.js`, `ayni-icons.js` and the `i18n/` folder) holds the colours, light and dark, icons and texts; the controls come on top, one file pair per family of controls (until they are all split, `ayni.css` and `ayni.js` hold the rest). It all works from any static web server. The target is evergreen browsers from 2024 on (Chrome 119, Firefox 128, Safari 18).

![The Ayni gallery in dark mode: sliders, a date field, the calendar and the date-and-time popup](docs/gallery-dark.png)

## What's inside

| Family | Controls |
| --- | --- |
| **Buttons** | Push buttons (normal, small, bordered), default and busy buttons, toggles, popup buttons, second-action buttons, buttons over pictures, text buttons for wide calls to action, radio buttons, check boxes with a mixed state, switches |
| **Lists** | Single and multiple selection lists with type-ahead, drop-down list, combo box, all with one list picker on every device |
| **Texts** | Text fields with buttons inside, search field with filter, password show/hide, text area with a counter, number field, progress, info labels |
| **Pickers** | Slider, date field, date and time, a calendar with month and year views and date limits |
| **Menus** | Menu bar, pull-down menus, pop-up menus (right-click, long tap, Shift+F10), toolbar, popups that hold any control |
| **Feedback** | Tooltips, notifications (four kinds, stacked, Undo with Ctrl+Z while it shows), progress notifications, status bar, loading and empty states |
| **Layout** | Panels, tabs (closable, scrollable, keyboard-friendly), group boxes, a splitter with collapse and reset, scrolling everywhere |
| **Desktop** | Taskbar at the top or bottom, applications launcher with search, one chip per window with its controls, clock widget, windows with a title row toolbar and their own modeless dialogs |
| **Dialogs** | Message, live settings, apply on close, confirmation, modeless |

Everything works from the keyboard, with a mouse and by touch, and every state is shown in the gallery.

## Quick start

Copy the `ayni-*` files, `tz-geo.json` and the `i18n/` folder next to your page:

```html
<script src="ayni-i18n.js"></script>
<link rel="stylesheet" href="ayni-base.css">
<link rel="stylesheet" href="ayni-buttons.css">
<link rel="stylesheet" href="ayni-toasts.css">
<link rel="stylesheet" href="ayni-dialogs.css">
<link rel="stylesheet" href="ayni.css">
<script src="ayni-icons.js" defer></script>
<script src="ayni-base.js" defer></script>
<script src="ayni-buttons.js" defer></script>
<script src="ayni-toasts.js" defer></script>
<script src="ayni-dialogs.js" defer></script>
<script src="ayni.js" defer></script>

<button class="btn primary" data-i18n-attr="aria-label:new, data-tip:new">
  <span class="icon" data-icon="plus"></span>
</button>
```

That's it: the library finds its controls when the page loads. Then open [`gallery/index.html`](gallery/index.html), find the control you need and copy its markup.

## The gallery

The gallery is the living reference. It shows every control in every state, in light and dark, with a **Touch preview** switch so you can try the touch layout with a mouse. Open it [online](https://peyrona.github.io/ayni/gallery/) (once GitHub Pages is turned on for this repository), or open `gallery/index.html` straight from your disk.

The rules behind every control are in the [Ayni Design Guidelines](docs/guidelines.md) book. The book says what the rules are, and the gallery shows them working.

## Roadmap

Ayni is at version 0.1.0. The design is still being closed, so the markup and the API may change before 1.0.

- [ ] **Nayive's look.** Colours, type, corners, icons and languages taken from Nayive, the first app built on Ayni (rules written, code under way).
- [ ] **Desktop mode.** From 1024 px wide, Ayni switches on its own to a desktop with windows and a taskbar; below that there is no desktop mode. Under way: the taskbar (at the top or bottom, with the launcher, one chip per window and the clock) and the window are in, see the [desktop page](https://peyrona.github.io/ayni/gallery/desktop.html).
- [x] **Tree view.** Optional root, hidden items, drag and drop, keyboard moves, cut/copy/paste, insert, delete with Undo, rename in place and loading on demand.
- [ ] **Accessibility for everyone.** Screen readers, captions, right-to-left languages and Windows High Contrast come once the design is closed.

---

# Reference

## Using the library

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <script src="ayni-i18n.js" data-dict="i18n/" data-langs="en es pt fr de"></script>
  <script>try{document.documentElement.dataset.theme=localStorage.getItem('ayni-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}catch(e){}</script>
  <link rel="stylesheet" href="ayni-base.css">
  <link rel="stylesheet" href="ayni-buttons.css">
  <link rel="stylesheet" href="ayni-toasts.css">
  <link rel="stylesheet" href="ayni-dialogs.css">
  <link rel="stylesheet" href="ayni.css">
  <script src="ayni-icons.js" defer></script>
  <script src="ayni-base.js" defer></script>
  <script src="ayni-buttons.js" defer></script>
  <script src="ayni-toasts.js" defer></script>
  <script src="ayni-dialogs.js" defer></script>
  <script src="ayni.js" defer></script>
  <script src="app.js" defer></script>
</head>
<body>
  <section class="panel">
    <header><h2>Invoices</h2></header>
    <div class="body">
      <button class="btn primary" data-i18n-attr="aria-label:new, data-tip:new"><span class="icon" data-icon="plus"></span></button>
    </div>
  </section>
</body>
</html>
```

`ayni-i18n.js` comes first and without `defer`: it starts loading the texts at once and keeps the page hidden until they are in (2.5 s at most). `data-dict` is the folder with the app's own language files, `data-langs` the languages it offers (the first one is its reference language); Ayni's own texts come from its `i18n/` folder. The one-line script applies the saved light or dark choice before the first paint. Load the other scripts with `defer`, in this order. Ayni starts once the page is parsed and the texts are in; `Ayni.ready` resolves then, and your own code that builds controls or calls Ayni waits for it (`await Ayni.ready` in a module). When the page has loaded, `ayni.js` wires up every control it finds. For content added later, call `Ayni.init(element)`; a control is never wired twice, so calling it again is safe.

The markup of each control is the one in `gallery/index.html`: copy a specimen from there and change its text. The main building blocks are:

| Control | Markup |
| --- | --- |
| Panel (the base surface of windows, dialogs, menus and popups) | `.panel` with `header`, `.body` and `footer` |
| Button (round, icon only, always with a tooltip) | `button.btn` with `data-tip` (Ayni fills in `aria-label` from it); borderless with a dim icon at rest; `.sm` is small, `.bordered` adds a disc and a border, `.primary` marks the default button; `.danger`, `.ok`, `.warn` colour the icon; `.on-media` is a glass disc over a picture |
| Text button (wide calls to action only) | `button.btn.text` with an optional icon and a short label; `.bordered`, `.dashed`, `.sm` |
| Toggle button | `.btn` with `aria-pressed` and `data-toggle` |
| Switch (on/off, like one check box) | `label.switch` with the text, then `input[type="checkbox"][role="switch"]`; `label.switch.end` puts the switch at the row's end, in a list of settings |
| Two-sided switch (two options, like two radio buttons) | `.switch-pair[role="radiogroup"]` with `label > input[type="radio"]`, `span.track`, `label > input[type="radio"]` |
| Second action (double-click, long tap, Shift+Enter) | `data-alt="what it does"` on a `.btn`; listen for `ayni:press` |
| Busy button | `Ayni.setBusy(button, 'Saving…')`, then `Ayni.setBusy(button, false)` |
| New tooltip | `Ayni.setTip(element, 'Pause')`: shown at once if open; a round button's aria-label follows |
| Disabled button | `aria-disabled="true"` (stays focusable, its tooltip says why) |
| Tooltip | `data-tip` on any element |
| Info label | `button.info-tip` with `popovertarget="ayni-help"` and `data-help` |
| Tabs | `[role="tablist"]` with `[role="tab"]` and `[role="tabpanel"]`; `data-closable` and a `[data-close]` span for closable tabs; `data-hash` keeps the tab in the address |
| List box | `ul.lb[role="listbox"]`, `aria-multiselectable="true"` for several |
| Drop-down list and combo box | `.picker` with `data-picker="list"` or `data-picker="combo"` |
| Text field with buttons inside | `.input-group` |
| Search field | `.input-group.search-field` with a `[data-clear]` button |
| Password with show/hide | a `.btn` with `data-reveal` inside the `.input-group` |
| Text area that grows with its text (optional) | `textarea.input[data-autogrow]`; set `--autogrow-max` to change the 240px limit |
| Text area with a count (optional) | `.ta-wrap` with `textarea[maxlength]` and `.ta-count`; a plain `textarea.input` has none |
| Number field | `.input-group.spin` with `data-min`, `data-max`, `data-step` on the input |
| Field error | `aria-invalid="true"` plus `aria-describedby` pointing at a `.error` element with the message |
| Menu, pop-up menu | `.panel.menu[popover][role="menu"]` with `[role="menuitem"]` buttons; menu bar is `[role="menubar"]` |
| Popup with controls | `.panel.popup.controls[popover]` |
| Dialog | `dialog.panel` (small) or `dialog.panel.big` with `header`, `.body` and `footer`; any element with `data-open-dialog="id"` opens it, a `.btn[data-close]` closes it. Small dialogs fit their content (300-460 px) and stay floating; big ones (880 × 640) fill the screen below 1024 px. Only the dialog's buttons and Esc close it |
| Splitter | `.split` (`.split.rows` for top and bottom) with two `.pane` and a `.splitter` between them |
| Light/dark toggle | `data-theme-toggle` on a button |
| Status bar | `.statusbar`; mark the message cell with `data-ayni-status` |
| Desktop | `.desktop[data-edge]` with `main.area` and `nav.taskbar` (launcher `.btn.primary[popovertarget]`, `.chips`, `.widgets`); see `gallery/desktop.html` |
| Window | `section.panel.window` inside `.area`: `header` with `.app` (icon and `h2`) and `[role="toolbar"]`, then `.body`. Its chip is added by Ayni |
| Launcher | `.panel.popup.launcher[popover]` with a `.search-field` and `.apps > button[data-app]` |
| Clock widget | `.widget.clock` (any app widget is a `.widget`) |

A few controls need one call because they take options:

```js
Ayni.toolbar(document.querySelector('#my-toolbar'));                 // one Tab stop, arrows move
Ayni.calendar(element, (date) => { … });                             // inline calendar
Ayni.dateField(input, { popup, onChange: (date) => { … } });         // YYYY-MM-DD field with a calendar popup
Ayni.dateTimeField(input, { popup, value, onChange: (date) => { … } }); // YYYY-MM-DD HH:MM
Ayni.contextMenu(area, { menu, target: (event) => ({ name, back }) });  // right-click, long tap, Shift+F10
```

### Events

Controls tell the page what happened with DOM events that bubble, so one listener on `document` can serve the whole page.

| Event | Fired on | `event.detail` |
| --- | --- | --- |
| `ayni:change` | `.lb` list box | `{ selected }`: the texts of the selected items |
| `ayni:change` | `.picker` | `{ value, name, field, input }` |
| `ayni:press` | `.btn[data-alt]` | `{ second, label }`; use it instead of `click` on these buttons |
| `ayni:action` | `.panel.menu` | `{ item, menu, act }`: the chosen item, the menu's name, its `data-act` |
| `ayni:choose` | `.panel.menu` | the chosen `menuitemradio` |
| `ayni:tabselect`, `ayni:tabclose` | `[role="tablist"]` | the tab |
| `ayni:select` | `[role="tree"]` | `{ item, items, path }`: the focused item, all selected items, the focused item's path of names |
| `ayni:open` | `[role="tree"]` | `{ item, path }`: a leaf opened with a double-click or Enter |
| `ayni:move` | `[role="tree"]` | `{ items, parent, index }`, before the move; `preventDefault()` refuses it |
| `ayni:insert` | `[role="tree"]` | `{ items, parent, index, name }` for a new item, `{ …, copy: true, from }` for a paste, `{ items, undo: true }` for an Undo; cancelable |
| `ayni:delete` | `[role="tree"]` | `{ items }`; cancelable |
| `ayni:rename` | `[role="tree"]` | `{ item, from, to }`; cancelable |
| `ayni:hide` | `[role="tree"]` | `{ items, hidden }`; cancelable |
| `ayni:showhidden` | `[role="tree"]` | `{ on }` |
| `ayni:load` | `[role="tree"]` | `{ item, id, path, done(items), fail(text) }`: a `data-lazy` folder opened for the first time |
| `ayni:split` | `.split` | `{ action, pane, message }` |
| `ayni:theme` | `document` | `{ theme }`: light or dark changed (by hand, by the system, by the sun, in another tab) |
| `ayni:desktopmode` | `document` | `{ on }`: the width crossed 1024 px; desktop mode exists only from there |
| `ayni:edge` | `.desktop` | `{ edge }`: the user moved the taskbar to the top or the bottom |
| `ayni:launch` | `.launcher` | `{ app, item }`: an app was picked |
| `ayni:window` | `.panel.window` | `{ window, state }`: open, select, minimise, maximise, restore or close |
| `ayni:close` | `.panel.window` | `{ window }`, before it closes; cancelable |
| `ayni:dismiss` | an open menu or popup, before the page scroll or a resize closes it | cancel it with `preventDefault()` to keep the popup |

### JavaScript API

Everything lives on `window.Ayni`: `ready`, `init`, `status(text)`, `toast(kind, text, { undo, final, keepOnLeave, action, persist })` (returns `{ close() }`), `settleUndo()`, `dialog({ title, big })` (returns `{ dialog, body, footer, show(), close() }`), `dialogButton(role, tip, icon)`, `confirm(options)` (`true`, `false` or `'other'`), `alert(options)`, `ask(options)` (the text, or `null`), `autoSave(field, save, options)`, `progress(text, { pct, onStop })` (returns `{ set(text, pct), end() }`), `setBusy`, `setTip(element, text)`, `place(popup)`, `contextMenu`, `toolbar`, `tree(element, { root, items })` (returns the tree's controller: `data()`, `add`, `remove`, `rename`, `move`, `hide`, `showHidden`, `select`, `selected`, `path`), `calendar`, `dateField`, `dateTimeField`, `fillHelp(body, entries)` (the touch Help dialog), `focusFirstError(root)`, `isTouch()`, `setTouchPreview(on)`, `isDark()`, `setTheme('light' | 'dark' | 'sun' | null)` (`null` = follow the system), `theme.setPlace(lat, lon)` (for the sun), `theme.schemes` (the user's own schemes), `supported()` (false on a browser older than the target), `t(key)`, `tf(key, values)`, `i18n` (`ready`, `lang()`, `setLang(code)`, `apply(element)`), `icon(name)`, `setIcon(element, name)`, `icons.add(set)`, `icons.use(set)` (see [Icons](#icons)), `windows.select(w)`, `windows.minimise(w)`, `windows.maximise(w)`, `windows.restore(w)`, `windows.close(w)`, `setTaskbarEdge(desktop, edge)`, `isDesktop()`, the date helpers in `Ayni.dates`, and `version`.

### Icons

An icon is `<span class="icon" data-icon="name"></span>`, and `Ayni.icon(name)` returns the same markup for code. Ayni draws it from the icon set in use; `Ayni.setIcon(element, name)` changes it.

The drawings are Nayive's: 24 × 24 grid, rounded ends, 2 px stroke unless an icon reads better with another. Names are plain English words joined by hyphens. `ayni-icons.js` holds only the icons the controls need: `apps`, `arrow-down`, `arrow-up`, `calendar`, `check`, `chev-down`, `chev-right`, `close`, `copy`, `cut`, `edit`, `error`, `eye`, `eye-off`, `file`, `filter`, `folder`, `help`, `info`, `maximise`, `minimise`, `minus`, `more`, `ok`, `paste`, `plus`, `restore`, `search`, `today`, `trash`, `undo` and `warn` (also in `Ayni.icons.names`). Your app brings its own icons with `Ayni.icons.add({ name: '<svg …>' })`, as `gallery/demo-icons.js` does for the gallery. Never paste an SVG into the page: write `<span class="icon" data-icon="name"></span>`.

To use another icon set, give Ayni a map from its names to the set's names:

```js
Ayni.icons.use({
  sprite: 'icons/sprite.svg',          // SVG symbols, as markup or a URL (a URL is fetched, so not from file://)
  id: 'icon-{name}',                   // the symbol ids in that sprite; default '{name}'
  stroke: true,                        // the set draws with lines, like Ayni's own; default: filled shapes
  map: { close: 'x', search: 'magnifier', save: 'floppy' },
});
// An icon font instead of a sprite:
Ayni.icons.use({ render: (name) => `<i class="bi bi-${name}"></i>`, map: { close: 'x-lg', search: 'search' } });
```

Any name the map leaves out keeps Ayni's own icon (or your app's `i-<name>` symbol), and the console lists the control icons the set does not map. `Ayni.icons.use(null)` goes back to the built-in set. Every icon on the page is redrawn, so the set can change at any time.

A ready-made map for [Lucide](https://lucide.dev), which has the same style as Ayni's icons, is in `icons/lucide.js`. Load it after `ayni.js`, then call `Ayni.icons.use(Ayni.icons.lucide)`. It fetches Lucide's sprite from a CDN; pass `sprite` to use your own copy. The gallery's Icons tab switches the whole gallery between Ayni and Lucide.

### Colours

Each scheme, light and dark, sets its colours at the top of `ayni.css`: `--bg` (page), `--card` (panels), `--card2` (fields, chips), `--line`, `--text`, `--text-dim`, `--text-faint`, `--accent`, `--on-accent`, `--on-solid`, `--danger`, `--ok`, `--warn`, `--busy`, `--link` and `--shadow`. A few more are derived from them (`--card-head`, `--field-line`, `--accent-soft`, `--readonly-bg`, `--track`). An app overrides any of them for its own look. The same file holds the corners (`--radius-s/m/l/pill`), spacing (`--space-1` to `--space-5`), shadows (`--elev-card`, `--elev-dialog`), motion (`--tr-fast`, `--tr-move`) and type (`--font-sans`, `--font-mono`, `--field-fs`).

The page follows the system setting until the user picks light or dark (`ayni-theme`), or Sun mode, which follows the real sun at the place the page gives with `Ayni.theme.setPlace()`. The user's own schemes are kept as `ayni-schemes`. Every open tab follows a change at once, and `ayni:theme` fires on `document`.

## Files

| File | What it is |
| --- | --- |
| `ayni-i18n.js` | The language layer: loads the texts first, `data-i18n` markup, `Ayni.t()` |
| `i18n/*.json` | Ayni's own texts, one file per language |
| `ayni-base.css` | The base: both colour schemes, corners, spacing, type, motion, the icon box and the Panel |
| `ayni-base.js` | The base: light and dark (with Sun mode and own schemes), icons, tooltips, touch (`Ayni.isTouch`), `Ayni.t`, `Ayni.supported`, start-up and `Ayni.ready` |
| `ayni-buttons.css` | Buttons family: round and text buttons, toggles, second action, busy, buttons over pictures, switches, check boxes, radios |
| `ayni-buttons.js` | Buttons family: `Ayni.setBusy`, the second action, Enter runs the default button, the rule checks, switches |
| `ayni-toasts.css` | Notifications family: notifications and progress notifications (needs `ayni-buttons.css`) |
| `ayni-toasts.js` | Notifications family: `Ayni.toast` with Undo, `Ayni.settleUndo`, `Ayni.progress` |
| `ayni-dialogs.css` | Dialogs family: `dialog.panel`, small and big, modal and modeless (needs `ayni-buttons.css`) |
| `ayni-dialogs.js` | Dialogs family: Esc, the first field, moving, `Ayni.dialog`, `Ayni.dialogButton`, `Ayni.confirm`, `Ayni.alert`, `Ayni.ask`, `Ayni.autoSave` |
| `ayni.css` | The look of the controls not yet in a family file, and the touch sizes |
| `ayni.js` | The behaviour of the controls not yet in a family file; a family file hands its start-up to `Ayni.core.family()` |
| `ayni-icons.js` | The built-in icons, only those the controls use (Nayive's drawings) |
| `tz-geo.json` | The main city of each time zone, for Sun mode on a device that gives no place |
| `icons/lucide.js` | Map from Ayni's icon names to [Lucide](https://lucide.dev)'s, for `Ayni.icons.use()` |
| `api/` | Proposed programming interface: one class per component, skeletons only (see `api/README.md`) |
| `gallery/` | The gallery page, with its own layout and demo wiring (not needed by apps); `gallery/desktop.html` shows desktop mode |
| `docs/guidelines.md` | The Ayni Design Guidelines: every rule, chapter by chapter |
| `docs/accessibility-backlog.md` | Accessibility work planned for after the design is closed |
| `docs/*.png` | Images for this page |
| `tests/run.mjs` | The tests: `node tests/run.mjs` loads the gallery in a headless Chromium and checks it (Node 22+, no packages); it ends with ALL GREEN |
| `CHANGELOG.md` | What changed in each version |

## Licence

Apache 2.0.
