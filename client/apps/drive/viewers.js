/*
 * viewers.js - Drive: the image viewer and the audio / video player. Pictures
 * are edited in Image (apps/image), a window of its own.
 */
"use strict";

//------------------------------------------------------------------------//
// BUILT-IN IMAGE VIEWER (lightbox; view only, never handed to an editor)

function openImageViewer( path )
{
    const name = path.split( '/' ).pop();
    const img  = document.getElementById( 'viewerImg' );

    img.src = GumApi.fileUrl( path );
    img.alt = name;
    document.getElementById( 'viewerName' ).textContent = name;

    setBackdrop( 'viewerBackdrop', true );
}

function closeImageViewer()
{
    setBackdrop( 'viewerBackdrop', false );
    document.getElementById( 'viewerImg' ).removeAttribute( 'src' );   // free the decoded bitmap
}

//------------------------------------------------------------------------//
// BUILT-IN AUDIO / VIDEO PLAYER (view only, never handed to an editor)

function openMediaViewer( path, kind )
{
    const name  = path.split( '/' ).pop();
    const url   = GumApi.fileUrl( path );
    const video = document.getElementById( 'mediaVideo' );
    const audio = document.getElementById( 'mediaAudio' );

    video.hidden = (kind !== 'video');
    document.getElementById( 'mediaAudioBox' ).hidden = (kind !== 'audio');

    const el = (kind === 'video') ? video : audio;
    el.src = url;
    el.load();

    document.getElementById( 'mediaName' ).textContent = name;
    setBackdrop( 'mediaBackdrop', true );
    el.play().catch( function() {} );   // autoplay may be blocked — controls still work
}

function closeMediaViewer()
{
    const video = document.getElementById( 'mediaVideo' );
    const audio = document.getElementById( 'mediaAudio' );

    video.pause(); audio.pause();
    video.removeAttribute( 'src' ); audio.removeAttribute( 'src' );
    video.load(); audio.load();   // drop the buffered stream

    setBackdrop( 'mediaBackdrop', false );
}
