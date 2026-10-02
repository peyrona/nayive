/*
 * quirks.js - every place Write works around the editor engine, as data.
 *
 * Write rides the docx-editor.dev engine (lib/docx-editor/). Some of what it
 * does is not design, it is compensation: an event that fires when nothing was
 * edited, a class the engine needs on the host, a value it will not read back.
 * Those live here, one record each, carrying the version they were last checked
 * against, so that after an engine bump someone can say which are still needed:
 *
 *     tools/build-docx-editor.sh <new>
 *     CORPUS=<folder> node tools/docx-editor-smoke/smoke.mjs
 *     ...then walk this list: delete what the new version fixed, move
 *     verifiedOn on the rest.
 *
 * FIELDS
 *   id         what write.js reads it by: Q.someQuirk
 *   kind       'timing' - a wait or a synthetic event, value is ms (or a count/flag)
 *              'api'    - the engine's own API is missing or does not do what it says
 *              'note'   - not a workaround: something that WORKS, written down so
 *                         it is not re-derived
 *   what       one line, in plain words
 *   since      when it was first needed
 *   verifiedOn the last engine version it was CHECKED against - not guessed
 *   site       where in write.js / index.html it is used
 *
 * NOT in here: waits that are ours by choice, not the engine's - the 350 ms that
 * lets a toast paint before the modal print dialog freezes the page, the
 * setTimeout(0) that keeps a popup's own opening click from closing it. Those
 * are UI, and no engine version will ever "fix" them.
 */

