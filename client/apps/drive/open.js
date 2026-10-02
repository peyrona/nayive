/*
 * open.js - Drive: opening a file: openNode, Write / Calc, LibreOffice twins and
 * the "Abrir con" dialog.
 */
"use strict";

// Activate a node the way a plain click does: navigate into a folder, or
// route a file to its viewer / editor. Always handles the node — a file
// no extension rule claims ends in the "Abrir con" dialog — so it always
// returns true; the flag is kept for callers that still test it.
function openNode( node )
{
    // Something shared with us that belongs to an app: hand it straight to
    // that app instead of browsing its folder. Both open it read-only —
    // the server roots a "shared/..." path with writable=false.
    const app = sharedApp( node );
    if( app === 'photos' ) { openDoc( '../photos/index.html?dir='  + encodeURIComponent( node.path ) ); return true; }
    if( app === 'trips'  ) { openDoc( '../trips/index.html?open=' + encodeURIComponent( node.path ) ); return true; }
    if( app === 'split'  ) { openDoc( '../split/index.html?open=' + encodeURIComponent( node.path ) ); return true; }

    if( isDir( node ) ) { navigateTo( node.path ); return true; }

    const ext    = typeExt( node );
    const toText = TEXT_IMPORT.includes( ext );

    // A file in a format an editor opens natively: open it in place, from
    // wherever it lives. Calc opens a .csv as it is too (it saves it back as
    // a .csv, and says first what a .csv cannot keep). Anything else falls
    // through to the routing below.
    if( ext === 'docx' ) { openDoc( '../write/index.html?file=' + encodeURIComponent( node.path ) ); return true; }
    if( ext === 'xlsx' || ext === 'csv' ) { openDoc( '../calc/index.html?file=' + encodeURIComponent( node.path ) ); return true; }
    if( toText )         { openDoc( '../text/index.html?file='  + encodeURIComponent( node.path ) ); return true; }

    // A .zip: the list of what is inside, with "Extract here" (zip.js).
    if( ext === 'zip' ) { openZipDialog( node ); return true; }

    // A LibreOffice document: its Microsoft Office twin, made first when
    // there is none (Impress / Draw / Math / Base only get a "no").
    const office = officeKind( ext );
    if( office ) { openOffice( node, office ); return true; }

    // An image the editor can re-encode: open it in Image, a window of its own.
    if( IMAGE_EDIT.includes( ext ) ) { openDoc( '../image/index.html?file=' + encodeURIComponent( node.path ) ); return true; }

    // Any other image: show it in Drive's built-in lightbox viewer (no editing).
    if( IMAGE_VIEW.includes( ext ) ) { openImageViewer( node.path ); return true; }

    // Audio / video: play it in Drive's built-in player (no editing).
    if( VIDEO_VIEW.includes( ext ) ) { openMediaViewer( node.path, 'video' ); return true; }
    if( AUDIO_VIEW.includes( ext ) ) { openMediaViewer( node.path, 'audio' ); return true; }

    // A PDF: hand it to the browser's own PDF viewer (zoom, print, pages).
    if( ext === 'pdf' ) { openDoc( GumApi.fileUrl( node.path ) ); return true; }

    // No app claims this extension: ask which one should have it.
    openWithDialog( node.path, OPEN_WITH_ALL, 'drive.openWithAny' );
    return true;
}

//------------------------------------------------------------------------//
// OPEN A DRIVE FILE IN WRITE / CALC (the tool's import action, pre-triggered)

function openImport( tool, path )
{
    openDoc( '../' + tool + '/index.html?import=' + encodeURIComponent( path ) );
}

//------------------------------------------------------------------------//
// LIBREOFFICE DOCUMENTS (the lists sit with WRITE_IMPORT). The server
// writes the Microsoft Office twin beside the original - "x.odt" ->
// "x.docx", "y.ods" -> "y.xlsx" - and never touches the original
// (server/go/office.go). An upload converts every one; a double-click
// opens the twin, converting first when there is none yet.

// 'write' | 'calc' | 'refuse' | '' for an extension.
function officeKind( ext )
{
    if( OFFICE_WRITE.includes( ext ) )  return 'write';
    if( OFFICE_CALC.includes( ext ) )   return 'calc';
    if( OFFICE_REFUSE.includes( ext ) ) return 'refuse';
    return '';
}

// "docs/x.odt" -> "docs/x.docx"; '' for a file that has no twin.
function officeTwinRel( relPath )
{
    const kind = officeKind( extOf( relPath ) );
    if( kind !== 'write' && kind !== 'calc' ) return '';
    return relPath.replace( /\.[^./]+$/, kind === 'write' ? '.docx' : '.xlsx' );
}

// POST /api/office -> { path, converted }. `replace` on upload: the file
// just sent must never be answered with an older twin.
async function officeTwin( path, replace )
{
    const q = new URLSearchParams( { file: path } );
    if( replace ) q.set( 'replace', '1' );
    return JSON.parse( await withBusy( GumApi.fetchText( '/api/office?' + q.toString(), { method: 'POST' } ) ) );
}

