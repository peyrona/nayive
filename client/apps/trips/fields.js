/* fields.js - form field builders for the sheets. */

//------------------------------------------------------------------------//
// FORM FIELD BUILDERS

function textField( sLabel, sPlaceholder, sValue, fnOnChange )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;
    const input = document.createElement( 'input' );
    input.type = 'text';
    input.placeholder = sPlaceholder;
    input.value = sValue;
    input.addEventListener( 'input', function() { fnOnChange( input.value ); } );
    field.appendChild( label );
    field.appendChild( input );
    return field;
}

function textAreaField( sLabel, sPlaceholder, sValue, fnOnChange, nRows )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;
    const ta = document.createElement( 'textarea' );
    ta.placeholder = sPlaceholder;
    ta.value = sValue;
    if( nRows ) ta.rows = nRows;
    ta.addEventListener( 'input', function() { fnOnChange( ta.value ); } );
    field.appendChild( label );
    field.appendChild( ta );
    return field;
}

// "Ubicación": the text input carries an in-field "locate on the map" button on its
// right edge (hidden below the route-panel breakpoint, where no map is shown); after
// it, a round button that opens the Calendar app on this stage's start date.
function locationField( sLabel, sPlaceholder, sValue, fnOnChange )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;

    const row = document.createElement( 'div' );
    row.className = 'loc-row';

    const inputWrap = document.createElement( 'div' );
    inputWrap.className = 'loc-input-wrap';

    const input = document.createElement( 'input' );
    input.type = 'text';
    input.placeholder = sPlaceholder;
    input.value = sValue;
    input.addEventListener( 'input', function() { fnOnChange( input.value ); } );

    const mapBtn = document.createElement( 'button' );
    mapBtn.type = 'button';
    mapBtn.className = 'icon-btn sm loc-map-btn';
    mapBtn.title = T( 'trips.seeOnMap' );
    mapBtn.appendChild( svgIcon( ICON_MAP, 15 ) );
    mapBtn.addEventListener( 'click', function()
    {
        if( ! wideMql.matches )
            return;   // no route map at this size (button is CSS-hidden too)

        const lat   = stageDraft && stageDraft.lat;
        const lon   = stageDraft && stageDraft.lon;
        const label = (stageDraft && stageDraft.location || '').trim() || T( 'trips.stage' );

        if( typeof lat !== 'number' || typeof lon !== 'number' )
        {
            NayiveUI.toast( T( 'trips.notLocated' ) );
            return;
        }

        // Close the dialog so the map is fully visible, then fly to the city.
        closeStageSheet();
        highlightStageOnMap( lat, lon, label );
    });

    inputWrap.appendChild( input );
    inputWrap.appendChild( mapBtn );

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
    field.appendChild( label );
    field.appendChild( row );
    return field;
}

function dateField( sLabel, sValue, fnOnChange )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;
    const dt = document.createElement( 'div' );
    dt.className = 'dt-field';
    const input = document.createElement( 'input' );
    input.type = 'date';
    input.value = sValue;
    const display = document.createElement( 'span' );
    display.className = 'dt-display' + (sValue ? '' : ' placeholder');
    display.textContent = sValue || T( 'ui.dateHint' );
    input.addEventListener( 'input', function()
    {
        fnOnChange( input.value );
        display.textContent = input.value || T( 'ui.dateHint' );
        display.classList.toggle( 'placeholder', ! input.value );
    });
    dt.appendChild( input );
    dt.appendChild( display );
    field.appendChild( label );
    field.appendChild( dt );
    return field;
}

function timeField( sLabel, sValue, fnOnChange )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;
    const dt = document.createElement( 'div' );
    dt.className = 'dt-field';
    const input = document.createElement( 'input' );
    input.type = 'time';
    input.value = sValue;
    const display = document.createElement( 'span' );
    display.className = 'dt-display' + (sValue ? '' : ' placeholder');
    display.textContent = sValue || 'hh:mm';
    input.addEventListener( 'input', function()
    {
        fnOnChange( input.value );
        display.textContent = input.value || 'hh:mm';
        display.classList.toggle( 'placeholder', ! input.value );
    });
    dt.appendChild( input );
    dt.appendChild( display );
    field.appendChild( label );
    field.appendChild( dt );
    return field;
}

function selectField( sLabel, sValue, aOptions, fnOnChange )
{
    const field = document.createElement( 'div' );
    field.className = 'field';
    const label = document.createElement( 'label' );
    label.textContent = sLabel;
    const select = document.createElement( 'select' );
    aOptions.forEach( function( opt )
    {
        const o = document.createElement( 'option' );
        o.value = opt[0];
        o.textContent = opt[1];
        if( opt[0] === sValue ) o.selected = true;
        select.appendChild( o );
    });
    select.addEventListener( 'change', function() { fnOnChange( select.value ); } );
    field.appendChild( label );
    field.appendChild( select );
    return field;
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
//   fnDirName  - resolver for the trip folder name (a new trip's shifts while typing)
//   fnRerender - redraw the whole sheet after the attachment changes
//   fnSiblings - the sibling document list (for unique upload file names)
function buildDocRow( d, fnSetType, fnRemove, fnDirName, fnRerender, fnSiblings )
{
    const wrap = document.createElement( 'div' );

    const row = document.createElement( 'div' );
    row.className = 'doc-row';

    const typeSelect = document.createElement( 'select' );
    [ ['passport',T( 'trips.docPassport' )], ['visa',T( 'trips.docVisa' )], ['ticket',T( 'trips.docTicket' )], ['hotel',T( 'trips.docHotel' )], ['other',T( 'trips.trOther' )] ].forEach( function( opt )
    {
        const o = document.createElement( 'option' );
        o.value = opt[0];
        o.textContent = opt[1];
        if( opt[0] === d.type ) o.selected = true;
        typeSelect.appendChild( o );
    });
    typeSelect.addEventListener( 'change', function() { fnSetType( typeSelect.value ); } );

    const attach = document.createElement( 'div' );
    attach.className = 'doc-attach';

    if( docIsLink( d ) )
    {
        attach.appendChild( docAttachSet( ICON_LINK, d.path, null, function() { docOpenInTab( d, fnDirName() ); } ) );
    }
    else if( d.file || d._pending )
    {
        attach.appendChild( docAttachSet( ICON_UPLOAD, d.file, d._pending ? T( 'trips.pending' ) : null, function() { docOpenInTab( d, fnDirName() ); } ) );
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
    const removeBtn = document.createElement( 'button' );
    removeBtn.className = 'icon-btn danger';
    removeBtn.title = T( 'trips.remove' );
    removeBtn.appendChild( svgIcon( ICON_TRASH, 15 ) );
    removeBtn.addEventListener( 'click', fnRemove );

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
        path.textContent = docPath( 'data/trips/' + fnDirName(), d );
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
function docOpenInTab( d, sDirName )
{
    const url = d._pending ? URL.createObjectURL( d._pending )
                           : GumApi.fileUrl( docPath( 'data/trips/' + sDirName, d ) );

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
