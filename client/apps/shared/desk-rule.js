/*
 * desk-rule.js - the one "desktop or the simple view" rule, for the launcher
 * (index.html, which sends a big screen to the desktop) and the desktop
 * (desktop/index.html, which sends it back when the rule no longer holds).
 * One copy: a size changed in only one of them would bounce a screen back and
 * forth. A plain script, loaded before the launcher's redirect - so before
 * shared/i18n.js, and it needs nothing.
 *
 *   nayiveDeskMode()        this device's choice (localStorage balata-desktop
 *                           `mode`): "auto" (the default), "always" or "never"
 *   nayiveWantDesk( mode )  does this screen get the desktop under `mode`?
 *       auto    at least 1024 x 600 with a mouse or touchpad;
 *       always  at least 1024 x 600 either way up (a tablet held upright too),
 *               with or without a mouse;
 *       never   the simple view, always. A phone-sized screen never does.
 */
function nayiveDeskMode()
{
    try { var m = ( JSON.parse( localStorage.getItem( 'balata-desktop' ) || 'null' ) || {} ).mode; }
    catch( e ) {}
    return m === 'always' || m === 'never' ? m : 'auto';
}
function nayiveWantDesk( mode )
{
    var mq = function ( q ) { return window.matchMedia( q ).matches; };
    if( mode === 'never' || mq( '(max-width: 640px)' ) ) return false;
    if( mode === 'always' ) return mq( '(min-width: 1024px) and (min-height: 600px)' ) || mq( '(min-width: 600px) and (min-height: 1024px)' );
    return mq( '(min-width: 1024px) and (min-height: 600px) and (any-pointer: fine)' );
}
