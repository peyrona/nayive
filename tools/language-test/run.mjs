// run.mjs - the Language app's orchestrator tests (design document, 13.2),
// with fake engines and an in-memory storage: no browser, no network.
//
//   node tools/language-test/run.mjs
//
// The real engines, OCR, voices and dictionaries need a browser and the
// internet: see tools/language-test/browser.mjs.
import { Translator, AllEnginesFailedError, LocalModeError } from "../../client/apps/language/translator.js";
import { splitText, utf8Length } from "../../client/apps/language/split.js";
import { decodeEntities, checkBaseUrl } from "../../client/apps/language/net.js";
import { normalizeLanguage } from "../../client/apps/language/languages.js";
import { fakeAdapter, memoryStorage } from "./fake.js";

let pass = 0, fail = 0;
function ok( cond, name ) { if( cond ) pass++; else { fail++; console.log( "FAIL " + name ); } }
async function throws( p, check, name )
{
    try { await p; ok( false, name + " (did not throw)" ); }
    catch( e ) { ok( check( e ), name + " (" + ( e && ( e.category || e.message ) ) + ")" ); }
}

const eng = ( id, adapter, score, extra = {} ) => Object.assign( { id, name: id.toUpperCase(), adapter, enabled: true, score, timeoutMs: 2000, options: {} }, extra );

async function make( adapters, catalog, opts = {} )
{
    const t = new Translator( Object.assign( { adapters, catalog, storage: memoryStorage( opts.saved ? { "translator.config": opts.saved } : {} ),
                                               dictionaries: [] }, opts.extra || {} ) );
    await t.init();
    if( opts.remote ) t.setLocalMode( false );
    return t;
}
const req = ( text = "Hola, ¿cómo estás?", source = "es", target = "fr", extra = {} ) => Object.assign( { text, source, target }, extra );

// --- split -------------------------------------------------------------------
{
    const text = "Primera frase. Segunda frase algo más larga.\n\nOtro párrafo aquí.";
    const parts = splitText( text, 20 );
    ok( parts.map( ( p ) => p.text ).join( "" ) === text, "split: joining gives the text back" );
    ok( parts.filter( ( p ) => p.translatable ).every( ( p ) => p.text.length <= 20 ), "split: every piece within the limit" );
    ok( parts.some( ( p ) => ! p.translatable && p.text === "\n\n" ), "split: the blank line kept as is" );
    const zh = "最近的火车站在哪里？".repeat( 30 );
    ok( splitText( zh, 480, utf8Length ).filter( ( p ) => p.translatable ).every( ( p ) => utf8Length( p.text ) <= 480 ), "split: byte limit for Chinese" );
    ok( splitText( "x".repeat( 50 ), 20 ).filter( ( p ) => p.translatable ).length === 3, "split: a word longer than the limit is cut" );
}

// --- small helpers -----------------------------------------------------------
ok( decodeEntities( "l&#39;eau &amp; &quot;x&quot; &#x4e2d; <b>" ) === "l'eau & \"x\" 中 <b>", "entities decoded, tags left as text" );
ok( normalizeLanguage( "es-ES" ) === "es" && normalizeLanguage( "pt-BR" ) === "pt" && normalizeLanguage( "zh-Hans-CN" ) === "zh" && normalizeLanguage( "it" ) === null, "language tags normalized" );
await throws( Promise.resolve().then( () => checkBaseUrl( "http://x.com", "baseUrl" ) ), ( e ) => e.category === "invalid-input", "http URL refused" );
await throws( Promise.resolve().then( () => checkBaseUrl( "https://u:p@x.com", "baseUrl" ) ), ( e ) => e.category === "invalid-input", "URL with credentials refused" );
ok( checkBaseUrl( "https://x.com/api/", "b" ) === "https://x.com/api", "URL trailing slash dropped" );

// --- a single engine works ---------------------------------------------------
{
    const a = fakeAdapter( "a" );
    const t = await make( [ a ], [ eng( "a1", "a", 5 ) ] );
    const r = await t.translate( req() );
    ok( r.text === "[a]Hola, ¿cómo estás?" && r.engineId === "a1" && r.location === "local", "one engine: its text, id and location" );
    ok( r.attempts.length === 1 && r.attempts[ 0 ].ok, "one engine: one ok attempt" );
    ok( ! JSON.stringify( r.attempts ).includes( "Hola" ), "attempts never carry the text" );
}

