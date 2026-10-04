#!/usr/bin/env bash
# Build the vendored docx-editor.dev engine into client/apps/<app>/lib/docx-editor/.
#
# Run BY HAND only, when bumping the engine. deploy.sh never calls this.
# Needs: node + npm (uses a throwaway workdir; nothing is installed globally).
#
#   tools/build-docx-editor.sh              rebuild the version in docx-editor.lock.json
#   tools/build-docx-editor.sh 2.21.0       bump to 2.21.0
#   tools/build-docx-editor.sh --restore    put the previous build back
#
# <app> is client/apps/write/ - one folder since the swap.
#
# WHAT THIS SCRIPT OWNS, so that the next bump is one command:
#
#   * the versions live in ONE tracked file, lib/docx-editor/docx-editor.lock.json,
#     together with every npm package that went into the bundle and a sha256 of
#     every file shipped. tools/check-docx-editor holds the tree to it;
#   * every file carries the version in its NAME - docx-editor_v2.20.0.min.js,
#     harfbuzz_v2.20.0.wasm, fonts_v2.20.0/ - the house convention for a
#     vendored library. It is what makes the server's year-long `immutable`
#     header (everything under lib/ gets it) and sw.js's isImmutable() correct.
#     The fonts folder too: the engine rejects a font whose length differs from
#     the one baked into the bundle, so a year-old cached copy of a changed font
#     would silently drop the page to the estimated layout;
#   * the entry module is generated here with those names baked in: it points
#     HarfBuzz at its wasm and the fonts at their folder, both relative to the
#     bundle's own URL, so no page has to know where they are;
#   * the references are rewritten: write.js's import and index.html's <link>
#     (when those files exist - in Phase 0 of the plan they do not yet);
#   * the outgoing build is kept in lib/.docx-editor-prev/ (git-ignored), so
#     --restore is the rollback;
#   * THIRD_PARTY_NOTICES.md: every package esbuild put into the bundle, with its
#     licence text. A package whose licence is not on the list below stops the
#     build - the paid part (@docx-editor.dev/pro) must never slip in.
#
# Everything shipped here is Apache-2.0, MIT, Zlib or a font licence (OFL, GUST),
# so the build IS committed (house rule for vendored libs, like Calc's).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APPS="$REPO/client/apps"

APP="write"

DST="$APPS/$APP/lib/docx-editor"
PREV="$APPS/$APP/lib/.docx-editor-prev"
LOCK="$DST/docx-editor.lock.json"
INDEX="$APPS/$APP/index.html"
APPJS="$APPS/$APP/write.js"

ESBUILD_VERSION="0.28.2"     # pinned: a bundler bump is a deliberate change

# The engine family. Each is installed at EXACTLY the engine's version: core
# asks for i18n with a caret, so without this a rebuild of the same version
# quietly picks up whatever i18n came out since.
FAMILY=( @docx-editor.dev/core @docx-editor.dev/fonts @docx-editor.dev/i18n )

# Licences a bundled package may carry (SPDX ids). Anything else stops the build.
ALLOWED_LICENCES="MIT ISC Apache-2.0 BSD-2-Clause BSD-3-Clause 0BSD Zlib OFL-1.1 LicenseRef-GUST-Font-License"

say() { printf '%s\n' "$*"; }
die() { printf 'build-docx-editor: %s\n' "$*" >&2; exit 1; }

# The real Go toolchain lives in ~/sdk/ - tried first, as deploy.sh does: apt's
# go on PATH is too old (no -C).
find_go() {
    local g
    g="$(ls -d "$HOME"/sdk/go*/bin/go 2>/dev/null | sort -V | tail -1)"
    [[ -x "$g" ]] && { echo "$g"; return; }
    command -v go >/dev/null && { echo go; return; }
    return 1
}

