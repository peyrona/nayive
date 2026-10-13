#!/bin/sh
# publish.sh - builds the release APK and lays out the /app/ download site in
# android/build/site/: index.html, nayive.apk, version.json (what the app checks
# once a day). Copy that folder to the VPS's sites_dir as "app" - it is then
# https://<origin>/app/. Nothing here touches the VPS.
#
# The build is skipped when no input changed since the last one: a fingerprint
# of every file under android/ (minus build outputs, hidden dirs and *.md) is
# kept in build/publish.stamp. `./publish.sh -f` builds anyway.
#
# A build raises the version by itself (installed phones only take an APK
# whose versionCode is higher): versionCode +1 and versionName one step
# ("0.7" -> "0.8", "0.9" -> "1.0") in app/build.gradle - unless they are
# already above the last version.json built here (raised by hand).
# deploy.sh -n never runs this, so a dry run raises nothing.
set -e
cd "$(dirname "$0")"
out=build/site
stamp=build/publish.stamp
fingerprint() {
    find . -path '*/.*' -prune -o -path ./build -prune -o -path ./app/build -prune \
        -o -type f ! -name '*.md' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}
sum=$(fingerprint)
if [ "${1:-}" != "-f" ] && [ -f "$out/nayive.apk" ] && [ -f "$out/version.json" ] &&
   [ "$(cat "$stamp" 2>/dev/null)" = "$sum" ]; then
    echo "Android app unchanged - build skipped (./publish.sh -f forces it)."
    exit 0
fi
code=$(sed -n "s/.*versionCode = \([0-9]*\).*/\1/p" app/build.gradle)
name=$(sed -n "s/.*versionName = '\([^']*\)'.*/\1/p" app/build.gradle)
live=$(sed -n 's/.*"code": *\([0-9]*\).*/\1/p' "$out/version.json" 2>/dev/null)
if [ -n "$live" ] && [ "$code" -le "$live" ]; then
    code=$((live + 1))
    major=${name%%.*}; minor=${name#*.}
    # Not "major.minor": start again from the code (13 -> "1.3").
    echo "$name" | grep -qxE '[0-9]+\.[0-9]' || { major=$((code / 10)); minor=$((code % 10 - 1)); }
    minor=$((minor + 1))
    [ "$minor" -ge 10 ] && { major=$((major + 1)); minor=0; }
    name="$major.$minor"
    sed -i "s/versionCode = [0-9]*/versionCode = $code/; s/versionName = '[^']*'/versionName = '$name'/" app/build.gradle
    echo "Android app version raised to $name (code $code)."
    sum=$(fingerprint)      # the raised build.gradle is part of what was built
fi
./gradlew --no-daemon -q assembleRelease
rm -rf "$out"; mkdir -p "$out"
cp site/index.html "$out/"
cp app/build/outputs/apk/release/app-release.apk "$out/nayive.apk"
printf '{"code": %s, "name": "%s", "url": "/app/nayive.apk"}\n' "$code" "$name" > "$out/version.json"
echo "$sum" > "$stamp"
ls -la "$out"