// --- the preferred fails, the next one is used ------------------------------
{
    const bad = fakeAdapter( "bad", { fail: "network" } ), good = fakeAdapter( "good" );
    const t = await make( [ bad, good ], [ eng( "b", "bad", 5 ), eng( "g", "good", 4 ) ] );
    const events = [];
    const r = await t.translate( req(), { onEvent: ( e ) => events.push( e.type ) } );
    ok( r.engineId === "g" && r.attempts.length === 2 && ! r.attempts[ 0 ].ok && r.attempts[ 0 ].category === "network", "fallback: next engine, attempts say why" );
    ok( events.includes( "fallback" ), "fallback: event emitted" );
}

// --- all fail ----------------------------------------------------------------
{
    const t = await make( [ fakeAdapter( "x", { fail: "network" } ), fakeAdapter( "y", { fail: "internal" } ) ], [ eng( "x1", "x", 5 ), eng( "y1", "y", 4 ) ] );
    await throws( t.translate( req() ), ( e ) => e instanceof AllEnginesFailedError && e.attempts.length === 2 && e.attempts[ 1 ].category === "internal", "all fail: error with every attempt" );
}

// --- score tie keeps catalog order; disabled engine never runs ---------------
{
    const a = fakeAdapter( "a" ), b = fakeAdapter( "b" ), c = fakeAdapter( "c" );
    const t = await make( [ a, b, c ], [ eng( "c1", "c", 5, { enabled: false } ), eng( "a1", "a", 3 ), eng( "b1", "b", 3 ) ] );
    const r = await t.translate( req() );
    ok( r.engineId === "a1", "tie: catalog order" );
    ok( c.calls.length === 0, "disabled engine not run" );
    ok( t.getEngines().map( ( e ) => e.id ).join() === "c1,a1,b1", "getEngines sorted by score" );
}

// --- invalid settings rejected ----------------------------------------------
{
    const t = await make( [ fakeAdapter( "a" ) ], [ eng( "a1", "a", 3 ) ] );
    await throws( Promise.resolve().then( () => t.updateEngine( "a1", { score: 7 } ) ), ( e ) => e.category === "invalid-input" && e.details.field === "score", "score out of 0-5 refused" );
    await throws( Promise.resolve().then( () => t.updateEngine( "a1", { timeoutMs: 500 } ) ), ( e ) => e.details.field === "timeoutMs", "timeout out of range refused" );
    ok( t.getEngine( "a1" ).score === 3, "nothing saved after a refused change" );
}

// --- empty answer, quota inside a 200, time-out -----------------------------
{
    const t = await make( [ fakeAdapter( "e", { empty: true } ), fakeAdapter( "g" ) ], [ eng( "e1", "e", 5 ), eng( "g1", "g", 4 ) ] );
    const r = await t.translate( req() );
    ok( r.engineId === "g1" && r.attempts[ 0 ].category === "invalid-response", "empty answer: failure, next one" );
}
{
    const storage = memoryStorage();
    const t = new Translator( { adapters: [ fakeAdapter( "q", { fail: "quota" } ), fakeAdapter( "g" ) ], catalog: [ eng( "q1", "q", 5 ), eng( "g1", "g", 4 ) ], storage, dictionaries: [] } );
    await t.init();
    await t.translate( req() );
    const st = await t.getEngineStatus( "q1" );
    ok( st.state === "paused" && st.pausedUntil > new Date(), "quota: engine paused" );
    ok( JSON.parse( storage.getItem( "translator.config" ) ).quotaUntil.q1, "quota pause kept in storage" );
    const r = await t.translate( req() );
    ok( r.attempts.length === 1 && r.engineId === "g1", "quota: paused engine skipped next time" );
    const t2 = new Translator( { adapters: [ fakeAdapter( "q" ), fakeAdapter( "g" ) ], catalog: [ eng( "q1", "q", 5 ), eng( "g1", "g", 4 ) ], storage, dictionaries: [] } );
    await t2.init();
    ok( ( await t2.getEngineStatus( "q1" ) ).state === "paused", "quota pause survives a reload" );
}
{
    const t = await make( [ fakeAdapter( "slow", { ms: 3000 } ), fakeAdapter( "g" ) ], [ eng( "s1", "slow", 5, { timeoutMs: 1000 } ), eng( "g1", "g", 4 ) ] );
    const r = await t.translate( req() );
    ok( r.engineId === "g1" && r.attempts[ 0 ].category === "timeout", "time-out: aborted, next one" );
}

