/* fields.js - form field builders for the sheets. */

//------------------------------------------------------------------------//
// FORM FIELD BUILDERS

// The frame every field shares: <div class="field"><label>sLabel</label>control</div>.
function fieldShell( sLabel, elControl )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;
    field.appendChild( label );
    field.appendChild( elControl );
    return field;
}

// The <option>s of a <select>, sValue picked: aOptions is [ [ value, text ], ... ].
function fillOptions( select, aOptions, sValue )
{
    aOptions.forEach( function( opt )
    {
        const o = document.createElement( 'option' );
        o.value = opt[0];
        o.textContent = opt[1];
        if( opt[0] === sValue ) o.selected = true;
        select.appendChild( o );
    });
}

function textField( sLabel, sPlaceholder, sValue, fnOnChange )
{
    const input = document.createElement( 'input' );
    input.type = 'text';
    input.placeholder = sPlaceholder;
    input.value = sValue;
    input.addEventListener( 'input', function() { fnOnChange( input.value ); } );
    return fieldShell( sLabel, input );
}

function textAreaField( sLabel, sPlaceholder, sValue, fnOnChange, nRows )
{
    const ta = document.createElement( 'textarea' );
    ta.placeholder = sPlaceholder;
    ta.value = sValue;
    if( nRows ) ta.rows = nRows;
    ta.addEventListener( 'input', function() { fnOnChange( ta.value ); } );
    return fieldShell( sLabel, ta );
}

// "Ubicación": the text input carries an in-field "locate on the map" button on its
// right edge (hidden below the route-panel breakpoint, where no map is shown); after
// it, a round button that opens the Calendar app on this stage's start date.
function locationField( sLabel, sPlaceholder, sValue, fnOnChange )
{
    const row = document.createElement( 'div' );
    row.className = 'loc-row';

    const inputWrap = document.createElement( 'div' );
    inputWrap.className = 'loc-input-wrap';

    const input = document.createElement( 'input' );
    input.type = 'text';
    input.placeholder = sPlaceholder;
    input.value = sValue;
    input.addEventListener( 'input', function() { fnOnChange( input.value ); } );

    // No "see it on the map" button in here: it could only work by closing the
    // stage dialog to uncover the route panel, which threw away the draft with
    // no way back. The route map is the header's own map button instead.
    inputWrap.appendChild( input );

    const calBtn = document.createElement( 'button' );
    calBtn.type = 'button';
    calBtn.className = 'icon-btn';
    calBtn.title = T( 'trips.activities' );
    calBtn.appendChild( svgIcon( ICON_CALENDAR, 16 ) );
    calBtn.addEventListener( 'click', function()
    {
        const d = (stageDraft && stageDraft.startDate || '').trim();
        window.open( '../calendar/' + (d ? '?date=' + encodeURIComponent( d ) : ''), '_blank', 'noopener' );
    });

    row.appendChild( inputWrap );
    row.appendChild( calBtn );
    return fieldShell( sLabel, row );
}

// A date or time input under a span that shows the value, or sEmpty when blank.
function dtField( sType, sEmpty, sLabel, sValue, fnOnChange )
{
    const dt = document.createElement( 'div' );
    dt.className = 'dt-field';
    const input = document.createElement( 'input' );
    input.type = sType;
    input.value = sValue;
    const display = document.createElement( 'span' );
    display.className = 'dt-display' + (sValue ? '' : ' placeholder');
    display.textContent = sValue || sEmpty;
    input.addEventListener( 'input', function()
    {
        fnOnChange( input.value );
        display.textContent = input.value || sEmpty;
        display.classList.toggle( 'placeholder', ! input.value );
    });
    dt.appendChild( input );
    dt.appendChild( display );
    return fieldShell( sLabel, dt );
}

function dateField( sLabel, sValue, fnOnChange ) { return dtField( 'date', T( 'ui.dateHint' ), sLabel, sValue, fnOnChange ); }
function timeField( sLabel, sValue, fnOnChange ) { return dtField( 'time', 'hh:mm', sLabel, sValue, fnOnChange ); }

function selectField( sLabel, sValue, aOptions, fnOnChange )
{
    const select = document.createElement( 'select' );
    fillOptions( select, aOptions, sValue );
    select.addEventListener( 'change', function() { fnOnChange( select.value ); } );
    return fieldShell( sLabel, select );
}

