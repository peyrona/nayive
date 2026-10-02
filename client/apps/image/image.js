/*
 * image.js - Image: the photo editor on ONE picture, ?file=<path>. A module
 * for its top-level await of the dictionary.
 *
 * ✓ writes the edit back to the file (and the photo note), and the editor
 * stays open on it. "Save a copy" writes a new file beside it and goes on
 * editing the copy. Leaving with something unsaved asks first: the ← (not in
 * a desktop window), Escape, and the desktop window's own close, which asks
 * through window.nayiveBeforeClose (desktop/index.html, close).
 *
 * Nothing here tells Drive or Photos what changed: every write goes through
 * GumApi, whose file news (onFilesChanged) they already listen to.
 */

// Nothing is drawn from JS before the dictionary is in: without an
// in-source fallback, an early render would paint the bare keys.
await NayiveI18n.ready;

const T  = function( k )    { return NayiveUI.t( k ); };
const TF = function( k, o ) { return NayiveUI.tf( k, o ); };
const $  = function( id )   { return document.getElementById( id ); };

// The formats the editor can load AND re-encode (canvas.toDataURL).
const EDIT_EXT = [ 'png', 'jpg', 'jpeg', 'webp' ];

let imageEditor = null;    // the live tui.ImageEditor, or null
let editorPath  = '';      // the file being edited - the copy, after "Save a copy"
let editorDirty = false;   // an image edit not yet on disk
let savedOnce   = false;   // after a save the undo stack still holds what was saved
let commentBase = '';      // the photo note as last loaded / saved
let saving      = false;   // a write in flight: no second one, no leaving
let closing     = false;   // leaving was already asked about

function extOf( name ) { const i = name.lastIndexOf( '.' ); return i < 0 ? '' : name.slice( i + 1 ).toLowerCase(); }
function nameOf( path ) { return path.split( '/' ).pop(); }
function dirOf( path ) { const i = path.lastIndexOf( '/' ); return i < 0 ? '' : path.slice( 0, i ); }

function showName( path )
{
    const name = nameOf( path );
    $( 'fileLabel' ).textContent = name;
    document.title = name;                  // the desktop's bar button names the window by it
}

function setMsg( text ) { $( 'editorMsg' ).textContent = text; }

//------------------------------------------------------------------------//
// PHOTO NOTE - one hidden sidecar map keyed by the image's path, the same
// file Photos reads and writes (shared/media.js keeps it in step when Drive
// renames, moves or copies a picture).

function commentValue() { return $( 'editorComment' ).value.trim(); }
function isDirty() { return editorDirty || commentValue() !== commentBase; }

async function loadNote( path )
{
    let map;
    try { map = await NayiveMedia.readComments(); } catch( _ ) { return; }
    $( 'editorComment' ).value = map[ path ] || '';
    commentBase = commentValue();
}

async function saveNote( path )
{
    let map;
    try { map = await NayiveMedia.readComments(); } catch( _ ) { return; }
    const text = commentValue();
    if( text ) map[ path ] = text; else delete map[ path ];
    try { await NayiveMedia.writeComments( map ); commentBase = text; }
    catch( _ ) { /* non-fatal: the image itself was saved */ }
}

// The note `path` has now: '' for none, null when the notes could not be read
// (the Undo then leaves them alone).
async function noteOf( path )
{
    try { return ( await NayiveMedia.readComments() )[ path ] || ''; }
    catch( _ ) { return null; }
}

//------------------------------------------------------------------------//
// OPEN

async function start()
{
    const file = new URLSearchParams( location.search ).get( 'file' ) || '';
    showName( file || T( 'ui.untitled' ) );
    setBusy( true );

    try { await GumApi.probeAccess(); }
    catch( err ) { if( err && err.status === 401 ) { GumApi.loginRedirect(); return; } }

    if( ! file || EDIT_EXT.indexOf( extOf( file ) ) < 0 ) { setMsg( T( 'photos.cantEdit' ) ); return; }

    setMsg( T( 'drive.loadingEditor' ) );
    try { await NayivePhoto.loadEditor(); }
    catch( _ ) { setMsg( T( 'drive.editorFailed' ) ); return; }

    editorPath = file;
    loadNote( file );

    const host = $( 'tuiEditor' );
    host.innerHTML = '';
    imageEditor = NayivePhoto.newEditor( host, GumApi.fileUrl( file ), nameOf( file ) );
    imageEditor.on( 'undoStackChanged', function( len ) { editorDirty = savedOnce || len > 0; } );
    setBusy( false );
}