// --- a new Translate cancels the previous -----------------------------------
{
    const t = await make( [ fakeAdapter( "slow", { ms: 300 } ) ], [ eng( "s1", "slow", 5 ) ] );
    const first = t.translate( req( "uno" ) );
    const second = t.translate( req( "dos" ) );
    await throws( first, ( e ) => e.category === "aborted", "second Translate cancels the first" );
    ok( ( await second ).text.endsWith( "dos" ), "only the last result arrives" );
    const third = t.translate( req( "tres" ) );
    t.cancel();
    await throws( third, ( e ) => e.category === "aborted", "cancel(): aborted" );
}

// --- detection ---------------------------------------------------------------
{
    const det = fakeAdapter( "d", { detect: { language: "fr", confidence: 0.9 } } );
    const t = await make( [ det ], [ eng( "d1", "d", 5 ) ] );
    const r = await t.translate( req( "Où se trouve la gare la plus proche ?", "auto", "es" ) );
    ok( r.source === "fr" && r.detection.language === "fr", "auto: detected and translated" );
    const low = await make( [ fakeAdapter( "d", { detect: { language: "fr", confidence: 0.2 } } ) ], [ eng( "d1", "d", 5 ) ] );
    await throws( low.translate( req( "ok", "auto", "es" ) ), ( e ) => e.category === "unsupported" && e.details.reason === "low-confidence", "auto: low confidence asks the user" );
    const none = await make( [ fakeAdapter( "a" ) ], [ eng( "a1", "a", 5 ) ] );
    await throws( none.translate( req( "Bonjour", "auto", "es" ) ), ( e ) => e.category === "unsupported" && e.details.reason === "no-detector", "auto without a detector: asks the user" );
}

// --- request checks ----------------------------------------------------------
{
    const a = fakeAdapter( "a" );
    const t = await make( [ a ], [ eng( "a1", "a", 5 ) ] );
    await throws( t.translate( req( "Hola", "es", "es" ) ), ( e ) => e.category === "invalid-input", "same language refused" );
    await throws( t.translate( req( "   " ) ), ( e ) => e.category === "invalid-input", "empty text refused" );
    await throws( t.translate( req( "x".repeat( 5001 ) ) ), ( e ) => e.category === "invalid-input", "text over the limit refused" );
    ok( a.calls.length === 0, "no engine called for a refused request" );
}

// --- long text: split, translated, joined, line breaks kept -----------------
{
    const a = fakeAdapter( "a", { maxChars: 30, prefix: "" } );
    const t = await make( [ a ], [ eng( "a1", "a", 5 ) ] );
    const text = "Una frase corta. Otra frase corta. Y una más.\n\nSegundo párrafo.";
    const r = await t.translate( req( text ) );
    ok( a.calls.length > 2 && a.calls.every( ( c ) => c.text.length <= 30 ), "long text: split by maxChars" );
    ok( r.text === text, "long text: joined back with the line breaks" );
}

// --- HTML in an answer stays text --------------------------------------------
{
    const t = await make( [ fakeAdapter( "h", { raw: "<img src=x onerror=alert(1)>" } ) ], [ eng( "h1", "h", 5 ) ] );
    ok( ( await t.translate( req() ) ).text === "<img src=x onerror=alert(1)>", "HTML comes back as plain text (shown with textContent)" );
}

// --- a model to download: consent asked once, preparing not a time-out ------
{
    const a = fakeAdapter( "m", { availability: "downloadable", consent: true } );
    const t = await make( [ a ], [ eng( "m1", "m", 5 ) ] );
    let asked = 0;
    const events = [];
    const r = await t.translate( req(), { confirmDownload: async () => { asked++; return true; }, onEvent: ( e ) => events.push( e.type ) } );
    ok( r.engineId === "m1" && a.prepared === 1 && asked === 1, "download: asked, prepared, translated" );
    ok( events.includes( "preparing" ), "download: progress events" );
    ok( t.getPreferences().downloadsAllowed.includes( "m1:es-fr" ), "download: consent remembered" );
    const b = fakeAdapter( "m", { availability: "downloadable", consent: true } );
    const t2 = await make( [ b, fakeAdapter( "r", { location: "remote" } ) ], [ eng( "m1", "m", 5 ), eng( "r1", "r", 4 ) ] );
    t2.setLocalMode( false );
    const r2 = await t2.translate( req(), { confirmDownload: async () => false } );
    ok( r2.engineId === "r1" && r2.attempts[ 0 ].declined && ! b.prepared, "download declined: skipped, nothing downloaded" );
}

