/*
 * vcard.js - reading and writing vCard text (RFC 6350 / 2426, and the 2.1 that
 * phones still export), for every page that reads the address book
 * (data/contacts.vcf): Contacts, which owns it, Chat's card picker, Tasks'
 * birthdays and Drive's .vcf import. Plain classic script, one global:
 *
 *     NayiveVCard.contentLines( text )        physical lines -> content lines
 *     NayiveVCard.read( text )                every card, the light way (see read)
 *     NayiveVCard.cards( text )               every card as the text it is in the file
 *     NayiveVCard.write( { name, tels, emails } )   one small card's text (Chat)
 *     ... and the pieces they are made of: splitOnce, splitOutsideQuotes,
 *     splitEscaped, parseParams, decodeValue, isQuotedPrintable, unescapeText,
 *     escapeText, foldLine, photoOf.
 *
 * Contacts builds its whole model on these (and writes an untouched card back
 * line for line); the others only want a few properties, but read them the
 * same way - folds, QUOTED-PRINTABLE and escapes included.
 *
 * Contacts loads it NOT deferred, right before its inline script, which takes
 * the functions on its first lines. Nothing here touches the DOM.
 *
 * Public on purpose (server/go/static.go): a person's Chat link has no
 * session, and saves a shared contact with write(). No data lives here.
 */
