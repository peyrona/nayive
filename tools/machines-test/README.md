# Machines - tests

Machines is one of the games of Games (`client/apps/games/`). Its files there:

- `machines.html` the frame: toolbar, board box, pieces row. Loads the rest on first open.
- `machines-board.js` the board: Canvas 2D, touch first, play and design modes.
- `machines-sim.js` rules and physics, no drawing. The same file runs in the tests.
- `machines-levels.js` the levels, plain JSON (the format is at the top of the file).
- `lib/nape_v3.43.5.min.js` nape-js as one file, with `vendor/det-math.js` built in.
  Rebuild with `vendor/build-vendor.sh`.

Tests (from the repo root):

    node tools/machines-test/test.js 1000        physics, every level's solution, 1000 random machines
    node tools/machines-test/uitest.mjs [dir]    the game inside Games, real touch, headless Chromium
    node tools/machines-test/crossbrowser.mjs    Node, Chromium and Firefox must match bit for bit

Same physics on every device: nape uses Math.sin, cos, atan2 and acos, and each JS
engine computes those its own way. `det-math.js` replaces them with code built only
from + - * / and sqrt, which are exact everywhere. So in `machines-sim.js`: never
Math.hypot, sin or cos, and nothing that reads the clock.

To compare a real device: Design, board menu, a level, Run. The banner shows the
run's fingerprint (`#3f443d81`); the same level must show the same one everywhere.
