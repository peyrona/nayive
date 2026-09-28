/* file-picker.js - pick a file or folder from the user's files/ tree. */

//------------------------------------------------------------------------//
// FILE PICKER - browse the user's own files/ tree to link an existing file
// (passport, etc.). Uploads go through docAttachUpload instead.
// (Folder picking is NOT here - the trip photos folder uses the shared
//  NayiveUI.pickFolder sheet, same as Photos / Music / Movies.)

let filePickerOnPick   = null;
let filePickerFilesNode = null;   // null = loading, undefined = load failed, else the 'files' tree node
let filePickerExpanded = null;

async function openFilePicker( onPick )
{
    filePickerOnPick      = onPick;
    filePickerFilesNode   = null;
    filePickerExpanded    = new Set();

    renderFilePickerSheet();
    openSheet( 'filePickerSheetBackdrop' );

    try
    {
        // The files/ subtree only (same node shape the old full tree gave).
        filePickerFilesNode = await GumApi.listDirRecursive( 'files' );
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
        p.className = 'calc-rate';
        p.textContent = T( 'trips.loadingFiles' );
        sheet.appendChild( p );
        return;
    }

    if( filePickerFilesNode === undefined )
    {
        const p = document.createElement( 'p' );
        p.className = 'calc-warn';
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

    const toggle = function()
    {
        if( filePickerExpanded.has( node.path ) ) filePickerExpanded.delete( node.path );
        else filePickerExpanded.add( node.path );
        renderFilePickerSheet();
    };

    host.appendChild( row );

    if( isDir )
    {
        row.addEventListener( 'click', toggle );

        if( filePickerExpanded.has( node.path ) )
            sortTreeNodes( node.nodes || [] ).forEach( function( c ) { appendFileNode( host, c, depth + 1 ); } );
    }
    else
    {
        row.addEventListener( 'click', pick );
    }
}
