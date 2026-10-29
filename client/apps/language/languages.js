/*
 * languages.js - Language: the language codes and how each engine spells them.
 *
 * The API speaks short codes: es, fr, zh, de, pt (and en, only as the pivot
 * some engines translate through - never offered to the user). Regional tags
 * (es-ES, pt-BR, zh-CN, FR) are normalized here; each adapter maps the short
 * code to its own spelling with the tables below.
 */

export const LANGS = [ 'es', 'fr', 'zh', 'de', 'pt' ];

// Speech voices (Web Speech API), OCR data (tesseract.js) and Tatoeba codes.
export const VOICE    = { es: 'es-ES', fr: 'fr-FR', zh: 'zh-CN', de: 'de-DE', pt: 'pt-PT' };
export const OCR      = { es: 'spa', fr: 'fra', zh: 'chi_sim', de: 'deu', pt: 'por' };
export const ISO639_3 = { es: 'spa', fr: 'fra', zh: 'cmn', de: 'deu', pt: 'por' };

// "es-ES" -> "es", "zh-Hans-CN" -> "zh", "EN" -> "en"; null when not ours.
export function normalizeLanguage( tag, withPivot )
{
    if( typeof tag !== 'string' ) return null;
    const code = tag.trim().toLowerCase().split( /[-_]/ )[ 0 ];
    if( LANGS.includes( code ) ) return code;
    return withPivot && code === 'en' ? 'en' : null;
}

// The name of a language in another language: Intl knows them all.
export function languageName( code, display )
{
    try
    {
        const n = new Intl.DisplayNames( [ display || 'es' ], { type: 'language' } ).of( code );
        return n ? n.charAt( 0 ).toLocaleUpperCase( display ) + n.slice( 1 ) : code;
    }
    catch( e ) { return code; }
}

// Every ordered pair of two different user languages.
export function allPairs()
{
    const out = [];
    for( const s of LANGS ) for( const t of LANGS ) if( s !== t ) out.push( [ s, t ] );
    return out;
}
