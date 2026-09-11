#!/usr/bin/env python3
"""
build-icons.py - generate the PWA icons for the offline apps.

Each app already carries a 24x24 line-icon as an inline SVG favicon. A web app
manifest needs real raster icons, so this wraps that glyph on the dark theme
background (#1E1F23, rounded square) and renders 192px + 512px PNGs into
apps/<app>/icons/.

The LAUNCHER icon (apps/icons/) is NOT a glyph - it is hand-made artwork. Its
master lives at tools/launcher-logo-512.png and is only copied/downscaled here,
never redrawn. Never add "launcher" back to GLYPHS: that is what used to
overwrite the real logo with a generic 3x3 grid on every run.

Rarely needs re-running - only when an app's glyph or the brand colour changes.
Needs Inkscape on PATH.

    ./tools/build-icons.py

------------------------------------------------------------------------------
PYTHON NOTES
------------------------------------------------------------------------------
py: `subprocess.run([...], check=True, capture_output=True)` - spawn an external
    program. The first arg is an ARGV LIST (no shell, so no quoting/injection
    worries). check=True raises CalledProcessError on a non-zero exit;
    capture_output=True keeps stdout/stderr off your console.

py: `tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False)` - a temp
    file with a real name on disk. delete=False means "don't remove it when I
    close it" (we hand the path to inkscape, then delete it ourselves in the
    `finally`).

py: f-strings with a FORMAT SPEC: `f"{scale:.4f}"` = 4 decimal places,
    `f"{off:.2f}"` = 2. The bit after ":" is the same mini-language as
    str.format / printf precision.

py: this script mutates apps/<app>/icons/*.png as a side effect and prints what
    it wrote - no return value, no tests.
"""

import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
APPS = REPO / "todeploy" / "apps"

LAUNCHER_MASTER = REPO / "tools" / "launcher-logo-512.png"

BG     = "#1E1F23"
ACCENT = "#16A085"

# glyph = the inner markup of each app's favicon SVG (24x24 viewBox), with the
# stroke/fill colour dropped so we can set it uniformly here.
GLYPHS = {
    "tasks": {
        "dir": APPS / "tasks" / "icons",
        "svg": (
            "<rect x='3' y='4' width='18' height='17' rx='2'></rect>"
            "<path d='M8 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1'></path>"
            "<polyline points='8 13 11 16 16 10.5'></polyline>"
        ),
    },
    "split": {
        "dir": APPS / "split" / "icons",
        "svg": (
            "<path d='M16.5 7A7 7 0 1 0 16.5 17'></path>"
            "<line x1='3' y1='10.2' x2='13.5' y2='10.2'></line>"
            "<line x1='3' y1='13.8' x2='13.5' y2='13.8'></line>"
        ),
    },
    "habits": {
        "dir": APPS / "habits" / "icons",
        "svg": (
            "<path d='M12 22V10'></path>"
            "<path d='M12 12C12 8.5 9.2 5.5 5.5 5.5c0 3.5 2.8 6.5 6.5 6.5z'></path>"
            "<path d='M12 14c0-3.2 2.6-5.8 6-5.8 0 3.2-2.6 5.8-6 5.8z'></path>"
        ),
    },
    "calendar": {
        "dir": APPS / "calendar" / "icons",
        "svg": (
            "<rect x='3' y='4' width='18' height='18' rx='2'></rect>"
            "<line x1='16' y1='2' x2='16' y2='6'></line>"
            "<line x1='8' y1='2' x2='8' y2='6'></line>"
            "<line x1='3' y1='10' x2='21' y2='10'></line>"
        ),
    },
    "contact": {
        "dir": APPS / "contact" / "icons",
        "svg": (
            "<rect x='3' y='4' width='18' height='17' rx='2'/>"
            "<circle cx='9' cy='11' r='2.2'/>"
            "<path d='M5.5 17.5c0-2.2 1.7-3.3 3.5-3.3s3.5 1.1 3.5 3.3'/>"
            "<line x1='14' y1='10' x2='18' y2='10'/>"
            "<line x1='14' y1='14' x2='18' y2='14'/>"
        ),
    },
    "planner": {
        "dir": APPS / "planner" / "icons",
        "svg": (
            "<circle cx='12' cy='12' r='10'></circle>"
            "<polyline points='12 6 12 12 16 14'></polyline>"
        ),
    },
    "write": {
        "dir": APPS / "write" / "icons",
        "svg": (
            "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'></path>"
            "<polyline points='14 2 14 8 20 8'></polyline>"
            "<line x1='8' y1='13' x2='16' y2='13'></line>"
            "<line x1='8' y1='17' x2='13' y2='17'></line>"
        ),
    },
    "games": {
        "dir": APPS / "games" / "icons",
        "svg": (
            "<line x1='6' y1='11' x2='10' y2='11'></line>"
            "<line x1='8' y1='9' x2='8' y2='13'></line>"
            "<line x1='15' y1='12' x2='15.01' y2='12'></line>"
            "<line x1='18' y1='10' x2='18.01' y2='10'></line>"
            "<path d='M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.08.67-.7 5.87-.7 7.41a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.62-6.74-.7-7.41A4 4 0 0 0 17.32 5z'></path>"
        ),
    },
    "trips": {
        "dir": APPS / "trips" / "icons",
        "svg": (
            "<ellipse cx='5.5' cy='9' rx='2' ry='2.5'></ellipse>"
            "<ellipse cx='12' cy='6' rx='2.1' ry='2.6'></ellipse>"
            "<ellipse cx='18.5' cy='9' rx='2' ry='2.5'></ellipse>"
            "<path d='M12 12c-4.5 0-7.8 2-7.8 4.4 0 2 2.55 3.3 5.4 2.9 1.35-.2 1.5-.7 2.4-.7"
            "s1.05.5 2.4.7c2.85.4 5.4-.9 5.4-2.9C19.8 14 16.5 12 12 12z'></path>"
        ),
    },
}

