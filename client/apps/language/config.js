/*
 * config.js - Language: the initial catalog (design document, sections 4.1
 * and 6). The user's changes live in localStorage (settings.js) and are
 * applied on top of this by id; a new engine added here shows up for
 * everyone on the next load, even over an old saved configuration.
 *
 * Order of preference (score): Chrome's built-in translator, then Bergamot
 * (on the device, any modern browser), then MyMemory (internet). An own
 * server (LibreTranslate) and Lingva are listed but off.
 */

export const CATALOG_VERSION = 1;

export const DEFAULT_ENGINES = [
    { id: 'chrome-builtin', name: 'Chrome',      adapter: 'chromeBuiltin',  enabled: true,  score: 5, timeoutMs: 20000, options: {} },
    { id: 'bergamot',       name: 'Bergamot',    adapter: 'bergamot',       enabled: true,  score: 4, timeoutMs: 60000, options: {} },
    { id: 'mymemory',       name: 'MyMemory',    adapter: 'mymemory',       enabled: true,  score: 3, timeoutMs: 15000, options: { email: '' } },
    { id: 'own-server',     name: 'LibreTranslate', adapter: 'libretranslate', enabled: false, score: 2, timeoutMs: 20000, options: { baseUrl: '' } },
    { id: 'lingva',         name: 'Lingva',      adapter: 'lingva',         enabled: false, score: 1, timeoutMs: 15000, options: { baseUrl: '' } }
];

export const DEFAULT_DICTIONARIES = [
    { id: 'wiktionary', name: 'Wiktionary', enabled: true, location: 'remote' },
    { id: 'tatoeba',    name: 'Tatoeba',    enabled: true, location: 'remote' }
];

export const MAX_TEXT_LENGTH = 5000;

// The sentence "Test" translates in Settings.
export const TEST_SENTENCE = { es: 'Hola, ¿cómo estás?', fr: 'Bonjour, comment ça va ?', zh: '你好，你好吗？',
                               de: 'Hallo, wie geht es dir?', pt: 'Olá, como estás?' };

// BERGAMOT MODELS (checked 2026-10-28, Phase 0 - see docs/language-app.md).
// Mozilla publishes them in Remote Settings; the files come through our own
// /api/translate/model (Mozilla's file CDN sends no CORS header). Pinned:
// the newest version of each that the vendored engine (0.4.9) really runs -
// zh>en 2.1 and en>pt 2.1 crash it, 2.0 works. A pin missing upstream falls
// back to the old S3 registry (no Chinese there).
export const BERGAMOT = {
    records:  'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records',
    proxy:    '/api/translate/model?f=',
    s3:       'https://bergamot.s3.amazonaws.com/models/index.json',
    pins:     { 'es-en': '2.0', 'en-es': '2.1', 'fr-en': '2.0', 'en-fr': '2.0', 'zh-en': '2.0', 'en-zh': '2.2',
                'de-en': '2.0', 'en-de': '2.1', 'pt-en': '2.0', 'en-pt': '2.0' },
    // Mozilla spells Simplified Chinese "zh-Hans".
    code:     { zh: 'zh-Hans' }
};

// tesseract.js: vendored here; the language data comes from its usual CDN.
export const OCR_LIB = {
    worker: 'lib/tesseract_v7.0.0/worker.min.js',
    core:   'lib/tesseract_v7.0.0/',
    script: 'lib/tesseract_v7.0.0/tesseract.min.js'
};
