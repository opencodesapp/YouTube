(() => {
  'use strict';

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[YT-Ad]', ...args);

  // ============================================================
  // Configuration
  // ============================================================

  const POLL_INTERVAL = 600;
  const VIDEO_ATTACH_INTERVAL = 1200;

  const AD_CONFIRM_DELAY = 250;
  const AD_END_GRACE = 800;

  const SKIP_CLICK_INTERVAL = 500;

  // Keep this moderate. Very high playback rates can cause blank
  // frames during YouTube's ad -> main-video transition.
  const AD_PLAYBACK_RATE = 8;

  // Guard against a previous injection still running (e.g. WebView
  // re-injects the script on every navigation without a full reload).
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

  let lastSkipClick = 0;
  let lastPlayAttempt = 0;

  let originalPlaybackRate = 1;

  // Track pending restore timers so overlapping ad transitions
  // can't fight each other.
  let restoreTimeoutId = null;

  // Bookkeeping so we can detach listeners from stale video elements.
  let attachedVideo = null;
  const boundUpdateAdState = () => updateAdState();

  // Handles + intervals so everything can be torn down cleanly.
  let pollIntervalId = null;
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

  // ============================================================
  // Advertisement UI detection
  // ============================================================

  // Narrower, cheaper text-based selector set than a blanket
  // [class*="ad-"] scan, which can false-positive (e.g. "admin",
  // "adjacent") and is expensive on a large DOM.
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

      restoreVideoPlayback();
    }
  }

  // ============================================================
  // Restore normal video playback
  // ============================================================

  function restoreVideoPlayback() {
    const v = getVideo();
    if (!v) return;

    // Do NOT seek here — YouTube may still be switching from the
    // ad media to the actual video.
    try {
      v.playbackRate = originalPlaybackRate > 0 ? originalPlaybackRate : 1;
    } catch (_) {}

    clearPendingRestore();

    // Give the player a moment to load the actual video.
    restoreTimeoutId = setTimeout(() => {
      restoreTimeoutId = null;

      // If an ad started again in the meantime, bail — don't
      // stomp on the new ad's playback rate handling.
      if (adActive) return;

      const currentVideo = getVideo();
      if (!currentVideo) return;

      if (!isVideoReady(currentVideo)) {
        log('main video not ready yet');
        return;
      }

      // Re-assert the rate in case something else changed it
      // while we waited.
      try {
        currentVideo.playbackRate =
          originalPlaybackRate > 0 ? originalPlaybackRate : 1;
      } catch (_) {}

      if (currentVideo.paused) {
        currentVideo.play().catch(() => {});
      }
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

    // New video element
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

      // Wait a little before declaring the ad finished — avoids
      // immediately fighting YouTube's media transition.
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
  // Skip / accelerate advertisement
  // ============================================================

  function trySkipAd() {
    if (!adActive) return;

    const v = getVideo();
    if (!v) return;

    const now = performance.now();

    // 1. First priority: actual Skip button.
    if (now - lastSkipClick >= SKIP_CLICK_INTERVAL) {
      const skipButton = findSkipButton();
      if (skipButton) {
        try {
          skipButton.click();
          lastSkipClick = now;
          log('clicked skip button');
          return;
        } catch (_) {}
      }
    }

    // 2. No skip button: accelerate playback. We intentionally
    // don't touch currentTime — seeking during the ad -> main
    // transition can produce blank/black frames.
    try {
      if (isFiniteDuration(v) && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        v.playbackRate = AD_PLAYBACK_RATE;
      }
    } catch (_) {}

    // 3. Keep playing without hammering play().
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
    'timeupdate'
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

    // Detach from the previous element so listeners don't pile up
    // across SPA navigations that swap the <video> node.
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
  // Teardown (call window.__ytAdBlockerTeardown() if you ever
  // need to fully unload this, e.g. before re-injecting fresh).
  // ============================================================

  function teardown() {
    if (pollIntervalId !== null) clearInterval(pollIntervalId);
    if (attachIntervalId !== null) clearInterval(attachIntervalId);
    if (mutationObserver) mutationObserver.disconnect();
    clearPendingRestore();

    if (attachedVideo) detachVideoEvents(attachedVideo);

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
    trySkipAd();
  }, POLL_INTERVAL);

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

  log('Mobile WebView ad handling ready');
})();