#!/bin/sh
# Rebuilds nape.min.js: @newkrok/nape-js with the four engine-dependent Math calls
# swapped for det-math.js. NAPE_MODULES = a node_modules holding nape-js + esbuild.
set -e
cd "$( dirname "$0" )"
cat > /tmp/nape-entry.$$.js <<'X'
export { Space, Body, BodyType, Vec2, Circle, Polygon, Material, InteractionGroup, PivotJoint, MotorJoint, DistanceJoint, PulleyJoint, SpringJoint } from '@newkrok/nape-js';
X
NODE_PATH="$NAPE_MODULES" "$NAPE_MODULES/.bin/esbuild" /tmp/nape-entry.$$.js --bundle --minify --format=iife --global-name=Nape \
    --define:Math.sin=DM.sin --define:Math.cos=DM.cos --define:Math.atan2=DM.atan2 --define:Math.acos=DM.acos \
    --banner:js="$( cat det-math.js )" --outfile=nape.min.js --log-level=warning
rm /tmp/nape-entry.$$.js
