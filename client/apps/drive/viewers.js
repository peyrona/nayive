/*
 * viewers.js - Drive: the image viewer, the image editor and the audio / video player.
 */
"use strict";

//------------------------------------------------------------------------//
// BUILT-IN IMAGE VIEWER (lightbox; view only, never handed to an editor)

function openImageViewer( path )
{
    const name = path.split( '/' ).pop();
    const img  = document.getElementById( 'viewerImg' );

    img.src = GumApi.fileUrl( path );
    img.alt = name;
    document.getElementById( 'viewerName' ).textContent = name;

    setBackdrop( 'viewerBackdrop', true );
}

function closeImageViewer()
{
    setBackdrop( 'viewerBackdrop', false );
    document.getElementById( 'viewerImg' ).removeAttribute( 'src' );   // free the decoded bitmap
}

//------------------------------------------------------------------------//
// BUILT-IN IMAGE EDITOR (TOAST UI Image Editor — png / jpg / webp only)

// The library (~0.7 MB) is heavy and rarely needed, so it is not in the page
// head: this loads its two bundles once, on the first edit, and caches the
// promise. Order matters — tui.colorPicker must exist before the editor bundle.
let editorLibPromise = null;

function loadImageEditorLib()
{
    if( editorLibPromise ) return editorLibPromise;

    function addCss( href )
    {
        const l = document.createElement( 'link' );
        l.rel = 'stylesheet'; l.href = href;
        document.head.appendChild( l );
    }

    function addScript( src )
    {
        return new Promise( function( resolve, reject )
        {
            const s = document.createElement( 'script' );
            s.src = src;
            s.onload = resolve;
            s.onerror = function() { reject( new Error( 'failed to load ' + src ) ); };
            document.head.appendChild( s );
        });
    }

    addCss( 'lib/tui-color-picker_v2.2.8.min.css' );
    addCss( 'lib/tui-image-editor_v3.15.3.min.css' );

    editorLibPromise = addScript( 'lib/tui-color-picker_v2.2.8.min.js' )
        .then( function() { return addScript( 'lib/tui-image-editor_v3.15.3.min.js' ); } )
        .catch( function( err ) { editorLibPromise = null; throw err; } );

    return editorLibPromise;
}

let imageEditor  = null;    // the live tui.ImageEditor instance, or null
let editorSeq    = 0;       // bumped on every open AND every close, so a
                            // slow first library load knows it is stale
let editorPath   = null;    // Drive path of the image being edited
let editorDirty  = false;   // an edit is on the undo stack and not yet saved
let commentBase  = '';      // the photo comment as last loaded / saved

// Per-photo comments live in one hidden sidecar map keyed by the image's
// files/ path, the same file the Photos app reads and writes. The map is
// NOT stored inside the image (a canvas export drops all metadata), so it
// has to follow a rename / move / copy - which is why both the map and
// that upkeep belong to shared/media.js, not here.
function commentValue() { return document.getElementById( 'editorComment' ).value.trim(); }
function isEditorDirty() { return editorDirty || commentValue() !== commentBase; }

async function loadPhotoComment( path )
{
    const box = document.getElementById( 'editorComment' );
    box.value  = '';
    commentBase = '';
    let map;
    try { map = await NayiveMedia.readComments(); } catch( _ ) { return; }
    box.value  = map[ path ] || '';
    commentBase = box.value.trim();
}

async function savePhotoComment( path )
{
    let map;
    try { map = await NayiveMedia.readComments(); } catch( _ ) { return; }
    const text = commentValue();
    if( text ) map[ path ] = text; else delete map[ path ];
    try { await NayiveMedia.writeComments( map ); commentBase = text; }
    catch( _ ) { /* non-fatal: the image itself was saved */ }
}