# sw.js's precache list and the .gz sidecars are generated - refresh them, or a
# rebuild leaves the service worker pointing at the file names of the old build.
refresh_generated() {
    local go
    if ! go="$(find_go)"; then
        say "! go not found - sw.js and the .gz sidecars were NOT refreshed."
        say "  Run by hand:  go -C tools run ./build-precache && go -C tools run ./build-gzip"
        return
    fi
    ( cd "$REPO" && "$go" -C tools run ./build-precache && "$go" -C tools run ./build-gzip ) >/dev/null
}

lock_get() {   # lock_get <key>  - read a top-level string from the lock file
    [[ -f "$LOCK" ]] || return 1
    node -e 'const l=require(process.argv[1]);const v=l[process.argv[2]];if(v==null)process.exit(1);console.log(v)' "$LOCK" "$1"
}

# ------------------------------------------------------------------------------
# Rewrite the references to the versioned names, in the files that exist and
# already reference the engine. A file with no reference yet is only reported:
# tools/check-docx-editor is what turns that into a failure.
# ------------------------------------------------------------------------------
rewrite_refs() {
    local ver="$1"

    if [[ -f "$APPJS" ]] && grep -q "lib/docx-editor/docx-editor_v" "$APPJS"; then
        sed -i -E "s#(lib/docx-editor/)docx-editor_v[0-9A-Za-z.+-]*\.min\.js#\1docx-editor_v${ver}.min.js#g" "$APPJS"
        grep -q "lib/docx-editor/docx-editor_v${ver}.min.js" "$APPJS" || die "could not rewrite the import in $APP/write.js"
    else
        say "  ($APP/write.js does not import the engine yet - nothing to rewrite)"
    fi

    if [[ -f "$INDEX" ]] && grep -q "lib/docx-editor/docx-editor_v" "$INDEX"; then
        sed -i -E "s#(lib/docx-editor/)docx-editor_v[0-9A-Za-z.+-]*\.css#\1docx-editor_v${ver}.css#g" "$INDEX"
        grep -q "lib/docx-editor/docx-editor_v${ver}.css" "$INDEX" || die "could not rewrite the stylesheet link in $APP/index.html"
    else
        say "  ($APP/index.html does not link the engine yet - nothing to rewrite)"
    fi
}

# ------------------------------------------------------------------------------
# --restore : swap the previous build back in
# ------------------------------------------------------------------------------
if [[ "${1:-}" == "--restore" ]]; then
    [[ -d "$PREV" ]] || die "nothing to restore: $PREV does not exist"
    SWAP="$(mktemp -d "${TMPDIR:-/tmp}/docx-editor-swap.XXXXXX")"
    mv "$DST" "$SWAP/current"
    mv "$PREV" "$DST"
    mv "$SWAP/current" "$PREV"
    rmdir "$SWAP"
    ver="$(lock_get core)" || die "the restored build has no readable docx-editor.lock.json"
    rewrite_refs "$ver"
    refresh_generated
    say "✓ restored docx-editor.dev $ver in $APP/  (run --restore again to go back)"
    exit 0
fi

# ------------------------------------------------------------------------------
# Which version are we building?
# ------------------------------------------------------------------------------
if [[ -n "${1:-}" ]]; then
    VERSION="$1"
else
    VERSION="$(lock_get core)" || die "no version given and no docx-editor.lock.json to read one from"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "not a version: $VERSION"

command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/build-docx-editor.XXXXXX")"
STAGE="$WORK/stage"
FONTS="fonts_v${VERSION}"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$STAGE/licenses" "$STAGE/$FONTS"

say "→ workdir $WORK"
cd "$WORK"
printf '{ "name": "build-docx-editor", "private": true, "type": "module" }\n' > package.json

PKGS=()
for p in "${FAMILY[@]}"; do PKGS+=( "$p@$VERSION" ); done
say "→ installing ${PKGS[*]}…"
npm install --silent --no-audit --no-fund "${PKGS[@]}" "esbuild@$ESBUILD_VERSION" \
    || die "npm install failed for docx-editor.dev $VERSION (does every package of the family have that version?)"

