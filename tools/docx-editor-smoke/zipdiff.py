#!/usr/bin/env python3
"""zipdiff.py - two .docx files, compared part by part by MEANING, not by bytes.

    python3 tools/docx-editor-smoke/zipdiff.py original.docx saved.docx

Prints one JSON object: {same, total, changed, lost, added, blocks, problems}.
`blocks` is how many top-level blocks of the body (paragraphs, tables) differ
when word/document.xml changed - an edit in one paragraph should say 1.

Why not bytes: the engine re-serialises every XML part it keeps - no XML
declaration, namespaces sorted, prefixes renamed - so a byte compare calls
every part "changed" even when not one element moved. So each XML part is
parsed (namespace PREFIXES vanish, their URIs stay) and compared as a tree,
leaving out what carries no content:
  * w14:paraId / w14:textId (paragraph ids Word itself adds and renews),
  * xml:space, but ONLY where the text has no edge space - where it has one,
    dropping "preserve" makes Word eat the space, so there it still counts,
  * the ORDER of the prefixes in mc:Ignorable (it is a set),
  * whitespace-only text between elements (indentation), but never inside a
    leaf such as <w:t> </w:t>, where a lone space is content.
Binary parts (images, fonts) are compared byte for byte.

`problems` is a small integrity check of the SAVED file, the kind of thing that
makes Word refuse a document while lenient readers (pandoc) shrug:
  * an mc:Ignorable prefix the part's root does not declare,
  * a relationship whose internal target is missing from the zip,
  * an r:id / r:embed used in a part but absent from that part's .rels.
"""
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W14    = '{http://schemas.microsoft.com/office/word/2010/wordml}'
XMLNS  = '{http://www.w3.org/XML/1998/namespace}'
IGNORE = '{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable'
WS     = ' \t\r\n'      # XML's whitespace. NOT str.strip()'s: a no-break space is content


def tree( e ):
    attrs = []
    text  = e.text or ''
    for k, v in e.attrib.items():
        if k in ( W14 + 'paraId', W14 + 'textId' ):
            continue
        if k == XMLNS + 'space' and text == text.strip( WS ):
            continue
        if k == IGNORE:
            v = ' '.join( sorted( v.split() ) )
        attrs.append( ( k, v ) )
    kids = list( e )
    if kids and not text.strip( WS ):
        text = ''
    return ( e.tag, tuple( sorted( attrs ) ), text,
             tuple( ( tree( k ), '' if not ( k.tail or '' ).strip( WS ) else k.tail ) for k in kids ) )


def meaning( name, data ):
    if not ( name.endswith( '.xml' ) or name.endswith( '.rels' ) ):
        return data
    try:
        return tree( ET.fromstring( data ) )
    except ET.ParseError:
        return data                      # not XML after all (Synology's synoDoc.xml is JSON): bytes


def rels_of( z, part ):
    d, b = posixpath.split( part )
    return posixpath.join( d, '_rels', b + '.rels' )


def problems( z ):
    out   = []
    names = set( z.namelist() )
    for n in sorted( names ):
        if not ( n.endswith( '.xml' ) or n.endswith( '.rels' ) ):
            continue
        text = z.read( n ).decode( 'utf-8', 'replace' )

        root = re.search( r'<[A-Za-z][^?!][^>]*>', text )
        if root:
            tag = root.group( 0 )
            ign = re.search( r'mc:Ignorable="([^"]*)"', tag )
            if ign:
                for p in ign.group( 1 ).split():
                    if f'xmlns:{p}=' not in tag:
                        out.append( f'{n}: mc:Ignorable names "{p}" but the root does not declare it' )

        if n.endswith( '.rels' ):
            base = posixpath.dirname( posixpath.dirname( n ) )
            for m in re.finditer( r'<Relationship [^>]*>', text ):
                r = m.group( 0 )
                if 'TargetMode="External"' in r:
                    continue
                t = re.search( r'Target="([^"]*)"', r ).group( 1 )
                full = t.lstrip( '/' ) if t.startswith( '/' ) else posixpath.normpath( posixpath.join( base, t ) )
                if full not in names:
                    out.append( f'{n}: target {t} is not in the zip' )
        else:
            used = set( re.findall( r'\br:(?:id|embed|link|pict)="([^"]*)"', text ) )
            if used:
                rp  = rels_of( z, n )
                ids = set( re.findall( r'Id="([^"]*)"', z.read( rp ).decode( 'utf-8', 'replace' ) ) ) if rp in names else set()
                for i in sorted( used - ids ):
                    out.append( f'{n}: uses {i}, not in {rp}' )
    return out


def main( a_path, b_path ):
    a, b = zipfile.ZipFile( a_path ), zipfile.ZipFile( b_path )
    an, bn = a.namelist(), set( b.namelist() )
    same, changed = [], []
    for n in an:
        if n in bn:
            ( same if meaning( n, a.read( n ) ) == meaning( n, b.read( n ) ) else changed ).append( n )
    blocks = 0
    if 'word/document.xml' in changed:
        body = lambda z: next( e for e in ET.fromstring( z.read( 'word/document.xml' ) ).iter() if e.tag.endswith( '}body' ) )
        x, y = list( body( a ) ), list( body( b ) )
        blocks = sum( tree( p ) != tree( q ) for p, q in zip( x, y ) ) + abs( len( x ) - len( y ) )
    print( json.dumps( { 'same': len( same ), 'total': len( an ), 'changed': changed, 'blocks': blocks,
                         'lost':  [ n for n in an if n not in bn ],
                         'added': sorted( bn - set( an ) ),
                         'problems': problems( b ) }, ensure_ascii = False ) )


if __name__ == '__main__':
    main( sys.argv[ 1 ], sys.argv[ 2 ] )
