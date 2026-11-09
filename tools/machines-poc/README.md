# Machines - proof of concept

A mechanical puzzle game for Nayive's Games (adults). This folder tests the risky
parts before any level is made. Nothing in Nayive uses it yet.

Open `index.html` in a browser (double-click works). No build step.

- `sim.js` rules and physics, no drawing. Runs in the page and in the tests.
- `ui.js` the board: Canvas 2D, touch first.
- `scenes.js` five test rooms and one free room, each with a stored solution.
- `vendor/` nape-js as one file, with `det-math.js` built in. Rebuild: `build-vendor.sh`.

Tests:

    node test.js 1000        physics, solutions, 1000 random machines
    node uitest.mjs          real touch input in headless Chromium
    node crossbrowser.mjs    Node, Chromium and Firefox must match bit for bit

Same physics on every device: nape uses Math.sin, cos, atan2 and acos, and each JS
engine computes those its own way. `det-math.js` replaces them with code built only
from + - * / and sqrt, which are exact everywhere. So in `sim.js`: never Math.hypot,
sin or cos, and nothing that reads the clock.
