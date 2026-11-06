/* Ayni library 0.2.0, share: the dialog to share something with people, and a link anyone can open. Plain JavaScript, no build step,
   evergreen browsers 2024+. Optional, with ayni-share.css; it needs ayni-dialogs.js and ayni-lists.js when it opens.
     Ayni.share({ path, app, title, canAdd, link, lead, peopleHead, api, users })
   The app gives the data: users() resolves to the names; api(method, body, id) makes the calls: 'GET' resolves to { mine: [grants] },
   'POST' gets { to, root, app, title, mode } ('*' is everybody) or { link: true, root, title } and resolves to the grant, 'DELETE'
   gets the id. A grant is { id, to, root, app, title, mode, token, url }. link: true shows the link section; it is made as the dialog
   opens. Resolves when the dialog closes. Ayni.share.rowButton(name, title, action): the round button of its rows. */
( function ()
{
    "use strict";

    var t = Ayni.t, tf = Ayni.tf;

    // The full URL of a server path the API answered with ("/s/<token>", "/api/location/<key>").
    function linkUrl( g ) { return window.location.origin + g.url; }

    // A round icon button (.share-drop) that disables itself while its action runs.
    function rowButton( name, title, action )
    {
        var b = document.createElement( "button" );
        b.type      = "button";
        b.className = "share-drop";
        Ayni.setTip( b, title );
        b.setAttribute( "aria-label", title );
        b.innerHTML = Ayni.icon( name );
        b.addEventListener( "click", function ()
        {
            Ayni.setBusy( b, t( "ayni.wait" ) );
            Promise.resolve().then( action )
                .catch( function ( e ) { Ayni.toast( "err", e.message ); } )
                .then( function () { Ayni.setBusy( b, false ); } );
        } );
        return b;
    }

    // The public links whose × is still on Undo: a sheet opened again meanwhile
    // must not show (or hand out) a link about to die.
    var linksGoing = {};

    /* The "Share" dialog: tick one or more people, see who already has it, take it back.
     * opts = { path, app, title }. Resolves when the dialog closes. */
    Ayni.share = function ( opts )
    {
        opts = opts || {};
        var path = opts.path || "";

        return new Promise( function ( resolve )
        {
            // Escape presses its × (Ayni); a question asked from inside it
            // (Ayni.confirm) is the innermost dialog and takes its own Escape.
            var d = Ayni.dialog( { title: tf( "ayni.share.title", { what: opts.title || path.split( "/" ).pop() } ) } );
            var sheet = d.body;
            d.dialog.addEventListener( "close", function () { close(); } );

            var users = [], mine = [], chosen = [];   // chosen = every person ticked right now
            var mayAdd = false;                      // "pueden añadir archivos" ticked?
            var toAll  = false;                      // "Todos" ticked: one grant to every user, now and later
            var link   = null;                       // a trip's public link, when it has one
            var dropped = false;                     // × on the link: no new one until the sheet opens again

            function close()
            {
                if( d.close() ) resolve();
            }

            var ok = null;   // the "Share" button, so a tick-box can enable it

            function render()
            {
                ok = null;
                sheet.innerHTML    = "";
                d.footer.innerHTML = "";
                d.header.querySelectorAll( "[data-close]" ).forEach( function ( b ) { b.remove(); } );

                // --- anyone with the link, above the people ---
                if( opts.link ) sheet.appendChild( linkSection() );

                // --- only the people you pick: a heading and a note, like the link's ---
                var people = document.createElement( "div" );
                people.className = "share-sect";

                var head = document.createElement( "p" );
                head.className   = "share-head";
                head.textContent = opts.peopleHead || t( "ayni.share.people.head" );
                people.appendChild( head );

                var lead = document.createElement( "p" );
                lead.className = "share-note";

                // The note says what the share will actually allow, so it never
                // contradicts the "may add" tick below it.
                function setLead()
                {
                    lead.textContent = mayAdd                ? t( "ayni.share.leadadd" )
                                     : opts.lead ? opts.lead : t( "ayni.share.lead" );
                }
                setLead();
                people.appendChild( lead );

                // --- who already has it ---
                if( mine.length )
                {
                    var have = document.createElement( "div" );
                    have.className = "share-have";
                    mine.forEach( function ( g )
                    {
                        var row = document.createElement( "div" );
                        row.className = "share-row";

                        // "*" is the grant to everybody.
                        var name = g.to === "*" ? t( "ayni.share.all" ) : g.to;
                        var who  = document.createElement( "span" );
                        who.textContent = g.mode === "add"
                                        ? tf( "ayni.share.hasadd", { who: name } )
                                        : name;
                        row.appendChild( who );

                        var del = document.createElement( "button" );
                        del.type      = "button";
                        del.className = "share-drop";
                        Ayni.setTip( del, t( "ayni.share.stop" ) );
                        del.innerHTML = Ayni.icon( "close" );
                        del.addEventListener( "click", function ()
                        {
                            Ayni.setBusy( del, t( "ayni.wait" ) );
                            opts.api( "DELETE", null, g.id )
                                .then( function ()
                                {
                                    // Undo shares it again, the same way (a new grant, same person and rights).
                                    Ayni.toast( "ok", tf( "ayni.share.stopped", { who: name } ), { undo: function ()
                                    {
                                        opts.api( "POST", { to: g.to, root: path, app: g.app || opts.app || "folder",
                                                            title: g.title || opts.title || "", mode: g.mode || "ro" } )
                                            .catch( function ( e ) { Ayni.toast( "err", e.message ); } )
                                            .then( function () { if( d.dialog.isConnected ) return load(); } );
                                    } } );
                                    return load();
                                } )
                                .catch( function ( e ) { Ayni.toast( "err", e.message ); Ayni.setBusy( del, false ); } );
                        } );
                        row.appendChild( del );
                        have.appendChild( row );
                    } );
                    people.appendChild( have );
                }

                // --- who else could have it ---
                // Shared with everybody already: nobody is left to pick.
                var already = mine.map( function ( g ) { return g.to; } );
                var free    = already.indexOf( "*" ) !== -1 ? []
                            : users.filter( function ( n ) { return already.indexOf( n ) === -1; } );

                if( ! free.length )
                {
                    var none = document.createElement( "p" );
                    none.className   = "fp-msg";
                    none.textContent = users.length
                        ? t( "ayni.share.everyone" )
                        : t( "ayni.share.nobody" );
                    people.appendChild( none );
                }
                else
                {
                    // "Everybody" on top: one grant that also reaches whoever gets
                    // an account later. While it is on the names below are greyed
                    // out - everybody is in already.
                    var allLab = document.createElement( "label" );
                    allLab.className = "share-add share-all";
                    var allBox = document.createElement( "input" );
                    allBox.type    = "checkbox";
                    allBox.setAttribute( "role", "switch" );
                    allBox.checked = toAll;
                    var allSw = document.createElement( "span" );
                    allSw.className = "switch";
                    allSw.appendChild( allBox );
                    allLab.appendChild( document.createTextNode( t( "ayni.share.allPick" ) ) );
                    allLab.appendChild( allSw );
                    people.appendChild( allLab );

                    // The names: an Ayni pick list (a click or Space ticks one,
                    // Shift a range, Ctrl+A all), in three columns. A name too wide
                    // for its column ends in "..." (the tooltip has it whole).
                    var list = document.createElement( "ul" );
                    list.className = "lb share-pick";
                    list.id        = "sharePick";
                    list.tabIndex  = 0;
                    list.setAttribute( "role", "listbox" );
                    list.setAttribute( "aria-multiselectable", "true" );
                    list.setAttribute( "aria-label", t( "ayni.share.pick" ) );
                    if( toAll ) list.setAttribute( "aria-disabled", "true" );

                    free.forEach( function ( name )
                    {
                        var li = document.createElement( "li" );
                        li.setAttribute( "role", "option" );
                        li.setAttribute( "aria-selected", chosen.indexOf( name ) !== -1 ? "true" : "false" );
                        li.title = name;
                        var nm = document.createElement( "span" );
                        nm.textContent = name;
                        li.appendChild( nm );
                        list.appendChild( li );
                    } );

                    // No render() on a change: it would scroll the list back to the top.
                    list.addEventListener( "ayni:change", function ( e )
                    {
                        chosen.splice.apply( chosen, [ 0, chosen.length ].concat( e.detail.selected ) );
                        if( ok ) ok.ariaDisabled = ! ( toAll || chosen.length );
                    } );
                    allBox.addEventListener( "change", function ()
                    {
                        toAll = allBox.checked;
                        list.setAttribute( "aria-disabled", toAll ? "true" : "false" );
                        if( ok ) ok.ariaDisabled = ! ( toAll || chosen.length );
                    } );
                    Ayni.init( list );
                    people.appendChild( list );
                }

                // --- may they add files of their own? ---
                // Only offered for a FOLDER (opts.canAdd) - there is nothing to
                // add to a single file, and Adding is all it grants: the server
                // still refuses overwrite, delete, rename and re-share.
                if( opts.canAdd && free.length )
                {
                    var addLab = document.createElement( "label" );
                    addLab.className = "share-add";

                    var addBox = document.createElement( "input" );
                    addBox.type    = "checkbox";
                    addBox.setAttribute( "role", "switch" );
                    addBox.checked = mayAdd;
                    addBox.addEventListener( "change", function ()
                    {
                        mayAdd = addBox.checked;
                        setLead();          // no render(): that would scroll the list back to the top
                    } );

                    // An on / off option: the text, then the shared .switch.
                    var addSw = document.createElement( "span" );
                    addSw.className = "switch";
                    addSw.appendChild( addBox );

                    addLab.appendChild( document.createTextNode(
                        t( "ayni.share.mayadd" ) ) );
                    addLab.appendChild( addSw );
                    people.appendChild( addLab );
                }
                sheet.appendChild( people );

                // --- buttons: a lone × goes in the title row ---
                var row2 = d.footer;

                var cancel = Ayni.dialogButton( "close", t( "ayni.close" ) );
                cancel.addEventListener( "click", close );
                ( free.length ? row2 : d.header ).appendChild( cancel );

                if( free.length )
                {
                    ok = Ayni.dialogButton( "primary", t( "ayni.share.send" ) );
                    ok.ariaDisabled = ! ( toAll || chosen.length );
                    ok.addEventListener( "click", function ()
                    {
                        if( ! toAll && ! chosen.length ) return;
                        Ayni.setBusy( ok, t( "ayni.wait" ) );   // load() draws the list again, with a new ✓

                        // Everybody: ONE grant. The server drops the ones made to
                        // single people for this same item.
                        if( toAll )
                        {
                            opts.api( "POST", { to: "*", root: path,
                                                app: opts.app || "folder", title: opts.title || "",
                                                mode: mayAdd ? "add" : "ro" } )
                                .then( function ()
                                {
                                    toAll = false;
                                    Ayni.toast( "ok", t( "ayni.share.allDone" ) );
                                    return load();
                                } )
                                .catch( function ( e ) { Ayni.toast( "err", e.message ); return load(); } );
                            return;
                        }

                        var done = [];

                        // One POST per person, one after another. Each success drops that
                        // name from "chosen", so if one fails the rest stay ticked.
                        chosen.slice().reduce( function ( chain, name )
                        {
                            return chain.then( function ()
                            {
                                return opts.api( "POST", { to: name, root: path,
                                                           app: opts.app || "folder", title: opts.title || "",
                                                           mode: mayAdd ? "add" : "ro" } )
                                    .then( function ()
                                    {
                                        done.push( name );
                                        var at = chosen.indexOf( name );
                                        if( at !== -1 ) chosen.splice( at, 1 );
                                    } );
                            } );
                        }, Promise.resolve() )
                        .then( function ()
                        {
                            Ayni.toast( "ok", tf( "ayni.share.done", { who: done.join( ", " ) } ) );
                            return load();
                        } )
                        .catch( function ( e ) { Ayni.toast( "err", e.message ); return load(); } );
                    } );
                    row2.appendChild( ok );
                }

                Ayni.init( d.dialog );
            }

            // "Anyone with the link": the item's public link - send it, copy it,
            // take it away. Nothing to "create": load() makes it as the sheet opens.
            // The row is the same .share-row / .share-drop as a person's.
            function linkSection()
            {
                var box = document.createElement( "div" );
                box.className = "share-sect share-link";

                var head = document.createElement( "p" );
                head.className   = "share-head";
                head.textContent = t( "ayni.share.link.head" );
                box.appendChild( head );

                var note = document.createElement( "p" );
                note.className   = "share-note";
                note.textContent = t( "ayni.share.link.warn" );
                box.appendChild( note );

                var row = document.createElement( "div" );
                row.className = "share-row";

                // "..." while load() is still making it; after its ×, how to get one back.
                var text = document.createElement( "span" );
                text.className   = "share-link-url";
                text.textContent = link ? linkUrl( link ) : dropped ? t( "ayni.share.link.none" ) : "…";
                row.appendChild( text );

                if( link )
                {
                    var url = linkUrl( link );
                    if( navigator.share )
                        row.appendChild( rowButton( "share", t( "ayni.share.link.send" ), function ()
                        {
                            return navigator.share( { title: opts.title || "", url: url } )
                                            .catch( function () { /* the person closed the share sheet */ } );
                        } ) );
                    row.appendChild( rowButton( "copy", t( "ayni.share.link.copy" ), function ()
                    {
                        return Ayni.copyText( url ).then( function () { Ayni.toast( "ok", t( "ayni.share.link.copied" ) ); },
                                                     function () { Ayni.toast( "info", url ); } );
                    } ) );
                    // Gone from the sheet at once; the link itself dies when the
                    // Undo does (a new link would be a new address).
                    row.appendChild( rowButton( "close", t( "ayni.share.link.stop" ), function ()
                    {
                        var id = link.id;
                        linksGoing[ id ] = true;
                        link    = null;
                        dropped = true;
                        render();
                        Ayni.toast( "ok", t( "ayni.share.link.stopped" ), { undo: function ()
                        {
                            delete linksGoing[ id ];
                            dropped = false;
                            if( d.dialog.isConnected ) load();
                        }, final: function ()
                        {
                            opts.api( "DELETE", null, id )
                                .catch( function ( e ) { Ayni.toast( "err", e.message ); } )
                                .then( function () { delete linksGoing[ id ]; } );
                        } } );
                    } ) );
                }
                box.appendChild( row );
                return box;
            }

            function load()
            {
                return Promise.all( [ opts.users(), opts.api( "GET" ) ] ).then( function ( res )
                {
                    users = res[ 0 ];
                    var here = ( ( res[ 1 ] && res[ 1 ].mine ) || [] )
                                .filter( function ( g ) { return g.root === path; } );
                    // A public link is not a person: it has its own section.
                    mine = here.filter( function ( g ) { return ! g.token; } );
                    link = here.filter( function ( g ) { return !! g.token; } )[ 0 ] || null;
                    if( link && linksGoing[ link.id ] ) { link = null; dropped = true; }   // its × is still on Undo

                    // One link per item, the same for whoever gets it - so it is made
                    // as the sheet opens, with nothing to press first. After its ×
                    // it stays gone until the next open.
                    if( opts.link && ! link && ! dropped )
                        return opts.api( "POST", { link: true, root: path, title: opts.title || "" } )
                                   .then( function ( g ) { link = g; } );
                } ).catch( function ( e )
                {
                    Ayni.toast( "err", e.message || t( "ayni.loadFailed" ) );
                } ).then( render );
            }

            render();
            d.show();
            load();
        } );
    };

    Ayni.share.rowButton = rowButton;
} )();