export const QUIRKS =
[
    {
        id: 'loadFiresChange', kind: 'api', value: true,
        what: 'load() fires one change event of its own (revision 0) before it returns, although nothing was edited - so ready is false across a load and a change whose revision is not past the loaded one is not an edit.',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'loadIntoEditor, onChange'
    },
    {
        id: 'scrollContainerClasses', kind: 'note', value: true,
        what: 'the engine finds its viewport with closest(".docx-editor__scroll-container"); without that class (and .docx-editor) on the scroller the fit-to-width zoom has nothing to measure and a phone gets a 100 % page cut in half.',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'index.html, #editor'
    },
    {
        id: 'pageBackground', kind: 'api', value: true,
        what: 'the engine leaves .docx-page transparent (its React adapter paints it with a class of its own), so index.html paints the sheet white.',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'index.html, #editor .docx-page'
    },
    {
        id: 'noStyleCreation', kind: 'api', value: true,
        what: 'setParagraphStyle refuses a style the document does not define ("not a paragraph style of this document") and nothing public adds one, where Word adds its built-in definition on use. So Word\'s Heading 1-3 (from the engine\'s blank template) are written into styles.xml as a file opens (docx-patch.js).',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'withHeadings, docx-patch.js'
    },
    {
        id: 'footnoteReplacesSelection', kind: 'api', value: true,
        what: 'insert.footnote with text selected replaces that text with the note mark (Word keeps the text and puts the mark after it), and undo needs two steps to bring the text back. The footnote button and menu entry are greyed until the selection is a plain caret. Table, TOC keep the text; a page break replaces it, as in Word.',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'slotBlocked'
    },
    {
        id: 'replaceMatchUnsupported', kind: 'api', value: true,
        what: 'replaceMatch and replaceAllMatches (and replaceText, and insertText with a target) are refused: "not supported by the tree editor". What works: selectMatch( match ), then insertText with NO target - it replaces the selection, one undo step.',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'replaceMatch (spelling), find.js putOver'
    },
    {
        id: 'replaceAllOneStepPerMatch', kind: 'api', value: true,
        what: 'history grouping (beginHistoryGroup + exec options) refuses insertText ("does not support history grouping"), so Replace all is one undo step per match.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'find.js replaceAll'
    },
    {
        id: 'findAllScopes', kind: 'note', value: true,
        what: 'findMatches also returns matches in headers and footers, each with a `scope`; body matches have none (or kind "body"). The find bar keeps the body ones only.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'find.js find'
    },
    {
        id: 'hyperlinkOnSurface', kind: 'api', value: true,
        what: 'no command makes a link: the text.link slot is "not wired to an editor command" and insertHyperlink refuses a target ("a link applies at the selection"). editor.surface.hyperlinks (applyHyperlink / removeHyperlink / linkAtCaret) works - typed and exported, but `surface` is the engine\'s seam for hosts that need more than the command contract, so re-check it on a bump.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'links, openLinkDialog, confirmLink, showLinkMenu'
    },
    {
        id: 'imageInsertAsync', kind: 'note', value: true,
        what: 'exec( insertImage ) is refused ("insertImage is asynchronous; use executeImageCommand"): the bundle entry exports executeImageCommand (tools/build-docx-editor.sh) and Write awaits it.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'insertPickedImage'
    },
    {
        id: 'tableBordersOnSelectedCells', kind: 'api', value: true,
        what: 'setTableBorders acts on the selected cells - the caret\'s cell alone at a plain caret - and selectTableRegion (select the whole table) is "not supported by the tree editor"; a setSelection range from one cell\'s paragraph to another\'s reaches only the last cell. There is one inside target, no inside-horizontal / inside-vertical.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'applyTableBorderPreset, #tbPopup'
    },
    {
        id: 'pasteCaretBefore', kind: 'api', value: true,
        what: 'a paste carrying HTML (Ctrl+V of the engine\'s own copy, or the paste command with html) leaves the caret BEFORE the pasted text; a plain-text paste leaves it after. Write moves it to the end when the paste stayed on one line (read and set through surface.state() / setSelection with offsets).',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'caretAfterPaste'
    },
    {
        id: 'tabInTable', kind: 'api', value: true,
        what: 'Tab in a table cell types a tab character; Word goes to the next cell (Shift+Tab the one before, Tab in the last cell adds a row). Write does that itself.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'onTableTab, moveCell'
    },
    {
        id: 'noListFormatCommand', kind: 'api', value: true,
        what: 'no command sets a list level\'s number format (1, a, i ...): it is written into word/numbering.xml (docx-patch.js, the abstractNum cloned when shared) and the document loaded again - which clears the undo history (the dialog says so) and is not an edit (session.edited()).',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'applyListFormat, docx-patch.js withListFormat'
    },
    {
        id: 'noTypingHook', kind: 'api', value: true,
        what: 'nothing public sees a character before it is inserted, so autocorrect catches the typing in the DOM: the engine owns an ordinary contenteditable (.docx-pages, inside the container), every character arrives there as a beforeinput of inputType "insertText", and Write listens in the CAPTURE phase of the scroller above it. When a rule fires it takes the event over - preventDefault (or the browser writes the raw character into the painted page) and stopPropagation (or the engine inserts it too) - and execs insertText instead.',
        since: '2026-09-20', verifiedOn: '2.21.0', site: 'onBeforeInput'
    },
    {
        id: 'pageBreakNotRepainted', kind: 'api', value: true,
        what: 'insert.pageBreak WRITES the break correctly - <w:br w:type="page"/> at the caret, Word / LibreOffice honour it. Re-checked 2026-09-28 on three real files: in the middle of a document the pages repaint (every one of 18 places, at a paragraph\'s start or end; relayout() changes nothing). What does not: a break as the very LAST thing in the document gets no page of its own until something follows it, so the caret stays on the old page. Write then splits the paragraph after the break (editor.surface.splitParagraph - Word also puts a paragraph there): the new page appears with the caret on it, and undo takes two steps.',
        since: '2026-09-20', verifiedOn: '2.21.0', site: 'landAfterPageBreak (runSlot)'
    },
    {
        id: 'paintedDom', kind: 'api', value: true,
        what: 'nothing public says where a word is painted, so Write reads the engine\'s own page DOM: each run of text is a <span class="layout-run-text"> carrying data-paragraph-id (the surface\'s paragraph id, NOT the command contract\'s paraId) and data-start (where it starts in that paragraph), inside a .docx-page. The spelling underlines and its right-click, the find bar\'s marks, autocorrect\'s look back and the paste caret all read it; a bump that renames any of it breaks them quietly.',
        since: '2026-09-18', verifiedOn: '2.21.0', site: 'proofing-overlay.js, find.js paint, paintedText, onContextMenu'
    },
    {
        id: 'caretOffsetsOnSurface', kind: 'api', value: true,
        what: 'the command contract\'s selection names paragraphs only (snapshot().selection.from.paraId); the caret\'s offsets are in editor.surface.state().selection (anchor / head: paragraphId + offset), and setSelection takes that shape back. `surface` is the engine\'s seam for hosts, as with the links: re-check it on a bump.',
        since: '2026-09-19', verifiedOn: '2.21.0', site: 'caretNow, onBeforeInput, caretAfterPaste, landAfterPageBreak'
    }
];

// Q.loadFiresChange and friends - what write.js reads.
export const Q = Object.freeze( QUIRKS.reduce( function ( o, q ) { o[ q.id ] = q.value; return o; }, {} ) );
