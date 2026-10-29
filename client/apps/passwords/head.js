/*
 * head.js - Passwords: the two lines every other app has inline in its
 * <head>. This page's Content-Security-Policy allows no inline script, so
 * they live here. Loaded WITHOUT defer: the theme must be set before the
 * first paint.
 */
try{ document.documentElement.dataset.theme = localStorage.getItem( 'ayni-theme' ) || ( matchMedia( '(prefers-color-scheme: dark)' ).matches ? 'dark' : 'light' ); }catch( e ){}

if( 'serviceWorker' in navigator )
    window.addEventListener( 'load', function () { navigator.serviceWorker.register( '../sw.js' ).catch( function () {} ); } );
