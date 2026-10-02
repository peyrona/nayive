/*
 * boot.js - Bookmarks: the one module. It waits for the dictionary (a
 * top-level await cannot sit in the classic files), then wires the page,
 * the store, the help and the auto re-read, and boots. Last, ?add=<url>
 * (&title=) - what the "Save from any page" browser button sends - opens
 * the new-bookmark sheet with it.
 */
await NayiveI18n.ready;

loadUi();
applyTreeWidth();

// conflicts: a save over a file changed on another device since is held back
// and merged (model.js, TWO DEVICES) instead of overwriting it.
store = NayiveStore.createStore( { apiBase: GumApi.API_FILES, conflicts: true } );

wireAll();
store.onState( NayiveUI.syncIndicator() );
store.onConflict( function( path ) { if( path === FILE ) resolveConflict(); } );

// The plug's click and the focus / visibility re-reads. Not while a sheet
// is open or something is being dragged: the re-read repaints the list.
NayiveUI.wireRefresh( { store: store, read: loadData, guard: function()
{
    return !! document.querySelector( '.sheet-backdrop.open' ) || !! dragIds || merging;
} } );

NayiveUI.firstRun( {
    app:   'bookmarks',
    title: 'Bookmarks',
    lead:  T( 'bookmarks.introLead' ),
    buttons: [
        { icon: 'search', name: T( 'ui.search' ), text: T( 'bookmarks.introSearch' ) },
        { sel: '#addBtn',       text: T( 'bookmarks.introAdd' ) },
        { sel: '#newFolderBtn', text: T( 'bookmarks.introFolder' ) },
        { sel: '#moreBtn',      text: T( 'bookmarks.introMore' ) },
        { sel: '#gridBtn',      text: T( 'bookmarks.introGrid' ) },
        { sel: '#listBtn',      text: T( 'bookmarks.introList' ) },
        { sel: '#syncIndicator', name: T( 'ui.syncName' ), text: T( 'bookmarks.introSync' ) }
    ]
} );

await NayiveUI.bootWithStore( store, loadData );

// Only once the page is really up: a boot that goes to the login page, or
// reloads for the account's language, keeps ?add= for the next one.
const params = new URLSearchParams( window.location.search );
if( params.get( 'add' ) && document.getElementById( 'app' ).style.display !== 'none' )
{
    history.replaceState( null, '', window.location.pathname );
    openBookmarkSheet( null, { url: params.get( 'add' ), title: params.get( 'title' ) || '' } );
}
