/* Ayni library 0.2.0, upload: one progress notification for a burst of uploads, and the check that there is room first. The transport
   is the app's. Plain JavaScript, no build step, evergreen browsers 2024+. Optional; it needs ayni-toasts.js and ayni-dialogs.js when it runs. */
( function ()
{
    "use strict";

    var t = Ayni.t, tf = Ayni.tf;

    /* Is there room for `need` bytes? Resolves true to go ahead, false to stop.
     *
     * A trashed file still takes up disk and still counts against the quota, so
     * when the upload does not fit but WOULD fit with the bin emptied,
     * this offers exactly that and empties it if the user agrees. A server should
     * enforce the quota anyway; this is only here to say something useful before
     * a long upload fails. o: space() resolves to { usable, trash }, binIds() to the
     * ids in the bin, empty( ids ) deletes them. */
    Ayni.ensureRoom = async function ( need, o )
    {
        var s;
        try { s = await o.space(); }
        catch ( e ) { return true; }                  // can't tell: let the server decide
        if ( ! s || typeof s.usable !== "number" || need <= s.usable ) return true;

        var held  = s.trash || 0;
        var short = tf( "ayni.room.short", { need: Ayni.fmtBytes( need ), free: Ayni.fmtBytes( s.usable ) } );

        // Only what the bin holds when the user is asked is deleted - those
        // ids, never "empty everything": an item deleted on another device
        // after that (its Undo toast maybe still up there) stays (G4). The
        // ids travel in the URL: at most 2000 a call.
        var ids = null;
        if ( held > 0 && need <= s.usable + held )
        {
            try { ids = await o.binIds(); }
            catch ( e ) { ids = null; }
        }
        if ( ids && ids.length )
        {
            var ok = await Ayni.confirm( {
                title:   t( "ayni.room.title" ),
                body:    short + "\n\n" + tf( "ayni.room.trashBody", { held: Ayni.fmtBytes( held ) } ),
                confirm: t( "ayni.room.empty" ), danger: true } );
            if ( ! ok ) return false;
            try
            {
                for ( var i = 0; i < ids.length; i += 2000 ) await o.empty( ids.slice( i, i + 2000 ) );
                return true;
            }
            catch ( e ) { Ayni.toast( "err", t( "ayni.room.emptyFail" ) ); return false; }
        }

        Ayni.toast( "err", t( "ayni.room.none" ) + " " + short +
               ( held > 0 ? " " + tf( "ayni.room.trashHolds", { held: Ayni.fmtBytes( held ) } ) : "" ) );
        return false;
    };

    // An app's transport announces every upload as events on the document, of the
    // name in o.event ({ id, loaded, total }, then { id, done: true }). The uploads of
    // one BURST share one progress notification (Ayni.progress, in the toast
    // stack): an app may send many files one after another, and each
    // alone may be quick. Ayni shows it only once the burst has run 600 ms, so
    // a small one shows nothing. It goes UPLOAD_HIDE_MS
    // after the last one ends, so it does not flicker in the gap between two files.
    //
    // The percent is of what is in flight NOW.

    var UPLOAD_HIDE_MS = 400;

    var uploads     = {};     // id -> { loaded, total }, the requests in flight
    var burstBytes  = 0;      // bytes the finished uploads of this burst sent
    var uploadRow   = null;   // the burst's progress notification
    var uploadHideT = null;
    var burstOpts   = null;

    function uploadsBusy() { return Object.keys( uploads ).length > 0; }

    function uploadPercent()
    {
        var loaded = 0, total = 0;
        for( var id in uploads ) { loaded += uploads[ id ].loaded; total += uploads[ id ].total; }
        return total > 0 ? Math.min( 100, Math.floor( loaded * 100 / total ) ) : 0;
    }

    function drawUploadBar( pct )
    {
        var text = tf( "ayni.uploading", { pct: pct } );
        if( uploadRow ) uploadRow.set( text, pct );
        else if( document.body && window.Ayni && Ayni.progress ) uploadRow = Ayni.progress( text, { pct: pct } );
    }

    function endUploadBurst()
    {
        uploadHideT = null;
        if( uploadRow ) { uploadRow.end(); uploadRow = null; }
        if( burstOpts && burstOpts.onBurst ) burstOpts.onBurst( burstBytes );
        burstBytes = 0;
    }

    function onUploadEvent( e )
    {
        var d = e.detail || {};
        if( d.done && uploads[ d.id ] ) burstBytes += uploads[ d.id ].total;
        if( d.done ) delete uploads[ d.id ];
        else         uploads[ d.id ] = { loaded: d.loaded || 0, total: d.total || 0 };

        if( uploadsBusy() )
        {
            clearTimeout( uploadHideT );
            uploadHideT = null;
            drawUploadBar( uploadPercent() );
        }
        else
        {
            if( uploadRow ) drawUploadBar( 100 );           // it did finish
            if( ! uploadHideT ) uploadHideT = setTimeout( endUploadBurst, UPLOAD_HIDE_MS );
        }
    }

    // Ayni.uploads( { event, onBurst } ): event is the name to listen to; onBurst( bytes ) runs after each burst ends.
    Ayni.uploads = function ( o )
    {
        burstOpts = o;
        document.addEventListener( o.event, onUploadEvent );
    };
} )();