// --- Local mode --------------------------------------------------------------
{
    const loc = fakeAdapter( "loc", { unsupported: [ "es>zh" ] } ), rem = fakeAdapter( "rem", { location: "remote" } );
    const t = await make( [ loc, rem ], [ eng( "l1", "loc", 3 ), eng( "r1", "rem", 5 ) ] );
    ok( t.isLocalMode(), "Local mode on by default" );
    const r = await t.translate( req() );
    ok( r.engineId === "l1" && rem.calls.length === 0, "Local mode: remote engine never called" );
    await throws( t.translate( req( "Hola", "es", "zh" ) ), ( e ) => e instanceof LocalModeError && e.remoteEngineIds.includes( "r1" ), "Local mode, no local engine: LocalModeError naming the remote ones" );
    ok( rem.calls.length === 0, "...and still nothing sent" );
    const r2 = await t.translate( req( "Hola", "es", "zh", { allowRemote: true } ) );
    ok( r2.engineId === "r1" && r2.location === "remote", "allowRemote once: the remote engine" );
    ok( t.isLocalMode(), "allowRemote does not turn Local mode off" );
}

// --- Local mode, the local engine fails: the internet is offered, not used --
{
    const loc = fakeAdapter( "loc", { fail: "internal" } ), rem = fakeAdapter( "rem", { location: "remote" } );
    const t = await make( [ loc, rem ], [ eng( "l1", "loc", 5 ), eng( "r1", "rem", 3 ) ] );
    await throws( t.translate( req() ), ( e ) => e instanceof LocalModeError && e.remoteEngineIds.join() === "r1" && e.attempts.length === 1,
                  "Local mode, local engine fails: LocalModeError with the attempt" );
    ok( rem.calls.length === 0, "...and the remote engine was not called" );
}

// --- three network failures pause for 5 minutes ------------------------------
{
    const t = await make( [ fakeAdapter( "n", { fail: "network" } ), fakeAdapter( "g" ) ], [ eng( "n1", "n", 5 ), eng( "g1", "g", 4 ) ] );
    let paused = null;
    t.on( "engine-paused", ( e ) => { paused = e.detail; } );
    for( let i = 0; i < 3; i++ ) await t.translate( req() );
    const st = await t.getEngineStatus( "n1" );
    ok( st.state === "paused" && st.pausedUntil - Date.now() > 4 * 60e3 && paused && paused.id === "n1", "3 network failures: paused 5 min, event sent" );
    const r = await t.translate( req() );
    ok( r.attempts.length === 1, "paused engine skipped" );
}

// --- persistence -------------------------------------------------------------
{
    const storage = memoryStorage();
    const mk = async ( catalog ) => { const t = new Translator( { adapters: [ fakeAdapter( "a" ) ], catalog, storage, dictionaries: [] } ); await t.init(); return t; };
    const t = await mk( [ eng( "a1", "a", 3 ) ] );
    t.updateEngine( "a1", { score: 4.5 } );
    t.setPreferences( { source: "fr", target: "es" } );
    const t2 = await mk( [ eng( "a1", "a", 3 ) ] );
    ok( t2.getEngine( "a1" ).score === 4.5 && t2.getPreferences().source === "fr", "reload: the configuration is kept" );
    const saved = JSON.parse( storage.getItem( "translator.config" ) );
    ok( Object.keys( saved.engines.a1 ).join() === "score", "only the differences are saved" );
    const t3 = await mk( [ eng( "a1", "a", 3 ), eng( "new", "a", 1 ) ] );
    ok( t3.getEngines().some( ( e ) => e.id === "new" ), "a new catalog engine appears over an old saved configuration" );

    t3.resetConfig();
    ok( t3.getEngine( "a1" ).score === 3 && t3.getPreferences().source === "es", "restore defaults: local changes gone" );
}
{
    let warned = null;
    const t = new Translator( { adapters: [ fakeAdapter( "a" ) ], catalog: [ eng( "a1", "a", 3 ) ], dictionaries: [],
                                storage: memoryStorage( { "translator.config": "{broken" } ) } );
    t.on( "storage-error", ( e ) => { warned = e.detail.reason; } );
    await t.init();
    ok( warned === "corrupt" && t.getEngine( "a1" ).score === 3, "corrupt storage: defaults + warning" );
    const broken = { getItem() { throw new Error( "denied" ); }, setItem() { throw new Error( "denied" ); }, removeItem() {} };
    const t2 = new Translator( { adapters: [ fakeAdapter( "a" ) ], catalog: [ eng( "a1", "a", 3 ) ], dictionaries: [], storage: broken } );
    await t2.init();
    ok( ( await t2.translate( req() ) ).engineId === "a1", "storage unavailable: still translates" );
}