// What to say when the server said no (the codes: api_office.go).
function officeFailText( err, name )
{
    const st = err && err.status;
    if( st === 503 ) return T( 'drive.officeOff' );
    if( st === 507 ) return TF( 'drive.officeQuota',    { name: name } );
    if( st === 403 ) return TF( 'drive.officeReadOnly', { name: name } );
    // openOffice asks twice on a 409: a second one is a FOLDER of the twin's name.
    if( st === 409 ) return TF( 'drive.officeTwinFolder', { name: officeTwinRel( name ) || name } );
    return TF( 'drive.officeFailed', { name: name } );
}

async function openOffice( node, kind )
{
    const name = displayName( node );
    if( kind === 'refuse' ) { NayiveUI.toast( TF( 'drive.officeRefusedOpen', { name: name } ), { ms: 6000 } ); return; }
    // A file shared on its own has no folder of ours to put a twin in.
    if( node.shared )       { NayiveUI.toast( TF( 'drive.officeReadOnly',    { name: name } ), { ms: 6000 } ); return; }

    // The tab opens NOW, while the double-click still counts: opened
    // after the wait, the browser would block it as a pop-up. Not in a
    // desktop window: there window.open is the desktop's own, which never
    // blocks and, given the twin's address, brings forward the window that
    // already shows it (sameDoc). A blank window pointed at it later was
    // always a second editor on the same file, each saving over the other (A1).
    const busyText = TF( 'drive.officeConverting', { name: name } );
    const early    = ! isPhone() && ! NayiveUI.windowed;
    const win      = early ? window.open( '', '_blank' ) : null;
    if( win ) try { win.document.title = name; win.document.body.textContent = busyText; } catch( _ ) {}
    setStatus( busyText );
    try
    {
        let r;
        try { r = await officeTwin( node.path, false ); }
        catch( err )
        {
            // 409: a file took the twin's name while LibreOffice ran, and the
            // server kept it. Asked again, that twin is the answer (a FOLDER of
            // that name is a 409 again: the failure below).
            if( ! err || err.status !== 409 ) throw err;
            r = await officeTwin( node.path, false );
            if( ! r.converted )
            {
                NayiveUI.toast( TF( 'drive.officeTwinExists', { name: r.path.split( '/' ).pop() } ), { ms: 5000 } );
                reload();
            }
        }
        const url = new URL( '../' + kind + '/index.html?file=' + encodeURIComponent( r.path ), location.href ).href;
        setStatus( '' );
        if( r.converted )
        {
            NayiveUI.toast( TF( 'drive.officeConverted', { name: r.path.split( '/' ).pop() } ), { ms: 5000 } );
            reload();     // the twin shows up beside the original
        }
        if( win )        win.location.href = url;
        else if( early ) location.href = url;     // the pop-up was blocked
        else             openDoc( url );
    }
    catch( err )
    {
        setStatus( '' );
        if( win ) win.close();
        NayiveUI.toast( officeFailText( err, name ), { ms: 6000 } );
    }
}

//------------------------------------------------------------------------//
// "ABRIR CON" DIALOG
//
// Drive has no launcher buttons for the other apps any more: a file gets
// to its app by being opened. When openNode knows the extension it goes
// straight there; when it does not, this dialog asks. Two callers:
//   - a file BOTH Write and Calc could import (their lists are disjoint
//     today, so it never fires — kept in case they ever overlap);
//   - a file no app claims, and then every app is on offer.

const OPEN_WITH_BTN =
{
    text:   'importWithTextBtn',   write: 'importWithWriteBtn', calc:   'importWithCalcBtn',
    photos: 'importWithPhotosBtn', music: 'importWithMusicBtn', movies: 'importWithMoviesBtn'
};
const OPEN_WITH_ALL = [ 'text', 'write', 'calc', 'photos', 'music', 'movies' ];

let openWithPath = null;

function openWithDialog( path, apps, msgKey )
{
    openWithPath = path;
    document.getElementById( 'importWithMsg' ).textContent =
        TF( msgKey, { name: path.split( '/' ).pop() } );

    for( const app in OPEN_WITH_BTN )
        document.getElementById( OPEN_WITH_BTN[ app ] ).hidden = ! apps.includes( app );

    setBackdrop( 'importWithBackdrop', true );
}

// Text opens any file as it is; Write and Calc convert theirs on import.
// Photos / Music / Movies only ever take a FOLDER (?dir=), so they open
// the one the file sits in.
function chooseOpenWith( app )
{
    const path = openWithPath;
    openWithPath = null;
    setBackdrop( 'importWithBackdrop', false );
    if( ! path ) return;

    if( app === 'text' )                    openDoc( '../text/index.html?file=' + encodeURIComponent( path ) );
    else if( app === 'write' || app === 'calc' ) openImport( app, path );
    else openDoc( '../' + app + '/index.html?dir=' +
                  encodeURIComponent( path.split( '/' ).slice( 0, -1 ).join( '/' ) ) );
}