async function openImageEditor( path )
{
    // The library is fetched on the FIRST edit and takes a moment, and
    // the overlay is already up while it loads — so the user can close
    // it, or pick another image, before we get to build anything. This
    // counter says whether the open we started is still the one wanted:
    // without it a closed editor would come to life behind the page,
    // invisible and undismissable.
    const seq  = ++editorSeq;
    const name = path.split( '/' ).pop();

    document.getElementById( 'editorName' ).textContent = name;
    document.getElementById( 'editorSaveBtn'   ).innerHTML = NayiveUI.icon( 'check'  );
    document.getElementById( 'editorSaveAsBtn' ).innerHTML = NayiveUI.icon( 'saveas' );
    setBackdrop( 'editorBackdrop', true );
    setStatus( T( 'drive.loadingEditor' ) );

    try { await loadImageEditorLib(); }
    catch( _ )
    {
        if( seq !== editorSeq ) return;
        setStatus( '' );
        setBackdrop( 'editorBackdrop', false );
        NayiveUI.toast( T( 'drive.editorFailed' ) );
        return;
    }
    if( seq !== editorSeq ) return;          // closed / superseded while it loaded
    setStatus( '' );

    editorPath  = path;
    editorDirty = false;
    loadPhotoComment( path );

    const host = document.getElementById( 'tuiEditor' );
    if( imageEditor ) { try { imageEditor.destroy(); } catch( _ ) {} imageEditor = null; }
    host.innerHTML = '';

    // The library puts the picture between its own two 64px rows (tools
    // below, zoom / undo above), so it gets the host minus both. Asking for
    // the whole window left a portrait photo running off the bottom.
    const box = host.getBoundingClientRect();

    imageEditor = new tui.ImageEditor( host, {
        includeUI: {
            loadImage: { path: GumApi.fileUrl( path ), name: name },
            menu: [ 'crop', 'flip', 'rotate', 'draw', 'shape', 'icon', 'text', 'mask', 'filter' ],
            initMenu: '',
            menuBarPosition: 'bottom',
            uiSize: { width: '100%', height: '100%' },
            locale: NayivePhoto.editorLocale()      // its words in the user's language
        },
        cssMaxWidth:  Math.max( 160, box.width - 16 ),
        cssMaxHeight: Math.max( 160, box.height - 136 ),
        selectionStyle: { cornerSize: 18, rotatingPointOffset: 60 },
        usageStatistics: false   // the library pings Google Analytics unless this is off
    });
    NayivePhoto.localizeEditor( host );

    imageEditor.on( 'undoStackChanged', function( len ) { editorDirty = len > 0; } );
}

// png stays png; jpg/jpeg → jpeg; webp → webp. Anything else defaults to png.
function editorFormatFor( name )
{
    const e = extOf( name );
    if( e === 'jpg' || e === 'jpeg' ) return 'jpeg';
    if( e === 'webp' )                return 'webp';
    return 'png';
}

