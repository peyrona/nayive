/* Ayni library 0.2.0, app shell: what the title row and the page do. Plain JavaScript, no build step, evergreen browsers 2024+.
   Optional: load it after ayni-base.js, with ayni-shell.css. The rules are chapter 18 of the guidelines. */
( function ()
{
    "use strict";

    // The card's title row is sticky; its height goes in --win-head-h, so a page's own sticky heads sit under it.
    if( window.ResizeObserver ) document.addEventListener( "DOMContentLoaded", function ()
    {
        var head = document.querySelector( ".page > .page-inner > .card > .header" );
        if( ! head ) return;
        new ResizeObserver( function ()
        {
            document.documentElement.style.setProperty( "--win-head-h", head.offsetHeight + "px" );
        } ).observe( head );
    } );

    // Export to PDF with no PDF library: `html` goes into the page's hidden #printRoot, <html> gets .printing (the print
    // rules show only #printRoot), `title` seeds the suggested file name, and the browser's print dialog writes the file
    // ("Save as PDF"). All undone on afterprint. `hintKey` is the key of the text that says so.
    function printPage( html, title, hintKey )
    {
        var root = document.getElementById( "printRoot" );
        root.innerHTML = html;

        var prevTitle = document.title;
        document.title = title;
        document.documentElement.classList.add( "printing" );

        window.addEventListener( "afterprint", function done()
        {
            window.removeEventListener( "afterprint", done );
            document.documentElement.classList.remove( "printing" );
            document.title = prevTitle;
            root.innerHTML = "";
        } );

        Ayni.toast( "info", Ayni.t( hintKey ) );
        setTimeout( function () { window.print(); }, 350 );
    }

    // The app's icon and name go home. Ayni.homeLinks( { go, tip, heads, not, onIcon } ) returns apply( root ), which marks
    // them: on the page, and on a part drawn later. go( event ) goes home; tip is the key of the icon's tooltip; heads the
    // title rows (default .topbar, .header); a name inside `not` stays plain; onIcon runs for each icon marked.
    // Real controls inside the title row keep their own job. A pane's icon is only its label: the host owns the way home.
    Ayni.homeLinks = function ( o )
    {
        var heads = o.heads || ".topbar, .header";

        function isAppTitleH1( el )
        {
            if( ! el || el.tagName !== "H1" ) return false;
            if( el.classList.contains( "app-title" ) ) return true;
            var head = el.closest && el.closest( heads );
            if( ! head || ! head.querySelector( ".app-icon" ) ) return false;
            return ! ( o.not && el.closest && el.closest( o.not ) );
        }

        function onHomeClick( e )
        {
            // a real control inside the header keeps its own job
            if( e.target.closest && e.target.closest( "a, button, input, .picker" ) ) return;
            e.preventDefault();
            o.go( e );
        }

        return function applyHomeLinks( root )
        {
            var scope = root && root.querySelectorAll ? root : document;
            var list  = [].slice.call( scope.querySelectorAll( ".app-icon, h1" ) );
            if( scope.nodeType === 1 && scope.matches &&
                ( scope.matches( ".app-icon" ) || scope.matches( "h1" ) ) )
                list.push( scope );

            for( var i = 0; i < list.length; i++ )
            {
                var el     = list[ i ];
                var isIcon = !! ( el.classList && el.classList.contains( "app-icon" ) );
                if( ! isIcon && ! isAppTitleH1( el ) ) continue;
                if( isIcon && Ayni.frame.embedded && ! Ayni.frame.windowed ) continue;
                if( el._ayniHome ) continue;
                el._ayniHome = true;

                el.classList.add( "home-link" );
                if( isIcon )
                {
                    if( ! el.dataset.tip && o.tip ) el.setAttribute( "data-i18n-attr", "data-tip:" + o.tip + ", aria-label:" + o.tip );
                    el.setAttribute( "role", "button" );
                }
                el.addEventListener( "click", onHomeClick );
                if( isIcon && o.onIcon ) o.onIcon( el );
            }
        };
    };

    Ayni.printPage = printPage;
} )();
