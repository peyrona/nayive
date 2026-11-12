/*
 * file-kinds.js - which file extensions belong to which kind: the lists Drive
 * routes, draws and searches by, and the "Type" choices of both searches
 * (Drive's advanced search and the launcher's). One copy: Drive's listing.js,
 * open.js and upload.js read these names, never a list of their own.
 *
 * window.NayiveKinds = { WRITE_IMPORT, CALC_IMPORT, ARCHIVE_EXT, OFFICE_WRITE,
 *   OFFICE_CALC, OFFICE_REFUSE, TEXT_IMPORT, IMAGE_VIEW, VIDEO_VIEW, AUDIO_VIEW,
 *   CONVERT_EXT, kinds() }
 */
( function ()
{
    "use strict";

    // Extensions each tool can open/import (mirrors the accept="" of their import
    // inputs — see apps/write, apps/calc). Kept disjoint so a double-click routes
    // to exactly one tool.
    var WRITE_IMPORT = [ 'docx' ];
    var CALC_IMPORT  = [ 'xlsx', 'csv' ];
    // Compressed files: all get the zipper icon. Only the last part of the name
    // counts, so "x.tar.gz" is 'gz'.
    var ARCHIVE_EXT  = [ 'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz', 'lzma', 'z', 'cab', 'arj', 'lzh' ];
    // LibreOffice documents. Write and Calc cannot read them, so the server
    // makes a .docx / .xlsx twin beside the original (Drive's openOffice; keep
    // officeTwin in server/go/office.go the same lists). The other LibreOffice
    // kinds have no app here: they upload as they are (no twin) and a
    // double-click only says Nayive cannot open them: Impress, Draw, Math, Base.
    var OFFICE_WRITE  = [ 'odt', 'ott', 'fodt', 'sxw', 'stw' ];
    var OFFICE_CALC   = [ 'ods', 'ots', 'fods', 'sxc', 'stc' ];
    var OFFICE_REFUSE = [ 'odp', 'otp', 'fodp', 'sxi', 'sti',      // Impress
                          'odg', 'otg', 'fodg', 'sxd', 'std',      // Draw
                          'odf', 'sxm', 'odb' ];                   // Math, Base
    // Plain-text / code / markup files → the Text editor (see apps/text), which is
    // also the catch-all: it opens anything not owned by another tool and not a
    // known-binary type, so this list only steers the file-row ICON.
    var TEXT_IMPORT  =
    [
        'txt', 'log', 'une', 'model', 'md', 'markdown', 'mkd',
        'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts',
        'json', 'map', 'webmanifest', 'xml', 'xsl', 'xsd', 'svg', 'rss',
        'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env',
        'sh', 'bash', 'zsh', 'ksh', 'ps1', 'bat', 'sql',
        'py', 'pyw', 'r', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'java', 'cs', 'tex'
    ];
    // Raster images → an image opener. '.svg' is deliberately absent: it is
    // text (the server sends it as image/svg+xml), so it stays in TEXT_IMPORT
    // and opens in the Text editor. IMAGE_VIEW is every raster type the
    // lightbox shows, and the superset used for the file-row icon.
    var IMAGE_VIEW = [ 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif' ];
    // Audio / video → Drive's own player (browser-native <audio>/<video> controls,
    // view only, no editing). What actually plays depends on the browser's codecs.
    var VIDEO_VIEW = [ 'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv' ];
    var AUDIO_VIEW = [ 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba' ];
    // A video no browser can play, offered for conversion to MP4 on upload
    // (Drive's upload.js). Keep the same list as convertExts in server/go/convert.go.
    var CONVERT_EXT = [ 'avi', 'divx', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'vob',
                        'ts', 'm2ts', 'mts', '3gp', 'rm', 'rmvb', 'ogm', 'mkv', 'mov' ];

    // The "Type" choices of a search: id (its name is T('drive.kind.' + id))
    // and the extensions it finds; "dir" is folders.
    function kinds()
    {
        return [
            { id: 'dir'   },
            { id: 'doc',   exts: WRITE_IMPORT.concat( OFFICE_WRITE, [ 'doc', 'rtf' ] ) },
            { id: 'sheet', exts: CALC_IMPORT.concat( OFFICE_CALC, [ 'xls' ] ) },
            { id: 'pdf',   exts: [ 'pdf' ] },
            { id: 'img',   exts: IMAGE_VIEW.concat( [ 'heic', 'heif' ] ) },
            { id: 'video', exts: VIDEO_VIEW.concat( CONVERT_EXT ) },
            { id: 'audio', exts: AUDIO_VIEW },
            { id: 'code',  exts: TEXT_IMPORT },
            { id: 'zip',   exts: ARCHIVE_EXT }
        ];
    }

    window.NayiveKinds = {
        WRITE_IMPORT: WRITE_IMPORT, CALC_IMPORT: CALC_IMPORT, ARCHIVE_EXT: ARCHIVE_EXT,
        OFFICE_WRITE: OFFICE_WRITE, OFFICE_CALC: OFFICE_CALC, OFFICE_REFUSE: OFFICE_REFUSE,
        TEXT_IMPORT: TEXT_IMPORT, IMAGE_VIEW: IMAGE_VIEW, VIDEO_VIEW: VIDEO_VIEW,
        AUDIO_VIEW: AUDIO_VIEW, CONVERT_EXT: CONVERT_EXT, kinds: kinds
    };
} )();
