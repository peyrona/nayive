/* drag.js - reorder the stages by drag and drop. */

//------------------------------------------------------------------------//
// STAGE DRAG & DROP - reorder within the itinerary (Pointer Events, so mouse,
// touch and pen all work). Two ways in:
//   - the grip icon before each title: drag starts on pointerdown (any pointer);
//   - anywhere else on the card, mouse/pen only: press and move past a few px
//     promotes to a drag; a plain press-release stays a click and opens the
//     editor. Touch keeps using the grip so a swipe still scrolls the page.

let stageDragCtx    = null;
let stageDragEndedAt = 0;   // timestamp - the card click handler ignores clicks right after a drag

// Grip handle: reorder immediately.
function onStageDragStart( e, stageId )
{
    e.preventDefault();
    beginStageDrag( e.pointerId, e.clientX, e.clientY, stageId, e.currentTarget );
}

// Card body (mouse / pen): arm on press, promote to a drag only once the
// pointer travels past the click slop; otherwise let the click through.
function onStageCardPointerDown( e, stageId, cardEl )
{
    if( e.pointerType === 'touch' )                return;   // leave touch to scroll / the grip
    if( e.button !== 0 && e.pointerType === 'mouse' ) return;
    if( e.target.closest( 'a, button, .stage-drag' ) ) return;   // controls + grip handle themselves

    e.preventDefault();   // stop the press from selecting text mid-card

    const startX = e.clientX, startY = e.clientY, pid = e.pointerId;

    try { cardEl.setPointerCapture( pid ); } catch( _ ) {}

    function onMove( ev )
    {
        if( ev.pointerId !== pid ) return;

        if( Math.hypot( ev.clientX - startX, ev.clientY - startY ) < 6 )
            return;   // still within click slop - keep waiting

        detach();
        beginStageDrag( pid, ev.clientX, ev.clientY, stageId, cardEl );
    }

    function onUp( ev )
    {
        if( ev.pointerId === pid ) detach();   // never moved far enough -> the card's click fires next
    }

    function detach()
    {
        cardEl.removeEventListener( 'pointermove',   onMove );
        cardEl.removeEventListener( 'pointerup',     onUp );
        cardEl.removeEventListener( 'pointercancel', onUp );
    }

    cardEl.addEventListener( 'pointermove',   onMove );
    cardEl.addEventListener( 'pointerup',     onUp );
    cardEl.addEventListener( 'pointercancel', onUp );
}

function beginStageDrag( pointerId, clientX, clientY, stageId, captureEl )
{
    const itemEl = captureEl.closest( '.stage-item' );
    const rect   = itemEl.getBoundingClientRect();

    try { captureEl.setPointerCapture( pointerId ); } catch( _ ) {}

    const ghost = itemEl.cloneNode( true );
    ghost.classList.add( 'stage-drag-ghost' );
    ghost.style.width = rect.width + 'px';
    document.body.appendChild( ghost );
    positionStageGhost( ghost, clientX, clientY );

    stageDragCtx = { stageId: stageId, ghostEl: ghost, hoverItem: null, before: true };

    itemEl.classList.add( 'stage-dragging' );

    captureEl.addEventListener( 'pointermove',   onStageDragMove );
    captureEl.addEventListener( 'pointerup',     onStageDragEnd );
    captureEl.addEventListener( 'pointercancel', onStageDragCancel );
}

function positionStageGhost( ghost, clientX, clientY )
{
    ghost.style.transform = 'translate(' + (clientX + 12) + 'px,' + (clientY - 16) + 'px)';
}

function stageItemUnder( clientX, clientY, ghost )
{
    const prev = ghost.style.pointerEvents;
    ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint( clientX, clientY );
    ghost.style.pointerEvents = prev;

    return el ? el.closest( '.stage-item' ) : null;
}

function clearStageDropMarks()
{
    document.querySelectorAll( '.stage-item.drop-before, .stage-item.drop-after' )
        .forEach( function( el ) { el.classList.remove( 'drop-before', 'drop-after' ); } );
}

function onStageDragMove( e )
{
    if( ! stageDragCtx )
        return;

    positionStageGhost( stageDragCtx.ghostEl, e.clientX, e.clientY );
    clearStageDropMarks();

    const item = stageItemUnder( e.clientX, e.clientY, stageDragCtx.ghostEl );

    if( item && item.dataset.stageId !== String( stageDragCtx.stageId ) )
    {
        const r      = item.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;

        item.classList.add( before ? 'drop-before' : 'drop-after' );
        stageDragCtx.hoverItem = item;
        stageDragCtx.before    = before;
    }
    else
    {
        stageDragCtx.hoverItem = null;
    }
}

function onStageDragEnd( e )
{
    if( ! stageDragCtx )
        return;

    const ctx = stageDragCtx;

    cleanupStageDrag( e.currentTarget );

    if( ctx.hoverItem )
        reorderStage( ctx.stageId, ctx.hoverItem.dataset.stageId, ctx.before );
    else
        renderAll();   // dropped nowhere useful - just repaint to clear the drag state
}

function onStageDragCancel( e )
{
    if( ! stageDragCtx )
        return;

    cleanupStageDrag( e.currentTarget );
    renderAll();
}

function cleanupStageDrag( handle )
{
    if( stageDragCtx )
        stageDragCtx.ghostEl.remove();

    clearStageDropMarks();

    handle.removeEventListener( 'pointermove',   onStageDragMove );
    handle.removeEventListener( 'pointerup',     onStageDragEnd );
    handle.removeEventListener( 'pointercancel', onStageDragCancel );

    stageDragCtx = null;
    stageDragEndedAt = Date.now();   // swallow the click the browser fires right after the drop
}
