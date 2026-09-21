/*
 * buffer-stub.js - node's `buffer` module, for a browser that never asks.
 *
 * docx.js (inside @hufe921/canvas-editor-plugin-docx) decodes base64 like this:
 *
 *     if( typeof atob == "function" ) { ...atob... }
 *     else { const t = require("buffer"); return new t.Buffer( e, "base64" ); }
 *
 * The else is for node. A browser always has atob, so that branch is dead - but
 * esbuild bundles it anyway and then cannot resolve "buffer". build.sh aliases
 * it here. Same idea as client/apps/write/lib/superdoc/.peer-stub.js.
 */
export const Buffer = undefined;
export default { Buffer: undefined };
