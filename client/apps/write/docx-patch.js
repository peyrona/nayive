/*
 * docx-patch.js - the few changes Write makes to a .docx package itself, where
 * the engine has no command for them. Pure functions over bytes: unzip, change
 * one part, zip again.
 *
 * The zip library is the one inside the engine bundle (fflate, MIT), handed in
 * by write.js - this file imports nothing, so an engine bump never touches it.
 *
 *   const patch = createPatcher( { unzipSync, zipSync, strFromU8, strToU8, blank } );
 *   bytes = patch.withHeadingStyles( bytes );   // the same bytes when nothing was missing
 *   const sp = patch.styleSpacing( bytes, 'Heading1' );          // { beforePt, afterPt }
 *   bytes = patch.withStyles( bytes, { Heading1: { sizePt: 18, color: 'C00000' } } );
 *   const l = patch.listInfo( bytes, paraId );  // the numbered list that paragraph is in
 *   bytes = patch.withListFormat( bytes, l, level, 'lowerRoman' );
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// The heading levels Write offers (Formato > Estilos, Ctrl+Alt+1..3).
const LEVELS = [ 1, 2, 3 ];

export function createPatcher( z )
{
    let blankStyles = null;      // Heading1..3 as XML text, from Word's blank template

    //---- HEADING STYLES ------------------------------------------------------
    //
    // A file made outside Word often defines only "Normal" (19 of 35 of his did),
    // and the engine refuses a paragraph style the document does not define -
    // Word, in the same place, quietly adds its built-in definition. So Write
    // does that too, as the file is put on screen: any of Heading 1-3 that is
    // missing gets Word's own definition, taken from the engine's blank
    // template. A heading is found by its BUILT-IN NAME ("heading 1"), not its
    // id, since Word writes the id in the document's language ("Ttulo1").
    //
    // Nothing reaches the server unless the document is edited and saved; then
    // the definitions travel with it, as they would from Word.

    function withHeadingStyles( bytes )
    {
        const part = z.unzipSync( bytes, { filter: function( f ) { return f.name === 'word/styles.xml'; } } )[ 'word/styles.xml' ];
        if( ! part ) return bytes;

        const xml = z.strFromU8( part );
        const doc = new DOMParser().parseFromString( xml, 'application/xml' );
        if( doc.getElementsByTagName( 'parsererror' ).length ) return bytes;

        const styles  = [ ...doc.getElementsByTagNameNS( W_NS, 'style' ) ];
        const attr    = function( el, name ) { return el.getAttributeNS( W_NS, name ) || el.getAttribute( 'w:' + name ); };
        const nameOf  = function( el ) { const n = el.getElementsByTagNameNS( W_NS, 'name' )[ 0 ]; return n ? String( attr( n, 'val' ) ).toLowerCase() : ''; };
        const ids     = new Set( styles.map( function( s ) { return attr( s, 'styleId' ); } ) );
        const paras   = styles.filter( function( s ) { return attr( s, 'type' ) === 'paragraph'; } );

        const missing = LEVELS.filter( function( n )
        {
            return ! paras.some( function( s ) { return attr( s, 'styleId' ) === 'Heading' + n || nameOf( s ) === 'heading ' + n; } );
        } );
        if( ! missing.length ) return bytes;

        // What the new styles are based on: "Normal" when the file has it, else
        // its default paragraph style, else nothing.
        let base = 'Normal';
        if( ! paras.some( function( s ) { return attr( s, 'styleId' ) === 'Normal'; } ) )
        {
            const def = paras.find( function( s ) { return /^(1|true|on)$/.test( attr( s, 'default' ) || '' ); } );
            base = def ? attr( def, 'styleId' ) : null;
        }

        // Word writes the "w:" prefix; any other one is followed, and a file
        // with the main namespace as default (no prefix) is left alone - its
        // attributes would need one anyway.
        const prefix = doc.documentElement.prefix || '';
        if( ! prefix ) return bytes;

        let add = '';

        for( const n of missing )
        {
            if( ids.has( 'Heading' + n ) ) continue;         // the id is taken by something else: leave it

            let s = headingXml( n );
            if( ! s ) continue;

            s = base ? s.replace( /(<w:(?:basedOn|next) w:val=")Normal(")/g, '$1' + base + '$2' )
                     : s.replace( /<w:(?:basedOn|next) w:val="Normal"\/>/g, '' );

            if( prefix !== 'w' ) s = s.replace( /(<\/?)w:/g, '$1' + prefix + ':' ).replace( / w:/g, ' ' + prefix + ':' );
            add += s;
        }
        if( ! add ) return bytes;

        const close = xml.lastIndexOf( '</' + prefix + ':styles>' );
        if( close < 0 ) return bytes;

        const files = z.unzipSync( bytes );
        files[ 'word/styles.xml' ] = z.strToU8( xml.slice( 0, close ) + add + xml.slice( close ) );

        return rezip( files );    // the engine writes its own zip on save anyway
    }

    // Word's definition of Heading n, as the blank template writes it.
    function headingXml( n )
    {
        if( ! blankStyles )
        {
            blankStyles = {};
            const part = z.unzipSync( z.blank(), { filter: function( f ) { return f.name === 'word/styles.xml'; } } )[ 'word/styles.xml' ];
            const xml  = part ? z.strFromU8( part ) : '';

            for( const l of LEVELS )
            {
                const m = new RegExp( '<w:style [^>]*w:styleId="Heading' + l + '"[^>]*>[\\s\\S]*?</w:style>' ).exec( xml );
                if( m ) blankStyles[ l ] = m[ 0 ];
            }
        }
        return blankStyles[ n ] || null;
    }

    //---- CHANGING A STYLE ----------------------------------------------------
    //
    // Normal and Heading 1-3 changed where Word keeps them: their w:style in
    // word/styles.xml. The engine has no command for it (2.21.0). A style is
    // asked for by Write's key ("Normal", "Heading1") and found by that id or by
    // its BUILT-IN NAME, as above - "Ttulo1" in a Spanish file.
    //
    //   changes = { Heading1: { font, sizePt, bold, italic, color, beforePt, afterPt }, ... }
    //
    // Only the fields given are written; color is six hex digits or 'auto'. An
    // explicit font or colour drops the theme's one, which would win over it, and
    // "not bold" is written as <w:b w:val="0"/>, since the style it is based on
    // may be bold. Runs on what the engine saved, so the prefix is "w:".

    const STYLE_RE = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g;

    // Schema order of the children Write may add (the rest keep their place).
    const RPR_ORDER = [ 'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike',
                        'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden',
                        'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect',
                        'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout',
                        'specVanish', 'oMath', 'rPrChange' ];
    const PPR_ORDER = [ 'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr',
                        'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap',
                        'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd',
                        'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap',
                        'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId',
                        'cnfStyle', 'rPr', 'sectPr', 'pPrChange' ];
    // What may follow w:pPr / w:rPr inside a w:style.
    const AFTER_PPR = [ 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr' ];
    const AFTER_RPR = [ 'tblPr', 'trPr', 'tcPr', 'tblStylePr' ];

    function stylesXml( bytes )
    {
        const part = parts( bytes, [ 'word/styles.xml' ] )[ 'word/styles.xml' ];
        return part ? z.strFromU8( part ) : null;
    }

    // The paragraph style Write calls `key`: { xml, at, id } or null.
    function findStyle( xml, key )
    {
        const name = key === 'Normal' ? 'normal' : key.replace( /^Heading(\d)$/, 'heading $1' );
        const all  = [];
        let m;
        STYLE_RE.lastIndex = 0;
        while( ( m = STYLE_RE.exec( xml ) ) )
        {
            const head = /^<w:style\b[^>]*>/.exec( m[ 0 ] )[ 0 ];
            if( attrIn( head, 'type' ) !== 'paragraph' ) continue;
            all.push( { xml: m[ 0 ], at: m.index, id: attrIn( head, 'styleId' ),
                        name: String( attrOf( m[ 0 ], 'name' ) || '' ).toLowerCase() } );
        }
        return all.find( function( s ) { return s.id === key; } ) ||
               all.find( function( s ) { return s.name === name; } ) || null;
    }

    // Space before / after of a style in points: its own, else the style it is
    // based on, else the document's default; 0 when nobody says.
    //   { beforePt, afterPt }  or null when the style is not there
    function styleSpacing( bytes, key )
    {
        const xml = stylesXml( bytes );
        const s   = xml && findStyle( xml, key );
        if( ! s ) return null;

        const out  = { beforePt: null, afterPt: null };
        const take = function( block )
        {
            const sp = block && /<w:spacing\b[^>]*\/?>/.exec( block );
            if( ! sp ) return;
            const b = attrIn( sp[ 0 ], 'before' ), a = attrIn( sp[ 0 ], 'after' );
            if( out.beforePt === null && b !== null ) out.beforePt = Number( b ) / 20;
            if( out.afterPt  === null && a !== null ) out.afterPt  = Number( a ) / 20;
        };

        const seen = new Set();
        for( let cur = s; cur && ! seen.has( cur.id ); )
        {
            seen.add( cur.id );
            take( ( /<w:pPr>[\s\S]*?<\/w:pPr>/.exec( cur.xml ) || [] )[ 0 ] );
            const base = attrOf( cur.xml, 'basedOn' );
            cur = base ? findById( xml, base ) : null;
        }

        take( ( /<w:pPrDefault>[\s\S]*?<\/w:pPrDefault>/.exec( xml ) || [] )[ 0 ] );

        return { beforePt: out.beforePt || 0, afterPt: out.afterPt || 0 };
    }

    function findById( xml, id )
    {
        const m = new RegExp( '<w:style\\b[^>]*w:styleId="' + id.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '"[^>]*>[\\s\\S]*?</w:style>' ).exec( xml );
        return m ? { xml: m[ 0 ], at: m.index, id: id } : null;
    }

    // The bytes with the styles changed, or null when one of them is not in
    // the file (nothing is changed then).
    function withStyles( bytes, changes )
    {
        let xml = stylesXml( bytes );
        if( ! xml ) return null;

        for( const key of Object.keys( changes ) )
        {
            const s = findStyle( xml, key );
            // A style with a tracked change inside (w:rPrChange / w:pPrChange) is
            // left alone: its old copy holds the same tags.
            if( ! s || /<w:(?:rPrChange|pPrChange)\b/.test( s.xml ) ) return null;
            xml = xml.slice( 0, s.at ) + patchStyle( s.xml, changes[ key ] ) + xml.slice( s.at + s.xml.length );
        }

        const files = z.unzipSync( bytes );
        files[ 'word/styles.xml' ] = z.strToU8( xml );
        return rezip( files );
    }

    function patchStyle( style, c )
    {
        const has = function( k ) { return c[ k ] !== undefined && c[ k ] !== null; };

        if( has( 'beforePt' ) || has( 'afterPt' ) )
        {
            style = withBlock( style, 'pPr', AFTER_PPR, function( p )
            {
                const old = /<w:spacing\b[^>]*\/>/.exec( p );
                // beforeLines / auto spacing would win over a value in points: dropped.
                let sp = old ? old[ 0 ].replace( /\s+w:(?:beforeLines|afterLines|beforeAutospacing|afterAutospacing)="[^"]*"/g, '' )
                             : '<w:spacing/>';
                if( has( 'beforePt' ) ) sp = setAttr( sp, 'before', String( Math.round( c.beforePt * 20 ) ) );
                if( has( 'afterPt'  ) ) sp = setAttr( sp, 'after',  String( Math.round( c.afterPt  * 20 ) ) );
                return putChild( p, 'spacing', sp, PPR_ORDER );
            } );
        }

        if( has( 'font' ) || has( 'sizePt' ) || has( 'bold' ) || has( 'italic' ) || has( 'color' ) )
        {
            style = withBlock( style, 'rPr', AFTER_RPR, function( r )
            {
                if( has( 'font' ) )
                {
                    const old  = ( /<w:rFonts\b[^>]*\/>/.exec( r ) || [ '<w:rFonts/>' ] )[ 0 ];
                    const keep = old.replace( /\s+w:(?:ascii|hAnsi|cs|asciiTheme|hAnsiTheme|cstheme)="[^"]*"/g, '' );
                    const f    = escAttr( c.font );
                    r = putChild( r, 'rFonts', keep.replace( /^<w:rFonts/, '<w:rFonts w:ascii="' + f + '" w:hAnsi="' + f + '" w:cs="' + f + '"' ), RPR_ORDER );
                }
                if( has( 'bold' ) )
                {
                    r = putChild( r, 'b',   c.bold ? '<w:b/>'   : '<w:b w:val="0"/>',   RPR_ORDER );
                    r = putChild( r, 'bCs', c.bold ? '<w:bCs/>' : '<w:bCs w:val="0"/>', RPR_ORDER );
                }
                if( has( 'italic' ) )
                {
                    r = putChild( r, 'i',   c.italic ? '<w:i/>'   : '<w:i w:val="0"/>',   RPR_ORDER );
                    r = putChild( r, 'iCs', c.italic ? '<w:iCs/>' : '<w:iCs w:val="0"/>', RPR_ORDER );
                }
                if( has( 'color' ) ) r = putChild( r, 'color', '<w:color w:val="' + escAttr( c.color ) + '"/>', RPR_ORDER );
                if( has( 'sizePt' ) )
                {
                    const hp = String( Math.max( 2, Math.round( c.sizePt * 2 ) ) );
                    r = putChild( r, 'sz',   '<w:sz w:val="'   + hp + '"/>', RPR_ORDER );
                    r = putChild( r, 'szCs', '<w:szCs w:val="' + hp + '"/>', RPR_ORDER );
                }
                return r;
            } );
        }

        return style;
    }

    // The style's w:pPr or w:rPr run through `edit` - made first when the
    // style has none, in its schema place (before any of `after`).
    function withBlock( style, tag, after, edit )
    {
        const re  = new RegExp( '<w:' + tag + '\\s*/>|<w:' + tag + '>[\\s\\S]*?</w:' + tag + '>' );
        const old = re.exec( style );
        const empty = '<w:' + tag + '></w:' + tag + '>';
        if( old ) return style.slice( 0, old.index ) + edit( old[ 0 ].endsWith( '/>' ) ? empty : old[ 0 ] ) + style.slice( old.index + old[ 0 ].length );

        const block = edit( empty );
        const at    = firstOf( style, after );
        return at < 0 ? style.replace( /<\/w:style>$/, block + '</w:style>' )
                      : style.slice( 0, at ) + block + style.slice( at );
    }

    // `el` in place of the block's own w:<tag>, or added where the schema wants it.
    function putChild( block, tag, el, order )
    {
        const close = block.lastIndexOf( '</' );
        const inner = block.slice( 0, close );

        const re  = new RegExp( '<w:' + tag + '(?=[\\s/>])[^>]*?(?:/>|>[\\s\\S]*?</w:' + tag + '>)' );
        const old = re.exec( inner );
        if( old ) return block.slice( 0, old.index ) + el + block.slice( old.index + old[ 0 ].length );

        const at = firstOf( inner, order.slice( order.indexOf( tag ) + 1 ) );
        const to = at < 0 ? close : at;
        return block.slice( 0, to ) + el + block.slice( to );
    }

    // Where the first of these elements starts, or -1.
    function firstOf( xml, tags )
    {
        let best = -1;
        for( const t of tags )
        {
            const i = xml.search( new RegExp( '<w:' + t + '(?=[\\s/>])' ) );
            if( i >= 0 && ( best < 0 || i < best ) ) best = i;
        }
        return best;
    }

    function setAttr( el, name, value )
    {
        const re = new RegExp( '\\sw:' + name + '="[^"]*"' );
        return re.test( el ) ? el.replace( re, ' w:' + name + '="' + value + '"' )
                             : el.replace( /\s*\/>$/, ' w:' + name + '="' + value + '"/>' );
    }

    // An attribute in an element's start tag: w:<name>="..." or null.
    function attrIn( head, name )
    {
        const m = new RegExp( '\\sw:' + name + '="([^"]*)"' ).exec( head );
        return m ? m[ 1 ] : null;
    }

    function escAttr( v )
    {
        return String( v ).replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );
    }

    //---- LIST NUMBER FORMAT --------------------------------------------------
    //
    // "1, 2, 3" -> "a, b, c" for one level of one list. The engine has no command
    // for it (2.21.0), so it is done where Word keeps it: word/numbering.xml.
    //
    // A paragraph names its list by w:numId; that w:num points at a w:abstractNum,
    // whose w:lvl elements say how each level is numbered. Several w:num may
    // share one w:abstractNum, and patching it in place would restyle every list
    // that uses it - so when it is shared, it is CLONED (a new abstractNumId and
    // nsid) and only this list's w:num is pointed at the clone, which is what
    // Word does. Every paragraph of the list follows its w:num; document.xml is
    // not touched.
    //
    // These run on what the ENGINE saved (editor.save()), so the prefixes are the
    // engine's own: w: and w14:.

    function parts( bytes, names )
    {
        return z.unzipSync( bytes, { filter: function( f ) { return names.indexOf( f.name ) >= 0; } } );
    }

    // The numbered list the paragraph with this w14:paraId is in, straight from
    // its own w:numPr (a list that comes only from a style is not handled):
    //   { numId, ilvl, formats: [ 'decimal', 'lowerLetter', ... ] }   one per level
    // or null.
    function listInfo( bytes, paraId )
    {
        const f   = parts( bytes, [ 'word/document.xml', 'word/numbering.xml' ] );
        const doc = f[ 'word/document.xml' ], num = f[ 'word/numbering.xml' ];
        if( ! doc || ! num || ! /^[0-9A-Fa-f]{8}$/.test( paraId || '' ) ) return null;

        const xml = z.strFromU8( doc );
        const p   = new RegExp( '<w:p\\b[^>]*w14:paraId="' + paraId + '"[^>]*>\\s*<w:pPr>([\\s\\S]*?)</w:pPr>', 'i' ).exec( xml );
        const np  = p && /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec( p[ 1 ] );
        if( ! np ) return null;

        const numId = attrOf( np[ 1 ], 'numId' );
        const ilvl  = parseInt( attrOf( np[ 1 ], 'ilvl' ) || '0', 10 );
        if( ! numId || numId === '0' ) return null;          // numId 0 = "no list"

        const n = numbering( z.strFromU8( num ), numId );
        if( ! n ) return null;

        return { numId: numId, ilvl: ilvl, formats: n.levels.map( function( l ) { return l.fmt; } ) };
    }

    // The bytes with level `ilvl` of the list numbered `numFmt`, or null when the
    // list cannot be changed this way (its levels live in a numbering style).
    function withListFormat( bytes, info, ilvl, numFmt )
    {
        const files = z.unzipSync( bytes );
        const part  = files[ 'word/numbering.xml' ];
        if( ! part || ! info ) return null;

        let xml = z.strFromU8( part );
        const n = numbering( xml, info.numId );
        if( ! n || ! n.levels[ ilvl ] ) return null;

        // A level this w:num overrides with a w:lvl of its own belongs to this
        // list alone: patch it where it is.
        const over = n.overrides[ ilvl ];
        if( over )
        {
            xml = xml.slice( 0, over.at ) + patchLevel( over.xml, ilvl, numFmt ) + xml.slice( over.at + over.xml.length );
        }
        else
        {
            let abs = n.abs;

            if( n.shared )
            {
                const ids  = allMatches( xml, /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"/g ).map( Number );
                const next = String( Math.max.apply( null, ids.concat( [ 0 ] ) ) + 1 );

                const clone = abs.xml.replace( /(<w:abstractNum\b[^>]*w:abstractNumId=")\d+(")/, '$1' + next + '$2' )
                                     .replace( /(<w:nsid w:val=")[0-9A-Fa-f]+(")/, '$1' + nsid() + '$2' );

                // After the last w:abstractNum: the schema wants them all before any w:num.
                const lastEnd = xml.lastIndexOf( '</w:abstractNum>' ) + '</w:abstractNum>'.length;
                xml = xml.slice( 0, lastEnd ) + clone + xml.slice( lastEnd );

                // This list's w:num now points at the clone.
                xml = xml.replace( new RegExp( '(<w:num\\b[^>]*w:numId="' + info.numId + '"[^>]*>\\s*<w:abstractNumId w:val=")\\d+(")' ),
                                   '$1' + next + '$2' );

                abs = { xml: clone, at: lastEnd };
            }

            const lvl = levelsOf( abs.xml )[ ilvl ];
            const out = abs.xml.slice( 0, lvl.at ) + patchLevel( lvl.xml, ilvl, numFmt ) + abs.xml.slice( lvl.at + lvl.xml.length );
            xml = xml.slice( 0, abs.at ) + out + xml.slice( abs.at + abs.xml.length );
        }

        files[ 'word/numbering.xml' ] = z.strToU8( xml );
        return rezip( files );
    }

    // The w:num with this id and what it points at:
    //   { abs: { xml, at }, shared, levels: [ { fmt, xml, at } ], overrides: { ilvl: { xml, at } } }
    function numbering( xml, numId )
    {
        const num = new RegExp( '<w:num\\b[^>]*w:numId="' + numId + '"[^>]*>([\\s\\S]*?)</w:num>' ).exec( xml );
        if( ! num ) return null;

        const absId = attrOf( num[ 1 ], 'abstractNumId' );
        const abs   = new RegExp( '<w:abstractNum\\b[^>]*w:abstractNumId="' + absId + '"[^>]*>[\\s\\S]*?</w:abstractNum>' ).exec( xml );
        if( ! abs ) return null;
        if( /<w:numStyleLink\b/.test( abs[ 0 ] ) ) return null;     // levels live in a numbering style

        const users = allMatches( xml, /<w:num\b[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g ).filter( function( v ) { return v === absId; } );

        const overrides = {};
        const numStart  = num.index + num[ 0 ].indexOf( '>' ) + 1;
        const re = /<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>[\s\S]*?<\/w:lvlOverride>/g;
        let m;
        while( ( m = re.exec( num[ 1 ] ) ) )
        {
            const l = /<w:lvl\b[\s\S]*?<\/w:lvl>/.exec( m[ 0 ] );
            if( l ) overrides[ m[ 1 ] ] = { xml: l[ 0 ], at: numStart + m.index + l.index };
        }

        const levels = levelsOf( abs[ 0 ] ).map( function( l, i )
        {
            const src = overrides[ i ] ? overrides[ i ].xml : l.xml;
            return { fmt: attrOf( src, 'numFmt' ) || 'decimal', xml: l.xml, at: l.at };
        } );

        return { abs: { xml: abs[ 0 ], at: abs.index }, shared: users.length > 1, levels: levels, overrides: overrides };
    }

    // The w:lvl elements of an abstractNum, in ilvl order, with their offsets.
    function levelsOf( absXml )
    {
        const out = [];
        const re  = /<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>[\s\S]*?<\/w:lvl>/g;
        let m;
        while( ( m = re.exec( absXml ) ) ) out[ Number( m[ 1 ] ) ] = { xml: m[ 0 ], at: m.index };
        return out;
    }

    // One w:lvl with a new w:numFmt. Its w:lvlText is kept when it already holds
    // a number ("%1)" stays a parenthesis); a bullet's is replaced with "%n.",
    // and so is the bullet's symbol font, or the number would be drawn in it.
    function patchLevel( lvl, ilvl, numFmt )
    {
        const wasBullet = attrOf( lvl, 'numFmt' ) === 'bullet';

        lvl = /<w:numFmt\b[^>]*\/>/.test( lvl )
            ? lvl.replace( /<w:numFmt\b[^>]*\/>/, '<w:numFmt w:val="' + numFmt + '"/>' )
            : lvl.replace( /(<w:lvl\b[^>]*>(?:\s*<w:start\b[^>]*\/>)?)/, '$1<w:numFmt w:val="' + numFmt + '"/>' );

        const text = attrOf( lvl, 'lvlText' );
        if( text === null || text.indexOf( '%' ) < 0 )
        {
            const want = '<w:lvlText w:val="%' + ( ilvl + 1 ) + '."/>';
            lvl = /<w:lvlText\b[^>]*\/>/.test( lvl ) ? lvl.replace( /<w:lvlText\b[^>]*\/>/, want )
                                                    : lvl.replace( /(<w:numFmt\b[^>]*\/>)/, '$1' + want );
        }

        if( wasBullet ) lvl = lvl.replace( /<w:rFonts\b[^>]*\/>/g, '' );
        return lvl;
    }

    // w:<name> w:val="..." inside a piece of XML: the first one's value, or null.
    function attrOf( xml, name )
    {
        const m = new RegExp( '<w:' + name + '\\b[^>]*w:val="([^"]*)"' ).exec( xml );
        return m ? m[ 1 ] : null;
    }

    function allMatches( xml, re )
    {
        const out = [];
        let m;
        while( ( m = re.exec( xml ) ) ) out.push( m[ 1 ] );
        return out;
    }

    // A fresh w:nsid: eight hex digits, as Word writes them.
    function nsid()
    {
        return ( '0000000' + Math.floor( Math.random() * 0xFFFFFFFF ).toString( 16 ).toUpperCase() ).slice( -8 );
    }

    // XML parts deflated, the rest (images, fonts: already compressed) stored.
    function rezip( files )
    {
        const out = {};
        for( const name in files ) out[ name ] = [ files[ name ], { level: /\.(xml|rels)$/i.test( name ) ? 6 : 0 } ];
        return z.zipSync( out );
    }

    return { withHeadingStyles: withHeadingStyles, styleSpacing: styleSpacing, withStyles: withStyles,
             listInfo: listInfo, withListFormat: withListFormat };
}
