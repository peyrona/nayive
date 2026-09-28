/*
 * labels.js - Nayive's own labels, and the settings dialog.
 *
 * Labels belong to Nayive, not to the mail server (server/go/mail_labels.go):
 * the same for every provider, several per message, and a tap on one in the
 * side panel lists what carries it, from every account.
 *
 * THE PICKER (the tag button): every label, ticked when all the targets have
 * it, a dash when some do. A tap puts it on all of them, or - when all had
 * it - takes it off all of them. At once, no "Save". A new label can be made
 * there and goes on them straight away.
 *
 * ONE LABEL (the side panel's + makes one, a label's pencil edits it): its
 * name and one of eight colours; the bin deletes it, and off every message
 * (with Undo: out of sight at once, deleted when the Undo is gone).
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S, h = E.h;

    E.loadLabels = async function ()
    {
        var r = await E.api( "GET", "labels" );
        S.labels = ( r.labels || [] ).filter( function ( l ) { return ! S.goneLabels.has( l.id ); } );
        S.colors = r.colors || S.colors;
    };

    E.loadSettings = async function ()
    {
        try { S.settings = Object.assign( { trashDays: 30, showImages: false, signature: "" }, await E.api( "GET", "settings" ) ); } catch( e ) {}
    };

    function labelError( err )
    {
        if( err && err.status === 409 ) return E.T( "mail.labelDup" );
        return E.errText( err );
    }

    async function createLabel( input )
    {
        var name = input.value.trim();
        if( ! name ) { input.focus(); return null; }
        try
        {
            var l = await E.api( "POST", "labels", { name: name } );
            input.value = "";
            S.labels.push( l );
            E.renderSide();
            return l;
        }
        catch( err ) { NayiveUI.toast( labelError( err ), { ms: 3000 } ); return null; }
    }

    // ---------------------------------------------------------------------
    // the picker
    // ---------------------------------------------------------------------

    var picking = [];

    E.openLabelPicker = function ( list )
    {
        picking = list.slice();
        if( ! picking.length ) return;
        renderPicker();
        E.$( "labelNew" ).value = "";
        NayiveUI.open( "labelSheet" );
    };

    function renderPicker()
    {
        var box = E.$( "labelPick" );
        box.textContent = "";
        E.$( "labelPickEmpty" ).hidden = S.labels.length > 0;
        S.labels.forEach( function ( l )
        {
            var have = picking.filter( function ( m ) { return ( m.labels || [] ).indexOf( l.id ) >= 0; } ).length;
            var state = have === 0 ? "" : have === picking.length ? "all" : "some";
            var dot = h( "i", { class: "mail-dot" } );
            dot.style.setProperty( "--c", l.color );
            var mark = h( "span", { class: "mail-pick-mark", html: state === "all" ? NayiveUI.icon( "check" ) : state === "some" ? "&minus;" : "" } );
            box.appendChild( h( "button", { class: "card-row mail-pick" + ( state ? " is-on" : "" ), attrs: { type: "button", "aria-pressed": state === "all" ? "true" : "false" },
                                            on: { click: function () { toggle( l, state !== "all" ); } } },
                                dot, h( "span", { class: "mail-pick-name", text: l.name } ), mark ) );
        } );
    }

    // Each row takes the labels the SERVER says it has now: a row of a
    // label's list whose message moved since is changed by its tag (the
    // Message-ID goes beside the ref), and one it could not find stays as it is.
    async function toggle( l, on )
    {
        var groups = {};
        picking.forEach( function ( m ) { ( groups[ E.acctOf( m ) ] = groups[ E.acctOf( m ) ] || [] ).push( m ); } );
        E.plug( "saving" );
        var changed = [];
        try
        {
            for( var acct in groups )
            {
                var rows = groups[ acct ];
                var body = { refs: rows.map( function ( m ) { return m.ref; } ), mids: rows.map( function ( m ) { return m.mid || ""; } ) };
                body[ on ? "add" : "remove" ] = [ l.id ];
                var r = await E.api( "POST", encodeURIComponent( acct ) + "/labels", body );
                var byRef = {}, known = ( r && r.known ) || {};
                ( ( r && r.items ) || [] ).forEach( function ( it ) { byRef[ it.ref ] = it.labels || []; } );
                rows.forEach( function ( m )
                {
                    var now = byRef[ m.ref ] || ( m.mid && known[ m.mid ] );
                    if( ! now ) return;
                    m.labels = now.slice();
                    changed.push( m );
                } );
            }
            E.plug( "synced" );
        }
        catch( err ) { E.plug( "offline" ); NayiveUI.toast( E.errText( err ) ); }
        if( changed.length ) { renderPicker(); E.labelsChanged( changed ); }
    }

    async function newFromPicker()
    {
        var l = await createLabel( E.$( "labelNew" ) );
        if( l ) await toggle( l, true );
    }

    // ---------------------------------------------------------------------
    // one label: new (the side panel's +) or edit (its pencil)
    // ---------------------------------------------------------------------

    var editing = null, colour = "";

    E.openLabelDialog = function ( l )
    {
        editing = l || null;
        colour = l ? l.color : ( S.colors[ S.labels.length % ( S.colors.length || 1 ) ] || "" );
        E.$( "labelDlgTitle" ).textContent = E.T( l ? "mail.editLabel" : "mail.newLabel" );
        E.$( "labelName" ).value = l ? l.name : "";
        E.$( "labelDelBtn" ).hidden = ! l;
        E.$( "labelDlgError" ).hidden = true;
        renderSwatches();
        NayiveUI.open( "labelDlg" );
        setTimeout( function () { E.$( "labelName" ).focus(); }, 50 );
    };

    function renderSwatches()
    {
        var box = E.$( "labelColors" );
        box.textContent = "";
        S.colors.forEach( function ( c )
        {
            var on = c === colour;
            var b = h( "button", { class: "mail-swatch" + ( on ? " is-on" : "" ),
                                   attrs: { type: "button", role: "radio", "aria-checked": on ? "true" : "false", title: c },
                                   html: on ? NayiveUI.icon( "check" ) : "",
                                   on: { click: function () { colour = c; renderSwatches(); } } } );
            b.style.setProperty( "--c", c );
            if( light( c ) ) b.style.color = "#202124";      // a white tick on yellow would vanish
            box.appendChild( b );
        } );
    }

    function light( hex )
    {
        var n = parseInt( String( hex ).slice( 1 ), 16 );
        return ( 0.299 * ( n >> 16 & 255 ) + 0.587 * ( n >> 8 & 255 ) + 0.114 * ( n & 255 ) ) > 170;
    }

    async function saveLabel()
    {
        var name = E.$( "labelName" ).value.trim(), err = E.$( "labelDlgError" );
        if( ! name ) { err.textContent = E.T( "mail.labelNeedName" ); err.hidden = false; E.$( "labelName" ).focus(); return; }
        try
        {
            if( editing )
            {
                var got = await E.api( "PATCH", "labels/" + encodeURIComponent( editing.id ), { name: name, color: colour } );
                Object.assign( editing, got );
                S.items.forEach( function ( m ) { if( ( m.labels || [] ).indexOf( editing.id ) >= 0 ) E.redrawRow( m ); } );
                if( S.open ) E.renderReadLabels( S.open.labels );
            }
            else S.labels.push( await E.api( "POST", "labels", { name: name, color: colour } ) );
            NayiveUI.close( "labelDlg" );
            E.renderSide();
        }
        catch( e ) { err.textContent = labelError( e ); err.hidden = false; }
    }

    // The bin (the dialog is the question): out of sight at once, with Undo.
    // The server deletes it, and off every message, only when the Undo is
    // gone - a page closed meanwhile deletes it too. Hidden, its chips go
    // (E.chips skips a label it does not know) but the rows keep its id: the
    // Undo only puts it back in the list.
    function deleteLabel()
    {
        var l = editing;
        if( ! l ) return;
        var at = S.labels.findIndex( function ( x ) { return x.id === l.id; } );
        var wasOn = S.label === l.id;
        S.goneLabels.add( l.id );
        S.labels = S.labels.filter( function ( x ) { return x.id !== l.id; } );
        redrawWith( l.id );
        NayiveUI.close( "labelDlg" );
        if( wasOn ) E.openTray( "inbox" );
        else E.renderSide();

        function back()
        {
            S.goneLabels.delete( l.id );
            if( ! E.labelById( l.id ) ) S.labels.splice( at < 0 ? S.labels.length : Math.min( at, S.labels.length ), 0, l );
            redrawWith( l.id );
            E.renderSide();
        }
        // deleted: its id may be given to a new label - off the rows here too
        function done()
        {
            S.goneLabels.delete( l.id );
            var off = function ( m ) { if( m && ( m.labels || [] ).indexOf( l.id ) >= 0 ) m.labels = m.labels.filter( function ( id ) { return id !== l.id; } ); };
            S.items.forEach( off );
            off( S.open );
        }
        NayiveUI.undoToast( E.T( "ui.toast.deleted" ), function ()
        {
            var here = ! S.label && S.tray === "inbox" && ! S.open && ! S.selecting && ! E.isComposing();
            back();
            if( wasOn && here ) E.openLabel( l.id );      // still where it sent us: back to its list
        }, { onExpire: function ()
        {
            E.api( "DELETE", "labels/" + encodeURIComponent( l.id ) ).then( done, function ( err )
            {
                if( err.status === 404 ) { done(); return; }      // gone already (another device)
                back();
                NayiveUI.toast( E.errText( err ) );
            } );
        } } );
    }

    // The rows (and the message open) that carry a label, drawn again.
    function redrawWith( id )
    {
        S.items.forEach( function ( m ) { if( ( m.labels || [] ).indexOf( id ) >= 0 ) E.redrawRow( m ); } );
        if( S.open ) E.renderReadLabels( S.open.labels );
    }

    document.addEventListener( "DOMContentLoaded", function ()
    {
        E.$( "labelNewBtn" ).addEventListener( "click", newFromPicker );
        E.$( "labelNew" ).addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); newFromPicker(); } } );
        E.$( "labelAddBtn" ).addEventListener( "click", function () { E.openLabelDialog( null ); } );
        E.$( "labelSaveBtn" ).addEventListener( "click", saveLabel );
        E.$( "labelDelBtn" ).addEventListener( "click", deleteLabel );
        E.$( "labelName" ).addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); saveLabel(); } } );
        E.$( "labelName" ).addEventListener( "input", function () { E.$( "labelDlgError" ).hidden = true; } );
    } );
} )();
