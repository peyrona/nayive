/* file-picker.js - pick a file or folder from the user's files/ tree. */

//------------------------------------------------------------------------//
// FILE PICKER - browse the user's own files/ tree to link an existing file
// (passport, etc.). Uploads go through docAttachUpload instead.
// (Folder picking is NOT here - the trip photos folder uses the shared
//  NayiveUI.pickFolder sheet, same as Photos / Music / Movies.)

let filePickerOnPick   = null;
let filePickerFilesNode = null;   // null = loading, undefined = load failed, else the 'files' tree node
let filePickerExpanded = null;
let filePickerLoaded   = null;   // folder paths whose own list is in (each opened folder is listed on its own, T17)

async function openFilePicker( onPick )
{
    filePickerOnPick      = onPick;
    filePickerFilesNode   = null;
    filePickerExpanded    = new Set();
    filePickerLoaded      = new Set();

    renderFilePickerSheet();
    openSheet( 'filePickerSheetBackdrop' );

    try
    {
        // files/ itself only - never its whole tree, every photo included
        // (T17): a folder is listed when it is opened (toggle below).
        filePickerFilesNode = await AyniNet.listDir( 'files' );
        filePickerLoaded.add( 'files' );
    }
    catch( err )
    {
        filePickerFilesNode = err && err.status === 404
                            ? { path: 'files', nodes: [] } : undefined;
    }

    renderFilePickerSheet();
}

function closeFilePicker() { closeSheet( 'filePickerSheetBackdrop' ); filePickerOnPick = null; }

function renderFilePickerSheet()
{
    const sheet = document.getElementById( 'filePickerSheet' );
    sheet.innerHTML = '';
    buildSheetHeader( T( 'trips.pickFile' ), 'filePickerSheetBackdrop', sheet );

    if( filePickerFilesNode === null )
    {
        const p = document.createElement( 'p' );
        p.className = 'dim-note';
        p.textContent = T( 'trips.loadingFiles' );
        sheet.appendChild( p );
        return;
    }

    if( filePickerFilesNode === undefined )
    {
        const p = document.createElement( 'p' );
        p.className = 'warn-box';
        p.textContent = T( 'trips.loadFilesFailed' );
        sheet.appendChild( p );
        return;
    }

    const box  = document.createElement( 'div' );
    box.className = 'filetree';
    const kids = filePickerFilesNode.nodes || [];

    if( ! kids.length )
    {
        const empty = document.createElement( 'div' );
        empty.className = 'ft-empty';
        empty.textContent = T( 'trips.noFilesInDrive' );
        box.appendChild( empty );
    }
    else
    {
        sortTreeNodes( kids ).forEach( function( n ) { appendFileNode( box, n, 0 ); } );
    }

    sheet.appendChild( box );
}

// Directories first, then files; each group alphabetical (case-insensitive).
function sortTreeNodes( nodes )
{
    return nodes.slice().sort( function( a, b )
    {
        const ad = Array.isArray( a.nodes ), bd = Array.isArray( b.nodes );
        if( ad !== bd ) return ad ? -1 : 1;
        return a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1;
    });
}

function appendFileNode( host, node, depth )
{
    const isDir = Array.isArray( node.nodes );

    const row = document.createElement( 'div' );
    row.className = 'ft-row' + (isDir ? '' : ' ft-file');
    row.style.paddingLeft = (8 + depth * 16) + 'px';

    const caret = document.createElement( 'span' );
    caret.className = 'ft-caret';
    caret.textContent = isDir ? (filePickerExpanded.has( node.path ) ? '▾' : '▸') : '';
    row.appendChild( caret );

    row.appendChild( svgIcon( isDir ? ICON_FOLDER : ICON_FILE, 15 ) );

    const label = document.createElement( 'span' );
    label.textContent = node.path.split( '/' ).pop();
    row.appendChild( label );

    const pick = function()
    {
        const cb = filePickerOnPick;
        closeFilePicker();
        if( cb ) cb( node.path );
    };

    const toggle = async function()
    {
        if( filePickerExpanded.has( node.path ) ) { filePickerExpanded.delete( node.path ); renderFilePickerSheet(); return; }
        filePickerExpanded.add( node.path );
        if( filePickerLoaded.has( node.path ) || node._loading ) { renderFilePickerSheet(); return; }

        const loaded = filePickerLoaded;
        node._loading = true;
        renderFilePickerSheet();
        try   { node.nodes = ( await AyniNet.listDir( node.path ) ).nodes || []; loaded.add( node.path ); node._failed = false; }
        catch ( err ) { node._failed = ! ( err && err.status === 404 ); node.nodes = []; if( ! node._failed ) loaded.add( node.path ); }
        node._loading = false;
        if( loaded === filePickerLoaded ) renderFilePickerSheet();   // still the same picker
    };

    host.appendChild( row );

    if( isDir )
    {
        row.addEventListener( 'click', toggle );

        if( filePickerExpanded.has( node.path ) )
        {
            if( node._loading || node._failed )
            {
                const note = document.createElement( 'div' );
                note.className = node._failed ? 'ft-empty warn' : 'ft-empty';
                note.style.paddingLeft = ( 8 + ( depth + 1 ) * 16 ) + 'px';
                note.textContent = T( node._failed ? 'trips.loadFilesFailed' : 'trips.loadingFiles' );
                host.appendChild( note );
            }
            else sortTreeNodes( node.nodes || [] ).forEach( function( c ) { appendFileNode( host, c, depth + 1 ); } );
        }
    }
    else
    {
        row.addEventListener( 'click', pick );
    }
}