# Every @docx-editor.dev package npm put in node_modules must be THIS version.
for f in node_modules/@docx-editor.dev/*/package.json; do
    got="$(node -p "require('./$f').version")"
    [[ "$got" == "$VERSION" ]] || die "asked for $VERSION, npm installed $(dirname "${f#node_modules/}")@$got"
done

# ------------------------------------------------------------------------------
# The entry module. Only the public API (see the plan's rules): the editor, the
# toolbar/menu helpers, the packaged fonts, HarfBuzz's wasm URL - and the zip
# library the engine bundles anyway (fflate).
# ------------------------------------------------------------------------------
cat > entry.js <<JS
// Generated by tools/build-docx-editor.sh for docx-editor.dev ${VERSION}. Do not edit.
import { setHarfBuzzWasmUrl } from '@docx-editor.dev/core/layout';
import { packagedFonts as upstreamPackagedFonts } from '@docx-editor.dev/fonts';

export { createDocxEditor, blankDocumentBytes, runToolbarCommand, toolbarCommandState,
         toolbarCommandStates, CHROME_MENUS, applyTableChromePick, runTableChromeCommand,
         executeImageCommand, canExecuteImageCommand }
    from '@docx-editor.dev/core/editor';
export { setHarfBuzzWasmUrl };

// The zip library the engine itself uses (fflate, MIT), for the few places Write
// has to touch a part of the package the engine has no command for - adding
// Word's heading styles to a file that lacks them, say. Already in the bundle;
// exporting it adds the few functions below, not a second copy.
export { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

// esbuild leaves \`new URL( x, import.meta.url )\` alone, so the engine would look
// for "harfbuzz.wasm" beside the bundle. Ours carries the version in its name.
setHarfBuzzWasmUrl( new URL( './harfbuzz_v${VERSION}.wasm', import.meta.url ) );

// The fonts package asks for "../assets/<face>" relative to its own module -
// one folder ABOVE the bundle once bundled. The faces live in ${FONTS}/ beside
// it instead. Only the file name is kept: the engine picks it from a closed
// list, never from the document.
const FONT_DIR = new URL( './${FONTS}/', import.meta.url );

export function packagedFonts( options = {} )
{
    const get = options.fetcher || ( ( u, init ) => fetch( u, init ) );
    return upstreamPackagedFonts( { ...options,
        fetcher: ( u, init ) => get( new URL( new URL( String( u ) ).pathname.split( '/' ).pop(), FONT_DIR ), init ) } );
}
JS

say "→ bundling…"
BUNDLE="docx-editor_v${VERSION}.min.js"
# Node-only branches: the core has import('fs'), import('path')... behind a
# "running in Node?" test. They stay dynamic imports and never run in a browser.
./node_modules/.bin/esbuild entry.js \
    --bundle --format=esm --minify --target=es2022 --platform=browser \
    --external:fs --external:fs/promises --external:path --external:url --external:module \
    --metafile="$WORK/meta.json" \
    --outfile="$STAGE/$BUNDLE" \
    --log-level=warning \
    || die "esbuild failed"

CORE=node_modules/@docx-editor.dev/core
FONTPKG=node_modules/@docx-editor.dev/fonts

cp "$CORE/dist/editor.css"   "$STAGE/docx-editor_v${VERSION}.css"
cp "$CORE/dist/harfbuzz.wasm" "$STAGE/harfbuzz_v${VERSION}.wasm"
cp "$CORE/LICENSE"           "$STAGE/LICENSE"
cp "$CORE/licenses/"*        "$STAGE/licenses/"
cp "$CORE/THIRD_PARTY_NOTICES.md" "$STAGE/licenses/docx-editor-core-THIRD_PARTY_NOTICES.md"

# The faces, and the licences that must travel with them (OFL, GUST).
cp "$FONTPKG/assets/"*       "$STAGE/$FONTS/"
cp "$FONTPKG/LICENSE"        "$STAGE/$FONTS/LICENSE"
cp "$FONTPKG/THIRD_PARTY_NOTICES.md" "$STAGE/$FONTS/THIRD_PARTY_NOTICES.md"
mkdir -p "$STAGE/$FONTS/licenses"
cp "$FONTPKG/licenses/"*     "$STAGE/$FONTS/licenses/"

# BUILD.md is the recipe and is tracked; carry the existing one over.
[[ -f "$DST/BUILD.md" ]] && cp "$DST/BUILD.md" "$STAGE/BUILD.md"

# ------------------------------------------------------------------------------
# What went into the bundle: every package esbuild read a file from, from the
# metafile. Its licence is checked against the list above, and its licence text
# goes into THIRD_PARTY_NOTICES.md (MIT and friends ask for exactly that).
# ------------------------------------------------------------------------------
say "→ licences…"
ALLOWED="$ALLOWED_LICENCES" VERSION="$VERSION" node -e '
const fs = require( "fs" ), path = require( "path" );
const meta = JSON.parse( fs.readFileSync( process.argv[ 1 ], "utf8" ) );
const allowed = new Set( process.env.ALLOWED.split( " " ) );

const pkgs = new Map();
for( const input of Object.keys( meta.inputs ) )
{
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec( input );
    if( ! m ) continue;
    const dir = input.slice( 0, m.index + m[ 0 ].length );
    if( pkgs.has( m[ 1 ] ) ) continue;
    const pj = JSON.parse( fs.readFileSync( path.join( dir, "package.json" ), "utf8" ) );
    const licence = typeof pj.license === "string" ? pj.license : ( pj.license?.type || "" );
    const file = fs.readdirSync( dir ).find( f => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test( f ) );
    pkgs.set( m[ 1 ], { name: pj.name, version: pj.version, licence, text: file ? fs.readFileSync( path.join( dir, file ), "utf8" ).trim() : null } );
}

const list = [ ...pkgs.values() ].sort( ( a, b ) => a.name.localeCompare( b.name ) );
const bad  = list.filter( p => ! p.licence || p.licence.replace( /[()]/g, " " ).split( /\s+/ )
                                   .filter( t => t && ! /^(AND|OR|WITH)$/.test( t ) ).some( t => ! allowed.has( t ) ) );
if( bad.length )
{
    console.error( "build-docx-editor: bundled package(s) with a licence not on the allowed list:" );
    for( const p of bad ) console.error( "  " + p.name + "@" + p.version + "  " + ( p.licence || "(none)" ) );
    process.exit( 1 );
}

let md = "# Third-party notices - docx-editor_v" + process.env.VERSION + ".min.js\n\n" +
         "Written by tools/build-docx-editor.sh from esbuild'"'"'s metafile. Do not edit.\n\n" +
         "The bundle is one esbuild output of the packages below, minified. Each is\n" +
         "redistributed under its own licence, reproduced in full after the list.\n" +
         "`@docx-editor.dev/core` itself inlines further code (HarfBuzz via harfbuzzjs);\n" +
         "its own notices are in `licenses/docx-editor-core-THIRD_PARTY_NOTICES.md`\n" +
         "and `licenses/HarfBuzz-COPYING.txt`. The fonts and their licences are in\n" +
         "`fonts_v" + process.env.VERSION + "/`.\n\n## Bundled packages\n\n";
for( const p of list ) md += "- " + p.name + " " + p.version + " - " + p.licence + "\n";
for( const p of list )
{
    md += "\n---\n\n## " + p.name + " " + p.version + "\n\nLicense: " + p.licence + "\n\n";
    md += p.text ? "```\n" + p.text + "\n```\n" : "(the package ships no licence file; its package.json says " + p.licence + ")\n";
}
fs.writeFileSync( process.argv[ 2 ], md );
fs.writeFileSync( process.argv[ 3 ], JSON.stringify( Object.fromEntries( list.map( p => [ p.name, p.version ] ) ) ) );
for( const p of list ) if( ! p.text ) console.log( "  ! " + p.name + " ships no licence file - noted as such" );
' "$WORK/meta.json" "$STAGE/THIRD_PARTY_NOTICES.md" "$WORK/packages.json" || die "licence check failed"

# ------------------------------------------------------------------------------
# The lock file: what is installed, and a sha256 of every shipped byte.
# ------------------------------------------------------------------------------
say "→ hashing…"
# BUILD.md is ours and hand-edited; everything else here came from npm or from
# this script, so it is hashed and the guard holds it to these bytes.
( cd "$STAGE" && find . -type f ! -name docx-editor.lock.json ! -name BUILD.md -printf '%P\n' | LC_ALL=C sort \
  | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done ) > "$WORK/hashes.txt"

VERSION="$VERSION" ESBUILD="$ESBUILD_VERSION" FONTS="$FONTS" BUNDLE="$BUNDLE" \
node -e '
const fs = require( "fs" );
const files = {};
for( const line of fs.readFileSync( process.argv[ 1 ], "utf8" ).split( "\n" ) )
{
    if( ! line.trim() ) continue;
    const [ hash, ...rest ] = line.split( "  " );
    files[ rest.join( "  " ) ] = "sha256-" + hash;
}
const v = process.env.VERSION;
const lock = {
    _comment: "Written by tools/build-docx-editor.sh. tools/check-docx-editor holds lib/docx-editor/ to it before every deploy.",
    core    : v,
    fonts   : v,
    esbuild : process.env.ESBUILD,
    bundle  : process.env.BUNDLE,
    css     : "docx-editor_v" + v + ".css",
    wasm    : "harfbuzz_v" + v + ".wasm",
    fontDir : process.env.FONTS,
    built   : new Date().toISOString().slice( 0, 10 ),
    packages: JSON.parse( fs.readFileSync( process.argv[ 3 ], "utf8" ) ),
    files
};
fs.writeFileSync( process.argv[ 2 ], JSON.stringify( lock, null, 2 ) + "\n" );
' "$WORK/hashes.txt" "$STAGE/docx-editor.lock.json" "$WORK/packages.json"

# ------------------------------------------------------------------------------
# Install: previous build aside, new one in, references rewritten.
# ------------------------------------------------------------------------------
rm -rf "$PREV"
[[ -d "$DST" ]] && mv "$DST" "$PREV"
mkdir -p "$(dirname "$DST")"
cp -a "$STAGE" "$DST"

say "→ references…"
rewrite_refs "$VERSION"

say "→ refreshing sw.js and the .gz sidecars…"
refresh_generated

kb() { awk '{ printf "%.0f KB", $1 / 1024 }'; }
say ""
say "✓ built  $(du -sh --exclude='*.gz' "$DST" | cut -f1)  →  $DST"
say "  docx-editor.dev  $VERSION  ($(node -p "Object.keys(require('$DST/docx-editor.lock.json').packages).length") packages in the bundle)"
printf '  bundle  %s raw, %s gzipped\n' "$( wc -c < "$DST/$BUNDLE" | kb )" "$( gzip -c "$DST/$BUNDLE" | wc -c | kb )"
printf '  wasm    %s raw, %s gzipped\n' "$( wc -c < "$DST/harfbuzz_v${VERSION}.wasm" | kb )" "$( gzip -c "$DST/harfbuzz_v${VERSION}.wasm" | wc -c | kb )"
printf '  css     %s raw, %s gzipped\n' "$( wc -c < "$DST/docx-editor_v${VERSION}.css" | kb )" "$( gzip -c "$DST/docx-editor_v${VERSION}.css" | wc -c | kb )"
printf '  fonts   %s raw, %s gzipped (fetched only for the families a document names)\n' \
       "$( cat "$DST/$FONTS/"*.[ot]tf | wc -c | kb )" "$( cat "$DST/$FONTS/"*.[ot]tf | gzip -c | wc -c | kb )"
say ""
if [[ -d "$PREV" ]]; then
    say "  Previous build kept in $PREV  —  tools/build-docx-editor.sh --restore puts it back."
    say ""
fi
say "  Next: go -C tools run ./check-docx-editor"
say "        CORPUS=<folder of .docx> node tools/docx-editor-smoke/smoke.mjs   (same numbers or better)"
say "        walk $APP/quirks.js: delete what this version fixed"
say "        update the version table in $DST/BUILD.md"