function dataUrlToBytes( dataUrl )
{
    // "data:," is a canvas with no picture - what a device hands back for a
    // canvas bigger than it allows (an iPhone stops near 16.7 MP). Saving it
    // would leave an empty file where the photo was.
    if( ! /^data:image\//.test( dataUrl ) ) throw new Error( 'empty render' );
    const bin = atob( dataUrl.slice( dataUrl.indexOf( ',' ) + 1 ) );
    const out = new Uint8Array( bin.length );
    for( let i = 0; i < bin.length; i++ ) out[i] = bin.charCodeAt( i );
    return out;
}

// `replaced`: set when "Save a copy" sent a file of the same name to the
// bin first (confirmSaveCopy) - the "Saved" toast then carries its Undo.
async function saveEditorTo( destPath, replaced )
{
    if( ! imageEditor ) return;

    // Only the note changed: the picture on disk is already right, and
    // encoding it again would only lose quality.
    if( ! editorDirty && destPath === editorPath )
    {
        await savePhotoComment( destPath );
        NayiveUI.toast( T( 'drive.imageSaved' ) );
        return;
    }

    const fmt  = editorFormatFor( destPath );
    const opts = { format: fmt };
    if( fmt !== 'png' ) opts.quality = 0.92;

    let bytes;
    try { bytes = dataUrlToBytes( imageEditor.toDataURL( opts ) ); }
    catch( _ ) { NayiveUI.toast( T( 'drive.renderFailed' ) ); return; }
    const size = imageEditor.getCanvasSize();

    setStatus( T( 'ui.sync.saving' ) );
    try
    {
        bytes = await NayivePhoto.keepExif( editorPath, bytes, size.width, size.height );
        const oldThumb = await NayivePhoto.thumbOf( destPath );   // a file being rewritten
        await withBusy( GumApi.writeFileBytes( destPath, bytes ) );
        NayivePhoto.dropThumb( oldThumb );
        editorDirty = false;

        // "Guardar copia" → keep editing the copy from now on.
        editorPath = destPath;
        document.getElementById( 'editorName' ).textContent = destPath.split( '/' ).pop();

        await savePhotoComment( destPath );

        if( replaced ) NayiveUI.undoToast( T( 'drive.imageSaved' ), function() { undoSaveCopy( destPath, replaced ); } );
        else           NayiveUI.toast( T( 'drive.imageSaved' ) );
    }
    catch( _ ) { NayiveUI.toast( T( 'drive.imageSaveFailed' ) ); }

    setStatus( '' );
    await reload();
}

function saveEditor()
{
    if( editorPath ) saveEditorTo( editorPath );
}

function saveEditorAs()
{
    if( ! editorPath ) return;

    const cur = editorPath.split( '/' ).pop();
    const dot = cur.lastIndexOf( '.' );
    const tag = '-' + T( 'ui.editedSuffix' );
    const seed = dot > 0 ? cur.slice( 0, dot ) + tag + cur.slice( dot ) : cur + tag;

    const inp = document.getElementById( 'saveCopyName' );
    inp.value = seed;
    setBackdrop( 'saveCopyBackdrop', true );
    inp.focus();
    // preselect the base name, leaving the extension out of the selection
    try { inp.setSelectionRange( 0, dot > 0 ? seed.length - ( cur.length - dot ) : seed.length ); }
    catch( _ ) {}
}

async function confirmSaveCopy()
{
    if( ! editorPath ) return;
    const name = document.getElementById( 'saveCopyName' ).value.trim();
    if( ! name ) return;

    const cut  = editorPath.lastIndexOf( '/' );
    const dir  = cut < 0 ? '' : editorPath.slice( 0, cut );   // '' at the root
    const dest = joinPath( dir, name );

    setBackdrop( 'saveCopyBackdrop', false );

    // A PUT replaces the file outright, with no trip through the
    // papelera, so the copy has to ask what renaming and uploading both
    // ask. The folder is re-listed rather than read off the screen: the
    // image may have been opened from a search hit, whose folder is not
    // the one on display.
    let replaced = null;      // what the Undo needs to put the replaced file back

    if( dest !== editorPath && ( await destNameSet( dir ) ).has( name ) )
    {
        if( ! await NayiveUI.confirm( {
            title: T( 'drive.nameExistsTitle' ),
            body: TF( 'drive.nameExistsCopyBody', { name: name } ),
            confirm: T( 'drive.replace' ), danger: true } ) ) return;

        const note = await noteOf( dest );          // the copy's note will take its place
        let ids;
        try { ids = await withBusy( GumApi.binPaths( [ dest ] ) ); }
        catch( _ ) { NayiveUI.toast( T( 'drive.moveExistingFailed' ) ); return; }
        await NayiveMedia.purgePaths( [ dest ] );   // its thumbnail + scan entry, as Drive's own delete does

        // An old server does not say the bin ids: no Undo then.
        if( ids ) replaced = { ids: ids, note: note, from: editorPath, seq: editorSeq };
    }

    saveEditorTo( dest, replaced );
}

// The photo note `path` has now: '' for none, null when the notes could not
// be read (the Undo then leaves them alone).
async function noteOf( path )
{
    try { return ( await NayiveMedia.readComments() )[ path ] || ''; }
    catch( _ ) { return null; }
}

// Undo of "Save a copy" over an existing name: the copy goes to the bin the
// way Drive's own delete sends it, THEN the file it replaced comes back to
// its name (the other order would land it as "name (2)"), with its note.
// An editor still open on the copy goes back to the image it was editing,
// unsaved - otherwise its ✓ would overwrite the file that just came back.
async function undoSaveCopy( dest, r )
{
    setStatus( T( 'drive.restoring' ) );

    try { await withBusy( GumApi.deletePaths( [ dest ] ) ); }
    catch( _ ) { setStatus( '' ); NayiveUI.toast( T( 'drive.restoreFailed' ) ); return; }
    await NayiveMedia.purgePaths( [ dest ] );

    if( editorPath === dest )
    {
        if( editorSeq === r.seq )
        {
            editorPath  = r.from;
            editorDirty = true;
            document.getElementById( 'editorName' ).textContent = r.from.split( '/' ).pop();
        }
        else closeImageEditor( true );      // re-opened on the copy: that file is in the bin now
    }

    let res = null;
    try { res = await withBusy( GumApi.trashRestore( r.ids ) ); }
    catch( _ ) { NayiveUI.toast( T( 'drive.restoreFailed' ) ); }

    // Its note, unless it had to land under another name.
    if( res && ! ( res.renamed && res.renamed.length ) && r.note !== null )
    {
        try
        {
            const map = await NayiveMedia.readComments();
            if( r.note ) map[ dest ] = r.note; else delete map[ dest ];
            await NayiveMedia.writeComments( map );
        }
        catch( _ ) { /* non-fatal: the file itself is back */ }
    }

    await refreshView();
    if( res ) restoredStatus( res );
    else      setStatus( '' );
}

async function closeImageEditor( force )
{
    if( ! force && isEditorDirty() &&
        ! await NayiveUI.confirm( {
            title: T( 'drive.unsavedTitle' ),
            body: T( 'drive.unsavedBody' ),
            confirm: T( 'drive.closeWithout' ), danger: true } ) )
        return;

    editorSeq++;                 // an open still loading its library is now stale

    if( imageEditor )
    {
        try { imageEditor.destroy(); } catch( _ ) {}
        imageEditor = null;
    }
    document.getElementById( 'tuiEditor' ).innerHTML = '';
    document.getElementById( 'editorComment' ).value = '';
    editorPath   = null;
    editorDirty  = false;
    commentBase  = '';
    setBackdrop( 'editorBackdrop', false );
}

//------------------------------------------------------------------------//
// BUILT-IN AUDIO / VIDEO PLAYER (view only, never handed to an editor)

function openMediaViewer( path, kind )
{
    const name  = path.split( '/' ).pop();
    const url   = GumApi.fileUrl( path );
    const video = document.getElementById( 'mediaVideo' );
    const audio = document.getElementById( 'mediaAudio' );

    video.hidden = (kind !== 'video');
    document.getElementById( 'mediaAudioBox' ).hidden = (kind !== 'audio');

    const el = (kind === 'video') ? video : audio;
    el.src = url;
    el.load();

    document.getElementById( 'mediaName' ).textContent = name;
    setBackdrop( 'mediaBackdrop', true );
    el.play().catch( function() {} );   // autoplay may be blocked — controls still work
}

function closeMediaViewer()
{
    const video = document.getElementById( 'mediaVideo' );
    const audio = document.getElementById( 'mediaAudio' );

    video.pause(); audio.pause();
    video.removeAttribute( 'src' ); audio.removeAttribute( 'src' );
    video.load(); audio.load();   // drop the buffered stream

    setBackdrop( 'mediaBackdrop', false );
}