function setBusy( on )
{
    $( 'editorSaveBtn'   ).disabled = on;
    $( 'editorSaveAsBtn' ).disabled = on;
}

//------------------------------------------------------------------------//
// SAVE

// png stays png; jpg/jpeg → jpeg; webp → webp. Anything else defaults to png.
function formatFor( name )
{
    const e = extOf( name );
    if( e === 'jpg' || e === 'jpeg' ) return 'jpeg';
    if( e === 'webp' )                return 'webp';
    return 'png';
}

// `replaced`: set when "Save a copy" sent a file of the same name to the
// bin first (confirmSaveCopy) - the "Saved" toast then carries its Undo.
async function saveTo( dest, replaced )
{
    if( ! imageEditor || saving ) return;

    // Only the note changed: the picture on disk is already right, and
    // encoding it again would only lose quality.
    if( ! editorDirty && dest === editorPath )
    {
        await saveNote( dest );
        NayiveUI.toast( T( 'drive.imageSaved' ) );
        return;
    }

    const fmt  = formatFor( dest );
    const opts = { format: fmt };
    if( fmt !== 'png' ) opts.quality = 0.92;

    let bytes;
    try { bytes = NayivePhoto.dataUrlBytes( imageEditor.toDataURL( opts ) ); }
    catch( _ ) { NayiveUI.toast( T( 'drive.renderFailed' ) ); return; }
    const size = imageEditor.getCanvasSize();

    saving = true;
    setBusy( true );
    try
    {
        bytes = await NayivePhoto.keepExif( editorPath, bytes, size.width, size.height );
        const oldThumb = await NayivePhoto.thumbOf( dest );   // a file being rewritten
        await GumApi.writeFileBytes( dest, bytes );
        NayivePhoto.dropThumb( oldThumb );
        editorDirty = false;
        savedOnce   = true;

        // "Save a copy" → keep editing the copy from now on.
        editorPath = dest;
        showName( dest );

        await saveNote( dest );

        if( replaced ) NayiveUI.undoToast( T( 'drive.imageSaved' ), function() { undoSaveCopy( dest, replaced ); } );
        else           NayiveUI.toast( T( 'drive.imageSaved' ) );
    }
    catch( _ ) { NayiveUI.toast( T( 'drive.imageSaveFailed' ) ); }
    finally { saving = false; setBusy( false ); }
}

function save() { if( editorPath ) saveTo( editorPath ); }

//------------------------------------------------------------------------//
// SAVE A COPY - beside the picture, under a name the user picks.

function openSaveCopy()
{
    if( ! imageEditor || saving ) return;

    const cur  = nameOf( editorPath );
    const dot  = cur.lastIndexOf( '.' );
    const tag  = '-' + T( 'ui.editedSuffix' );
    const seed = dot > 0 ? cur.slice( 0, dot ) + tag + cur.slice( dot ) : cur + tag;

    const inp = $( 'saveCopyName' );
    inp.value = seed;
    NayiveUI.setOpen( 'saveCopyBackdrop', true );
    inp.focus();
    // preselect the base name, leaving the extension out of the selection
    try { inp.setSelectionRange( 0, dot > 0 ? seed.length - ( cur.length - dot ) : seed.length ); }
    catch( _ ) {}
}

// Is `name` already in the folder `dir`? A listing that fails answers no,
// as Drive's own check does.
async function nameTaken( dir, name )
{
    try { return ( ( await GumApi.listDir( dir ) ).nodes || [] ).some( function( n ) { return nameOf( n.path ) === name; } ); }
    catch( _ ) { return false; }
}

async function confirmSaveCopy()
{
    if( ! imageEditor || saving ) return;
    const name = $( 'saveCopyName' ).value.trim();
    if( ! name ) return;

    const dir  = dirOf( editorPath );
    const dest = dir ? dir + '/' + name : name;

    NayiveUI.setOpen( 'saveCopyBackdrop', false );

    // A PUT replaces the file outright, with no trip through the bin, so
    // the copy asks first what renaming and uploading in Drive ask.
    let replaced = null;      // what the Undo needs to put the replaced file back

    if( dest !== editorPath && await nameTaken( dir, name ) )
    {
        if( ! await NayiveUI.confirm( {
            title: T( 'drive.nameExistsTitle' ),
            body: TF( 'drive.nameExistsCopyBody', { name: name } ),
            confirm: T( 'drive.replace' ), danger: true } ) ) return;

        const note = await noteOf( dest );          // the copy's note will take its place
        let ids;
        try { ids = await GumApi.binPaths( [ dest ] ); }
        catch( _ ) { NayiveUI.toast( T( 'drive.moveExistingFailed' ) ); return; }
        await NayiveMedia.purgePaths( [ dest ] );   // its thumbnail + scan entry, as Drive's own delete does

        // An old server does not say the bin ids: no Undo then.
        if( ids ) replaced = { ids: ids, note: note, from: editorPath };
    }

    saveTo( dest, replaced );
}