// An on / off option: a <label class="sClass"> holding aBefore (the text, its
// (i)), then the shared .switch around the checkbox. The label is tied to the
// checkbox by sId, or a click anywhere in it goes to the (i), the first control.
function switchRow( sClass, sId, bChecked, aBefore )
{
    const row = document.createElement( 'label' );
    row.className = sClass;
    const input = document.createElement( 'input' );
    input.type    = 'checkbox';
    input.id      = sId;
    row.htmlFor   = sId;
    input.checked = bChecked;
    const sw = document.createElement( 'span' );
    sw.className = 'switch sm';
    const track = document.createElement( 'span' );
    track.className = 'track';
    sw.appendChild( input );
    sw.appendChild( track );
    aBefore.forEach( function( el ) { row.appendChild( el ); } );
    row.appendChild( sw );
    return { row: row, input: input };
}

// The "Documentos (3)" block of the trip and stage sheets: heading, then the rows.
// With at least one row, a chevron before the label folds the rows away so they
// don't bury the rest of the form.
//   aExtras        - controls after the label (the stage sheet's "(i)" and "+")
//   bCollapsed     - folded now?
//   fnSetCollapsed - keeps the state across the sheet's re-renders
function buildDocsField( aRows, aExtras, bCollapsed, fnSetCollapsed )
{
    const field = document.createElement( 'div' );
    field.className = 'field';

    const head = document.createElement( 'div' );
    head.className = 'doc-head';
    field.appendChild( head );

    let rowsHost = field;

    if( aRows.length >= 1 )
    {
        const toggle = document.createElement( 'button' );
        toggle.type = 'button';
        toggle.className = 'doc-collapse-toggle';
        toggle.title = T( 'trips.toggleDocs' );
        toggle.appendChild( svgIcon( ICON_CHEVRON_DOWN, 15, 'doc-collapse-chev' ) );
        head.appendChild( toggle );

        const body = document.createElement( 'div' );
        body.className = 'doc-collapse-body';
        field.appendChild( body );
        rowsHost = body;

        const apply = function()
        {
            body.hidden = bCollapsed;
            toggle.classList.toggle( 'collapsed', bCollapsed );
        };
        toggle.addEventListener( 'click', function() { bCollapsed = ! bCollapsed; fnSetCollapsed( bCollapsed ); apply(); } );
        apply();
    }

    const label = document.createElement( 'label' );
    label.textContent = T( 'trips.documents' );

    // "Documentos (3)" - how many rows there are right now, 0 included.
    const count = document.createElement( 'span' );
    count.className = 'doc-count';
    count.textContent = '(' + aRows.length + ')';
    label.appendChild( count );

    head.appendChild( label );
    aExtras.forEach( function( el ) { head.appendChild( el ); } );
    aRows.forEach( function( r ) { rowsHost.appendChild( r ); } );
    return field;
}