SIZES = [192, 512]


def wrapper_svg(glyph, fill):
    # 24x24 glyph scaled to 56% of a 512 canvas, centred.
    scale = 512 * 0.56 / 24
    off   = (512 - 24 * scale) / 2
    paint = (
        f"fill='{ACCENT}' stroke='none'"
        if fill
        else f"fill='none' stroke='{ACCENT}' stroke-width='2' "
             f"stroke-linecap='round' stroke-linejoin='round'"
    )
    return (
        "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 512 512'>"
        f"<rect width='512' height='512' rx='96' fill='{BG}'/>"
        f"<g transform='translate({off:.2f} {off:.2f}) scale({scale:.4f})' {paint}>"
        f"{glyph}</g></svg>"
    )


def render(svg_text, out_path, size):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as tmp:
        tmp.write(svg_text)
        tmp_path = tmp.name
    try:
        subprocess.run(
            ["inkscape", tmp_path, "-w", str(size), "-h", str(size), "-o", str(out_path)],
            check=True, capture_output=True,
        )
    finally:
        pathlib.Path(tmp_path).unlink(missing_ok=True)


def launcher_icons():
    """Copy the hand-made launcher artwork into apps/icons/ at both sizes."""
    if not LAUNCHER_MASTER.exists():
        print(f"error: missing {LAUNCHER_MASTER.relative_to(REPO)} - "
              f"apps/icons/ left untouched", file=sys.stderr)
        return
    out_dir = APPS / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(LAUNCHER_MASTER, out_dir / "icon-512.png")
    subprocess.run(
        ["inkscape", str(LAUNCHER_MASTER), "-w", "192", "-h", "192",
         "-o", str(out_dir / "icon-192.png")],
        check=True, capture_output=True,
    )
    for size in SIZES:
        print(f"  {(out_dir / f'icon-{size}.png').relative_to(REPO)}  (launcher artwork)")


def main():
    if not any(p.exists() for p in map(pathlib.Path, ("/usr/bin/inkscape", "/usr/local/bin/inkscape"))):
        print("warning: inkscape not at the usual path; trying PATH anyway", file=sys.stderr)

    launcher_icons()

    for key, spec in GLYPHS.items():
        svg = wrapper_svg(spec["svg"], spec.get("fill", False))
        for size in SIZES:
            out = spec["dir"] / f"icon-{size}.png"
            render(svg, out, size)
            print(f"  {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
