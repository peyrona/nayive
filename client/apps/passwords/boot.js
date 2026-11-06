/*
 * boot.js - Passwords: the one module. It waits for the dictionary (a
 * top-level await cannot sit in the classic files), then wires the page,
 * the store, the help and the auto re-read, and boots.
 */
await Ayni.i18n.ready;

loadUi();
applyTreeWidth();

// merge: a save over a file another device changed since is merged by the
// store with mergeFile (vault.js MERGE: sealed entries moved, never opened).
store = AyniStore.createStore( { apiBase: AyniNet.API_FILES, conflicts: true, merge: mergeFile } );

wireAll();
store.onState( Ayni.plug.listener() );
store.onMerged( onFileMerged );

// The plug's click and the focus / visibility re-reads. Not while a sheet is
// open, something is being dragged, or Argon2id is running.
AyniBoot.wireRefresh( { store: store, read: loadData, guard: function()
{
    return gateBusy || !! document.querySelector( 'dialog.panel[open]' ) || !! Ayni.dragIds();
} } );

Ayni.help( {
    title: 'Passwords',
    lead:  T( 'passwords.introLead' ),
    rows: [
        { icon: 'search', name: T( 'ui.search' ), text: T( 'passwords.introSearch' ), tour: { sel: '#searchBtn' } },
        { sel: '#addBtn',       text: T( 'passwords.introAdd' ) },
        { sel: '#lockBtn',      text: T( 'passwords.introLock' ) },
        { sel: '#newFolderBtn', text: T( 'passwords.introFolder' ) },
        { sel: '#moreBtn',      text: T( 'passwords.introMore' ) }
    ],
    tour: function()
    {
        // Only an open vault has these buttons to show.
        return isOpen() ? [ { sel: '#treePane, #treeBtn', text: T( 'passwords.tourTree' ) }, 'rows',
                            { use: 'pick', ghost: '#items, #emptyHint' }, { use: 'picked', ghost: '#items, #emptyHint' } ]
                        : [ { sel: '#gate .pw-gate-card', text: T( 'passwords.tourGate' ) } ];
    }
} );

await AyniBoot.boot( store, loadData );