// One document editor row: [type ▼] [attachment] [x]. There is no free-text name
// any more - the document's name is just its file's name (set on attach). The
// attachment sits where the name field used to be: when set it's a pill showing the
// path (click it to open the file in a new tab); when unset it's the link / upload
// buttons. To point a document at a different file you remove it and add a new one.
//   fnFolder   - resolver for the trip's folder path (tripBase; a new trip's shifts while typing)
//   fnRerender - redraw the whole sheet after the attachment changes
//   fnSiblings - EVERY document of the trip, this list included (for unique upload
//                file names: all of them share one folder, D2)
function buildDocRow( d, fnSetType, fnRemove, fnFolder, fnRerender, fnSiblings )
{
    const wrap = document.createElement( 'div' );

    const row = document.createElement( 'div' );
    row.className = 'doc-row';

    const typeSelect = document.createElement( 'select' );
    fillOptions( typeSelect, [ ['passport',T( 'trips.docPassport' )], ['visa',T( 'trips.docVisa' )], ['ticket',T( 'trips.docTicket' )], ['hotel',T( 'trips.docHotel' )], ['other',T( 'trips.trOther' )] ], d.type );
    typeSelect.addEventListener( 'change', function() { fnSetType( typeSelect.value ); } );

    const attach = document.createElement( 'div' );
    attach.className = 'doc-attach';

    if( docIsLink( d ) )
    {
        attach.appendChild( docAttachSet( ICON_LINK, d.path, null, function() { docOpenInTab( d, fnFolder() ); } ) );
    }
    else if( d.file || d._pending )
    {
        attach.appendChild( docAttachSet( ICON_UPLOAD, d.file, d._pending ? T( 'trips.pending' ) : null, function() { docOpenInTab( d, fnFolder() ); } ) );
    }
    else
    {
        const linkBtn = document.createElement( 'button' );
        linkBtn.type = 'button';
        linkBtn.className = 'doc-attach-btn';
        linkBtn.appendChild( svgIcon( ICON_LINK, 13 ) );
        linkBtn.appendChild( document.createTextNode( T( 'trips.link' ) ) );
        linkBtn.disabled = ! navigator.onLine;
        linkBtn.title = navigator.onLine ? T( 'trips.linkExisting' ) : T( 'trips.needsNet' );
        linkBtn.addEventListener( 'click', function() { docAttachLink( d, fnRerender ); } );

        const upBtn = document.createElement( 'button' );
        upBtn.type = 'button';
        upBtn.className = 'doc-attach-btn';
        upBtn.appendChild( svgIcon( ICON_UPLOAD, 13 ) );
        upBtn.appendChild( document.createTextNode( NayiveUI.t( 'ui.upload' ) ) );
        upBtn.addEventListener( 'click', function() { docAttachUpload( d, fnSiblings, fnRerender ); } );

        attach.appendChild( linkBtn );
        attach.appendChild( upBtn );
    }

    // A trashcan, not an "x": this deletes the document row (and its upload),
    // it does not close or clear anything. Same icon every other delete uses.
    const removeBtn = iconBtn( 'icon-btn danger', T( 'trips.remove' ), ICON_TRASH, 15, fnRemove );

    row.appendChild( typeSelect );
    row.appendChild( attach );
    row.appendChild( removeBtn );
    wrap.appendChild( row );

    // "will be stored at" preview - only for an upload (a link needs no copy)
    if( ! docIsLink( d ) && (d.file || d._pending) )
    {
        const path = document.createElement( 'div' );
        path.className = 'doc-row-path';
        path.dataset.docId = d.id;
        path.textContent = docPath( fnFolder(), d );
        wrap.appendChild( path );
    }

    return wrap;
}

// The set-attachment pill. It's a button: clicking it opens the attached file in
// a new browser tab. To change the target, remove the document and add a new one.
function docAttachSet( sIconPaths, sLabel, sTag, fnPick )
{
    const box = document.createElement( 'button' );
    box.type = 'button';
    box.className = 'doc-attach-set';
    box.title = T( 'trips.openNewTab' );
    box.appendChild( svgIcon( sIconPaths, 13 ) );

    const name = document.createElement( 'span' );
    name.className = 'doc-attach-name';
    name.textContent = sLabel || '';
    box.appendChild( name );

    if( sTag )
    {
        const tag = document.createElement( 'span' );
        tag.className = 'doc-attach-pending';
        tag.textContent = sTag;
        box.appendChild( tag );
    }

    if( fnPick )
        box.addEventListener( 'click', fnPick );

    return box;
}

// Open an attached document in a new browser tab. A not-yet-saved upload only
// exists in memory, so it's served from a temporary blob URL.
function docOpenInTab( d, sFolder )
{
    const url = d._pending ? URL.createObjectURL( d._pending )
                           : GumApi.fileUrl( docPath( sFolder, d ) );

    if( url )
        window.open( url, '_blank', 'noopener' );
}

function docAttachUpload( d, fnSiblings, fnRerender )
{
    const input = document.getElementById( 'docUploadInput' );
    input.value = '';
    input.onchange = function()
    {
        const f = input.files && input.files[ 0 ];
        input.onchange = null;

        if( ! f )
            return;

        const siblings = ( fnSiblings ? fnSiblings() : [] ).filter( function( x ) { return x !== d; } );

        d.kind = 'upload';
        d._pending = f;
        d.file = uniqueFileName( f.name, siblings );
        delete d.path;

        // No manual name field any more - the document's name follows its file.
        d.name = f.name.replace( /\.[^.]+$/, '' );

        fnRerender();
    };
    input.click();
}

function docAttachLink( d, fnRerender )
{
    openFilePicker( function( sPath )
    {
        d.kind = 'link';
        d.path = sPath;
        delete d.file;
        delete d._pending;

        // No manual name field any more - the document's name follows its file.
        d.name = sPath.split( '/' ).pop().replace( /\.[^.]+$/, '' );

        fnRerender();
    });
}