// Undo of "Save a copy" over an existing name: the copy goes to the bin,
// THEN the file it replaced comes back to its name (the other order would
// land it as "name (2)"), with its note. An editor still on the copy goes
// back to the picture it was editing, unsaved - otherwise its ✓ would
// overwrite the file that just came back.
async function undoSaveCopy( dest, r )
{
    try { await GumApi.deletePaths( [ dest ] ); }
    catch( _ ) { NayiveUI.toast( T( 'drive.restoreFailed' ) ); return; }
    await NayiveMedia.purgePaths( [ dest ] );

    if( editorPath === dest )
    {
        editorPath  = r.from;
        editorDirty = true;
        showName( r.from );
    }

    let res = null;
    try { res = await GumApi.trashRestore( r.ids ); }
    catch( _ ) { NayiveUI.toast( T( 'drive.restoreFailed' ) ); return; }
    GumApi.announce( [ dest ], false );             // a restore says nothing by itself

    // Its note, unless it had to land under another name.
    const renamed = res && res.renamed && res.renamed.length ? res.renamed[ 0 ] : '';
    if( ! renamed && r.note !== null )
    {
        try
        {
            const map = await NayiveMedia.readComments();
            if( r.note ) map[ dest ] = r.note; else delete map[ dest ];
            await NayiveMedia.writeComments( map );
        }
        catch( _ ) { /* non-fatal: the file itself is back */ }
    }

    NayiveUI.toast( renamed ? TF( 'drive.restoredAs', { name: renamed } ) : T( 'drive.restored' ) );
}

//------------------------------------------------------------------------//
// LEAVE

// True when the page may go: nothing unsaved, or the user said to drop it.
// The desktop asks the same before it closes this window.
async function canLeave()
{
    if( closing ) return true;
    if( saving ) return false;
    if( ! isDirty() ) return true;
    return NayiveUI.confirm( {
        title: T( 'drive.unsavedTitle' ),
        body: T( 'drive.unsavedBody' ),
        confirm: T( 'drive.closeWithout' ), danger: true } );
}
window.nayiveBeforeClose = canLeave;

// ← / Escape. A desktop window: the desktop closes it (its window.close).
// A phone opened this page in place of Drive / Photos: back to them. A tab
// of its own: closed - or, if the browser will not, Drive.
async function leave()
{
    if( ! await canLeave() ) return;
    closing = true;
    if( ! NayiveUI.windowed && history.length > 1 ) { history.back(); return; }
    window.close();
    if( ! NayiveUI.windowed ) setTimeout( function() { location.href = '../drive/index.html'; }, 400 );
}

window.addEventListener( 'beforeunload', function( e )
{
    if( closing || ! isDirty() ) return;
    e.preventDefault();
    e.returnValue = '';
} );

//------------------------------------------------------------------------//
// WIRING

$( 'backBtn'         ).innerHTML = NayiveUI.icon( 'back'   );
$( 'editorSaveBtn'   ).innerHTML = NayiveUI.icon( 'check'  );
$( 'editorSaveAsBtn' ).innerHTML = NayiveUI.icon( 'saveas' );

$( 'editorSaveBtn'   ).addEventListener( 'click', save );
$( 'editorSaveAsBtn' ).addEventListener( 'click', openSaveCopy );
$( 'backBtn'         ).addEventListener( 'click', leave );

$( 'saveCopyCancelBtn'  ).addEventListener( 'click', function() { NayiveUI.setOpen( 'saveCopyBackdrop', false ); } );
$( 'saveCopyConfirmBtn' ).addEventListener( 'click', confirmSaveCopy );
$( 'saveCopyName'       ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) { e.preventDefault(); confirmSaveCopy(); } } );

document.addEventListener( 'keydown', function( e )
{
    if( $( 'saveCopyBackdrop' ).classList.contains( 'open' ) )
    {
        if( e.key === 'Escape' ) NayiveUI.setOpen( 'saveCopyBackdrop', false );
        return;
    }
    if( document.querySelector( '.sheet-backdrop.open' ) ) return;     // a question is up: its keys
    if( e.key === 'Escape' ) { leave(); return; }
    if( ( e.ctrlKey || e.metaKey ) && e.key === 'Enter' ) { e.preventDefault(); save(); }
} );

start();
