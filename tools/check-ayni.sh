#!/usr/bin/env bash
# check-ayni.sh - Nayive USES Ayni; it never keeps UI changes of its own (CLAUDE.md).
#
# client/apps/shared/ayni/ is the Ayni repo itself (a git submodule). This fails
# when what would be deployed is not an Ayni commit that Nayive records:
#   1. the submodule is missing           -> git submodule update --init
#   2. Ayni has changes not committed     -> commit them IN AYNI first
#   3. Nayive records another Ayni commit -> git add client/apps/shared/ayni
# and warns (does not fail) when that Ayni commit is not on GitHub yet: a clone
# of Nayive could not fetch it until Ayni is pushed.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
AY=client/apps/shared/ayni

if [ ! -e "$AY/.git" ]; then
    echo "check-ayni: $AY is not the Ayni submodule (run: git submodule update --init)" >&2
    exit 1
fi

DIRTY="$(git -C "$AY" status --porcelain)"
if [ -n "$DIRTY" ]; then
    echo "check-ayni: Ayni has changes that are not committed in Ayni:" >&2
    echo "$DIRTY" | sed 's/^/    /' >&2
    echo "  Commit them in Ayni ($AY), then record it in Nayive (git add $AY)." >&2
    exit 1
fi

case "$(git submodule status -- "$AY")" in
    +*) echo "check-ayni: Ayni is at a commit Nayive does not record (git add $AY, then commit Nayive)." >&2
        exit 1 ;;
    -*) echo "check-ayni: the Ayni submodule is not checked out (git submodule update --init)." >&2
        exit 1 ;;
esac

if [ -z "$(git -C "$AY" branch -r --contains HEAD 2>/dev/null)" ]; then
    echo "check-ayni: WARNING - Ayni $(git -C "$AY" rev-parse --short HEAD) is not pushed to GitHub yet." >&2
fi
echo "check-ayni: OK - Ayni $(git -C "$AY" rev-parse --short HEAD), nothing left out of Ayni"
