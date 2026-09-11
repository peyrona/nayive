typo.js — Typo.js v1.3.2 (MIT). https://github.com/cfinke/Typo.js
es.{aff,dic} — dictionary-es 4.0.0 — LibreOffice RLA es_ES, tri-licensed GPL-3.0+/LGPL-3.0+/MPL-1.1+ (see es.LICENSE). Used here under LGPL/MPL for personal self-hosted use.
en.{aff,dic} — dictionary-en 4.0.0 — SCOWL-based en_US, permissive (see en.LICENSE).
pt.{aff,dic} — LibreOffice pt_PT (see pt.LICENSE).
fr.{aff,dic} — LibreOffice fr_FR (see fr.LICENSE).
de.{aff,dic} — LibreOffice de_DE frami (see de.LICENSE).
it.{aff,dic} — LibreOffice it_IT (see it.LICENSE).

Weight: the four added on 2026-09-08 cost about 2.1 MB gzipped on top of es+en's
0.4 MB, and everything under lib/ is precached by the service worker — German is
1.2 MB of that on its own. Dropping a language is deleting its two files and its
line in proofing.js's DICT map; the Settings list is built from that map.

Vendored for apps/write proofing. No build step. Refresh: npm i typo-js dictionary-es dictionary-en and re-copy.
