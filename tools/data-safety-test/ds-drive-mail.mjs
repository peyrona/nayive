// ds-drive-mail.mjs - eMail "Save to Drive" never replaces a file there
// (D5, mail-chat #9).
//
// A failed listing of the folder was read as "folder empty": the attachment
// ("informe.pdf") went up over last month's file of that name. And a name
// taken after the listing was written over too.
//
// lib.mjs's server() has no mail account, so this one starts the eMail test
// server of tools/email-test (TestMailE2EServe in server/go: user ana/abc, one
// account on an in-memory IMAP server whose mail "With a file" carries
// informe.pdf) - the same way ds-mail.mjs does.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, client, ok, section, done, REPO, sleep } from "./lib.mjs";

const GO = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );

async function mailServer()
{
    const port = await new Promise( res => { const x = net.createServer(); x.listen( 0, "127.0.0.1", () => { const p = x.address().port; x.close( () => res( p ) ); } ); } );
    const tmp  = fs.mkdtempSync( path.join( os.tmpdir(), "ds-mail-" ) );
    const stop = path.join( tmp, "stop" );
    const proc = spawn( GO, [ "test", "-v", "-count=1", "-timeout", "20m", "-run", "^TestMailE2EServe$", "." ],
                        { cwd: path.join( REPO, "server/go" ), stdio: [ "ignore", "pipe", "inherit" ],
                          env: { ...process.env, NAYIVE_MAIL_E2E: "127.0.0.1:" + port, NAYIVE_MAIL_E2E_STOP: stop } } );
    process.on( "exit", () => { try { fs.writeFileSync( stop, "" ); } catch {} try { proc.kill(); } catch {} } );
    await new Promise( ( res, rej ) =>
    {
        let buf = "";
        const t = setTimeout( () => rej( new Error( "the mail test server did not start: " + buf ) ), 300000 );
        proc.stdout.on( "data", d => { buf += d; if( buf.includes( "E2E READY" ) ) { clearTimeout( t ); res(); } } );
        proc.on( "exit", code => rej( new Error( "the mail test server stopped: " + code + " " + buf ) ) );
    } );
    return {
        base: "http://127.0.0.1:" + port, users: { ana: "abc" },
        stop: async () =>
        {
            try { fs.writeFileSync( stop, "" ); } catch {}
            await new Promise( r => { if( proc.exitCode !== null ) r(); else { proc.once( "exit", r ); setTimeout( () => { try { proc.kill(); } catch {} r(); }, 4000 ); } } );
            try { fs.rmSync( tmp, { recursive: true, force: true } ); } catch {}
        }
    };
}

const s = await mailServer();
const phone = await client( s.base, "ana", "abc" );
const onServer = async rel => { const r = await phone.get( rel ); return r.status === 200 ? r.text : null; };
const c = await browser( s, { lang: "es" } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:email', '1' ); true" );

const row = subject => `[...document.querySelectorAll('#list .mail-row')].find( r => r.querySelector('.subj span').textContent === ${JSON.stringify( subject )} )`;
// "Save to Nayive" on the file, into the Files root.
async function saveToRoot()
{
    await c.evaluate( "window.__toasts = []; document.querySelector('#readParts .mail-part-line .icon-btn').click(); true" );
    // The folder picker draws the shared tree (.fp-tree .tree-row); the first row is the Files root.
    if( ! await c.until( "document.querySelector('.sheet-backdrop.open .fp-tree .tree-row')" ) ) return false;
    await c.evaluate( "document.querySelector('.sheet-backdrop.open .fp-tree .tree-row').click(); true" );
    await c.until( "! document.querySelector('.sheet-backdrop.open .btn-primary').disabled" );
    await c.evaluate( "document.querySelector('.sheet-backdrop.open .btn-primary').click(); true" );
    return true;
}

section( "D5 · SAVE TO DRIVE ONTO A NAME THAT IS TAKEN" );
{
    const put = await phone.put( "files/informe.pdf", "LAST MONTH'S INVOICE" );
    ok( put.status === 200, "files/informe.pdf is there (last month's)" );

    await c.open( "/nayive/email/index.html" );
    ok( await c.until( "document.querySelectorAll( '#list .mail-row' ).length > 0 && NayiveMail.S.acct", 30000 ), "eMail is open" );
    // the item browser: a click picks a row, a double-click opens it
    await c.evaluate( row( "With a file" ) + ".dispatchEvent( new MouseEvent( 'dblclick', { bubbles: true } ) ); true" );
    ok( await c.until( "document.querySelector('#readParts .mail-part-line')" ), "the mail with informe.pdf is open" );

    // The folder's listing fails (a 5xx, a hiccup): nothing is saved.
    await c.evaluate( `window.__realList = GumApi.listDir; GumApi.listDir = function() { const e = new Error( 'HTTP 502: Bad Gateway' ); e.status = 502; return Promise.reject( e ); }; true` );
    ok( await saveToRoot(), "Save to Nayive -> Files" );
    ok( await c.until( "window.__toasts.includes( NayiveUI.t( 'ui.saveFailed' ) )", 8000 ), "it says it could not save", await c.evaluate( "window.__toasts" ) );
    ok( await onServer( "files/informe.pdf" ) === "LAST MONTH'S INVOICE", "last month's informe.pdf is untouched", await onServer( "files/informe.pdf" ) );

    // A listing that does not know the name yet (taken after the look): the
    // create-only PUT gets a 412 and the next free name is used.
    await c.evaluate( "GumApi.listDir = function() { return Promise.resolve( { nodes: [] } ); }; true" );
    ok( await saveToRoot(), "Save to Nayive -> Files, again" );
    ok( await c.until( "window.__toasts.some( t => /^Guardado en /.test( t ) )", 8000 ), "saved", await c.evaluate( "window.__toasts" ) );
    ok( await onServer( "files/informe.pdf" ) === "LAST MONTH'S INVOICE", "last month's informe.pdf is still untouched" );
    const second = await onServer( "files/informe (2).pdf" );
    ok( second !== null && second.startsWith( "%PDF" ), "the attachment went up as informe (2).pdf", second && second.slice( 0, 20 ) );
}

await done( c, s );