( function ()
{
    "use strict";

    // Physical lines -> content lines. Each one keeps the physical lines it came
    // from (so a card nobody edited is written back exactly as it was read) and
    // its text: RFC folds (a line that starts with a space or a tab) joined, and
    // so are vCard 2.1 QUOTED-PRINTABLE soft breaks (a line that ends in "=",
    // as Android exports), that "=" dropped. A blank line rides along with the
    // line above it: vCard 2.1 ends a base64 PHOTO with one.
    function contentLines( text )
    {
        const out  = [];
        let   cur  = null;
        let   soft = false;     // `cur` ends in a QUOTED-PRINTABLE soft break

        for( const p of text.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' ) )
        {
            if( cur && soft )
            {
                cur.text = cur.text.slice( 0, -1 ) + p;
                cur.phys.push( p );
                soft = /=$/.test( p );
                continue;
            }

            if( cur && ( p === '' || /^[ \t]/.test( p ) ) )
            {
                cur.text += p.slice( 1 );
                cur.phys.push( p );
                soft = /=$/.test( p ) && isQuotedPrintable( cur.text );
                continue;
            }

            cur  = { text: p, phys: [ p ] };
            soft = /=$/.test( p ) && isQuotedPrintable( p );
            out.push( cur );
        }

        return out;
    }

    // Does this content line say ENCODING=QUOTED-PRINTABLE (or 2.1's bare
    // QUOTED-PRINTABLE) before its value?
    function isQuotedPrintable( line )
    {
        const left = splitOnce( line, ':' )[ 0 ];
        return left !== null && /;\s*(ENCODING\s*=\s*)?QUOTED-PRINTABLE\s*(;|$)/i.test( left );
    }

    // The value of a vCard 2.1 QUOTED-PRINTABLE line as text, in its CHARSET
    // (UTF-8 when it names none, or one this browser does not know). Line
    // breaks come back as "\n". Any other value is returned as it is.
    function decodeValue( value, params )
    {
        if( ! params.some( p => p.val === 'QUOTED-PRINTABLE' ) )
            return value;

        const bytes = [];

        for( let i = 0; i < value.length; i++ )
        {
            const hex = value.substr( i + 1, 2 );

            if( value[ i ] === '=' && /^[0-9A-Fa-f]{2}$/.test( hex ) )
            {
                bytes.push( parseInt( hex, 16 ) );
                i += 2;
            }
            else
            {
                bytes.push( ...new TextEncoder().encode( value[ i ] ) );
            }
        }

        const charset = ( params.find( p => p.key === 'CHARSET' ) || {} ).val;
        let   dec;

        try   { dec = new TextDecoder( charset || 'utf-8' ); }
        catch { dec = new TextDecoder( 'utf-8' ); }

        return dec.decode( new Uint8Array( bytes ) ).replace( /\r\n?/g, '\n' );
    }

    function splitOnce( line, sep )
    {
        let inQ = false;

        for( let i = 0; i < line.length; i++ )
        {
            const ch = line[ i ];

            if( ch === '"' )               inQ = ! inQ;
            else if( ch === sep && ! inQ ) return [ line.slice( 0, i ), line.slice( i + 1 ) ];
        }

        return [ null, null ];
    }

    function splitOutsideQuotes( str, sep )
    {
        const parts = [];
        let   cur   = '';
        let   inQ   = false;

        for( const ch of str )
        {
            if( ch === '"' )               { inQ = ! inQ; cur += ch; }
            else if( ch === sep && ! inQ ) { parts.push( cur ); cur = ''; }
            else                            cur += ch;
        }

        parts.push( cur );
        return parts;
    }

    // Split a structured value on an UNescaped separator (so "\;" and "\," stay literal).
    function splitEscaped( str, sep )
    {
        const parts = [];
        let   cur   = '';

        for( let i = 0; i < str.length; i++ )
        {
            const ch = str[ i ];

            if( ch === '\\' && i + 1 < str.length ) { cur += ch + str[ ++i ]; continue; }
            if( ch === sep )                        { parts.push( cur ); cur = ''; continue; }
            cur += ch;
        }

        parts.push( cur );
        return parts;
    }

    function parseParams( segs )
    {
        const out = [];

        for( const seg of segs )
        {
            const eq = seg.indexOf( '=' );

            if( eq === -1 )
            {
                out.push( { key: 'TYPE', val: seg.trim().toUpperCase() } );   // vCard 2.1 style: TEL;HOME;VOICE:
                continue;
            }

            const key = seg.slice( 0, eq ).trim().toUpperCase();

            for( const v of seg.slice( eq + 1 ).split( ',' ) )
                out.push( { key: key, val: v.replace( /^"|"$/g, '' ).trim().toUpperCase() } );
        }

        return out;
    }

    function unescapeText( s )
    {
        let out = '';

        for( let i = 0; i < s.length; i++ )
        {
            const ch = s[ i ];

            if( ch === '\\' && i + 1 < s.length )
            {
                const nx = s[ ++i ];
                out += ( nx === 'n' || nx === 'N' ) ? '\n' : nx;
            }
            else
            {
                out += ch;
            }
        }

        return out;
    }

    function escapeText( s )
    {
        return String( s == null ? '' : s )
            .replace( /\\/g, '\\\\' )
            .replace( /\n/g, '\\n' )
            .replace( /,/g,  '\\,' )
            .replace( /;/g,  '\\;' );
    }

    // A small card of its own: { name, tels: [ ], emails: [ ] } -> the text of
    // one vCard 3.0 (Chat's shared contact, "Save" -> a .vcf). Contacts writes
    // its whole model its own way.
    function write( c )
    {
        const lines = [ 'BEGIN:VCARD', 'VERSION:3.0', 'FN:' + escapeText( c.name ), 'N:' + escapeText( c.name ) + ';;;;' ];
        ( c.tels   || [] ).forEach( function ( t ) { lines.push( 'TEL;TYPE=CELL:' + escapeText( t ) ); } );
        ( c.emails || [] ).forEach( function ( e ) { lines.push( 'EMAIL:' + escapeText( e ) ); } );
        lines.push( 'END:VCARD' );
        return lines.join( '\r\n' ) + '\r\n';
    }

    // RFC 6350 §3.2: fold content lines longer than 75 octets. Continuation lines begin
    // with a single space. Folding is done on UTF-8 octet boundaries without splitting a
    // multi-byte character.
    function foldLine( line )
    {
        const bytes = new TextEncoder().encode( line );

        if( bytes.length <= 75 )
            return line;

        const dec = new TextDecoder();
        let   out = '';
        let   pos = 0;
        let   max = 75;

        while( pos < bytes.length )
        {
            let end = Math.min( pos + max, bytes.length );

            while( end < bytes.length && ( bytes[ end ] & 0xC0 ) === 0x80 )
                end--;

            out += ( pos === 0 ? '' : '\r\n ' ) + dec.decode( bytes.slice( pos, end ) );
            pos  = end;
            max  = 74;   // continuation lines spend one octet on the leading space
        }

        return out;
    }

    // A PHOTO's picture as a data: URL, or '' for one this page cannot show
    // (a link to the web: its line stays in the card as it was). Read in the
    // three ways phones write it - 3.0 "PHOTO;ENCODING=b;TYPE=JPEG:<base64>",
    // 2.1 "PHOTO;ENCODING=BASE64;JPEG:<base64>" and 4.0 "PHOTO:data:image/...".
    // A 2.1 fold leaves spaces inside the base64: they go.
    function photoOf( value, params )
    {
        const v = value.replace( /\s+/g, '' );
        const d = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+\/=]+)$/i.exec( v );

        if( d ) return 'data:image/' + d[ 1 ].toLowerCase().replace( 'jpg', 'jpeg' ) + ';base64,' + d[ 2 ];

        if( params.some( p => p.key === 'VALUE' && /^UR[IL]$/.test( p.val ) ) || ! /^[A-Za-z0-9+\/=]+$/.test( v ) || v.length < 16 )
            return '';

        const t    = params.filter( p => p.key === 'TYPE' ).map( p => p.val.replace( /^IMAGE\//, '' ) );
        const mime = t.includes( 'PNG' ) || /^iVBOR/.test( v ) ? 'png'
                   : t.includes( 'GIF' ) || /^R0lG/.test( v )  ? 'gif'
                   : 'jpeg';

        return 'data:image/' + mime + ';base64,' + v;
    }

    // The cards of a .vcf as they are written: [{ text, uid, rev }], rev as
    // bare digits so "2026-09-28T10:00:00Z" and "20260928T100000Z" compare.
    // null = text that holds no card at all.
    function vcfCards( text )
    {
        const cards = [];
        let   cur   = null;
        const done  = () =>
        {
            const one  = cur.join( '\r\n' );
            const flat = one.replace( /\r\n[ \t]/g, '' );
            const val  = name => { const x = new RegExp( '^(?:[\\w-]+\\.)?' + name + '(?:;[^:\\r\\n]*)?:(.*)$', 'im' ).exec( flat ); return x ? x[ 1 ].trim() : ''; };
            cards.push( { text: one, uid: val( 'UID' ), rev: val( 'REV' ).replace( /\D/g, '' ) } );
            cur = null;
        };

        for( const l of String( text || '' ).replace( /\r\n?/g, '\n' ).split( '\n' ) )
        {
            const tag = l.trim().toUpperCase();
            if( tag === 'BEGIN:VCARD' ) { if( cur ) done(); cur = [ l ]; continue; }
            if( ! cur ) continue;
            cur.push( l );
            if( tag === 'END:VCARD' ) done();
        }
        if( cur ) done();

        return cards.length || ! String( text || '' ).trim() ? cards : null;
    }

    // Every card of a .vcf, read the light way - for a reader that wants a few
    // properties, not Contacts' whole model (Chat's picker, Tasks' birthdays):
    // one list per card of { name, params, value }. `name` is upper-case, without
    // its "itemN." group; `params` as parseParams makes them; `value` is decoded
    // from QUOTED-PRINTABLE but still escaped (unescapeText / splitEscaped it, as
    // the property needs). A card with no END (a file cut short) is left out.
    function read( text )
    {
        const out  = [];
        let   card = null;

        for( const cl of contentLines( String( text || '' ) ) )
        {
            const tag = cl.text.trim().toUpperCase();

            if( tag === 'BEGIN:VCARD' ) { card = []; continue; }
            if( tag === 'END:VCARD' )   { if( card ) out.push( card ); card = null; continue; }
            if( ! card ) continue;

            const [ left, raw ] = splitOnce( cl.text, ':' );
            if( left === null ) continue;

            const segs   = splitOutsideQuotes( left, ';' );
            const params = parseParams( segs.slice( 1 ) );

            card.push( { name  : segs[ 0 ].slice( segs[ 0 ].lastIndexOf( '.' ) + 1 ).trim().toUpperCase(),
                         params: params,
                         value : decodeValue( raw, params ) } );
        }

        return out;
    }

    window.NayiveVCard = {
        contentLines      : contentLines,
        read              : read,
        cards             : vcfCards,
        isQuotedPrintable : isQuotedPrintable,
        decodeValue       : decodeValue,
        splitOnce         : splitOnce,
        splitOutsideQuotes: splitOutsideQuotes,
        splitEscaped      : splitEscaped,
        parseParams       : parseParams,
        unescapeText      : unescapeText,
        escapeText        : escapeText,
        write             : write,
        foldLine          : foldLine,
        photoOf           : photoOf
    };
} )();
