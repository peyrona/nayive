#!/usr/bin/env python3
"""
make-icons.py - the app's icons, all taken from the real logo.

The logo is artwork (tools/launcher-logo-512.png): it is only scaled and
masked here, never redrawn. Re-run only when the logo changes:

    python3 android/make-icons.py

Writes into app/src/main/res/:
  mipmap-*/ic_launcher_foreground.png  the logo inside an adaptive icon's
                                       safe zone (66 of 108 dp)
  drawable-*/ic_stat.png               the status-bar icon: the logo's own
                                       silhouette, white (Android paints it)
  drawable-nodpi/splash.png            the TWA's splash picture
The adaptive icon's background is the PWA's background_color, #1E1F23.
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "..", "tools", "launcher-logo-512.png")
RES = os.path.join(HERE, "app", "src", "main", "res")
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

logo = Image.open(LOGO).convert("RGBA")
logo = logo.crop(logo.getbbox())


def fit(img, box):
    """img scaled to fit a box x box square, centred on a transparent one."""
    w, h = img.size
    k = box / max(w, h)
    small = img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    out = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    out.paste(small, ((box - small.width) // 2, (box - small.height) // 2), small)
    return out


def save(img, folder, name):
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    img.save(os.path.join(d, name), optimize=True)


for dens, k in DENS.items():
    canvas = round(108 * k)
    fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    inner = fit(logo, round(62 * k))
    fg.paste(inner, ((canvas - inner.width) // 2, (canvas - inner.height) // 2), inner)
    save(fg, "mipmap-" + dens, "ic_launcher_foreground.png")

    size = round(24 * k)
    shape = fit(logo, round(22 * k))
    alpha = shape.split()[3].point(lambda a: 255 if a > 110 else 0)
    white = Image.new("RGBA", shape.size, (255, 255, 255, 0))
    white.putalpha(alpha)
    stat = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    stat.paste(white, ((size - white.width) // 2, (size - white.height) // 2), white)
    save(stat, "drawable-" + dens, "ic_stat.png")

save(fit(logo, 288), "drawable-nodpi", "splash.png")
print("icons written under", RES)