// --- the admin's settings (options.shared) -----------------------------------
{
    const storage = memoryStorage();
    const mk = async ( shared ) => { const t = new Translator( { adapters: [ fakeAdapter( "a" ) ], catalog: [ eng( "a1", "a", 3 ) ], storage, dictionaries: [], shared } ); await t.init(); return t; };
    const t = await mk( undefined );
    t.updateEngine( "a1", { score: 1 } );
    t.setPreferences( { source: "fr" } );
    const t2 = await mk( { engines: { a1: { score: 4.5 } }, custom: [], dictionaries: {} } );
    ok( t2.getEngine( "a1" ).score === 4.5 && t2.getPreferences().source === "fr", "shared: the admin's engines win, own languages kept" );
    const t3 = await mk( undefined );
    ok( t3.getEngine( "a1" ).score === 4.5, "shared: kept as the offline copy" );
    const t4 = await mk( { engines: { a1: { score: 99 } } } );
    ok( t4.getEngine( "a1" ).score === 4.5, "shared: a bad answer keeps the copy" );
}

// --- engines: add, remove, missing adapter, test ----------------------------
{
    const t = await make( [ fakeAdapter( "a" ), fakeAdapter( "r", { location: "remote" } ) ], [ eng( "a1", "a", 3 ), eng( "gone", "nope", 4 ) ] );
    ok( t.getEngine( "gone" ).enabled === false && t.getEngine( "gone" ).missingAdapter, "missing adapter: kept, disabled, marked" );
    t.addEngine( { id: "mine", name: "Mine", adapter: "r" } );
    ok( t.getEngine( "mine" ).location === "remote" && ! t.getEngine( "mine" ).builtIn, "addEngine: created" );
    await throws( Promise.resolve().then( () => t.addEngine( { id: "mine", name: "x", adapter: "r" } ) ), ( e ) => e.details.field === "id", "addEngine: id taken" );
    await throws( Promise.resolve().then( () => t.removeEngine( "a1" ) ), ( e ) => e.category === "invalid-input", "built-in engines cannot be removed" );
    t.removeEngine( "mine" );
    ok( ! t.getEngines().some( ( e ) => e.id === "mine" ), "removeEngine: gone" );
    const r = await t.testEngine( "a1" );
    ok( r.ok && r.text.startsWith( "[a]" ), "testEngine: translates the test sentence" );
    const bad = await make( [ fakeAdapter( "b", { fail: "network" } ) ], [ eng( "b1", "b", 3 ) ] );
    const rb = await bad.testEngine( "b1" );
    ok( ! rb.ok && rb.category === "network", "testEngine: failure reported, not thrown" );
}

// --- supported pairs respect Local mode --------------------------------------
{
    const t = await make( [ fakeAdapter( "loc", { unsupported: [ "es>zh" ] } ), fakeAdapter( "rem", { location: "remote" } ) ], [ eng( "l1", "loc", 3 ), eng( "r1", "rem", 2 ) ] );
    const pairs = await t.getSupportedPairs();
    ok( pairs.length === 19 && ! pairs.some( ( p ) => p.source === "es" && p.target === "zh" ), "pairs: Local mode leaves es>zh out" );
    t.setLocalMode( false );
    ok( ( await t.getSupportedPairs() ).length === 20, "pairs: Local mode off, all 20" );
}

console.log( `\n${ pass } passed, ${ fail } failed` );
process.exit( fail ? 1 : 0 );
