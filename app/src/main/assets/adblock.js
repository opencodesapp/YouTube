(() => {
  'use strict';

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log('[YT-Ad]', ...args);

  // ============================================================
  // Configuration
  // ============================================================

  const POLL_INTERVAL = 400;          // full ad-state re-evaluation
  const SKIP_POLL_INTERVAL = 150;     // dedicated fast loop for clicking Skip
  const SEEK_POLL_INTERVAL = 150;     // dedicated fast loop for seek-to-end attempts
  const VIDEO_ATTACH_INTERVAL = 1200;

  const AD_CONFIRM_DELAY = 250;
  const AD_END_GRACE = 800;

  const SKIP_CLICK_INTERVAL = 300;    // don't spam-click the same button
  const SEEK_RETRY_INTERVAL = 400;    // re-attempt seek if ad UI is still up
  const MAX_SEEK_ATTEMPTS = 5;        // give up on seeking after this many tries

  // Only used if seeking is blocked by the ad player AND no skip
  // button ever appears. Kept modest — high rates make the ad ->
  // main-video swap more likely to show a blank/black frame.
  const AD_PLAYBACK_RATE = 4;
  const FASTFORWARD_DELAY = 3000; // give seek+skip a real chance first

  // Video is hidden (opacity 0) for this long max during the ad -> main
  // transition, then forced visible regardless, so a stuck detection
  // can't leave the screen blank forever.
  const TRANSITION_HIDE_MAX = 1200;

  // How often we check "is the real video actually ready now?" while
  // masked. This runs independently of the slower ad-state grace
  // period so we reveal the instant content is really back, instead
  // of staying hidden for the full AD_END_GRACE window.
  const REVEAL_CHECK_INTERVAL = 80;

  if (window.__ytAdBlockerActive) {
    log('already running, skipping re-init');
    return;
  }
  window.__ytAdBlockerActive = true;

  // ============================================================
  // Cosmetic ad UI hiding
  // ============================================================

  const style = document.createElement('style');
  style.dataset.ytAdBlockerStyle = '1';
  style.textContent = `
    .ytp-ad-module,
    .ytp-ad-image-overlay,
    .ytp-ad-overlay-container,
    .ytp-ad-message-container,
    .ytp-ad-player-overlay,
    .ytp-ad-text,
    .ytp-ad-preview-container,

    ytm-promoted-video-renderer,
    ytd-promoted-video-renderer,
    ytd-display-ad-renderer,
    ytd-ad-slot-renderer,
    ytm-companion-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-action-companion-ad-renderer,
    ytm-companion-slot,
    #masthead-ad,
    ytd-banner-promo-renderer,
    yt-mealbar-promo-renderer,

    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytm-rich-item-renderer:has(ad-slot-renderer),
    lazy-list > ad-slot-renderer {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }

    /* Masks the blank/black frame during the ad -> main-video handoff. */
    .yt-ad-blocker-hide-video {
      opacity: 0 !important;
      transition: opacity 120ms ease-out;
    }
  `;
  document.documentElement.appendChild(style);

  // ============================================================
  // State
  // ============================================================

  let video = null;
  let adActive = false;

  let lastDuration = NaN;
  let lastSrc = '';

  let adCandidateSince = 0;
  let adGoneSince = 0;
  let adStartedAt = 0;

  let lastSkipClick = 0;
  let lastPlayAttempt = 0;
  let lastSeekAttempt = 0;
  let seekAttemptCount = 0;

  let originalPlaybackRate = 1;

  let restoreTimeoutId = null;
  let transitionRevealTimeoutId = null;

  let attachedVideo = null;
  const boundUpdateAdState = () => updateAdState();

  let pollIntervalId = null;
  let skipPollIntervalId = null;
  let seekPollIntervalId = null;
  let revealPollIntervalId = null;
  let attachIntervalId = null;
  let mutationObserver = null;

  // ============================================================
  // Helpers
  // ============================================================

  function getVideo() {
    return (
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video')
    );
  }

  function getPlayer() {
    const v = getVideo();
    if (!v) return null;

    return (
      v.closest('#movie_player') ||
      v.closest('.html5-video-player') ||
      v.closest('ytm-player') ||
      v.parentElement
    );
  }

  function isFiniteDuration(v) {
    return Number.isFinite(v.duration) && v.duration > 0;
  }

  function isVideoReady(v) {
    return (
      v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      Number.isFinite(v.currentTime)
    );
  }

  function clearPendingRestore() {
    if (restoreTimeoutId !== null) {
      clearTimeout(restoreTimeoutId);
      restoreTimeoutId = null;
    }
  }

  // ------------------------------------------------------------
  // Transition hide/reveal
  // ------------------------------------------------------------

  function hideDuringTransition(v) {
    if (!v) return;
    v.classList.add('yt-ad-blocker-hide-video');

    if (transitionRevealTimeoutId !== null) {
      clearTimeout(transitionRevealTimeoutId);
    }

    transitionRevealTimeoutId = setTimeout(() => {
      transitionRevealTimeoutId = null;
      revealVideo(getVideo());
    }, TRANSITION_HIDE_MAX);
  }

  function revealVideo(v) {
    if (transitionRevealTimeoutId !== null) {
      clearTimeout(transitionRevealTimeoutId);
      transitionRevealTimeoutId = null;
    }
    if (v) v.classList.remove('yt-ad-blocker-hide-video');
  }

  // ------------------------------------------------------------
  // Fast, independent reveal check.
  //
  // hideDuringTransition() gets called the instant we *attempt* a
  // skip (click/seek), which is before we can be sure the ad is
  // actually gone. The official ad-gone detection (AD_END_GRACE)
  // is intentionally conservative to avoid flicker, which means
  // waiting for it to reveal the video would mask the screen far
  // longer than the real transition takes.
  //
  // This loop runs independently, checking only "is a real video
  // frame ready right now, with no ad UI showing" — as soon as
  // that's true, reveal immediately, regardless of what the slower
  // state machine has decided yet.
  // ------------------------------------------------------------

  function checkFastReveal() {
    const v = getVideo();
    if (!v) return;
    if (!v.classList.contains('yt-ad-blocker-hide-video')) return;

    if (!detectAdUI() && isVideoReady(v)) {
      revealVideo(v);
      log('fast reveal: real content ready');
    }
  }

  // ============================================================
  // Advertisement UI detection
  // ============================================================

  const AD_TEXT_SELECTORS =
    '.ytp-ad-text, .ytp-ad-message-container, .ytp-ad-overlay-container, .ytp-ad-simple-ad-badge';

  const STRONG_AD_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-preview-container',
    '.ytp-ad-message-container',
    '.ytp-ad-player-overlay',
    '.ytp-ad-text',
    '.ytp-ad-simple-ad-badge',
    '[class*="ad-showing"]',
    '.ad-showing'
  ];

  function detectAdUI() {
    const player = getPlayer();
    if (!player) return false;

    for (const selector of STRONG_AD_SELECTORS) {
      try {
        if (player.querySelector(selector)) return true;
      } catch (_) {}
    }

    try {
      const elements = player.querySelectorAll(AD_TEXT_SELECTORS);
      for (const element of elements) {
        const text = (element.textContent || '').toLowerCase();
        if (
          text.includes('advertisement') ||
          text.includes('sponsored') ||
          text.includes('skip ad') ||
          text.includes('skipads') ||
          text.includes('ad ·')
        ) {
          return true;
        }
      }
    } catch (_) {}

    return false;
  }

  // ============================================================
  // Supporting media detection
  // ============================================================

  function detectMediaChange(v) {
    const src = v.currentSrc || v.src || '';
    if (!lastSrc) {
      lastSrc = src;
      return false;
    }
    if (src && src !== lastSrc) {
      lastSrc = src;
      log('media source changed');
      return true;
    }
    return false;
  }

  function detectDurationChange(v) {
    if (!isFiniteDuration(v)) return false;

    const duration = v.duration;
    if (!Number.isFinite(lastDuration)) {
      lastDuration = duration;
      return false;
    }

    const difference = Math.abs(duration - lastDuration);
    lastDuration = duration;
    return difference > 5;
  }

  // ============================================================
  // Ad state
  // ============================================================

  function setAdActive(active, reason) {
    if (active === adActive) return;
    adActive = active;

    if (active) {
      log('▶ AD START:', reason || '');

      clearPendingRestore();
      adStartedAt = performance.now();
      seekAttemptCount = 0;

      const v = getVideo();
      if (v) {
        originalPlaybackRate = Number.isFinite(v.playbackRate)
          ? v.playbackRate
          : 1;
      }

      adCandidateSince = performance.now();
      adGoneSince = 0;
    } else {
      log('■ AD END:', reason || '');

      adCandidateSince = 0;
      adGoneSince = 0;
      seekAttemptCount = 0;

      restoreVideoPlayback();
    }
  }

  // ============================================================
  // Restore normal video playback
  // ============================================================

  function restoreVideoPlayback() {
    const v = getVideo();
    if (!v) return;

    hideDuringTransition(v);

    try {
      v.playbackRate = originalPlaybackRate > 0 ? originalPlaybackRate : 1;
    } catch (_) {}

    clearPendingRestore();

    restoreTimeoutId = setTimeout(() => {
      restoreTimeoutId = null;

      if (adActive) return;

      const currentVideo = getVideo();
      if (!currentVideo) return;

      if (!isVideoReady(currentVideo)) {
        log('main video not ready yet, waiting a bit longer');
        restoreTimeoutId = setTimeout(() => {
          restoreTimeoutId = null;
          const v2 = getVideo();
          if (v2 && !adActive) {
            if (v2.paused) v2.play().catch(() => {});
            revealVideo(v2);
          }
        }, 200);
        return;
      }

      try {
        currentVideo.playbackRate =
          originalPlaybackRate > 0 ? originalPlaybackRate : 1;
      } catch (_) {}

      if (currentVideo.paused) {
        currentVideo.play().catch(() => {});
      }

      revealVideo(currentVideo);
    }, 150);
  }

  // ============================================================
  // Main state machine
  // ============================================================

  function updateAdState() {
    const v = getVideo();

    if (!v) {
      if (adActive) setAdActive(false, 'video gone');
      video = null;
      return;
    }

    if (v !== video) {
      log('video element changed');
      video = v;

      lastDuration = NaN;
      lastSrc = v.currentSrc || v.src || '';

      adCandidateSince = 0;
      adGoneSince = 0;

      if (adActive) setAdActive(false, 'new video element');
    }

    const hasAdUI = detectAdUI();
    const mediaChanged = detectMediaChange(v);
    const durationChanged = detectDurationChange(v);

    if (hasAdUI) {
      adGoneSince = 0;

      if (!adCandidateSince) adCandidateSince = performance.now();

      if (!adActive && performance.now() - adCandidateSince >= AD_CONFIRM_DELAY) {
        setAdActive(true, 'ad UI confirmed');
      }
      return;
    }

    if (adActive) {
      if (!adGoneSince) adGoneSince = performance.now();

      if (performance.now() - adGoneSince >= AD_END_GRACE) {
        setAdActive(false, 'ad UI gone');
      }
      return;
    }

    if (mediaChanged || durationChanged) {
      log('media transition detected', { mediaChanged, durationChanged });
    }

    adCandidateSince = 0;
  }

  // ============================================================
  // Find skip button
  // ============================================================

  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.videoAdUiSkipButton'
  ];

  function findSkipButton() {
    for (const selector of SKIP_SELECTORS) {
      try {
        const button = document.querySelector(selector);
        if (button && button.offsetParent !== null) return button;
      } catch (_) {}
    }

    try {
      const buttons = document.querySelectorAll('button, .ytp-button');
      for (const button of buttons) {
        const text = (
          button.textContent ||
          button.getAttribute('aria-label') ||
          ''
        ).toLowerCase();

        if (/skip\s*(ad|ads)?/i.test(text) && button.offsetParent !== null) {
          return button;
        }
      }
    } catch (_) {}

    return null;
  }

  // ============================================================
  // Priority 1: click the real Skip button
  // ============================================================

  function trySkipClickOnly() {
    if (!adActive) return;

    const now = performance.now();
    if (now - lastSkipClick < SKIP_CLICK_INTERVAL) return;

    const skipButton = findSkipButton();
    if (!skipButton) return;

    try {
      // Mask proactively, right as we trigger the transition —
      // don't wait for the slower ad-gone detection to catch up.
      hideDuringTransition(getVideo());

      skipButton.click();
      lastSkipClick = now;
      log('clicked skip button');
    } catch (_) {}
  }

  // ============================================================
  // Priority 2: instant seek-to-end
  //
  // Jumping currentTime to (duration - epsilon) fires the video's
  // native 'ended' event immediately. YouTube's player treats that
  // exactly like the ad finishing on its own and advances straight
  // to the real video — no sped-up playback, no visible fast-
  // forward, and a much shorter window for the transition frame
  // than ramping playbackRate ever gave us.
  //
  // This only works while the underlying <video> element still
  // allows programmatic seeking, which is true for the vast
  // majority of YouTube's ad player. A few ad types (live-style or
  // server-stitched ads with duration = Infinity/NaN) can't be
  // seeked this way — those fall through to the fast-forward
  // fallback below.
  // ============================================================

  function trySeekSkip() {
    if (!adActive) return;
    if (seekAttemptCount >= MAX_SEEK_ATTEMPTS) return;

    const v = getVideo();
    if (!v) return;

    if (!isFiniteDuration(v)) return; // can't jump to "the end" of Infinity/NaN

    const now = performance.now();
    if (now - lastSeekAttempt < SEEK_RETRY_INTERVAL) return;

    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Already essentially at the end — nothing to do, let the
    // 'ended'/ad-UI-gone detection catch up.
    if (v.duration - v.currentTime < 0.25) return;

    try {
      lastSeekAttempt = now;
      seekAttemptCount += 1;

      // Mask proactively — the seek is about to trigger YouTube's
      // media swap, and that's what produces the blank frame.
      hideDuringTransition(v);

      v.currentTime = Math.max(0, v.duration - 0.05);
      log('seek-skip attempt', seekAttemptCount, '-> jumped to end of ad');
    } catch (_) {}
  }

  // ============================================================
  // Priority 3 (last resort): accelerate playback
  //
  // Only reached if seeking is blocked AND no skip button ever
  // shows up, and only after giving both a real chance first.
  // ============================================================

  function tryFastForwardFallback() {
    if (!adActive) return;

    const v = getVideo();
    if (!v) return;

    const now = performance.now();

    if (now - adStartedAt < FASTFORWARD_DELAY) return;
    if (findSkipButton()) return;          // let the click loop handle it
    if (isFiniteDuration(v)) return;       // let seek-skip handle it

    try {
      if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        v.playbackRate = AD_PLAYBACK_RATE;
      }
    } catch (_) {}

    if (v.paused && now - lastPlayAttempt > 1000) {
      lastPlayAttempt = now;
      v.play().catch(() => {});
    }
  }

  // ============================================================
  // Video event handling
  // ============================================================

  const VIDEO_EVENTS = [
    'durationchange',
    'loadedmetadata',
    'canplay',
    'canplaythrough',
    'emptied',
    'loadstart',
    'loadeddata',
    'play',
    'playing',
    'pause',
    'timeupdate',
    'ended'
  ];

  function detachVideoEvents(v) {
    if (!v) return;
    VIDEO_EVENTS.forEach((eventName) => {
      v.removeEventListener(eventName, boundUpdateAdState);
    });
    delete v.dataset.ytAdAttached;
  }

  function attachVideoEvents(v) {
    if (!v) return;

    if (v === attachedVideo && v.dataset.ytAdAttached === '1') return;

    if (attachedVideo && attachedVideo !== v) {
      detachVideoEvents(attachedVideo);
    }

    VIDEO_EVENTS.forEach((eventName) => {
      v.addEventListener(eventName, boundUpdateAdState, { passive: true });
    });

    v.dataset.ytAdAttached = '1';
    attachedVideo = v;

    log('attached video events');
  }

  // ============================================================
  // Mutation observer
  // ============================================================

  let mutationScheduled = false;

  function startObserver() {
    mutationObserver = new MutationObserver(() => {
      if (mutationScheduled) return;
      mutationScheduled = true;

      requestAnimationFrame(() => {
        mutationScheduled = false;
        updateAdState();
      });
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // ============================================================
  // Visibility / lifecycle handling
  // ============================================================

  function resumeAllVideos() {
    document.querySelectorAll('video').forEach((v) => {
      if (v.paused) v.play().catch(() => {});
    });
  }

  function handleVisibilityChange() {
    if (!document.hidden) return;
    resumeAllVideos();
  }

  function handlePageHide() {
    resumeAllVideos();
  }

  // ============================================================
  // Teardown
  // ============================================================

  function teardown() {
    if (pollIntervalId !== null) clearInterval(pollIntervalId);
    if (skipPollIntervalId !== null) clearInterval(skipPollIntervalId);
    if (seekPollIntervalId !== null) clearInterval(seekPollIntervalId);
    if (revealPollIntervalId !== null) clearInterval(revealPollIntervalId);
    if (attachIntervalId !== null) clearInterval(attachIntervalId);
    if (mutationObserver) mutationObserver.disconnect();
    clearPendingRestore();

    if (transitionRevealTimeoutId !== null) {
      clearTimeout(transitionRevealTimeoutId);
      transitionRevealTimeoutId = null;
    }

    if (attachedVideo) {
      detachVideoEvents(attachedVideo);
      revealVideo(attachedVideo);
    }

    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);

    style.remove();

    window.__ytAdBlockerActive = false;
    log('torn down');
  }
  window.__ytAdBlockerTeardown = teardown;

  // ============================================================
  // Startup
  // ============================================================

  startObserver();

  pollIntervalId = setInterval(() => {
    updateAdState();
    tryFastForwardFallback();
  }, POLL_INTERVAL);

  skipPollIntervalId = setInterval(trySkipClickOnly, SKIP_POLL_INTERVAL);
  seekPollIntervalId = setInterval(trySeekSkip, SEEK_POLL_INTERVAL);
  revealPollIntervalId = setInterval(checkFastReveal, REVEAL_CHECK_INTERVAL);

  attachIntervalId = setInterval(() => {
    const v = getVideo();
    if (v) attachVideoEvents(v);
  }, VIDEO_ATTACH_INTERVAL);

  document.addEventListener('visibilitychange', handleVisibilityChange, {
    passive: true
  });
  window.addEventListener('pagehide', handlePageHide, { passive: true });

  updateAdState();

  const initialVideo = getVideo();
  if (initialVideo) attachVideoEvents(initialVideo);

  log('Mobile WebView ad handling ready (seek-skip priority mode)');
})();