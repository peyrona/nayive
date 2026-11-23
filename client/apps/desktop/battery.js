/* desktop/battery.js - the battery level on the desktop's bar, out of Ayni's desk page (2026-11-23): it talks to
   the device (navigator.getBattery), so it is Nayive's, not UI. The level (#batt) and its row in the "⋮"
   (#battRow, set.battBar: this device).
   A plain script: desktop/index.html puts the markup in the desk page's slots, then calls
     var BT = NayiveDesk.battery( D )     BT: { battEl }, for the help card. */
( window.NayiveDesk = window.NayiveDesk || {} ).battery = function ( D )
{
    var set = D.set, saveSet = D.saveSet, placeMore = D.relayout, t = D.t;

    // BATTERY - this device's choice (set.battBar, the first row of the "⋮"
    // menu): the level on the bar, an icon and "80%". Only where the browser
    // tells it (navigator.getBattery: Chrome, Edge; not Firefox or Safari) and
    // there is a battery; else the switch is greyed and the bar shows nothing.
    // A PC without one reports "charging, full, no time left" - and so does a
    // full laptop on its charger: greyed too, until it is unplugged. The
    // low-battery dialog is shared/ui.js's (every page, this switch or not).

    var battEl = document.getElementById( 'batt' ), battChk = document.getElementById( 'battBarChk' ),
        battRow = document.getElementById( 'battRow' ), batt = null;

    function battNone( b )
    {
        return ! b || ( b.charging && b.level >= 1 && b.chargingTime === 0 && b.dischargingTime === Infinity );
    }

    function battApply()
    {
        var none = battNone( batt );
        battChk.checked  = !! set.battBar;
        battChk.disabled = none;
        battRow.toggleAttribute( 'disabled', none );
        battEl.hidden = none || ! set.battBar;
        if( battEl.hidden ) return;
        var n = Math.round( batt.level * 100 );
        battEl.classList.toggle( 'low', ! batt.charging && batt.level <= 0.15 );
        battEl.classList.toggle( 'chg', batt.charging );
        battEl.querySelector( '.batt-fill' ).setAttribute( 'width', Math.max( 1, 14 * batt.level ).toFixed( 1 ) );
        battEl.querySelector( 'b' ).textContent = n + '%';
        battEl.title = t( 'desktop.battery' ) + ': ' + n + '%' + ( batt.charging ? ' · ' + t( 'desktop.battCharging' ) : '' );
        battEl.setAttribute( 'aria-label', battEl.title );
    }
    battChk.addEventListener( 'change', function () { set.battBar = battChk.checked; saveSet(); battApply(); placeMore(); } );
    battApply();
    if( window.Ayni ) Ayni.i18n.ready.then( battApply );     // the tooltip's words
    if( navigator.getBattery ) navigator.getBattery().then( function ( b )
    {
        batt = b;
        [ 'chargingchange', 'levelchange', 'chargingtimechange', 'dischargingtimechange' ].forEach( function ( ev ) { b.addEventListener( ev, battApply ); } );
        battApply();
    }, function () {} );

    return { battEl: battEl };
};
