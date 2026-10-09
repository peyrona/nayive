# Tour checks

The guided tour is `NayiveUI.tour` in `client/apps/shared/ui.js` (header
comment "GUIDED TOUR"); its look is `.tour-*` in `shared/app.css`.

    node tools/tour-test/run.mjs            # all
    node tools/tour-test/run.mjs habits     # one file
    APPS=drive,calc node tools/tour-test/apps.mjs   # some apps of the table
    SHOTS=/some/dir node tools/tour-test/habits.mjs   # + a screenshot per step

Each file starts its own scratch server and a headless Chromium (the
data-safety harness's `server()` / `browser()`); nothing touches real data.

## Adding a tour to an app (all but Games)

Every app has one now; this is for a new app or a new button.

1. In the app's `NayiveUI.firstRun( {...} )` (or the card it hands to
   `showIntro` / `setIntro`) add `tour: [ ... ]` (or a function returning it;
   `tour: true` = `[ 'buttons' ]`). The help card then shows "Ver el tour";
   Write / Calc / Text get it as a fourth entry of their Ayuda menu
   (shared/office.js). Never open it on its own.
2. `'buttons'` walks the card's own rows, in order: a row with `sel` lights
   that button. A row with no `sel` (an idea, a row's button) joins only with
   a `tour: { sel / ghost / open / picked ... }` of its own; `tour: false`
   keeps a row out. A row whose button this layout lacks is left out, as
   the card leaves it out.
3. The tour adds by itself: the app's name first ("home") and the "?" last;
   the ⋮ for any toolbar button fitBar moved there; the menu row of a hidden
   button that a menu copies (`data-menu="<id>"`, Write / Calc / Text).
4. Shared steps by name, with their shared text: `'search'`, `'more'`,
   `'pick'` (a row's round tick; the user taps it), `'picked'` (the
   selection group, a row picked by the tour). Change a field with
   `{ use: 'pick', ghost: '#emptyList' }`.
5. Step fields: `{ sel, text, title?, tap?, open?, ghost?, icon?, picked?, optional?, before?, after? }`.
   - No skipping: a button that only shows with data gets a `ghost` (the empty
     list / empty state) plus an `icon`.
   - `open`: what to press first - a menu, a panel, a tab. A list is tried in
     order, each one pressed only while the target is still not out (Write:
     `[ '#wrPageBtn', '#moreBtn' ]` = the popup on a PC, the ⋮ on a phone).
     Steps in a row with the same `open` keep it open.
   - `picked: true`: a selection action; the first row is picked for it and
     let go after the last such step.
   - `optional: true` only for what this layout never has (Planner's frame).
   - Put back what a step changed (a view, a tab) in its `after`.
6. A check: add the app to the table in `apps.mjs` (path, ready, seed, a few
   `expect`s; `group` for a second screen with its own card). Apps with more
   to prove have their own file (habits, tasks, contacts, shared). Every
   check walks wide and on a touch phone and compares the whole home before
   and after: a tour never writes. `settle` waits out an app's own background
   writes on load (a scan cache, the account config) first.
