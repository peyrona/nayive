#!/bin/sh
# publish.sh - builds the release APK and lays out the /app/ download site in
# android/build/site/: index.html, nayive.apk, version.json (what the app checks
# once a day). Copy that folder to the VPS's sites_dir as "app" - it is then
# https://<origin>/app/. Nothing here touches the VPS.
#
# The build is skipped when no input changed since the last one: a fingerprint
# of every file under android/ (minus build outputs, hidden dirs and *.md) is
# kept in build/publish.stamp. `./publish.sh -f` builds anyway.
set -e
cd "$(dirname "$0")"
out=build/site
stamp=build/publish.stamp
sum=$(find . -path '*/.*' -prune -o -path ./build -prune -o -path ./app/build -prune \
        -o -type f ! -name '*.md' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
if [ "${1:-}" != "-f" ] && [ -f "$out/nayive.apk" ] && [ -f "$out/version.json" ] &&
   [ "$(cat "$stamp" 2>/dev/null)" = "$sum" ]; then
    echo "Android app unchanged - build skipped (./publish.sh -f forces it)."
    exit 0
fi
./gradlew --no-daemon -q assembleRelease
rm -rf "$out"; mkdir -p "$out"
cp site/index.html "$out/"
cp app/build/outputs/apk/release/app-release.apk "$out/nayive.apk"
code=$(sed -n "s/.*versionCode = \([0-9]*\).*/\1/p" app/build.gradle)
name=$(sed -n "s/.*versionName = '\([^']*\)'.*/\1/p" app/build.gradle)
printf '{"code": %s, "name": "%s", "url": "/app/nayive.apk"}\n' "$code" "$name" > "$out/version.json"
echo "$sum" > "$stamp"
ls -la "$out"
