// ==UserScript==
// @name         Thread Tracker
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  Tracks OTK threads on /b/, stores messages and media, shows top bar with colors and controls, removes inactive threads entirely
// @match        https://boards.4chan.org/b/
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(function() {
    'use strict';

function createStatsDisplayElements(statsWrapperParam) {
    const statsWrapper = statsWrapperParam || document.getElementById('otk-stats-wrapper');

    if (!statsWrapper) {
        consoleWarn('[createStatsDisplayElements] otk-stats-wrapper not found. Cannot create stats display.');
        return null;
    }

    // Check if stats display is already a child of statsWrapper
    if (statsWrapper.querySelector('#otk-stats-display')) {
        return;
    }

    const otkStatsDisplay = document.createElement('div');
    otkStatsDisplay.id = 'otk-stats-display';
    otkStatsDisplay.style.cssText = `
        font-size: 11px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        width: fit-content;
        min-width: 200px; /* Reserve space for (+n) */
    `;

    const threadsTrackedStat = document.createElement('div');
    threadsTrackedStat.id = 'otk-threads-tracked-stat';
    threadsTrackedStat.style.cssText = `
        display: flex;
        align-items: center;
        color: var(--otk-stats-text-color);
        min-width: 200px; /* Prevent shifting from (+n) */
        white-space: nowrap;
    `;

    const totalMessagesStat = document.createElement('div');
    totalMessagesStat.id = 'otk-total-messages-stat';
    totalMessagesStat.style.cssText = `
        display: flex;
        align-items: center;
        color: var(--otk-stats-text-color);
        min-width: 200px;
        white-space: nowrap;
    `;

    const localImagesStat = document.createElement('div');
    localImagesStat.id = 'otk-local-images-stat';
    localImagesStat.style.cssText = `
        display: flex;
        align-items: center;
        color: var(--otk-stats-text-color);
        min-width: 200px;
        white-space: nowrap;
    `;

    const localVideosStat = document.createElement('div');
    localVideosStat.id = 'otk-local-videos-stat';
    localVideosStat.style.cssText = `
        display: flex;
        align-items: center;
        color: var(--otk-stats-text-color);
        min-width: 200px;
        white-space: nowrap;
    `;

    otkStatsDisplay.appendChild(threadsTrackedStat);
    otkStatsDisplay.appendChild(totalMessagesStat);
    otkStatsDisplay.appendChild(localImagesStat);
    otkStatsDisplay.appendChild(localVideosStat);

    statsWrapper.appendChild(otkStatsDisplay);

    return otkStatsDisplay;
}

    // --- IIFE Scope Helper for Intersection Observer ---
    function handleIntersection(entries, observerInstance) {
        entries.forEach(entry => {
            const wrapper = entry.target;
            let iframe = wrapper.querySelector('iframe');

            if (entry.isIntersecting) {
                // Element is now visible
                if (!iframe) {
                    // If the iframe was removed, recreate it
                    const newIframe = document.createElement('iframe');
                    // Copy attributes from a template or stored config if necessary
                    // For now, assuming basic recreation is enough
                    newIframe.style.position = 'absolute';
                    newIframe.style.top = '0';
                    newIframe.style.left = '0';
                    newIframe.style.width = '100%';
                    newIframe.style.height = '100%';
                    newIframe.setAttribute('frameborder', '0');
                    newIframe.setAttribute('allowfullscreen', 'true');
                    if (wrapper.classList.contains('otk-twitch-embed-wrapper')) {
                        newIframe.setAttribute('scrolling', 'no');
                    } else if (wrapper.classList.contains('otk-youtube-embed-wrapper')) {
                        newIframe.setAttribute('allow', 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
                    }
                    newIframe.dataset.src = wrapper.dataset.embedUrl;
                    wrapper.innerHTML = '';
        if (window.twttr?.widgets?.load) {
            twttr.widgets.load(wrapper);
        } // Clear placeholder
                    wrapper.appendChild(newIframe);
                    iframe = newIframe;
                }

                if (iframe && iframe.dataset.src && (!iframe.src || iframe.src === 'about:blank')) {
                    consoleLog('[LazyLoad] Iframe is intersecting, loading src:', iframe.dataset.src);
                    iframe.src = iframe.dataset.src;
                }
                observerInstance.unobserve(wrapper);
            } else {
                // Element is no longer visible
                if (wrapper.classList.contains('otk-tweet-embed-wrapper')) {
                    return; // Do not unload tweet embeds
                }

                if (iframe && iframe.src && iframe.src !== 'about:blank') {
                    consoleLog('[LazyLoad] Iframe is no longer intersecting, removing iframe for:', iframe.src);

                    // For YouTube, try to pause the video before removing
                    if (iframe.contentWindow && iframe.src.includes("youtube.com/embed")) {
                        try {
                            iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', 'https://www.youtube.com');
                        } catch (e) {
                            consoleWarn('[LazyLoad] Error attempting to postMessage pause to YouTube:', e);
                        }
                    } else if (iframe.contentWindow && iframe.src.includes("twitch.tv")) {
                        try {
                            iframe.contentWindow.postMessage({"event": "video.pause"}, "*");
                        } catch (e) {
                            consoleWarn('[LazyLoad] Error attempting to postMessage pause to Twitch:', e);
                        }
                    }

                    // Store the embed URL on the wrapper if it's not already there
                    if (!wrapper.dataset.embedUrl) {
                        wrapper.dataset.embedUrl = iframe.dataset.src;
                    }

                    // Remove the iframe and add a placeholder
                    iframe.remove();
                    const placeholder = document.createElement('div');
                    placeholder.textContent = 'Embed hidden. Scroll to load.';
                    placeholder.style.cssText = `
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        width: 100%;
                        height: 100%;
                        background-color: #181818;
                        color: white;
                        font-size: 14px;
                    `;
                    wrapper.appendChild(placeholder);
                    observerInstance.observe(wrapper);
                }
            }
        });
    }

    let statAnimationFrameId = null;
let tabHidden = false;
let statAnimationTimers = [];

document.addEventListener("visibilitychange", () => {
  tabHidden = document.hidden;
  if (typeof updateTabTitle === 'function') updateTabTitle();
});

    // Constants for storage keys
    const THREADS_KEY = 'otkActiveThreads';
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';
    const DROPPED_THREADS_KEY = 'otkDroppedThreadIds';
    const BACKGROUND_UPDATES_DISABLED_KEY = 'otkBackgroundUpdatesDisabled';
    const DEBUG_MODE_KEY = 'otkDebugModeEnabled'; // For localStorage
    const LOCAL_IMAGE_COUNT_KEY = 'otkLocalImageCount';
    const LOCAL_VIDEO_COUNT_KEY = 'otkLocalVideoCount';
    const UNREAD_MESSAGE_IDS_KEY = 'otkUnreadMessageIds';
    const VIEWER_OPEN_KEY = 'otkViewerOpen'; // For viewer open/closed state
    const PINNED_MESSAGE_ID_KEY = 'otkPinnedMessageId'; // For storing pinned message ID
    const PINNED_MESSAGE_CLASS = 'otk-pinned-message'; // CSS class for highlighting pinned message
    const MAX_QUOTE_DEPTH = 2; // Maximum depth for rendering nested quotes
    const SEEN_EMBED_URL_IDS_KEY = 'otkSeenEmbedUrlIds'; // For tracking unique text embeds for stats
    const OTK_TRACKED_KEYWORDS_KEY = 'otkTrackedKeywords'; // For user-defined keywords
    const OTK_BG_UPDATE_FREQ_SECONDS_KEY = 'otkBgUpdateFrequencySeconds'; // For background update frequency
    const TWEET_EMBED_MODE_KEY = 'otkTweetEmbedMode'; // For tweet embed theme
    const TWEET_CACHE_KEY = 'otkTweetCache'; // For caching tweet HTML
    const MAIN_THEME_KEY = 'otkMainTheme';
    const THEME_SETTINGS_KEY = 'otkThemeSettings';
    const BLURRED_IMAGES_KEY = 'otkBlurredImages';
    const IMAGE_BLUR_AMOUNT_KEY = 'otkImageBlurAmount';
    const BLOCKED_THREADS_KEY = 'otkBlockedThreads';
    const FILTER_RULES_V2_KEY = 'otkFilterRulesV2';
    const OTK_BLOCKED_KEYWORDS_KEY = 'otkBlockedKeywords';
    const THREAD_TITLE_COLORS_KEY = 'otkThreadTitleColors';

    // --- Global variables ---
    let threadTitleAnimationInterval = null;
    let titleFlashingInterval = null;
    let threadTitleAnimationIndex = 0;
    let originalTitle = document.title;
    let currentTitlePrefix = '';
    let otkViewer = null;

    function updateTabTitle() {
        const totalMessagesStatNode = document.getElementById('otk-total-messages-stat');
        if (!totalMessagesStatNode) return;

        const newMessagesNode = totalMessagesStatNode.querySelector('#otk-stat-new-messages');
        const newRepliesNode = totalMessagesStatNode.querySelector('#otk-stat-new-replies');

        // Extract numbers to ensure consistent formatting
        const msgMatch = newMessagesNode?.textContent.match(/\d+/);
        const replyMatch = newRepliesNode?.textContent.match(/\d+/);
        const msgCount = msgMatch ? parseInt(msgMatch[0], 10) : 0;
        const replyCount = replyMatch ? parseInt(replyMatch[0], 10) : 0;

        let newPrefix = '';
        if (msgCount > 0 && replyCount > 0) {
            newPrefix = `(+${msgCount} | +${replyCount}) `;
        } else if (msgCount > 0) {
            newPrefix = `(+${msgCount}) `;
        } else if (replyCount > 0) {
            newPrefix = `(+${replyCount}) `;
        }

        // Robust base title sync
        const currentTitle = document.title;
        if (currentTitlePrefix && currentTitle.startsWith(currentTitlePrefix)) {
            const base = currentTitle.substring(currentTitlePrefix.length);
            if (base && base !== originalTitle) {
                originalTitle = base;
            }
        } else if (currentTitle !== originalTitle && !currentTitle.startsWith('(') && !currentTitle.startsWith('[Suspended]')) {
             originalTitle = currentTitle;
        }

        currentTitlePrefix = newPrefix;

        if (titleFlashingInterval) {
            clearInterval(titleFlashingInterval);
            titleFlashingInterval = null;
        }

        const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        const isFlashEnabled = themeSettings.tabTitleStatsAnimation === 'Flash';

        if (isFlashEnabled && newPrefix && document.hidden) {
            let showingPrefix = true;
            document.title = newPrefix + originalTitle;
            const speed = parseFloat(themeSettings.tabTitleStatsAnimationSpeed) || 1.0;
            titleFlashingInterval = setInterval(() => {
                showingPrefix = !showingPrefix;
                document.title = showingPrefix ? newPrefix + originalTitle : originalTitle;
            }, 1000 / speed);
        } else {
            document.title = newPrefix + originalTitle;
        }
    }
    let cityData = [];
    // Debug mode (load from localStorage, default to false)
    let DEBUG_MODE = localStorage.getItem(DEBUG_MODE_KEY) === null ? false : localStorage.getItem(DEBUG_MODE_KEY) === 'true';

    const consoleLog = (...args) => {
        if (DEBUG_MODE) {
            console.log('[OTK Tracker]', ...args);
        }
    };
    const consoleWarn = (...args) => {
        if (DEBUG_MODE) {
            console.warn('[OTK Tracker]', ...args);
        }
    };
    const consoleError = (...args) => {
        // Errors should probably always be logged, or at least have a separate toggle
        console.error('[OTK Tracker]', ...args);
    };

    let tweetCache = {};
    try {
        tweetCache = JSON.parse(localStorage.getItem(TWEET_CACHE_KEY)) || {};
    } catch (e) {
        consoleError("Error parsing tweet cache from localStorage:", e);
    }
    let viewerActiveImageCount = null; // For viewer-specific unique image count
    let viewerActiveVideoCount = null; // For viewer-specific unique video count
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    let handleGuiMouseMoveForArrows = null;
    let handleGuiMouseLeaveForArrows = null;
    let handleGuiMouseEnterForArrows = null;
    let isSuspended = false;
    const BACKGROUND_REFRESH_INTERVAL = 30000; // 30 seconds
    let lastViewerScrollTop = 0; // To store scroll position
    let renderedMessageIdsInViewer = new Set(); // To track IDs in viewer for incremental updates
    let uniqueImageViewerHashes = new Set(); // Global set for viewer's unique image hashes
    let threadFetchMetadata = {}; // For ETags / Last-Modified dates { threadId: { etag: "...", lastModified: "..." } }
    // let uniqueVideoViewerHashes = new Set(); // Removed as obsolete
    let viewerTopLevelAttachedVideoHashes = new Set(); // Viewer session: Hashes of ATTACHED videos in top-level messages
    let viewerTopLevelEmbedIds = new Set(); // Viewer session: Canonical IDs of EMBEDDED videos in top-level messages
    let renderedFullSizeImageHashes = new Set(); // Tracks image hashes already rendered full-size in current viewer session
    let mediaIntersectionObserver = null; // For lazy loading embeds
    let createdBlobUrls = new Set();
    let videoBlobUrlCache = new Map();
    let blurredImages = new Set();
    let blockedThreads = new Set();
    let cachedNewMessages = [];
    let multiQuoteSelections = new Set();
let userPostIds = new Set();
let unreadIds = new Set(JSON.parse(localStorage.getItem(UNREAD_MESSAGE_IDS_KEY) || '[]'));
let newReplyIds = new Set(JSON.parse(localStorage.getItem('otkNewReplyIds') || '[]'));

    // IndexedDB instance
    let otkMediaDB = null;

    // --- Loading Screen Elements Setup ---
    function setupLoadingScreen() {
        try {
            if (document.getElementById('otk-loading-overlay')) {
                consoleLog("Loading screen elements already exist.");
                return;
            }

            const overlay = document.createElement('div');
        overlay.id = 'otk-loading-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 89px; /* Height of otkGuiWrapper (85px) + border (4px) */
            left: 0;
            width: 100%;
            height: calc(100vh - 89px); /* Full viewport height minus GUI height */
            background-color: rgba(var(--otk-loading-overlay-bg-rgb, 0,0,0), var(--otk-loading-overlay-opacity, 0.8)); /* Use CSS variables */
            z-index: 100000; /* Ensure it's on top of everything, including viewer */
            display: none; /* Hidden by default */
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-family: Verdana, sans-serif;
            color: var(--otk-loading-text-color, white); /* Use CSS variable */
        `;

        const detailsElement = document.createElement('div');
        detailsElement.id = 'otk-loading-details';
        // Inherits color from parent overlay, specific text styling:
        detailsElement.style.cssText = `
            margin-bottom: 20px;
            font-size: 16px;
            white-space: pre-line; /* Allow \n to create line breaks */
            text-align: center; /* Ensure multi-line text is also centered */
        `;
        overlay.appendChild(detailsElement);

        const progressBarContainer = document.createElement('div');
        progressBarContainer.id = 'otk-progress-bar-container';
        progressBarContainer.style.cssText = `
            width: 60%;
            max-width: 400px;
            background-color: var(--otk-loading-progress-bar-bg-color, #333); /* Use CSS variable */
            border: 1px solid #555; /* Border color could also be a variable if needed */
            border-radius: 5px;
            padding: 2px;
        `;
        overlay.appendChild(progressBarContainer);

        const progressBar = document.createElement('div');
        progressBar.id = 'otk-progress-bar';
        progressBar.style.cssText = `
            width: 0%;
            height: 25px;
            background-color: var(--otk-loading-progress-bar-fill-color, #4CAF50); /* Use CSS variable */
            border-radius: 3px;
            text-align: center;
            line-height: 25px;
            color: var(--otk-loading-progress-bar-text-color, white); /* Use CSS variable */
            font-weight: bold;
            transition: width 0.3s ease;
        `;
        progressBarContainer.appendChild(progressBar);

        document.body.appendChild(overlay);
        consoleLog("Loading screen elements created and appended to body.");

        // Self-check diagnostics
        consoleLog('Attempting to verify loading screen elements immediately after creation:');
        consoleLog('  Overlay found by ID:', document.getElementById('otk-loading-overlay') !== null);
        consoleLog('  Details found by ID:', document.getElementById('otk-loading-details') !== null);
        consoleLog('  Progress bar container found by ID:', document.getElementById('otk-progress-bar-container') !== null);
        consoleLog('  Progress bar fill found by ID:', document.getElementById('otk-progress-bar') !== null);
        } catch (e) {
            consoleError('CRITICAL ERROR within setupLoadingScreen itself:', e);
        }
    }

    function showLoadingScreen(initialDetailsText = "Loading...") {
        const overlay = document.getElementById('otk-loading-overlay');
        const detailsElement = document.getElementById('otk-loading-details');
        const progressBarElement = document.getElementById('otk-progress-bar');

        if (!overlay || !detailsElement || !progressBarElement) {
            consoleError("Loading screen elements not found. Cannot show loading screen.");
            return;
        }

        detailsElement.textContent = initialDetailsText;
        progressBarElement.style.width = '0%';
        progressBarElement.textContent = '0%';
        overlay.style.display = 'flex'; // Use flex as per setupLoadingScreen styles
        consoleLog(`Loading screen shown. Details: ${initialDetailsText}`);
    }

    function hideLoadingScreen() {
        const overlay = document.getElementById('otk-loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            consoleLog("Loading screen hidden.");

            // As a final failsafe for the stuck button issue, find the refresh button and ensure its state is visually correct.
            const btnRefresh = document.getElementById('otk-refresh-data-btn');
            if (btnRefresh && !btnRefresh.disabled) {
                btnRefresh.classList.remove('otk-button--active');
                // Re-apply the base background color directly to override any lingering :active styles.
                btnRefresh.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-button-bg-color').trim();
            }
        } else {
            consoleWarn("Loading screen overlay not found when trying to hide.");
        }
    }

    function showSuspendedScreen() {
        const overlay = document.createElement('div');
        overlay.id = 'otk-suspended-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.9);
            z-index: 100001;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: Verdana, sans-serif;
            color: white;
            font-size: 24px;
        `;
        overlay.textContent = 'Thread Tracker is suspended due to inactivity.';
        document.body.appendChild(overlay);
        document.title = "[Suspended] " + originalTitle;
    }

    function hideSuspendedScreen() {
        const overlay = document.getElementById('otk-suspended-overlay');
        if (overlay) {
            overlay.remove();
        }
        document.title = originalTitle;
    }

    function updateLoadingProgress(percentage, detailsText) {
        const detailsElement = document.getElementById('otk-loading-details');
        const progressBarElement = document.getElementById('otk-progress-bar');

        if (!progressBarElement || !detailsElement) {
            consoleError("Progress bar or details element not found. Cannot update loading progress.");
            return;
        }

        percentage = Math.max(0, Math.min(100, parseFloat(percentage))); // Clamp percentage & ensure number

        progressBarElement.style.width = percentage + '%';
        progressBarElement.textContent = Math.round(percentage) + '%';

        if (detailsText !== undefined && detailsText !== null) { // Allow empty string to clear details
            detailsElement.textContent = detailsText;
        }
        consoleLog(`Loading progress: ${Math.round(percentage)}%, Details: ${detailsText === undefined ? '(no change)' : detailsText }`);
    }


    // --- IndexedDB Initialization ---


    // --- Media Embedding Helper Functions ---
function createYouTubeEmbedElement(videoId, timestampStr) {
    let startSeconds = 0;
    if (timestampStr) {
        if (timestampStr.match(/^\d+$/)) {
            startSeconds = parseInt(timestampStr, 10) || 0;
        } else {
            const timeParts = timestampStr.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?/);
            if (timeParts) {
                const hours = parseInt(timeParts[1], 10) || 0;
                const minutes = parseInt(timeParts[2], 10) || 0;
                const seconds = parseInt(timeParts[3], 10) || 0;
                if (hours > 0 || minutes > 0 || seconds > 0) {
                    startSeconds = (hours * 3600) + (minutes * 60) + seconds;
                } else if (timeParts[0] === timestampStr && !isNaN(parseInt(timestampStr, 10))) {
                    startSeconds = parseInt(timestampStr, 10) || 0;
                }
            }
        }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'otk-youtube-embed-wrapper otk-embed-inline';
    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0';
    wrapper.style.backgroundColor = '#000';
    wrapper.style.width = '480px';
    wrapper.style.height = '270px';

    const createIframe = (embedUrl) => {
        const iframe = document.createElement('iframe');
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allowfullscreen', 'true');
        iframe.setAttribute('allow', 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');

        const lazyLoadEnabled = (localStorage.getItem('otkLazyLoadYouTube') || 'true') === 'true';
        if (lazyLoadEnabled) {
            iframe.dataset.src = embedUrl;
            wrapper.innerHTML = '';
            wrapper.appendChild(iframe);
            if (mediaIntersectionObserver) {
                mediaIntersectionObserver.observe(wrapper);
            } else {
                consoleWarn("[LazyLoad] mediaIntersectionObserver not ready. Iframe will load immediately:", iframe.dataset.src);
                iframe.src = embedUrl;
            }
        } else {
            iframe.src = embedUrl;
            wrapper.innerHTML = '';
            wrapper.appendChild(iframe);
        }
    };

    const useFallback = (reason) => {
        consoleLog(`[YT Fallback] Using fallback for video ${videoId}. Reason: ${reason}`);
        const fallbackFormat = (JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {}).youtubeFallbackProviderFormat || 'https://invidious.tiekoetter.com/embed/{videoId}';
        let embedUrl = fallbackFormat.replace('{videoId}', videoId);
        if (startSeconds > 0) {
            embedUrl += (embedUrl.includes('?') ? '&' : '?') + `start=${startSeconds}`;
        }
        createIframe(embedUrl);
    };

    GM_xmlhttpRequest({
        method: 'GET',
        url: `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoId}&format=json`,
        onload: function(response) {
            if (response.status === 200) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.title === "This video is unavailable.") {
                        useFallback("oEmbed title indicates unavailable video.");
                        return;
                    }
                } catch (e) {
                    consoleWarn('[YT Fallback] Error parsing oEmbed response, assuming playable.', e);
                }
                let embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=0`;
                if (startSeconds > 0) {
                    embedUrl += `&start=${startSeconds}`;
                }
                createIframe(embedUrl);
            } else {
                useFallback(`oEmbed check failed with status ${response.status}`);
            }
        },
        onerror: function(error) {
            useFallback("oEmbed request failed.");
        }
    });

    const placeholder = document.createElement('div');
    placeholder.textContent = 'Loading YouTube embed...';
    placeholder.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        background-color: #181818;
        color: white;
        font-size: 14px;
    `;
    wrapper.appendChild(placeholder);

    return wrapper;
}

// Helper function for processing text segments (either append as text or handle as quote)
function appendTextOrQuoteSegment(textElement, segment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises, parentMessageId) {
    // Note: mediaLoadPromises is passed down in case quote recursion generates media elements that need tracking.
    // However, createMessageElementDOM for quotes currently passes an empty array for it. This could be enhanced.
    const quoteMatch = segment.match(quoteRegex);

    if (quoteMatch && segment.startsWith(quoteMatch[0])) { // Process as quote only if segment starts with it
        // Handle quote (potentially recursive)
        if (currentDepth >= MAX_QUOTE_DEPTH) {
            // At max depth, display quote link as text or a placeholder, but don't recurse
            // To match original behavior of skipping pure ">>123" lines at max depth:
            if (segment === quoteMatch[0]) return; // Skip pure quote link if it's the entire segment

            // If "text >>123" or ">>123 text" at max depth, treat as text
            textElement.appendChild(document.createTextNode(segment));
            return;
        }

        // Not at max depth, so process the quote
        const quotedMessageId = quoteMatch[1];
        let quotedMessageObject = null;
        for (const threadIdKey in messagesByThreadId) {
            if (messagesByThreadId.hasOwnProperty(threadIdKey)) {
                const foundMsg = messagesByThreadId[threadIdKey].find(m => m.id === Number(quotedMessageId));
                if (foundMsg) {
                    quotedMessageObject = foundMsg;
                    break;
                }
            }
        }

        if (quotedMessageObject) {
            const quotedElement = createMessageElementDOM(
                quotedMessageObject,
                                mediaLoadPromises, // Pass down the array for mediaLoadPromises for quotes
                uniqueImageViewerHashes,
                // uniqueVideoViewerHashes, // Removed
                quotedMessageObject.board || boardForLink,
                false, // isTopLevelMessage = false for quotes
                currentDepth + 1,
                null, // threadColor is not used for quoted message accents
                parentMessageId // Pass the PARENT message's ID for the quote
            );
            if (quotedElement) {
                if (currentDepth >= MAX_QUOTE_DEPTH - 1 && !quotedMessageObject.text) {
                    return;
                }
                textElement.appendChild(quotedElement);
            }
        } else {
            const notFoundSpan = document.createElement('span');
            notFoundSpan.textContent = `>>${quotedMessageId} (Not Found)`;
            notFoundSpan.style.color = '#88ccee';
            notFoundSpan.style.textDecoration = 'underline';
            textElement.appendChild(notFoundSpan);
        }

        const restOfSegment = segment.substring(quoteMatch[0].length);
        if (restOfSegment.length > 0) {
            // Recursively process the rest of the segment for more quotes or text
            // This is important if a line is like ">>123 >>456 text"
            appendTextOrQuoteSegment(textElement, restOfSegment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises, parentMessageId);
        }
    } else {
        // Not a quote at the start of the segment (or not a quote at all), just plain text for this segment
        if (segment.length > 0) { // Ensure non-empty segment before creating text node
            textElement.appendChild(document.createTextNode(segment));
        }
    }
}

function createTwitchEmbedElement(type, id, timestampStr) {
    let embedUrl;
    const parentDomain = 'boards.4chan.org'; // Or dynamically get current hostname if needed for wider use

    if (type === 'clip_direct' || type === 'clip_channel') {
        embedUrl = `https://clips.twitch.tv/embed?clip=${id}&parent=${parentDomain}&autoplay=false`;
    } else if (type === 'vod') {
        let timeParam = '';
        if (timestampStr) {
            // Twitch expects format like 01h30m20s
            // The regex twitchTimestampRegex captures ((?:\d+h)?(?:\d+m)?(?:\d+s)?)
            // We need to ensure it's formatted correctly if only parts are present e.g. "30m10s" or "1h5s"
            // The regex already produces a string like "1h2m3s" or "45m" or "30s".
            // If it's just seconds, e.g. "120s", that's also valid.
            // If it's "120", it needs 's' appended. The regex ensures 's' if only seconds, or h/m present.
            // The regex `((?:\d+h)?(?:\d+m)?(?:\d+s)?)` might result in empty string if no t= is found.
            // And if t= is empty like `t=`, timestampStr would be empty.
            if (timestampStr.length > 0) { // Ensure timestampStr is not empty
                 timeParam = `&time=${timestampStr}`;
            }
        }
        embedUrl = `https://player.twitch.tv/?video=${id}&parent=${parentDomain}&autoplay=false${timeParam}`;
    } else {
        consoleError(`[EmbedTwitch] Unknown Twitch embed type: ${type}`);
        return document.createTextNode(`[Invalid Twitch Embed Type: ${type}]`);
    }

    const wrapper = document.createElement('div');
    // Apply common classes for potential shared styling, and specific for twitch
    wrapper.className = 'otk-twitch-embed-wrapper otk-embed-inline'; // All embeds are now 'inline' styled (fixed small size)

    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0'; // Consistent vertical margin
    wrapper.style.backgroundColor = '#181818'; // Twitchy background color

    // Universal fixed size for all embeds
    wrapper.style.width = '480px';
    wrapper.style.height = '270px'; // 16:9 aspect ratio for 480px width
    wrapper.dataset.embedUrl = embedUrl;

    const placeholder = document.createElement('div');
    placeholder.textContent = 'Twitch embed hidden. Scroll to load.';
    placeholder.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        background-color: #181818;
        color: white;
        font-size: 14px;
    `;
    wrapper.appendChild(placeholder);

    if (mediaIntersectionObserver) {
        mediaIntersectionObserver.observe(wrapper);
    } else {
        consoleWarn("[LazyLoad] mediaIntersectionObserver not ready. Twitch embed will not lazy load.");
    }

    return wrapper;
}

function createKickEmbedElement(clipId) {
    const embedUrl = `https://kick.com/embed/clip/${clipId}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'otk-kick-embed-wrapper otk-embed-inline';

    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0';
    wrapper.style.backgroundColor = '#111';

    wrapper.style.width = '480px';
    wrapper.style.height = '270px';

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('scrolling', 'no');

    const lazyLoadEnabled = (localStorage.getItem('otkLazyLoadKick') || 'true') === 'true';

    if (lazyLoadEnabled) {
        iframe.dataset.src = embedUrl;
        if (mediaIntersectionObserver) {
            mediaIntersectionObserver.observe(wrapper);
        } else {
            consoleWarn("[LazyLoad] mediaIntersectionObserver not ready. Iframe will load immediately:", iframe.dataset.src);
            iframe.src = iframe.dataset.src;
        }
    } else {
        iframe.src = embedUrl;
    }

    wrapper.appendChild(iframe);

    return wrapper;
}

function createTikTokEmbedElement(videoId) {
    const embedUrl = `https://www.tiktok.com/player/v1/${videoId}?autoplay=0`;

    const wrapper = document.createElement('div');
    wrapper.className = 'otk-tiktok-embed-wrapper otk-embed-inline';

    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0';
    wrapper.style.backgroundColor = '#000';

    wrapper.style.width = '325px';
    wrapper.style.height = '750px';

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('scrolling', 'no');

    const lazyLoadEnabled = (localStorage.getItem('otkLazyLoadTikTok') || 'true') === 'true';

    if (lazyLoadEnabled) {
        iframe.dataset.src = embedUrl;
        if (mediaIntersectionObserver) {
            mediaIntersectionObserver.observe(wrapper);
        } else {
            consoleWarn("[LazyLoad] mediaIntersectionObserver not ready. Iframe will load immediately:", iframe.dataset.src);
            iframe.src = iframe.dataset.src;
        }
    } else {
        iframe.src = embedUrl;
    }

    wrapper.appendChild(iframe);

    return wrapper;
}

function createStreamableEmbedElement(videoId) {
    // Streamable embed URL format is typically https://streamable.com/e/VIDEO_ID
    // Attempting to add loop=0 to disable looping.
    const embedUrl = `https://streamable.com/e/${videoId}?loop=0`;

    const wrapper = document.createElement('div');
    wrapper.className = 'otk-streamable-embed-wrapper otk-embed-inline'; // Common class for fixed-size embeds

    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0';     // Consistent vertical margin
    wrapper.style.backgroundColor = '#111'; // Dark background for Streamable

    // Universal fixed size for all embeds
    wrapper.style.width = '480px';
    wrapper.style.height = '270px'; // Assuming 16:9 for consistency, adjust if Streamable common aspect is different

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('scrolling', 'no');

    const lazyLoadEnabled = (localStorage.getItem('otkLazyLoadStreamable') || 'true') === 'true';

    if (lazyLoadEnabled) {
        iframe.dataset.src = embedUrl;
        if (mediaIntersectionObserver) {
            mediaIntersectionObserver.observe(wrapper);
        } else {
            consoleWarn("[LazyLoad] mediaIntersectionObserver not ready. Iframe will load immediately:", iframe.dataset.src);
            iframe.src = iframe.dataset.src;
        }
    } else {
        iframe.src = embedUrl;
    }

    wrapper.appendChild(iframe);

    return wrapper;
}


function createTweetEmbedElement(tweetId) {
    const tweetUrl = `https://twitter.com/any/status/${tweetId}`;
    const link = document.createElement('a');
    link.href = tweetUrl;
    link.textContent = tweetUrl;
    link.target = '_blank';
    return link;
}



    // --- Data Handling & Utility Functions ---
    function decodeAllHtmlEntities(html) {
        if (typeof html !== 'string' || html.length === 0) return '';
        let decoded = html;
        // Loop twice to handle cases like &amp;#039; -> &#039; -> '
        for (let i = 0; i < 2; i++) {
            const txt = document.createElement('textarea');
            txt.innerHTML = decoded;
            if (txt.value === decoded) { // If no change, decoding is complete for this pass
                break;
            }
            decoded = txt.value;
        }
        return decoded;
    }

    function toTitleCase(str) {
        if (!str) return '';
        let title = str.toLowerCase().replace(/\b\w/g, s => s.toUpperCase());
        // Special case for 'OTK'
        title = title.replace(/\botk\b/gi, 'OTK');
        return title;
    }

    function getAllMessagesSorted() {
        let allMessages = [];
        const allThreadIds = Object.keys(messagesByThreadId);
        for (const threadId of allThreadIds) {
            if (messagesByThreadId.hasOwnProperty(threadId) && Array.isArray(messagesByThreadId[threadId])) {
                allMessages = allMessages.concat(messagesByThreadId[threadId]);
            }
        }
        allMessages.sort((a, b) => a.time - b.time); // Sort by timestamp ascending
        consoleLog(`Collected and sorted ${allMessages.length} messages from all locally stored threads.`);
        return allMessages;
    }

    async function recalculateAndStoreMediaStats() {
        if (!otkMediaDB) {
            consoleWarn("Cannot recalculate media stats: IndexedDB not available.");
            // Ensure localStorage is at least zeroed out if DB isn't there
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0');
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0');
            return { imageCount: 0, videoCount: 0 };
        }

        consoleLog("Recalculating local media statistics from IndexedDB...");
        return new Promise((resolve, reject) => {
            let imageCount = 0;
            let videoCount = 0;

            const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
            const store = transaction.objectStore('mediaStore');
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const item = cursor.value;
                    if (item && item.ext) {
                        const ext = item.ext.toLowerCase();
                        if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                            imageCount++;
                        } else if (['.webm', '.mp4'].includes(ext)) {
                            videoCount++;
                        }
                    }
                    cursor.continue();
                } else {
                    // Cursor finished
                    localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, imageCount.toString());
                    localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, videoCount.toString());
                    consoleLog(`Recalculated stats: ${imageCount} images, ${videoCount} videos. Stored to localStorage.`);
                    resolve({ imageCount, videoCount });
                }
            };

            request.onerror = (event) => {
                consoleError("Error recalculating media stats from IndexedDB:", event.target.error);
                // Don't clear localStorage here, might have valid old counts. Or do? For safety, let's clear.
                localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0');
                localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0');
                reject(event.target.error);
            };
        });
    }

    async function initDB() {
        return new Promise((resolve, reject) => {
            consoleLog('Initializing IndexedDB...');
            const request = indexedDB.open('otkMediaDB', 3); // DB name and version - Incremented to 3

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                consoleLog(`Upgrading IndexedDB from version ${event.oldVersion} to ${event.newVersion}.`);
                if (!db.objectStoreNames.contains('mediaStore')) {
                    const store = db.createObjectStore('mediaStore', { keyPath: 'filehash' });
                    store.createIndex('threadId', 'threadId', { unique: false });
                    consoleLog('MediaStore object store created with filehash as keyPath and threadId index.');
                }
                if (!db.objectStoreNames.contains('messagesStore')) {
                    const messagesStore = db.createObjectStore('messagesStore', { keyPath: 'threadId' });
                    consoleLog('MessagesStore object store created with threadId as keyPath.');
                }
            };

            request.onsuccess = (event) => {
                otkMediaDB = event.target.result;
                consoleLog('IndexedDB initialized successfully.');
                resolve(otkMediaDB);
            };

            request.onerror = (event) => {
                consoleError('IndexedDB initialization error:', event.target.error);
                otkMediaDB = null; // Ensure it's null on error
                reject(event.target.error);
            };
        });
    }

    // Color palette for thread indicators
    const COLORS = [
        '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c',
        '#008080', '#e6beff', '#9A6324', '#800000',
        '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'
    ];

    // --- GUI Setup ---
    // Create GUI structure
    let otkGuiWrapper = document.getElementById('otk-tracker-gui-wrapper');
    let otkGui = document.getElementById('otk-tracker-gui');

    if (!otkGuiWrapper) {
        otkGuiWrapper = document.createElement('div');
        otkGuiWrapper.id = 'otk-tracker-gui-wrapper';
        otkGuiWrapper.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 89px; /* 85px for GUI + 4px for border */
            z-index: 9999;
            background: var(--otk-gui-bg-color);
            box-sizing: border-box;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        `;

        otkGui = document.createElement('div');
        otkGui.id = 'otk-tracker-gui';
        otkGui.style.cssText = `
            height: 85px;
            color: var(--otk-gui-text-color); /* This is now for general GUI text */
            font-family: Verdana, sans-serif;
            font-size: 14px;
            padding: 5px 28px;
            box-sizing: border-box;
            display: flex;
            align-items: stretch;
            user-select: none;
            position: relative;
            justify-content: space-between;
            z-index: 1;
        `;
        otkGuiWrapper.appendChild(otkGui);

        const borderDiv = document.createElement('div');
        borderDiv.style.cssText = `
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background-color: var(--otk-gui-bottom-border-color);
            z-index: 2;
        `;
        otkGuiWrapper.appendChild(borderDiv);


        document.body.style.paddingTop = '89px';
        document.body.style.margin = '0';
        document.body.insertBefore(otkGuiWrapper, document.body.firstChild);

        // Thread display container (left)
        const threadDisplayContainer = document.createElement('div');
        threadDisplayContainer.id = 'otk-thread-display-container';
        threadDisplayContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            padding-top: 3px;
            padding-bottom: 5px;
            max-width: 450px;
            flex-grow: 0;
            flex-shrink: 0;
            justify-content: center;
        `;
        otkGui.appendChild(threadDisplayContainer);

        // Center info container
        const centerInfoContainer = document.createElement('div');
        centerInfoContainer.id = 'otk-center-info-container';
        centerInfoContainer.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 0 10px;
            pointer-events: none;
        `;

        // Wrapper for title and stats to keep them left-aligned but centered as a block
        const statsWrapper = document.createElement('div');
        statsWrapper.id = 'otk-stats-wrapper';
        statsWrapper.style.cssText = `
            margin-bottom: 4px;
            display: flex;
            flex-direction: column;
            align-items: flex-start; /* Left-align title and stats */
            width: fit-content; /* Only as wide as needed */
            max-width: 250px; /* Prevent excessive width */
            pointer-events: auto;
        `;

        const otkThreadTitleDisplay = document.createElement('div');
        otkThreadTitleDisplay.id = 'otk-thread-title-display';
        otkThreadTitleDisplay.textContent = 'Thread Tracker 2.7';
        otkThreadTitleDisplay.style.cssText = `
            font-weight: bold;
            font-size: 14px;
            display: inline;
            color: var(--otk-title-text-color);
        `;

        const cogIcon = document.createElement('span');
        cogIcon.id = 'otk-settings-cog';
        cogIcon.innerHTML = '⚙';
        cogIcon.style.cssText = `
            font-size: 16px;
            margin-left: 10px;
            cursor: pointer;
            display: inline-block;
            color: var(--otk-cog-icon-color);
        `;
        cogIcon.title = "Open Settings";

        const titleContainer = document.createElement('div');
        titleContainer.style.cssText = `
            display: flex;
            align-items: baseline;
            justify-content: flex-start; /* Left-align title and cog */
            margin-bottom: 4px;
        `;
        titleContainer.appendChild(otkThreadTitleDisplay);
        titleContainer.appendChild(cogIcon);


        const otkStatsDisplay = document.createElement('div');
        otkStatsDisplay.id = 'otk-stats-display';
        otkStatsDisplay.style.cssText = `
            font-size: 11px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            width: fit-content;
            min-width: 200px; /* Reserve space for (+n) */
        `;

        const threadsTrackedStat = document.createElement('div');
        threadsTrackedStat.id = 'otk-threads-tracked-stat';
        threadsTrackedStat.style.cssText = `
            display: flex;
            align-items: center;
            color: var(--otk-stats-text-color);
            min-width: 200px; /* Prevent shifting from (+n) */
            white-space: nowrap;
        `;

        const totalMessagesStat = document.createElement('div');
        totalMessagesStat.id = 'otk-total-messages-stat';
        totalMessagesStat.style.cssText = `
            display: flex;
            align-items: center;
            color: var(--otk-stats-text-color);
            min-width: 200px;
            white-space: nowrap;
        `;

        const localImagesStat = document.createElement('div');
        localImagesStat.id = 'otk-local-images-stat';
        localImagesStat.style.cssText = `
            display: flex;
            align-items: center;
            color: var(--otk-stats-text-color);
            min-width: 200px;
            white-space: nowrap;
        `;

        const localVideosStat = document.createElement('div');
        localVideosStat.id = 'otk-local-videos-stat';
        localVideosStat.style.cssText = `
            display: flex;
            align-items: center;
            color: var(--otk-stats-text-color);
            min-width: 200px;
            white-space: nowrap;
        `;

        otkStatsDisplay.appendChild(threadsTrackedStat);
        otkStatsDisplay.appendChild(totalMessagesStat);
        otkStatsDisplay.appendChild(localImagesStat);
        otkStatsDisplay.appendChild(localVideosStat);

        statsWrapper.appendChild(titleContainer);
        statsWrapper.appendChild(otkStatsDisplay);
        centerInfoContainer.appendChild(statsWrapper);
        otkGui.appendChild(centerInfoContainer);

        // Button container (right)
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'otk-button-container';
        buttonContainer.style.cssText = `
            display: flex;
            flex-direction: column;     /* Stack children vertically */
            align-items: flex-end;      /* Align children (top/bottom rows) to the right */
            justify-content: center;    /* Center the buttons vertically */
            gap: 5px;                   /* Small gap between top and bottom rows if needed */
            height: 100%;               /* Occupy full height of parent for space-between */
        `;
        otkGui.appendChild(buttonContainer);

        // Scroll buttons
        const scrollButtonContainer = document.createElement('div');
        scrollButtonContainer.id = 'otk-scroll-button-container';
        scrollButtonContainer.style.cssText = `
            display: none; /* Hidden by default */
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 10px;
            position: fixed;
            right: 7px;
            top: 95px; /* Position it just below the GUI bar */
            z-index: 9998;
        `;

        const scrollTopButton = document.createElement('div');
        scrollTopButton.id = 'otk-scroll-top-btn';
        scrollTopButton.innerHTML = '&#9650;'; // Chevron Up
        scrollTopButton.title = 'Scroll to top';
        scrollTopButton.style.cssText = `
            cursor: pointer;
            font-size: 16px;
            color: var(--otk-scroll-top-bottom-icon-color, var(--otk-gui-text-color));
        `;

        const scrollBottomButton = document.createElement('div');
        scrollBottomButton.id = 'otk-scroll-bottom-btn';
        scrollBottomButton.innerHTML = '&#9660;'; // Chevron Down
        scrollBottomButton.title = 'Scroll to bottom';
        scrollBottomButton.style.cssText = `
            cursor: pointer;
            font-size: 16px;
            color: var(--otk-scroll-top-bottom-icon-color, var(--otk-gui-text-color));
        `;

        scrollButtonContainer.appendChild(scrollTopButton);
        scrollButtonContainer.appendChild(scrollBottomButton);
        otkGui.appendChild(scrollButtonContainer);
    } else { // If GUI wrapper exists, ensure consistency
        if (document.body.style.paddingTop !== '89px') {
            document.body.style.paddingTop = '89px';
        }

        if (!otkGui) { // Re-create otkGui if missing
            otkGui = document.createElement('div');
            otkGui.id = 'otk-tracker-gui';
            // Apply styles as in initial creation
            otkGui.style.cssText = `
                height: 85px;
                color: var(--otk-gui-text-color); /* This is now for general GUI text */
                font-family: Verdana, sans-serif;
                font-size: 14px;
                padding: 5px 28px;
                box-sizing: border-box;
                display: flex;
                align-items: stretch;
                user-select: none;
            `;
            otkGuiWrapper.appendChild(otkGui);
        }

        // Ensure sub-containers exist
        if (!document.getElementById('otk-thread-display-container')) {
            const threadDisplayContainer = document.createElement('div');
            threadDisplayContainer.id = 'otk-thread-display-container';
            // Apply styles
             threadDisplayContainer.style.cssText = `
                display: flex;
                flex-direction: column;
                justify-content: flex-start;
                padding-top: 3px;
                padding-bottom: 5px;
                max-width: 450px;
                flex-grow: 0;
                flex-shrink: 0;
                justify-content: center;
            `;
            const existingButtonContainer = otkGui.querySelector('#otk-button-container');
            if (existingButtonContainer) {
                otkGui.insertBefore(threadDisplayContainer, existingButtonContainer);
            } else {
                otkGui.appendChild(threadDisplayContainer);
            }
        }

        if (!document.getElementById('otk-center-info-container')) {
            const centerInfoContainer = document.createElement('div');
            centerInfoContainer.id = 'otk-center-info-container';
            // Apply styles
            centerInfoContainer.style.cssText = `
                flex-grow: 1; /* Ensures it takes available space */
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center; /* Center the new parent container vertically */
                color: white;
                text-align: center;
                padding: 0 10px;
            `;
            consoleLog('[GUI Setup - Reconstruction] centerInfoContainer.style.flexGrow explicitly set to 1.');

            const otkThreadTitleDisplay = document.createElement('div');
            otkThreadTitleDisplay.id = 'otk-thread-title-display';
            otkThreadTitleDisplay.textContent = 'Thread Tracker 2.7'; // Updated version
            otkThreadTitleDisplay.style.cssText = `
                font-weight: bold; font-size: 14px; display: inline;
                color: var(--otk-title-text-color); /* Apply specific color variable */
            `; // Removed margin-bottom, display inline

            const cogIcon = document.createElement('span');
            cogIcon.id = 'otk-settings-cog'; // Ensure ID is consistent if needed for re-binding
            cogIcon.innerHTML = '&#x2699;';
            cogIcon.style.cssText = `
                font-size: 16px; margin-left: 10px; cursor: pointer; display: inline-block; vertical-align: middle; color: var(--otk-cog-icon-color);
            `;
            cogIcon.title = "Open Settings";
            // Note: Event listener for cog a V2 feature, or needs to be re-attached if GUI is rebuilt this way.
            // For now, just ensuring structure. If setupOptionsWindow is called after this, it might re-bind.

            const titleAndStatsContainer = document.createElement('div');
            titleAndStatsContainer.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: center;
            `;

            const titleContainer = document.createElement('div');
            titleContainer.style.cssText = `
                display: flex; align-items: center; justify-content: center; margin-bottom: 4px;
            `;
            titleContainer.appendChild(otkThreadTitleDisplay);
            titleContainer.appendChild(cogIcon);

            const otkStatsDisplay = document.createElement('div');
            otkStatsDisplay.id = 'otk-stats-display';
            otkStatsDisplay.style.cssText = `
                font-size: 11px;
                display: flex;
                flex-direction: column;
                align-items: flex-start; /* Left-align the stats */
                width: fit-content; /* Make block only as wide as its content */
            `;

            const threadsTrackedStat = document.createElement('div');
            threadsTrackedStat.id = 'otk-threads-tracked-stat';
            threadsTrackedStat.style.display = 'flex';

            const totalMessagesStat = document.createElement('div');
            totalMessagesStat.id = 'otk-total-messages-stat';
            totalMessagesStat.style.display = 'flex';

            const localImagesStat = document.createElement('div');
            localImagesStat.id = 'otk-local-images-stat';
            localImagesStat.style.display = 'flex';

            const localVideosStat = document.createElement('div');
            localVideosStat.id = 'otk-local-videos-stat';
            localVideosStat.style.display = 'flex';

            otkStatsDisplay.appendChild(threadsTrackedStat);
            otkStatsDisplay.appendChild(totalMessagesStat);
            otkStatsDisplay.appendChild(localImagesStat);
            otkStatsDisplay.appendChild(localVideosStat);

            titleAndStatsContainer.appendChild(titleContainer);
            titleAndStatsContainer.appendChild(otkStatsDisplay);
            centerInfoContainer.appendChild(titleAndStatsContainer);


            const existingButtonContainer = otkGui.querySelector('#otk-button-container');
            if (existingButtonContainer) {
                otkGui.insertBefore(centerInfoContainer, existingButtonContainer);
            } else {
                otkGui.appendChild(centerInfoContainer);
            }
        }

        if (!document.getElementById('otk-button-container')) {
            const buttonContainer = document.createElement('div');
            buttonContainer.id = 'otk-button-container';
            // Apply styles
            buttonContainer.style.cssText = `
                display: flex;
                align-items: flex-end; /* Consistent with initial creation */
                gap: 10px;
            `;
            buttonContainer.style.marginLeft = 'auto'; // Ensure right alignment
            consoleLog('[GUI Setup - Reconstruction] buttonContainer.style.marginLeft explicitly set to "auto".');
            otkGui.appendChild(buttonContainer);
        }
        // Update title if it exists and shows old version
        const titleDisplay = document.getElementById('otk-thread-title-display');
        if (titleDisplay && titleDisplay.textContent !== 'Thread Tracker 2.7') {
            titleDisplay.textContent = 'Thread Tracker 2.7';
        }
    }


    // --- Data Loading and Initialization ---
    function saveMessagesToDB(threadId, messages) {
        if (!otkMediaDB) {
            consoleError("DB not available, cannot save messages.");
            return Promise.reject("DB not available");
        }
        consoleLog(`Saving ${messages.length} messages for thread ${threadId} to DB.`);
        return new Promise((resolve, reject) => {
            const transaction = otkMediaDB.transaction(['messagesStore'], 'readwrite');
            transaction.oncomplete = () => {
                consoleLog(`Transaction to save messages for thread ${threadId} completed.`);
                resolve();
            };
            transaction.onerror = (event) => {
                consoleError(`Error saving messages for thread ${threadId} to DB:`, event.target.error);
                reject(event.target.error);
            };
            const store = transaction.objectStore('messagesStore');
            store.put({ threadId: threadId, messages: messages });
        });
    }

    function loadMessagesFromDB() {
        if (!otkMediaDB) {
            consoleError("DB not available, cannot load messages.");
            return Promise.resolve({});
        }
        return new Promise((resolve, reject) => {
            const transaction = otkMediaDB.transaction(['messagesStore'], 'readonly');
            const store = transaction.objectStore('messagesStore');
            const request = store.getAll();
            request.onsuccess = () => {
                const messagesById = {};
                if (Array.isArray(request.result)) {
                    for (const item of request.result) {
                        messagesById[item.threadId] = item.messages;
                    }
                }
                consoleLog("Messages loaded from DB: ", messagesById);
                resolve(messagesById);
            };
            request.onerror = (event) => {
                consoleError("Error loading messages from DB:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    let activeThreads = [];
    try {
        activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    } catch (e) {
        consoleError("Error parsing active threads from localStorage:", e);
    }
    let messagesByThreadId = {}; // Will be populated from DB
    let threadColors = {};
    try {
        threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
    } catch (e) {
        consoleError("Error parsing thread colors from localStorage:", e);
    }
    let droppedThreadIds = [];
    try {
        droppedThreadIds = JSON.parse(localStorage.getItem(DROPPED_THREADS_KEY)) || [];
    } catch (e) {
        consoleError("Error parsing dropped thread IDs from localStorage:", e);
    }

    // Normalize thread IDs and exclude known dropped threads
    droppedThreadIds = droppedThreadIds.map(id => Number(id)).filter(id => !isNaN(id));
    activeThreads = activeThreads
        .map(id => Number(id))
        .filter(id => !isNaN(id) && !droppedThreadIds.includes(id));

    // The following loop is commented out to prevent messages from being deleted on startup.
    // for (const threadId in messagesByThreadId) {
    //     if (!activeThreads.includes(Number(threadId))) {
    //         consoleLog(`Removing thread ${threadId} from messagesByThreadId during initialization (not in activeThreads or in droppedThreadIds).`);
    //         delete messagesByThreadId[threadId];
    //         delete threadColors[threadId];
    //     }
    // }
    // Clean up droppedThreadIds after processing
    localStorage.removeItem(DROPPED_THREADS_KEY); // This seems to be a one-time cleanup
    localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
    localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
    consoleLog('Initialized activeThreads from localStorage:', activeThreads);


    // (+n) Stat Update Logic
// --- Utility functions ---
    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function padNumber(num, length) {
        return String(num).padStart(length, '0');
    }

    function updateCountdown() {
        const nextUpdateTimestamp = parseInt(localStorage.getItem('otkNextUpdateTimestamp') || '0', 10);
        const countdownTimer = document.getElementById('otk-countdown-timer');
        if (!countdownTimer) {
            return;
        }

        const now = Date.now();
        const timeLeft = Math.max(0, nextUpdateTimestamp - now);
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

        countdownTimer.textContent = `${padNumber(hours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}`;
    }

    function hhmmssToSeconds(hms) {
        if (!hms || typeof hms !== 'string') return 0;
        const parts = hms.split(':');
        if (parts.length !== 3) return 0;
        const hours = parseInt(parts[0], 10) || 0;
        const minutes = parseInt(parts[1], 10) || 0;
        const seconds = parseInt(parts[2], 10) || 0;
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function secondsToHHMMSS(totalSeconds) {
        totalSeconds = Number(totalSeconds);
        if (isNaN(totalSeconds) || totalSeconds < 0) return '00:00:00';
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return [hours, minutes, seconds]
            .map(v => String(v).padStart(2, '0'))
            .join(':');
    }

    function hexToRgbParts(hex) {
        if (!hex) return '0,0,0'; // Default to black if invalid input
        let shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        hex = hex.replace(shorthandRegex, function(m, r, g, b) {
            return r + r + g + g + b + b;
        });

        let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (result) {
            const r = parseInt(result[1], 16);
            const g = parseInt(result[2], 16);
            const b = parseInt(result[3], 16);
            return `${r},${g},${b}`;
        }
        return '0,0,0'; // Fallback to black if full hex parsing fails
    }

    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    function truncateTitleWithWordBoundary(title, maxLength) {
        if (title.length <= maxLength) return title;
        let truncated = title.substr(0, maxLength);
        let lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > 0 && lastSpace > maxLength - 20) { // Ensure lastSpace is meaningful
            return truncated.substr(0, lastSpace) + '...';
        }
        return title.substr(0, maxLength - 3) + '...'; // Fallback if no good space
    }

    function truncateFilename(filename, maxLength) {
        if (filename.length <= maxLength) {
            return filename;
        }
        return filename.substring(0, maxLength - 3) + '...';
    }

    function loadUserPostIds() {
        try {
            const postHistory = JSON.parse(localStorage.getItem('postHistory') || '[]');
            userPostIds.clear(); // Clear before re-populating
            if (Array.isArray(postHistory)) {
                postHistory.forEach(post => {
                    if (post.pid) {
                        userPostIds.add(post.pid);
                    }
                });
            }
            consoleLog(`Loaded ${userPostIds.size} user post IDs.`);
        } catch (e) {
            consoleError("Error parsing postHistory from localStorage:", e);
        }
    }

    // --- Color Similarity Functions ---
    const SIMILARITY_THRESHOLD = 20; // Lower is more similar. 1-5 is imperceptible, >10 is distinct.

    function hexToRgb(hex) {
        let shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        hex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
        let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    function rgbToLab(rgb) {
        let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
        r = (r > 0.04045) ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
        g = (g > 0.04045) ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
        b = (b > 0.04045) ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

        let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
        let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.00000;
        let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

        x = (x > 0.008856) ? Math.pow(x, 1/3) : (7.787 * x) + 16/116;
        y = (y > 0.008856) ? Math.pow(y, 1/3) : (7.787 * y) + 16/116;
        z = (z > 0.008856) ? Math.pow(z, 1/3) : (7.787 * z) + 16/116;

        return { l: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
    }

    function deltaE(labA, labB){
        const deltaL = labA.l - labB.l;
        const deltaA = labA.a - labB.a;
        const deltaB = labA.b - labB.b;
        return Math.sqrt(Math.pow(deltaL, 2) + Math.pow(deltaA, 2) + Math.pow(deltaB, 2));
    }

    function getThreadColor(threadId) {
        if (threadColors[threadId]) {
            return threadColors[threadId];
        }

        // Use custom colors from localStorage if available, otherwise fall back to default COLORS
        let customColors;
        try {
            const storedColors = localStorage.getItem(THREAD_TITLE_COLORS_KEY);
            if (storedColors) {
                customColors = JSON.parse(storedColors);
            } else {
                // Fallback for first run or after a reset where key is missing
                customColors = [...COLORS];
            }
        } catch (e) {
            consoleError("Error parsing custom thread title colors, falling back to default.", e);
            customColors = [...COLORS];
        }


        const usedColorHexes = new Set(Object.values(threadColors));
        const availableColors = customColors.filter(c => !usedColorHexes.has(c));

        if (availableColors.length === 0) {
            // All colors from the palette are used, assign a fallback.
            const fallbackColor = '#888';
            threadColors[threadId] = fallbackColor;
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
            return fallbackColor;
        }

        if (usedColorHexes.size === 0) {
            // If no colors are in use, any color is fine. Pick a random one.
            const randomColor = availableColors[Math.floor(Math.random() * availableColors.length)];
            threadColors[threadId] = randomColor;
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
            return randomColor;
        }

        const usedLabColors = Array.from(usedColorHexes).map(hex => rgbToLab(hexToRgb(hex)));

        // For each available color, find its minimum distance to any of the used colors.
        const colorDistances = availableColors.map(candidateHex => {
            const candidateLab = rgbToLab(hexToRgb(candidateHex));
            const minDistance = Math.min(
                ...usedLabColors.map(usedLab => deltaE(candidateLab, usedLab))
            );
            return { color: candidateHex, distance: minDistance };
        });

        // Sort the candidates by their minimum distance in descending order.
        colorDistances.sort((a, b) => b.distance - a.distance);

        // The best candidate is the one with the largest minimum distance.
        const colorToAssign = colorDistances[0].color;

        threadColors[threadId] = colorToAssign;
        localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
        return colorToAssign;
    }

    function toggleImageBlur(filehash) {
        if (blurredImages.has(filehash)) {
            blurredImages.delete(filehash);
        } else {
            blurredImages.add(filehash);
        }

        localStorage.setItem(BLURRED_IMAGES_KEY, JSON.stringify(Array.from(blurredImages)));

        // Update all images on the page
        const allImagesOnPage = document.querySelectorAll(`img[data-filehash="${filehash}"]`);
        const blurAmount = (localStorage.getItem(IMAGE_BLUR_AMOUNT_KEY) || 60) / 5;
        const isBlurred = blurredImages.has(filehash);

        allImagesOnPage.forEach(img => {
            img.style.filter = isBlurred ? `blur(${blurAmount}px)` : 'none';
        });
        consoleLog(`Toggled blur for ${filehash}. Now blurred: ${isBlurred}`);
    }

function triggerQuickReply(postId, threadId) {
    const selections = Array.from(multiQuoteSelections);
    // The textToQuote logic has been removed to fix the bug.
    const textToQuote = ''; // Always empty now.

    consoleLog(`[OTK Injector] Creating script to trigger reply for post ID: ${postId}, Thread: ${threadId}, Multi-Quote Selections:`, selections);

    try {
        const script = document.createElement('script');
        script.id = 'otk-qr-injector-script';
        script.textContent = `
            (function() {
                try {
                    const postId = ${postId};
                    const threadId = ${threadId};
                    const selections = ${JSON.stringify(selections)};
                    // textToQuote is no longer passed or used in the injected script.
                    let quotesToApply = new Set(selections);

                    if (postId !== null) {
                        quotesToApply.add(postId);
                    }

                    console.log('[Injected Script] Executing for post: ' + postId + ' in thread ' + threadId);
                    console.log('[Injected Script] Quotes to apply:', Array.from(quotesToApply));

                    if (window.QR && typeof window.QR.show === 'function') {
                        window.QR.show(threadId);
                        console.log('[Injected Script] window.QR.show(' + threadId + ') called.');
                    } else {
                        console.error('[Injected Script] window.QR.show is not a function.');
                        return;
                    }

                    setTimeout(() => {
                        console.log('[Injected Script] Timeout executing...');
                        const qrDiv = document.getElementById('quickReply');
                        if (qrDiv) {
                            console.log('[Injected Script] Found #quickReply div.');
                            qrDiv.style.zIndex = '100001';
                            console.log('[Injected Script] Set #quickReply z-index to 100001.');

                            const textarea = qrDiv.querySelector('textarea[name="com"]');
                            if (textarea) {
                                let finalQuoteText = '';

                                if (quotesToApply.size > 0) {
                                    // This is now the only logic path for generating quote text.
                                    const sortedIds = Array.from(quotesToApply).sort((a, b) => a - b);
                                    finalQuoteText = sortedIds.map(id => '>>' + id).join('\\n') + '\\n';
                                    console.log('[Injected Script] Generated simple quote text.');
                                }

                                if (finalQuoteText) {
                                    console.log('[Injected Script] Generated quote text:', finalQuoteText.replace(/\\n/g, '\\\\n'));
                                    textarea.value = finalQuoteText + textarea.value;
                                    console.log('[Injected Script] Manually prepended quotes. New value:', textarea.value);
                                } else {
                                    console.log('[Injected Script] No quotes to apply.');
                                }
                            } else {
                                console.error('[Injected Script] Could not find QR textarea.');
                            }
                        } else {
                            console.error('[Injected Script] Could not find #quickReply div after timeout.');
                        }

                        // Dispatch event to clear selections in the main script
                        window.dispatchEvent(new CustomEvent('otkMultiQuoteApplied'));

                    }, 100);

                } catch (e) {
                    console.error('[Injected Script] Error during execution:', e);
                } finally {
                    const self = document.getElementById('otk-qr-injector-script');
                    if (self && self.parentNode) {
                        self.parentNode.removeChild(self);
                        console.log('[Injected Script] Self-removed from DOM.');
                    }
                }
            })();
        `;

        document.body.appendChild(script);
        consoleLog('[OTK Injector] Injected script into the DOM.');

    } catch (e) {
        consoleError('[OTK Injector] An unexpected error occurred in triggerQuickReply:', e);
        alert(`An error occurred while trying to inject the reply script: ${e.message}`);
    }
}

    // --- Core Logic: Rendering, Fetching, Updating ---

    function findMessageById(messageId) {
        messageId = Number(messageId);
        for (const threadId in messagesByThreadId) {
            if (messagesByThreadId.hasOwnProperty(threadId)) {
                const foundMsg = messagesByThreadId[threadId].find(m => m.id === messageId);
                if (foundMsg) {
                    return foundMsg;
                }
            }
        }
        return null;
    }

function findMessageDepth(message, targetId, currentDepth = 0) {
    if (String(message.id) === String(targetId)) {
        return currentDepth;
    }
    if (currentDepth < MAX_QUOTE_DEPTH && message.text) {
        const quoteRegex = />>(\d+)/g;
        let match;
        const uniqueQuoteIds = new Set();
        while ((match = quoteRegex.exec(message.text)) !== null) {
            uniqueQuoteIds.add(match[1]);
        }
        for (const quotedMessageId of uniqueQuoteIds) {
            const quotedMessageObject = findMessageById(quotedMessageId);
            if (quotedMessageObject) {
                const foundDepth = findMessageDepth(quotedMessageObject, targetId, currentDepth + 1);
                if (foundDepth !== null) {
                    return foundDepth;
                }
            }
        }
    }
    return null;
}

function hasTruncatedQuotes(message, currentDepth = 0) {
    if (currentDepth === MAX_QUOTE_DEPTH) {
        return message.text && />>(\d+)/.test(message.text);
    }
    if (currentDepth < MAX_QUOTE_DEPTH) {
        if (!message.text) return false;
        const quoteRegex = />>(\d+)/g;
        let match;
        const uniqueQuoteIds = new Set();
        while ((match = quoteRegex.exec(message.text)) !== null) {
            uniqueQuoteIds.add(match[1]);
        }
        for (const quotedMessageId of uniqueQuoteIds) {
            const quotedMessageObject = findMessageById(quotedMessageId);
            if (quotedMessageObject && hasTruncatedQuotes(quotedMessageObject, currentDepth + 1)) {
                return true;
            }
        }
    }
    return false;
}

function findNextUnloadedQuoteLink(topLevelElement) {
    // 1. Find all message elements within the top-level container.
    const allMessageElements = Array.from(topLevelElement.querySelectorAll('div[data-message-id]'));
    const renderedMessageIds = new Set(allMessageElements.map(el => el.dataset.messageId));

    // 2. Iterate through all rendered messages to find quote links.
    for (const messageElement of allMessageElements) {
        const messageId = messageElement.dataset.messageId;
        const messageObject = findMessageById(messageId);

        if (messageObject && messageObject.text) {
            const quoteRegex = />>(\d+)/g;
            let match;
            while ((match = quoteRegex.exec(messageObject.text)) !== null) {
                const quotedId = match[1];

                // 3. Check if the found quote link points to a message that is NOT already rendered.
                if (!renderedMessageIds.has(quotedId)) {
                    // This is a "leaf" node. We've found the next link to load.
                    return {
                        id: quotedId,
                        parentId: messageId, // The parent for insertion is the element containing the link.
                    };
                    }
                }
            }
        }

    // 4. If we loop through everything and find no unloaded links, return null.
        return null;
    }

function isMessageFiltered(message, rules) {
    const messageText = (message.text || '').toLowerCase();
    const messageMd5 = message.attachment?.filehash_db_key || '';

    const matchingFilterOutRule = rules.find(rule => {
        if (!rule.enabled || rule.action !== 'filterOut') {
            return false;
        }

        const matchContent = rule.matchContent; // Keep case for JSON parsing
        if (!matchContent) return false;

        switch (rule.category) {
            case 'keyword':
                return messageText.includes(matchContent.toLowerCase());
            case 'attachedMedia':
                // Do not convert to lower case, as MD5 (base64) is case sensitive.
                return messageMd5 === matchContent.replace('md5:', '');
            case 'entireMessage':
                try {
                    const conditions = JSON.parse(matchContent);
                    const textMatch = conditions.text ? messageText.includes(conditions.text.toLowerCase()) : true;
                    // Do not convert to lower case for media hash
                    const mediaHashInRule = conditions.media ? conditions.media.replace('md5:', '') : null;
                    const mediaMatch = mediaHashInRule ? messageMd5 === mediaHashInRule : true;
                    return textMatch && mediaMatch;
                } catch (e) {
                    return messageText.includes(matchContent.toLowerCase());
                }
            case 'embeddedLink':
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                let urls;
                while ((urls = urlRegex.exec(message.text || '')) !== null) { // Use original case text for this check
                    if (urls[0].toLowerCase().includes(matchContent.toLowerCase())) {
                        return true;
                    }
                }
                return false;
            default:
                return false;
        }
    });

    return !!matchingFilterOutRule;
}

function doesAnyRuleMatch(message, rules) {
    const messageText = (message.text || '').toLowerCase();
    const messageMd5 = message.attachment?.filehash_db_key || '';

    return rules.some(rule => {
        if (!rule.enabled) return false;
        const matchContent = rule.matchContent;
        if (!matchContent) return false;

        switch (rule.category) {
            case 'keyword':
                return messageText.includes(matchContent.toLowerCase());
            case 'attachedMedia':
                // Do not convert to lower case, as MD5 (base64) is case sensitive.
                return messageMd5 === matchContent.replace('md5:', '');
            case 'entireMessage':
                 try {
                    const conditions = JSON.parse(matchContent);
                    const textMatch = conditions.text ? messageText.includes(conditions.text.toLowerCase()) : false;
                    // Do not convert to lower case for media hash
                    const mediaHashInRule = conditions.media ? conditions.media.replace('md5:', '') : null;
                    const mediaMatch = mediaHashInRule ? messageMd5 === mediaHashInRule : false;
                    return textMatch || mediaMatch;
                } catch (e) {
                    // Fallback for old plain text rules
                    const matchContentLower = matchContent.toLowerCase();
                    return messageText.includes(matchContentLower) || (messageMd5 === matchContentLower);
                }
            case 'embeddedLink':
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                let urls;
                while ((urls = urlRegex.exec(message.text || '')) !== null) {
                    if (urls[0].toLowerCase().includes(matchContent.toLowerCase())) {
                        return true;
                    }
                }
                return false;
            default:
                return false;
        }
    });
}

function applyFiltersToMessageContent(message, rules) {
    const modifiedMessage = JSON.parse(JSON.stringify(message));
    let modifiedText = modifiedMessage.text || '';
    let attachmentFiltered = false;

    for (const rule of rules) {
        if (!rule.enabled || rule.action === 'filterOut') {
            continue;
        }

        const matchContent = rule.matchContent;
        const matchContentLower = matchContent.toLowerCase();

        switch (rule.category) {
            case 'keyword':
                if (modifiedText.toLowerCase().includes(matchContentLower)) {
                    if (rule.action === 'remove') {
                        modifiedText = modifiedText.replace(new RegExp(matchContent.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), '');
                    } else if (rule.action === 'replace') {
                        modifiedText = modifiedText.replace(new RegExp(matchContent.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), rule.replaceContent);
                    }
                }
                break;
            case 'attachedMedia':
                if (modifiedMessage.attachment && modifiedMessage.attachment.filehash_db_key === matchContent.replace('md5:', '')) {
                    if (rule.action === 'remove' || rule.action === 'replace') {
                        attachmentFiltered = true;
                    }
                }
                break;
            case 'embeddedLink':
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                if (rule.action === 'remove') {
                    modifiedText = modifiedText.replace(urlRegex, (url) => {
                        return url.toLowerCase().includes(matchContentLower) ? '' : url;
                    });
                } else if (rule.action === 'replace') {
                    modifiedText = modifiedText.replace(urlRegex, (url) => {
                        return url.toLowerCase().includes(matchContentLower) ? rule.replaceContent : url;
                    });
                }
                break;
            case 'entireMessage':
                try {
                    const conditions = JSON.parse(matchContent);
                    const textToMatch = conditions.text;
                    const mediaToMatch = conditions.media ? conditions.media.replace('md5:', '') : null;

                    const textMatches = textToMatch && modifiedText.toLowerCase().includes(textToMatch.toLowerCase());
                    const mediaMatches = mediaToMatch && modifiedMessage.attachment && modifiedMessage.attachment.filehash_db_key === mediaToMatch;

                    if (textMatches && mediaMatches) { // AND logic for applying filter
                        if (rule.action === 'remove') {
                            modifiedText = modifiedText.replace(new RegExp(textToMatch.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), '');
                            attachmentFiltered = true;
                        } else if (rule.action === 'replace') {
                            modifiedText = modifiedText.replace(new RegExp(textToMatch.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), rule.replaceContent);
                            attachmentFiltered = true; // Also remove/replace attachment
                        }
                    }
                } catch (e) {
                    // Fallback for old plain text rules
                    if (modifiedText.toLowerCase().includes(matchContentLower)) {
                        if (rule.action === 'remove') {
                            modifiedText = modifiedText.replace(new RegExp(matchContent.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), '');
                        } else if (rule.action === 'replace') {
                            modifiedText = modifiedText.replace(new RegExp(matchContent.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), rule.replaceContent);
                        }
                    }
                    if (modifiedMessage.attachment && modifiedMessage.attachment.filehash_db_key === matchContentLower) {
                        if (rule.action === 'remove' || rule.action === 'replace') {
                            attachmentFiltered = true;
                        }
                    }
                }
                break;
        }
    }

    modifiedMessage.text = modifiedText;
    if (attachmentFiltered) {
        modifiedMessage.attachment = null;
    }

    return modifiedMessage;
}

function createThreadListItemElement(thread, isForTooltip = false) {
    const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    const timePosition = themeSettings.otkThreadTimePosition || 'After Title';

    const threadItemDiv = document.createElement('div');
    threadItemDiv.style.cssText = `
        display: flex;
        align-items: center;
        padding: 4px 4px 4px 5.5px;
        border-radius: 3px;
        height: 28px; /* Fixed height for animation calculations */
        box-sizing: border-box;
    `;

    const colorBox = document.createElement('div');
    colorBox.style.cssText = `
        width: 12px;
        height: 12px;
        background-color: ${thread.color};
        border-radius: 2px;
        margin-right: 6px;
        flex-shrink: 0;
        border: var(--otk-gui-thread-box-outline, none);
    `;
    threadItemDiv.appendChild(colorBox);

    const textContentDiv = document.createElement('div');
    textContentDiv.style.display = 'flex';
    textContentDiv.style.flexDirection = 'column';
    textContentDiv.style.maxWidth = 'calc(100% - 18px)';

    const titleLink = document.createElement('a');
    titleLink.href = thread.url;
    titleLink.target = '_blank';
    titleLink.textContent = truncateTitleWithWordBoundary(thread.title, 65);
    titleLink.title = thread.title;
    titleLink.style.cssText = `
        color: var(--otk-gui-threadlist-title-color);
        text-decoration: none;
        font-weight: bold;
        font-size: 12px;
        display: block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `;

    const time = new Date(thread.firstMessageTime * 1000);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const bracketStyle = themeSettings.otkThreadTimeBracketStyle || '[]';
    const bracketColor = themeSettings.otkThreadTimeBracketColor || 'var(--otk-gui-threadlist-time-color)';
    const timestampSpan = document.createElement('span');
    timestampSpan.style.marginLeft = '5px';
    if (bracketStyle !== 'none') {
        const openBracket = document.createElement('span');
        openBracket.textContent = bracketStyle[0];
        openBracket.style.color = bracketColor;
        timestampSpan.appendChild(openBracket);
    }
    const timeText = document.createElement('span');
    timeText.textContent = timeStr;
    timeText.style.color = 'var(--otk-gui-threadlist-time-color)';
    timeText.style.fontSize = '12px';
    timestampSpan.appendChild(timeText);
    if (bracketStyle !== 'none') {
        const closeBracket = document.createElement('span');
        closeBracket.textContent = bracketStyle[1];
        closeBracket.style.color = bracketColor;
        timestampSpan.appendChild(closeBracket);
    }

    const titleTimeContainer = document.createElement('div');
    titleTimeContainer.style.display = 'flex';
    titleTimeContainer.style.alignItems = 'baseline';

    const dividerEnabled = themeSettings.otkThreadTimeDividerEnabled || false;
    const dividerSymbol = themeSettings.otkThreadTimeDividerSymbol || '|';
    const dividerColor = themeSettings.otkThreadTimeDividerColor || '#ffffff';

    if (timePosition === 'Before Title') {
        titleTimeContainer.appendChild(timestampSpan);
        if (dividerEnabled) {
            const dividerSpan = document.createElement('span');
            dividerSpan.textContent = dividerSymbol;
            dividerSpan.style.color = dividerColor;
            dividerSpan.style.fontSize = '10px';
            dividerSpan.style.padding = '0 5px';
            titleTimeContainer.appendChild(dividerSpan);
        }
        titleTimeContainer.appendChild(titleLink);
    } else { // After Title
        titleTimeContainer.appendChild(titleLink);
        if (dividerEnabled) {
            const dividerSpan = document.createElement('span');
            dividerSpan.textContent = dividerSymbol;
            dividerSpan.style.color = dividerColor;
            dividerSpan.style.fontSize = '10px';
            dividerSpan.style.padding = '0 5px';
            titleTimeContainer.appendChild(dividerSpan);
        }
        titleTimeContainer.appendChild(timestampSpan);
    }

    const crayonIcon = document.createElement('span');
    crayonIcon.innerHTML = '🖍️';
    crayonIcon.style.cssText = `font-size: 12px; cursor: pointer; margin-left: 8px; visibility: hidden;`;
    crayonIcon.title = "Reply to this thread";
    crayonIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        triggerQuickReply(null, thread.id);
    });

    const blockIcon = document.createElement('span');
    blockIcon.innerHTML = '&#x2715;';
    blockIcon.style.cssText = `font-size: 12px; color: #ff8080; cursor: pointer; margin-left: 5px; visibility: hidden;`;
    blockIcon.title = "Block this thread";
    blockIcon.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); blockedThreads.add(thread.id); localStorage.setItem(BLOCKED_THREADS_KEY, JSON.stringify(Array.from(blockedThreads))); activeThreads = activeThreads.filter(id => id !== thread.id); localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads)); if (confirm(`Thread ${thread.id} blocked. Also remove its messages from the viewer?`)) { delete messagesByThreadId[thread.id]; if (otkViewer && otkViewer.style.display === 'block') renderMessagesInViewer(); } renderThreadList(); updateDisplayedStatistics(false); });

    // Common logic for both tooltip and main list items
    titleTimeContainer.appendChild(crayonIcon);
    titleTimeContainer.appendChild(blockIcon);
    threadItemDiv.addEventListener('mouseenter', () => { crayonIcon.style.visibility = 'visible'; blockIcon.style.visibility = 'visible'; });
    threadItemDiv.addEventListener('mouseleave', () => { crayonIcon.style.visibility = 'hidden'; blockIcon.style.visibility = 'hidden'; });

    // Specific logic for non-tooltip items
    if (!isForTooltip) {
        titleLink.onmouseover = () => { titleLink.style.textDecoration = 'underline'; };
        titleLink.onmouseout = () => { titleLink.style.textDecoration = 'none'; };
        titleLink.onclick = (event) => {
            event.preventDefault();
            if (otkViewer && otkViewer.style.display === 'none') toggleViewer();
            else if (otkViewer && otkViewer.style.display !== 'block') { otkViewer.style.display = 'block'; document.body.style.overflow = 'hidden'; renderMessagesInViewer(); }
            if (scrollButtonContainer) scrollButtonContainer.style.display = 'flex';
            setTimeout(() => {
                const messagesContainer = document.getElementById('otk-messages-container');
                if (messagesContainer) {
                    const opMessageElement = messagesContainer.querySelector(`div[data-message-id="${thread.id}"]`);
                    if (opMessageElement) opMessageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
        };
    }

    textContentDiv.appendChild(titleTimeContainer);
    threadItemDiv.appendChild(textContentDiv);
    return threadItemDiv;
}


function renderThreadList() {
    if (threadTitleAnimationInterval) {
        clearInterval(threadTitleAnimationInterval);
        threadTitleAnimationInterval = null;
    }

    const threadDisplayContainer = document.getElementById('otk-thread-display-container');
    if (!threadDisplayContainer) return;

    threadDisplayContainer.innerHTML = '';
    // Reset styles that might be changed for the > 3 case
    threadDisplayContainer.style.height = '';
    threadDisplayContainer.style.overflow = 'visible';
    threadDisplayContainer.style.justifyContent = 'center';
    threadDisplayContainer.style.padding = '3px 0 5px 0px';
    threadDisplayContainer.style.boxSizing = '';
    threadDisplayContainer.style.position = '';
    threadDisplayContainer.style.flexDirection = 'column';
    threadDisplayContainer.style.maxWidth = ''; // Reset maxWidth

    const gui = document.getElementById('otk-tracker-gui');
    if (gui) {
        if (handleGuiMouseMoveForArrows) gui.removeEventListener('mousemove', handleGuiMouseMoveForArrows);
        if (handleGuiMouseLeaveForArrows) gui.removeEventListener('mouseleave', handleGuiMouseLeaveForArrows);
        if (handleGuiMouseEnterForArrows) gui.removeEventListener('mouseenter', handleGuiMouseEnterForArrows);
    }

    if (activeThreads.length === 0) return;

    const threadDisplayObjects = activeThreads.map(threadId => {
        const messages = messagesByThreadId[threadId] || [];
        let title = `Thread ${threadId}`;
        let firstMessageTime = null;
        if (messages.length > 0 && messages[0]) {
            title = messages[0].title ? toTitleCase(decodeEntities(messages[0].title)) : `Thread ${threadId}`;
            firstMessageTime = messages[0].time;
        }
        return { id: threadId, title, firstMessageTime, color: getThreadColor(threadId), url: `https://boards.4chan.org/b/thread/${threadId}` };
    });

    threadDisplayObjects.sort((a, b) => {
        if (a.firstMessageTime === null && b.firstMessageTime === null) return 0;
        if (a.firstMessageTime === null) return 1;
        if (b.firstMessageTime === null) return -1;
        return b.firstMessageTime - a.firstMessageTime;
    });

    const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    const animationSpeed = parseFloat(themeSettings.otkThreadTitleAnimationSpeed || '0');

    if (threadDisplayObjects.length > 3) {
        const itemHeight = 28;
        const hoverPadding = 25;

        threadDisplayContainer.style.height = `${itemHeight * 3}px`;
        threadDisplayContainer.style.overflow = 'visible';
        threadDisplayContainer.style.justifyContent = 'flex-start';
        threadDisplayContainer.style.boxSizing = 'border-box';
        threadDisplayContainer.style.padding = `0 0 0 ${hoverPadding}px`;
        threadDisplayContainer.style.position = 'relative';
        threadDisplayContainer.style.maxWidth = `calc(450px + ${hoverPadding}px)`;

        const clippingContainer = document.createElement('div');
        clippingContainer.style.height = '100%';
        clippingContainer.style.overflow = 'hidden';
        clippingContainer.style.marginLeft = `-${hoverPadding}px`;
        threadDisplayContainer.appendChild(clippingContainer);

        const scroller = document.createElement('div');
        scroller.style.transition = 'transform 0.5s ease-in-out';
        scroller.style.position = 'relative';
        scroller.style.top = '-4px';
        clippingContainer.appendChild(scroller);

        let isResetting = false;
        const intervalDuration = animationSpeed > 0 ? 4000 / animationSpeed : 0;

        if (animationSpeed > 0) {
            const clonesEnd = threadDisplayObjects.slice(0, 3).map(thread => createThreadListItemElement(thread, false));
            const clonesStart = threadDisplayObjects.slice(-3).map(thread => createThreadListItemElement(thread, false));

            clonesStart.forEach(clone => scroller.appendChild(clone));
            threadDisplayObjects.forEach(thread => scroller.appendChild(createThreadListItemElement(thread, false)));
            clonesEnd.forEach(clone => scroller.appendChild(clone));

            threadTitleAnimationIndex = 3;
            scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;
        } else {
            threadDisplayObjects.forEach(thread => scroller.appendChild(createThreadListItemElement(thread, false)));
            threadTitleAnimationIndex = 0;
        }

        const arrowContainer = document.createElement('div');
        arrowContainer.style.cssText = `
            position: absolute; left: -20px; top: 50%;
            transform: translateY(calc(-50% - 4px));
            display: flex; flex-direction: column; z-index: 10;
            opacity: 0; pointer-events: none;
            transition: opacity 0.2s ease-in-out;
        `;
        threadDisplayContainer.appendChild(arrowContainer);

        const upArrow = document.createElement('div');
        upArrow.innerHTML = '&#9650;';
        upArrow.style.cssText = 'cursor: pointer;';
        arrowContainer.appendChild(upArrow);

        const downArrow = document.createElement('div');
        downArrow.innerHTML = '&#9660;';
        downArrow.style.cssText = 'cursor: pointer;';
        arrowContainer.appendChild(downArrow);

        const stopAnimation = () => {
            if (threadTitleAnimationInterval) {
                clearInterval(threadTitleAnimationInterval);
                threadTitleAnimationInterval = null;
            }
        };

        const startAnimation = () => {
            if (animationSpeed <= 0 || threadTitleAnimationInterval) return;
            threadTitleAnimationInterval = setInterval(() => {
                if (document.hidden || isResetting) return;
                const themeSettingsForAnim = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
                const animationDirection = themeSettingsForAnim.otkThreadTitleAnimationDirection || 'Up';

                if (animationDirection === 'Up') {
                    threadTitleAnimationIndex++;
                } else { // Down
                    threadTitleAnimationIndex--;
                }
                scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;

                if (animationDirection === 'Up' && threadTitleAnimationIndex >= threadDisplayObjects.length + 3) {
                    isResetting = true;
                    setTimeout(() => {
                        scroller.style.transition = 'none';
                        threadTitleAnimationIndex = 3;
                        scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;
                        void scroller.offsetWidth;
                        scroller.style.transition = 'transform 0.5s ease-in-out';
                        isResetting = false;
                    }, 500);
                } else if (animationDirection === 'Down' && threadTitleAnimationIndex < 3) {
                    isResetting = true;
                    setTimeout(() => {
                        scroller.style.transition = 'none';
                        threadTitleAnimationIndex += threadDisplayObjects.length;
                        scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;
                        void scroller.offsetWidth;
                        scroller.style.transition = 'transform 0.5s ease-in-out';
                        isResetting = false;
                    }, 500);
                }
            }, intervalDuration);
        };

        const moveManually = (direction) => {
            if (animationSpeed <= 0 || isResetting) return;
            stopAnimation();
            threadTitleAnimationIndex += direction;
            scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;

            if (direction > 0 && threadTitleAnimationIndex >= threadDisplayObjects.length + 3) {
                isResetting = true;
                setTimeout(() => {
                    scroller.style.transition = 'none';
                    threadTitleAnimationIndex = 3;
                    scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;
                    void scroller.offsetWidth;
                    scroller.style.transition = 'transform 0.5s ease-in-out';
                    isResetting = false;
                }, 500);
            } else if (direction < 0 && threadTitleAnimationIndex < 3) {
                isResetting = true;
                setTimeout(() => {
                    scroller.style.transition = 'none';
                    threadTitleAnimationIndex += threadDisplayObjects.length;
                    scroller.style.transform = `translateY(-${threadTitleAnimationIndex * itemHeight}px)`;
                    void scroller.offsetWidth;
                    scroller.style.transition = 'transform 0.5s ease-in-out';
                    isResetting = false;
                }, 500);
            }
        };

        upArrow.addEventListener('click', () => moveManually(1));
        downArrow.addEventListener('click', () => moveManually(-1));

        let hideArrowsTimeout = null;
        const showArrows = () => {
            clearTimeout(hideArrowsTimeout);
            stopAnimation();
            arrowContainer.style.opacity = '1';
            arrowContainer.style.pointerEvents = 'auto';
        };

        const hideArrows = () => {
            hideArrowsTimeout = setTimeout(() => {
                arrowContainer.style.opacity = '0';
                arrowContainer.style.pointerEvents = 'none';
                startAnimation();
            }, 300);
        };

        if (gui) {
            const statsWrapper = document.getElementById('otk-stats-wrapper');
            handleGuiMouseMoveForArrows = (e) => {
                if (statsWrapper) {
                    const statsRect = statsWrapper.getBoundingClientRect();
                    if (e.clientX < statsRect.left) {
                        showArrows();
                    } else {
                        hideArrows();
                    }
                }
            };
            handleGuiMouseLeaveForArrows = hideArrows;
            handleGuiMouseEnterForArrows = () => clearTimeout(hideArrowsTimeout);

            gui.addEventListener('mousemove', handleGuiMouseMoveForArrows);
            gui.addEventListener('mouseleave', handleGuiMouseLeaveForArrows);
            arrowContainer.addEventListener('mouseenter', handleGuiMouseEnterForArrows);
        }

        startAnimation();
    } else {
        const threadsToDisplayInList = threadDisplayObjects.slice(0, 3);
        threadsToDisplayInList.forEach((thread, index) => {
            const threadItemDiv = createThreadListItemElement(thread, false);
            threadItemDiv.style.marginBottom = index < (threadsToDisplayInList.length - 1) ? '0px' : '3px';
            threadDisplayContainer.appendChild(threadItemDiv);
        });

        if (threadDisplayObjects.length > 3) {
            const numberOfAdditionalThreads = threadDisplayObjects.length - 3;
            const hoverContainer = document.createElement('div');
            hoverContainer.style.cssText = `display: inline-block; position: relative;`;
            const moreIndicator = document.createElement('div');
            moreIndicator.id = 'otk-more-threads-indicator';
            moreIndicator.textContent = `(+${numberOfAdditionalThreads})`;
            moreIndicator.style.cssText = `font-size: 12px; color: #ccc; font-style: italic; cursor: pointer; padding: 3px 6px; margin-left: 8px; display: inline;`;
            hoverContainer.appendChild(moreIndicator);

            if (threadsToDisplayInList.length > 0) {
                const lastThreadItemDiv = threadDisplayContainer.lastChild;
                const textContentDiv = lastThreadItemDiv?.children[1];
                if (textContentDiv && textContentDiv.firstChild) {
                    const titleTimeContainer = textContentDiv.firstChild;
                    const titleLink = titleTimeContainer.querySelector('a');
                    const timePosition = themeSettings.otkThreadTimePosition || 'After Title';

                    if (timePosition === 'Before Title') {
                        titleLink.parentNode.insertBefore(hoverContainer, titleLink.nextSibling);
                    } else {
                        titleTimeContainer.appendChild(hoverContainer);
                    }
                }
            } else {
                moreIndicator.style.marginLeft = '0px';
                moreIndicator.style.paddingLeft = '22px';
                threadDisplayContainer.appendChild(hoverContainer);
            }

            let tooltip = null;
            let tooltipTimeout;
            hoverContainer.addEventListener('mouseenter', () => {
                clearTimeout(tooltipTimeout);
                if (tooltip) tooltip.remove();
                tooltip = document.createElement('div');
                tooltip.id = 'otk-more-threads-tooltip';
                tooltip.style.cssText = `position: absolute; background-color: #343434; border: 1px solid #555; border-radius: 4px; padding: 8px; z-index: 100001;`;
                const additionalThreads = threadDisplayObjects.slice(3);
                additionalThreads.forEach(thread => {
                    tooltip.appendChild(createThreadListItemElement(thread, true));
                });
                document.body.appendChild(tooltip);
                const indicatorRect = moreIndicator.getBoundingClientRect();
                tooltip.style.left = `${indicatorRect.left}px`;
                tooltip.style.top = `${indicatorRect.bottom + window.scrollY + 3}px`;
                tooltip.addEventListener('mouseenter', () => clearTimeout(tooltipTimeout));
                tooltip.addEventListener('mouseleave', () => {
                    tooltipTimeout = setTimeout(() => {
                        if (tooltip && !tooltip.matches(':hover')) tooltip.remove();
                    }, 300);
                });
            });
            hoverContainer.addEventListener('mouseleave', () => {
                tooltipTimeout = setTimeout(() => {
                    if (tooltip && !tooltip.matches(':hover')) tooltip.remove();
                }, 300);
            });
        }
    }
}

    // Helper function to format timestamp for message headers
    function formatTimestampForHeader(unixTime) {
        const date = new Date(unixTime * 1000);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return {
            time: `${hours}:${minutes}:${seconds}`,
            date: `${day}/${month}/${year}`
        };
    }

    async function renderMessagesInViewer(options = {}) {
    const { isToggleOpen = false } = options;
        if (!otkViewer) {
            consoleError("Viewer element not found, cannot render messages.");
            return;
        }
        const loadingText = isToggleOpen ? "Restoring view..." : "Loading all messages...";
        showLoadingScreen(loadingText);

        // Global sets uniqueImageViewerHashes and uniqueVideoViewerHashes are used directly.
        // No local const declarations needed here.

        // Use a slight delay to ensure the loading screen renders before heavy processing
        await new Promise(resolve => setTimeout(resolve, 50));

        messagesByThreadId = await loadMessagesFromDB();

        // Revoke old blob URLs before creating new ones
        for (const url of createdBlobUrls) {
            URL.revokeObjectURL(url);
        }
        createdBlobUrls.clear();
        videoBlobUrlCache.clear(); // Also clear the video blob URL cache

        // Clear state for full rebuild (using global sets)
        renderedMessageIdsInViewer.clear();
        uniqueImageViewerHashes.clear(); // Now clearing the global set
        viewerTopLevelAttachedVideoHashes.clear(); // Clear new set for attached videos in top-level messages
        viewerTopLevelEmbedIds.clear(); // Clear new set for embeds in top-level messages
        renderedFullSizeImageHashes.clear(); // Clear for new viewer session
        consoleLog("[renderMessagesInViewer] Cleared renderedMessageIdsInViewer, blob caches, unique image hashes, top-level video tracking sets, and renderedFullSizeImageHashes for full rebuild.");

        otkViewer.innerHTML = ''; // Clear previous content

        let allMessages = getAllMessagesSorted();

    const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    const messageLimitEnabled = themeSettings.otkMessageLimitEnabled !== false;
    if (messageLimitEnabled) {
        const messageLimitValue = parseInt(themeSettings.otkMessageLimitValue || '500', 10);
        consoleLog(`[ViewerPruning] Message limit check: Total messages=${allMessages.length}, Limit=${messageLimitValue}, Enabled=${messageLimitEnabled}`);
        if (allMessages.length > messageLimitValue) {
            consoleLog(`[ViewerPruning] Message limit exceeded. Starting advanced pruning for viewer.`);

            const allMessagesById = new Map(allMessages.map(m => [m.id, m]));
            const newestMessages = allMessages.slice(-messageLimitValue);
            const messagesToKeepIds = new Set(newestMessages.map(m => m.id));
            const quoteRegex = />>(\d+)/g;
            const processingQueue = [...newestMessages];

            consoleLog(`[ViewerPruning] Initial set of newest messages for quote chasing: ${processingQueue.length}`);

            let processedCount = 0;
            const MAX_PROCESSED = processingQueue.length * 5; // Safety break

            while (processingQueue.length > 0) {
                processedCount++;
                if (processedCount > MAX_PROCESSED) {
                    consoleWarn("[ViewerPruning] Exceeded max processing iterations. Breaking quote search to prevent infinite loop.");
                    break;
                }

                const message = processingQueue.shift();
                if (!message || !message.text) continue;

                let match;
                while ((match = quoteRegex.exec(message.text)) !== null) {
                    const quoteId = parseInt(match[1], 10);
                    if (!messagesToKeepIds.has(quoteId)) {
                        messagesToKeepIds.add(quoteId);
                        const quotedMessage = allMessagesById.get(quoteId);
                        if (quotedMessage) {
                            processingQueue.push(quotedMessage);
                        }
                    }
                }
            }
            consoleLog(`[ViewerPruning] Total messages to keep after quote search: ${messagesToKeepIds.size}`);

            allMessages = allMessages.filter(m => messagesToKeepIds.has(m.id));

        // Enforce the hard limit after context-aware quote chasing
        if (allMessages.length > messageLimitValue) {
            consoleLog(`[ViewerPruning] Post-quote-chase count (${allMessages.length}) exceeds limit. Trimming to ${messageLimitValue} newest messages from the context-aware set.`);
            allMessages = allMessages.slice(-messageLimitValue);
        }

            consoleLog(`[ViewerPruning] Pruning complete. Messages to render in viewer: ${allMessages.length}`);
        }
    }
        if (!allMessages || allMessages.length === 0) {
            otkViewer.textContent = 'No messages found to display.'; // User-friendly message
            consoleWarn(`No messages to render in viewer.`);
            updateLoadingProgress(100, "No messages to display.");
            setTimeout(hideLoadingScreen, 500);
            return;
        }

        consoleLog(`Rendering ${allMessages.length} messages in viewer.`);

        // No thread title header needed anymore for continuous view

        const messagesContainer = document.createElement('div');
        messagesContainer.id = 'otk-messages-container';

        let scrollTimeout;
        messagesContainer.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(handleScrollRead, 200);
        });

        messagesContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow-y: auto; /* This container scrolls */
            padding: 10px 23px; /* 10px top/bottom, 23px left/right for content and scrollbar */
            box-sizing: border-box;
            /* width and height are now controlled by absolute positioning */
        `;
        otkViewer.appendChild(messagesContainer);

        // Initialize or re-initialize IntersectionObserver for media within this container
        if (mediaIntersectionObserver) {
            mediaIntersectionObserver.disconnect(); // Clean up previous observer if any
            consoleLog('[LazyLoad] Disconnected previous mediaIntersectionObserver.');
        }
        mediaIntersectionObserver = new IntersectionObserver(handleIntersection, {
            root: messagesContainer,
            rootMargin: '0px 0px 300px 0px',
            threshold: 0.01
        });

        const totalMessagesToRender = allMessages.length;
        let messagesProcessedInViewer = 0;
        let imagesFoundInViewer = 0;
        let videosFoundInViewer = 0;
        const mediaLoadPromises = [];
        const embedWrappers = [];
        const updateInterval = Math.max(1, Math.floor(totalMessagesToRender / 20)); // Update progress roughly 20 times or every message

        for (let i = 0; i < totalMessagesToRender; i++) {
            const message = allMessages[i];

            const boardForLink = message.board || 'b';
            const threadColor = getThreadColor(message.originalThreadId);

            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, true, 0, threadColor, null); // Top-level messages have no parent
            if (messageElement) {
                renderedMessageIdsInViewer.add(message.id);
                messagesContainer.appendChild(messageElement);
                const wrappers = messageElement.querySelectorAll('.otk-youtube-embed-wrapper, .otk-twitch-embed-wrapper, .otk-streamable-embed-wrapper, .otk-tweet-embed-wrapper');
                wrappers.forEach(wrapper => embedWrappers.push(wrapper));
            }

            messagesProcessedInViewer++;

            if (message.attachment) {
                const ext = message.attachment.ext.toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    imagesFoundInViewer++;
                } else if (['.webm', '.mp4'].includes(ext)) {
                    videosFoundInViewer++;
                }
            }

            if (messagesProcessedInViewer % updateInterval === 0 || messagesProcessedInViewer === totalMessagesToRender) {
                let currentProgress = (messagesProcessedInViewer / totalMessagesToRender) * 90; // Up to 90% for this stage
                let detailsStr = `Rendering messages (${messagesProcessedInViewer}/${totalMessagesToRender})...`; // Simplified
                updateLoadingProgress(currentProgress, detailsStr);
            }
        }
        otkViewer.appendChild(messagesContainer);

// After processing all messages, update global viewer counts
consoleLog(`[StatsDebug] Unique image hashes for viewer: ${uniqueImageViewerHashes.size}`, uniqueImageViewerHashes);
// consoleLog(`[StatsDebug] Unique video hashes for viewer: ${uniqueVideoViewerHashes.size}`, uniqueVideoViewerHashes); // Removed due to uniqueVideoViewerHashes being obsolete
// viewerActiveImageCount = uniqueImageViewerHashes.size; // MOVED TO AFTER PROMISES
// viewerActiveVideoCount = uniqueVideoViewerHashes.size; // MOVED TO AFTER PROMISES
// updateDisplayedStatistics(); // Refresh stats display -- MOVED TO AFTER PROMISES

        Promise.all(mediaLoadPromises).then(() => {
            embedWrappers.forEach(wrapper => mediaIntersectionObserver.observe(wrapper));
            consoleLog("All inline media load attempts complete.");
            updateLoadingProgress(95, "Finalizing view...");
    viewerActiveImageCount = uniqueImageViewerHashes.size;
    viewerActiveVideoCount = viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size;
    consoleLog(`[StatsDebug] Viewer counts updated: Images=${viewerActiveImageCount}, Videos (top-level attached + top-level embed)=${viewerActiveVideoCount}`);
updateDisplayedStatistics(false); // Update stats after all media processing is attempted.

            const storedPinnedInstanceId = localStorage.getItem(PINNED_MESSAGE_ID_KEY);
            consoleLog("[ViewerScroll] Found pinned message ID in localStorage:", storedPinnedInstanceId);

            setTimeout(() => {
                let scrolledToPin = false;
                if (storedPinnedInstanceId) {
                    const pinnedElement = document.getElementById(storedPinnedInstanceId);
                    consoleLog("[ViewerScroll] Attempting to find pinned element in DOM:", pinnedElement);

                    if (pinnedElement && messagesContainer.contains(pinnedElement)) {
                        try {
                            pinnedElement.scrollIntoView({ behavior: 'auto', block: 'center' });
                            scrolledToPin = true;
                            consoleLog(`[ViewerScroll] Scrolled to pinned message instance: ${storedPinnedInstanceId}`);
                            if (!pinnedElement.classList.contains(PINNED_MESSAGE_CLASS)) {
                                pinnedElement.classList.add(PINNED_MESSAGE_CLASS);
                            }
                        } catch (e) {
                            consoleError("[ViewerScroll] Error scrolling to pinned message:", e);
                        }
                    } else {
                        consoleWarn(`[ViewerScroll] Pinned message instance ${storedPinnedInstanceId} not found in viewer. Clearing pin.`);
                        localStorage.removeItem(PINNED_MESSAGE_ID_KEY);
                    }
                }

                if (!scrolledToPin) {
                    if (isToggleOpen && lastViewerScrollTop > 0) {
                        messagesContainer.scrollTop = lastViewerScrollTop;
                        consoleLog(`[ViewerScroll] No pin found. Restored scroll position to: ${lastViewerScrollTop}`);
                    } else {
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        consoleLog(`[ViewerScroll] No pin or saved scroll position. Scrolling to bottom.`);
                    }
                }

                updateLoadingProgress(100, "View ready!");
                setTimeout(hideLoadingScreen, 200);
                applyThemeSettings({ forceRerender: false });
            }, 500);
        }).catch(err => {
            consoleError("Error occurred during media loading promises:", err);
            updateLoadingProgress(100, "Error loading some media. View may be incomplete.");
            if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight; // Still try to scroll
            setTimeout(hideLoadingScreen, 500);
        });
    }

    async function appendNewMessagesToViewer(newMessages) {
        consoleLog(`[appendNewMessagesToViewer] Called with ${newMessages.length} new messages.`);
        const messagesContainer = document.getElementById('otk-messages-container');
        if (!messagesContainer) {
            consoleError("[appendNewMessagesToViewer] messagesContainer not found. Aborting append.");
            hideLoadingScreen();
            return;
        }

        if (newMessages.length === 0) {
            consoleLog("[appendNewMessagesToViewer] No new messages to append.");
            hideLoadingScreen();
            return;
        }

        const messageElementsBefore = messagesContainer.querySelectorAll('.otk-message-container-main');
        consoleLog(`[AppendLimit] Before append: DOM has ${messageElementsBefore.length} messages. renderedMessageIdsInViewer has ${renderedMessageIdsInViewer.size} IDs.`);

        // --- Scroll Anchoring Logic ---
        let anchorInfo = null;
        const isScrolledToBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 5;
        consoleLog(`[ScrollRestore] User is at bottom: ${isScrolledToBottom}`);

        if (!isScrolledToBottom) {
            const messageElements = messagesContainer.querySelectorAll('.otk-message-container-main');
            const messageLimitEnabled = (localStorage.getItem('otkMessageLimitEnabled') !== 'false');
            const messageLimitValue = parseInt(localStorage.getItem('otkMessageLimitValue') || '500', 10);
            const potentialPruneCount = Math.max(0, messageElements.length + newMessages.length - messageLimitValue);

            for (let i = 0; i < messageElements.length; i++) {
                const element = messageElements[i];
                const rect = element.getBoundingClientRect();
                const containerRect = messagesContainer.getBoundingClientRect();

                // Check if the element is within the visible portion of the container
                if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
                    if (i >= potentialPruneCount) {
                        anchorInfo = {
                            element: element,
                            id: element.dataset.messageId,
                            top: element.getBoundingClientRect().top
                        };
                        consoleLog(`[ScrollRestore] Found anchor message: ID=${anchorInfo.id}, Top=${anchorInfo.top}`);
                        break; // Found our anchor
                    }
                }
            }
        }
        // --- End Scroll Anchoring Logic ---

        const newContentDiv = document.createElement('div');

        const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        const showNewMessagesElements = (themeSettings.otkShowNewMessagesElements || 'Show') === 'Show';

        if (showNewMessagesElements) {
            const separatorDiv = document.createElement('div');
            const separatorAlignment = themeSettings.otkNewMessagesSeparatorAlignment || 'left';
            separatorDiv.style.borderTop = '2px dashed var(--otk-new-messages-divider-color)';
            separatorDiv.style.margin = '20px 0';
            separatorDiv.style.paddingTop = '10px';
            separatorDiv.style.paddingBottom = '10px';
            separatorDiv.style.color = 'var(--otk-new-messages-font-color)';
            separatorDiv.style.fontSize = 'var(--otk-new-messages-font-size)';
            separatorDiv.style.fontStyle = 'italic';
            separatorDiv.style.width = '100%';
            separatorDiv.style.boxSizing = 'border-box';

            if (separatorAlignment.toLowerCase() === 'center') {
                separatorDiv.style.textAlign = 'center';
                const scrollbarWidth = messagesContainer.offsetWidth - messagesContainer.clientWidth;
                if (scrollbarWidth > 0) {
                    separatorDiv.style.position = 'relative';
                    separatorDiv.style.left = `${scrollbarWidth / 2}px`;
                }
            } else {
                separatorDiv.style.textAlign = separatorAlignment.toLowerCase();
                separatorDiv.style.paddingLeft = '0px';
            }
            const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            separatorDiv.textContent = `--- ${currentTime} : ${newMessages.length} New Messages Loaded ---`;
            newContentDiv.appendChild(separatorDiv);
        }

        const mediaLoadPromises = [];
        const messageLimitEnabled = themeSettings.otkMessageLimitEnabled !== false;
        const messageLimitValue = parseInt(themeSettings.otkMessageLimitValue || '500', 10);

        for (const message of newMessages) {
            const boardForLink = message.board || 'b';
            const threadColor = getThreadColor(message.originalThreadId);
            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, true, 0, threadColor, null);
            if (messageElement) {
                newContentDiv.appendChild(messageElement);
                renderedMessageIdsInViewer.add(message.id);
            }
        }

        messagesContainer.appendChild(newContentDiv);

        const messageElementsAfter = messagesContainer.querySelectorAll('.otk-message-container-main');
        consoleLog(`[AppendLimit] After append: DOM has ${messageElementsAfter.length} messages. renderedMessageIdsInViewer has ${renderedMessageIdsInViewer.size} IDs.`);

        if (messageLimitEnabled) {
            const messageElements = messagesContainer.querySelectorAll('.otk-message-container-main');
            if (messageElements.length > messageLimitValue) {
                const numToRemove = messageElements.length - messageLimitValue;
                consoleLog(`[AppendLimit] Exceeds limit of ${messageLimitValue}. Removing ${numToRemove} oldest messages.`);
                for (let i = 0; i < numToRemove; i++) {
                    const messageToRemove = messageElements[i];
                    const messageId = parseInt(messageToRemove.dataset.messageId, 10);
                    if (!isNaN(messageId)) {
                        renderedMessageIdsInViewer.delete(messageId);
                    }
                    messageToRemove.remove();
                }
                const messageElementsFinal = messagesContainer.querySelectorAll('.otk-message-container-main');
                consoleLog(`[AppendLimit] After removal: DOM has ${messageElementsFinal.length} messages. renderedMessageIdsInViewer has ${renderedMessageIdsInViewer.size} IDs.`);
            }
        }

        Promise.all(mediaLoadPromises).then(async () => {
            hideLoadingScreen();

            if (anchorInfo && anchorInfo.element) {
                const newTop = anchorInfo.element.getBoundingClientRect().top;
                const topDiff = newTop - anchorInfo.top;
                messagesContainer.scrollTop += Math.round(topDiff); // Round to prevent minor jiggles
                consoleLog(`[ScrollRestore] Restored scroll position based on anchor. Top diff: ${topDiff}, New scrollTop: ${messagesContainer.scrollTop}`);
            } else {
                consoleLog(`[ScrollRestore] User was not at bottom, but no anchor was found. Maintaining scroll position.`);
            }

            viewerActiveImageCount = uniqueImageViewerHashes.size;
            viewerActiveVideoCount = viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size;
            updateDisplayedStatistics();
        }).catch(err => {
            consoleError("[appendNewMessagesToViewer] Error in media promises:", err);
            hideLoadingScreen();
        });
    }

    function handleScrollRead() {
        const messagesContainer = document.getElementById('otk-messages-container');
        if (!messagesContainer || unreadIds.size === 0) {
            return;
        }

        const unreadElements = Array.from(messagesContainer.querySelectorAll('.is-unread'));
        if (unreadElements.length === 0) {
            return;
        }

        const containerRect = messagesContainer.getBoundingClientRect();
        let newestVisibleUnreadMessage = null;

        // Find the newest (latest in DOM, latest timestamp) unread message that is at least partially visible
        for (let i = unreadElements.length - 1; i >= 0; i--) {
            const el = unreadElements[i];
            const elRect = el.getBoundingClientRect();
            // Check if the element is intersecting with the container's viewport
            if (elRect.top < containerRect.bottom && elRect.bottom > containerRect.top) {
                const messageId = parseInt(el.dataset.messageId, 10);
                const message = findMessageById(messageId);
                if (message) {
                    newestVisibleUnreadMessage = message;
                    break; // Found the newest visible one
                }
            }
        }

        if (newestVisibleUnreadMessage) {
            const cutoffTime = newestVisibleUnreadMessage.time;
            const allMessages = getAllMessagesSorted();

            let unreadChanged = false;
            const newUnreadIds = new Set();
            const unreadToRemove = new Set();
            for (const id of unreadIds) {
                const message = allMessages.find(m => m.id === id);
                if (message && message.time > cutoffTime) {
                    newUnreadIds.add(id);
                } else {
                    unreadToRemove.add(id);
                    unreadChanged = true;
                }
            }

            let repliesChanged = false;
            const newNewReplyIds = new Set();
            const repliesToRemove = new Set();
            for (const id of newReplyIds) {
                const message = allMessages.find(m => m.id === id);
                if (message && message.time > cutoffTime) {
                    newNewReplyIds.add(id);
                } else {
                    repliesToRemove.add(id);
                    repliesChanged = true;
                }
            }

            if (unreadChanged) {
                consoleLog(`[ScrollRead] Marking ${unreadToRemove.size} messages as read.`);
                unreadIds = newUnreadIds;
                unreadToRemove.forEach(id => {
                    const elements = document.querySelectorAll(`.otk-message-container-main[data-message-id='${id}']`);
                    elements.forEach(el => el.classList.remove('is-unread'));
                });
                localStorage.setItem(UNREAD_MESSAGE_IDS_KEY, JSON.stringify(Array.from(unreadIds)));
            }

            if (repliesChanged) {
                consoleLog(`[ScrollRead] Marking ${repliesToRemove.size} replies as seen.`);
                newReplyIds = newNewReplyIds;
                localStorage.setItem('otkNewReplyIds', JSON.stringify(Array.from(newReplyIds)));
            }

            if (unreadChanged || repliesChanged) {
                updateDisplayedStatistics();
            }
        }
    }


// Helper function to create a single media control icon
let activeMediaMenu = null;

function _createMediaPopupMenu(options) {
    const { event, isImage, downloadHandler, resizeHandler, blurHandler, blockHandler } = options;

    if (activeMediaMenu) {
        activeMediaMenu.remove();
        activeMediaMenu = null;
    }

    const menu = document.createElement('div');
    menu.style.cssText = `
        position: fixed;
        z-index: 10005;
        background-color: #333;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 5px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    `;

    const createMenuItem = (text, handler) => {
        const item = document.createElement('div');
        item.textContent = text;
        item.style.cssText = `
            padding: 5px 10px;
            color: #eee;
            cursor: pointer;
            border-radius: 3px;
        `;
        item.addEventListener('mouseenter', () => item.style.backgroundColor = '#555');
        item.addEventListener('mouseleave', () => item.style.backgroundColor = '');
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            handler();
            closeActiveMediaMenu();
        });
        return item;
    };

    menu.appendChild(createMenuItem('Download', downloadHandler));
    menu.appendChild(createMenuItem('Toggle Original Size', resizeHandler));
    if (isImage) {
        menu.appendChild(createMenuItem('Toggle Blur', blurHandler));
    }
    menu.appendChild(createMenuItem('Block', blockHandler));

    document.body.appendChild(menu);
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    activeMediaMenu = menu;
}

function closeActiveMediaMenu() {
    if (activeMediaMenu) {
        activeMediaMenu.remove();
        activeMediaMenu = null;
    }
}

document.addEventListener('click', (e) => {
    if (activeMediaMenu && !activeMediaMenu.contains(e.target)) {
        closeActiveMediaMenu();
    }
});

function _createMediaControlIcon(title, svgPath, onClick) {
    const icon = document.createElement('div');
    icon.className = 'media-control-icon';
    icon.title = title;
    icon.style.cssText = `
        width: 24px;
        height: 24px;
        background-color: var(--otk-blur-icon-bg-color); /* Using blur as a template, can be customized */
        border-radius: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
    `;

    const iconForeground = document.createElement('div');
    iconForeground.style.cssText = `
        width: 16px;
        height: 16px;
        background-color: var(--otk-blur-icon-color); /* Using blur as a template */
        -webkit-mask-image: url('${svgPath}');
        mask-image: url('${svgPath}');
        -webkit-mask-size: contain;
        mask-size: contain;
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-position: center;
        mask-position: center;
    `;
    icon.appendChild(iconForeground);

    icon.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick(e);
    });

    return icon;
}

// Helper function to populate attachmentDiv with media (images/videos)
function _populateAttachmentDivWithMedia(
    attachmentDiv, // The div to append media to
    message,       // The message object
    actualBoardForLink, // Board string for URLs
    mediaLoadPromises,  // Array for async operations
    uniqueImageViewerHashes, // Set for tracking unique images shown
    isTopLevelMessage,     // Boolean, for some media logic (e.g., video stats)
    layoutStyle,           // 'new_design' or 'default', to condition New Design specific logic
    renderedFullSizeImageHashes, // Set for tracking full-size images
    viewerTopLevelAttachedVideoHashes, // Set for video stats
    otkMediaDB, // IndexedDB instance
    effectiveDepthForStyling,
    filenameContainer
) {
    const loadImageFromCache = (imgElement, isThumb, fallbackSrc = null) => {
        const storeId = isThumb ? message.attachment.localThumbStoreId : message.attachment.localStoreId;
        const handleError = () => {
            if (fallbackSrc) {
                consoleLog(`[MediaLoad] Image cache miss/error for ${storeId}. Falling back to network: ${fallbackSrc}`);
                imgElement.src = fallbackSrc;
            }
        };

        if (storeId && otkMediaDB) {
            const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
            const store = transaction.objectStore('mediaStore');
            const request = store.get(storeId);
            request.onsuccess = (event) => {
                const storedItem = event.target.result;
                if (storedItem && storedItem.blob) {
                    const dataURL = URL.createObjectURL(storedItem.blob);
                    createdBlobUrls.add(dataURL);
                    imgElement.src = dataURL;
                } else {
                    handleError();
                }
            };
            request.onerror = handleError;
        } else {
            handleError();
        }
    };

    if (!message.attachment || !message.attachment.ext) {
        return;
    }

    const isArchived = !activeThreads.includes(message.originalThreadId);
    const mediaLoadModeSetting = localStorage.getItem('otkMediaLoadMode') || 'cache_only';
    const mediaLoadMode = isArchived ? 'cache_only' : mediaLoadModeSetting;
    if (isArchived && mediaLoadModeSetting !== 'cache_only') {
        consoleLog(`[MediaLoad] Message ${message.id} is in archived thread ${message.originalThreadId}. Forcing cache-only mode.`);
    }
    const extLower = message.attachment.ext.toLowerCase();
    const filehash = message.attachment.filehash_db_key || `${message.attachment.tim}${extLower}`;
    const isImage = ['.jpg', '.jpeg', '.png', '.gif'].includes(extLower);
    const isVideo = extLower.endsWith('webm') || extLower.endsWith('mp4');

    if (isImage || isVideo) {
        const attachmentContainer = document.createElement('div');
        attachmentContainer.style.display = 'inline-block';

        const mediaWrapper = document.createElement('div');
        mediaWrapper.classList.add(isImage ? 'image-wrapper' : 'video-wrapper');
        mediaWrapper.style.position = 'relative';
        mediaWrapper.style.display = 'inline-block';
        mediaWrapper.style.userSelect = 'none';

        let mediaElement;
        let setImageProperties;

        if (isImage) {
            const img = document.createElement('img');
            img.dataset.filehash = filehash;
            img.dataset.thumbWidth = message.attachment.tn_w;
            img.dataset.thumbHeight = message.attachment.tn_h;
            img.style.cursor = 'pointer';
            img.style.display = 'block';
            img.style.borderRadius = '3px';
            img.style.transform = 'translateZ(0)';
            img.style.backfaceVisibility = 'hidden';
            img.style.userSelect = 'none';
            mediaElement = img;

            const fullsizeWidth = message.attachment.w;
            const fullsizeHeight = message.attachment.h;
            const tnW = message.attachment.tn_w;
            const aspectRatio = fullsizeWidth / fullsizeHeight;
            const defaultToThumbnail = !((fullsizeWidth <= 800 && fullsizeHeight <= 600) || aspectRatio > 3 || tnW < 75);

            setImageProperties = (mode) => {
                img.dataset.mode = mode;
                let isThumb = (mode === 'thumb');
                const sourceUrl = isThumb
                    ? `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}s.jpg`
                    : `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;

                if (isThumb) {
                    img.style.width = message.attachment.tn_w + 'px';
                    img.style.height = message.attachment.tn_h + 'px';
                    img.style.maxWidth = '';
                    img.style.maxHeight = '';
                } else if (mode === 'full') {
                    img.style.maxWidth = '85%';
                    img.style.maxHeight = (layoutStyle === 'new_design' || isTopLevelMessage) ? '400px' : '350px';
                    img.style.width = 'auto';
                    img.style.height = 'auto';
                } else {
                    img.style.maxWidth = '100%';
                    img.style.maxHeight = 'none';
                    img.style.width = 'auto';
                    img.style.height = 'auto';
                }

                if (mediaLoadMode === 'cache_only') {
                    loadImageFromCache(img, isThumb, sourceUrl);
                } else {
                    img.src = sourceUrl;
                }
            };

            mediaLoadPromises.push(new Promise(resolve => {
                img.onload = () => { img.style.display = 'block'; resolve(); };
                img.onerror = () => {
                    const sourceUrl = (img.dataset.mode === 'thumb')
                        ? `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}s.jpg`
                        : `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;

                    // If src is a blob, it was a cache attempt that failed. Fallback to network.
                    if (img.src.startsWith('blob:')) {
                        img.src = sourceUrl;
                        img.onerror = () => resolve(); // Give up if network fails
                    } else if (img.src !== sourceUrl) {
                        // This handles source_first mode where network fails, now we try cache.
                        loadImageFromCache(img, img.dataset.mode === 'thumb');
                    }
                    resolve();
                };
            }));

            setImageProperties(defaultToThumbnail ? 'thumb' : 'full');
            uniqueImageViewerHashes.add(filehash);

            const maxHeightConstraint = isTopLevelMessage ? 400 : 350;
            const skipFullView = (message.attachment.h < maxHeightConstraint * 1.2) && (message.attachment.w < 1200);

            img.addEventListener('click', () => {
                const currentMode = img.dataset.mode;
                let nextMode;

                if (currentMode === 'thumb') {
                    nextMode = skipFullView ? 'original' : 'full';
                } else if (currentMode === 'full') {
                    nextMode = 'original';
                } else { // This covers 'original' and any other case, cycling back to thumb
                    nextMode = 'thumb';
                }
                setImageProperties(nextMode);
            });
            img.addEventListener('setImageProperties', (e) => {
                setImageProperties(e.detail.mode);
            });

            if (blurredImages.has(filehash)) {
                const blurAmount = (localStorage.getItem(IMAGE_BLUR_AMOUNT_KEY) || 60) / 5;
                img.style.filter = `blur(${blurAmount}px)`;
            }
        } else { // isVideo
            const video = document.createElement('video');
            video.controls = true;
            video.style.maxWidth = '85%';
            const defaultMaxHeight = isTopLevelMessage ? '400px' : '300px';
            video.style.maxHeight = defaultMaxHeight;
            video.dataset.defaultMaxHeight = defaultMaxHeight;
            video.style.borderRadius = '3px';
            video.style.display = 'block';
            mediaElement = video;

            const sourceUrl = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${extLower.startsWith('.') ? extLower : '.' + extLower}`;

            const loadFromCache = (fallbackToSource = false) => {
                if (message.attachment.localStoreId && otkMediaDB) {
                    const filehash = message.attachment.filehash_db_key;
                    if (videoBlobUrlCache.has(filehash)) {
                        video.src = videoBlobUrlCache.get(filehash);
                        return;
                    }

                    const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                    const store = transaction.objectStore('mediaStore');
                    const request = store.get(message.attachment.localStoreId);

                    const handleError = () => {
                        if (fallbackToSource) {
                            consoleLog(`[MediaLoad] Video cache miss/error for ${filehash}. Falling back to network.`);
                            video.src = sourceUrl;
                        }
                    };

                    request.onsuccess = (event) => {
                        const storedItem = event.target.result;
                        if (storedItem && storedItem.blob) {
                            const dataURL = URL.createObjectURL(storedItem.blob);
                            createdBlobUrls.add(dataURL);
                            videoBlobUrlCache.set(filehash, dataURL);
                            video.src = dataURL;
                        } else {
                            handleError();
                        }
                    };
                    request.onerror = handleError;
                } else {
                    if (fallbackToSource) {
                        consoleLog(`[MediaLoad] No storeId for video. Falling back to network.`);
                        video.src = sourceUrl;
                    }
                }
            };

            video.onerror = () => {
                const filehash = message.attachment.filehash_db_key;
                if (video.src.startsWith('blob:') && filehash && videoBlobUrlCache.has(filehash)) {
                    consoleWarn(`[MediaLoad] Cached video blob failed to load for ${filehash}. Clearing from cache and retrying.`);
                    videoBlobUrlCache.delete(filehash);
                    // Prevent infinite loops: remove the onerror handler before retrying.
                    video.onerror = null;
                    loadFromCache(true); // Retry once from DB/network
                }
            };

            // Always try to load from cache first, and fallback to source.
            // This prevents "Too Many Requests" errors by not re-fetching media that is already cached.
            loadFromCache(true);

            if (message.attachment.filehash_db_key && isTopLevelMessage) {
                viewerTopLevelAttachedVideoHashes.add(message.attachment.filehash_db_key);
            }
        }

        mediaWrapper.appendChild(mediaElement);
        attachmentContainer.appendChild(mediaWrapper); // Append media wrapper to the new container
        attachmentDiv.appendChild(attachmentContainer);

        const vSpan = document.createElement('span');
        vSpan.textContent = '☰';
        vSpan.style.cssText = "cursor: pointer; color: var(--otk-media-menu-icon-color, #ff8040); font-weight: bold;";

        const downloadHandler = () => {
            const url = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                responseType: 'blob',
                onload: function(response) {
                    const blob = response.response;
                    const objectUrl = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = objectUrl;
                    link.download = message.attachment.filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(objectUrl);
                },
                onerror: function(error) {
                    consoleError("Error downloading file:", error);
                    alert("Failed to download file. See console for details.");
                }
            });
        };

        const resizeHandler = () => {
            if (isImage) {
                const img = mediaElement;
                const currentMode = img.dataset.mode;
                const tnW = parseInt(img.dataset.thumbWidth, 10) || 0;
                const defaultToThumbnail = !((message.attachment.w <= 800 && message.attachment.h <= 600) || (message.attachment.w / message.attachment.h > 3) || tnW < 75);
                if (currentMode === 'original') {
                    const previousMode = img.dataset.previousMode || (defaultToThumbnail ? 'thumb' : 'full');
                    setImageProperties(previousMode);
                } else {
                    img.dataset.previousMode = currentMode;
                    setImageProperties('original');
                }
            } else if (isVideo) {
                if (mediaElement.style.maxHeight === 'none') {
                    mediaElement.style.maxHeight = mediaElement.dataset.defaultMaxHeight;
                } else {
                    mediaElement.style.maxHeight = 'none';
                }
            }
        };

        const blurHandler = () => {
            if (isImage) {
                toggleImageBlur(filehash);
            }
        };

        const blockHandler = () => {
            const newRule = {
                id: Date.now(),
                action: 'filterOut',
                enabled: true,
                category: 'attachedMedia',
                matchContent: `md5:${filehash}`,
                replaceContent: ''
            };
            const filterWindow = document.getElementById('otk-filter-window');
            if (filterWindow) {
                filterWindow.style.display = 'flex';
                renderFilterEditorView(newRule);
            }
        };

        vSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            _createMediaPopupMenu({
                event: e,
                isImage: isImage,
                downloadHandler,
                resizeHandler,
                blurHandler,
                blockHandler
            });
        });

        filenameContainer.prepend(vSpan);
    }
}

function wrapInCollapsibleContainer(elementsToWrap) {
    const container = document.createElement('div');
    container.className = 'otk-collapsible-container';

    const placeholder = document.createElement('div');
    placeholder.className = 'otk-collapsible-placeholder';
    placeholder.innerHTML = '<span style="margin-right: 5px;">[+]</span>Blocked Content';
    placeholder.style.cursor = 'pointer';
    placeholder.style.color = 'var(--otk-blocked-content-font-color)';
    placeholder.style.fontSize = '12px';
    placeholder.style.fontStyle = 'italic';
    placeholder.style.padding = '5px 0';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'otk-collapsible-content';
    contentDiv.style.display = 'none';

    elementsToWrap.forEach(el => {
        if (el) {
            contentDiv.appendChild(el);
        }
    });

    placeholder.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = contentDiv.style.display === 'none';
        contentDiv.style.display = isHidden ? 'block' : 'none';
        placeholder.querySelector('span').textContent = isHidden ? '[-]' : '[+]';
    });

    container.appendChild(placeholder);
    container.appendChild(contentDiv);

    return container;
}

function _populateMessageBody(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor, parentMessageId, ancestors, allThemeSettings, shouldDisableUnderline, effectiveDepthForStyling) {
    const textElement = document.createElement('div');
    textElement.style.whiteSpace = 'pre-wrap';
    textElement.style.overflowWrap = 'break-word';
    textElement.style.wordBreak = 'normal';

    if (shouldDisableUnderline) {
        textElement.style.marginTop = '0px';
        textElement.style.paddingTop = '0px';
    }

    if (message.text && typeof message.text === 'string') {
        const lines = message.text.split('\n');
        const quoteRegex = /^>>(\d+)/;
        const inlineQuoteRegex = />>(\d+)/;

        lines.forEach((line, lineIndex) => {
            const trimmedLine = line.trim();
            // const isBlockQuote = trimmedLine.match(quoteRegex) && trimmedLine.match(quoteRegex)[0] === trimmedLine;
            // The isBlockQuote check was removed as it prevented quote links at max depth from being rendered as text.
            // The logic now falls through to the inline quote handler which correctly processes them.

            let processedAsEmbed = false;
            let soleUrlEmbedMade = false;

            const youtubePatterns = [
                { regex: /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?=.*v=([a-zA-Z0-9_-]+))(?:[?&%#\w\-=\.\/;:]+)+$/, idGroup: 1 },
                { regex: /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
                { regex: /^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 }
            ];
            const youtubeTimestampRegex = /[?&]t=([0-9hm_s]+)/;
            const inlineYoutubePatterns = [
                { type: 'watch', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:[^#&?\s]*&)*v=([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 },
                { type: 'short', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 },
                { type: 'youtu.be', regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 }
            ];
            const twitchPatterns = [
                { type: 'clip_direct', regex: /^(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
                { type: 'clip_channel', regex: /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
                { type: 'vod', regex: /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos|v)\/(\d+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 }
            ];
            const twitchTimestampRegex = /[?&]t=((?:\d+h)?(?:\d+m)?(?:\d+s)?)/;
            const inlineTwitchPatterns = [
                { type: 'clip_direct', regex: /(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 },
                { type: 'clip_channel', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 },
                { type: 'vod', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos|v)\/(\d+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 }
            ];
            const streamablePatterns = [
                { type: 'video', regex: /^(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)(?:[?#][^\s]*)?$/, idGroup: 1 }
            ];
            const inlineStreamablePatterns = [
                { type: 'video', regex: /(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 }
            ];
            const tiktokPatterns = [
                { type: 'video', regex: /^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/, idGroup: 1 }
            ];
            const inlineTiktokPatterns = [
                { type: 'video', regex: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/, idGroup: 1 }
            ];
            const kickPatterns = [
                { type: 'clip', regex: /^(?:https?:\/\/)?kick\.com\/[\w.-]+\?clip=([\w-]+)/, idGroup: 1 }
            ];
            const inlineKickPatterns = [
                { type: 'clip', regex: /(?:https?:\/\/)?kick\.com\/[\w.-]+\?clip=([\w-]+)/, idGroup: 1 }
            ];

            if (!soleUrlEmbedMade) {
                for (const patternObj of youtubePatterns) {
                    const match = trimmedLine.match(patternObj.regex);
                    if (match) {
                        const videoId = match[patternObj.idGroup];
                        let timestampStr = null;
                        const timeMatch = trimmedLine.match(youtubeTimestampRegex);
                        if (timeMatch && timeMatch[1]) timestampStr = timeMatch[1];
                        if (videoId) {
                            textElement.appendChild(createYouTubeEmbedElement(videoId, timestampStr));
                            const urlLink = document.createElement('a');
                            urlLink.href = trimmedLine;
                            urlLink.textContent = trimmedLine;
                            urlLink.target = '_blank';
                            urlLink.style.cssText = "display: block; color: #60a5fa; font-size: 11px;";
                            textElement.appendChild(urlLink);
                            soleUrlEmbedMade = true;
                            processedAsEmbed = true;
                            break;
                        }
                    }
                }
            }
            if (!soleUrlEmbedMade) {
                for (const patternObj of twitchPatterns) {
                    const match = trimmedLine.match(patternObj.regex);
                    if (match) {
                        const id = match[patternObj.idGroup];
                        let timestampStr = null;
                        if (patternObj.type === 'vod') {
                            const timeMatch = trimmedLine.match(twitchTimestampRegex);
                            if (timeMatch && timeMatch[1]) timestampStr = timeMatch[1];
                        }
                        if (id) {
                            textElement.appendChild(createTwitchEmbedElement(patternObj.type, id, timestampStr));
                            const urlLink = document.createElement('a');
                            urlLink.href = trimmedLine;
                            urlLink.textContent = trimmedLine;
                            urlLink.target = '_blank';
                            urlLink.style.cssText = "display: block; color: #60a5fa; font-size: 11px;";
                            textElement.appendChild(urlLink);
                            soleUrlEmbedMade = true;
                            processedAsEmbed = true;
                            break;
                        }
                    }
                }
            }
            if (!soleUrlEmbedMade) {
                for (const patternObj of tiktokPatterns) {
                    const match = trimmedLine.match(patternObj.regex);
                    if (match) {
                        const videoId = match[patternObj.idGroup];
                        if (videoId) {
                            textElement.appendChild(createTikTokEmbedElement(videoId));
                            const urlLink = document.createElement('a');
                            urlLink.href = trimmedLine;
                            urlLink.textContent = trimmedLine;
                            urlLink.target = '_blank';
                            urlLink.style.cssText = "display: block; color: #60a5fa; font-size: 11px;";
                            textElement.appendChild(urlLink);
                            soleUrlEmbedMade = true;
                            processedAsEmbed = true;
                            break;
                        }
                    }
                }
            }
            if (!soleUrlEmbedMade) {
                for (const patternObj of streamablePatterns) {
                    const match = trimmedLine.match(patternObj.regex);
                    if (match) {
                        const videoId = match[patternObj.idGroup];
                        if (videoId) {
                            textElement.appendChild(createStreamableEmbedElement(videoId));
                            const urlLink = document.createElement('a');
                            urlLink.href = trimmedLine;
                            urlLink.textContent = trimmedLine;
                            urlLink.target = '_blank';
                            urlLink.style.cssText = "display: block; color: #60a5fa; font-size: 11px;";
                            textElement.appendChild(urlLink);
                            soleUrlEmbedMade = true;
                            processedAsEmbed = true;
                            break;
                        }
                    }
                }
            }

            if (!soleUrlEmbedMade) {
                let currentTextSegment = line;
                while (currentTextSegment.length > 0) {
                    let earliestMatch = null;
                    let earliestMatchPattern = null;
                    let earliestMatchType = null;
                    let earliestMatchIsQuoteLink = false;

                    for (const patternObj of [...inlineYoutubePatterns, ...inlineKickPatterns, ...inlineTiktokPatterns, ...inlineTwitchPatterns, ...inlineStreamablePatterns]) {
                        const matchAttempt = currentTextSegment.match(patternObj.regex);
                        if (matchAttempt && (earliestMatch === null || matchAttempt.index < earliestMatch.index)) {
                            earliestMatch = matchAttempt;
                            earliestMatchPattern = patternObj;
                            if (inlineYoutubePatterns.includes(patternObj)) earliestMatchType = 'youtube';
                            else if (inlineKickPatterns.includes(patternObj)) earliestMatchType = 'kick';
                            else if (inlineTiktokPatterns.includes(patternObj)) earliestMatchType = 'tiktok';
                            else if (inlineTwitchPatterns.includes(patternObj)) earliestMatchType = 'twitch';
                            else if (inlineStreamablePatterns.includes(patternObj)) earliestMatchType = 'streamable';
                            earliestMatchIsQuoteLink = false;
                        }
                    }

                    const quoteLinkMatch = currentTextSegment.match(inlineQuoteRegex);
                    if (quoteLinkMatch && (earliestMatch === null || quoteLinkMatch.index < earliestMatch.index)) {
                        earliestMatch = quoteLinkMatch;
                        earliestMatchType = null;
                        earliestMatchIsQuoteLink = true;
                    }

                    if (earliestMatch) {
                        processedAsEmbed = true;
                        if (earliestMatch.index > 0) {
                            textElement.appendChild(document.createTextNode(currentTextSegment.substring(0, earliestMatch.index)));
                        }
                        const matchedText = earliestMatch[0];
                        if (earliestMatchIsQuoteLink) {
                            if (currentDepth >= MAX_QUOTE_DEPTH) {
                                const newText = matchedText.replace(/>>(\d+)/, '↪ $1');
                                textElement.appendChild(document.createTextNode(newText));
                            } else {
                                const quotedMessageId = earliestMatch[1];
                                let quotedMessageObject = null;
                                for (const threadIdKey in messagesByThreadId) {
                                    if (messagesByThreadId.hasOwnProperty(threadIdKey)) {
                                        const foundMsg = messagesByThreadId[threadIdKey].find(m => m.id === Number(quotedMessageId));
                                        if (foundMsg) {
                                            quotedMessageObject = foundMsg;
                                            break;
                                        }
                                    }
                                }
                                if (quotedMessageObject) {
                                    const quotedElement = createMessageElementDOM(quotedMessageObject, mediaLoadPromises, uniqueImageViewerHashes, quotedMessageObject.board || boardForLink, false, currentDepth + 1, null, message.id, ancestors, effectiveDepthForStyling + 1);
                                    if (quotedElement) {
                                        textElement.appendChild(quotedElement);
                                        if (currentTextSegment.substring(earliestMatch[0].length).trim().length > 0) {
                                            textElement.appendChild(document.createElement('br'));
                                        }
                                    }
                                } else {
                                    const notFoundSpan = document.createElement('span');
                                    notFoundSpan.textContent = `↪ ${quotedMessageId} (Not Found)`;
                                    notFoundSpan.style.color = '#88ccee';
                                    notFoundSpan.style.textDecoration = 'underline';
                                    textElement.appendChild(notFoundSpan);
                                }
                            }
                        } else {
                            const id = earliestMatch[earliestMatchPattern.idGroup];
                            let timestampStr = null;
                            let embedElement = null;
                            if (earliestMatchType === 'youtube') {
                                const timeMatchInUrl = matchedText.match(youtubeTimestampRegex);
                                if (timeMatchInUrl && timeMatchInUrl[1]) timestampStr = timeMatchInUrl[1];
                                embedElement = createYouTubeEmbedElement(id, timestampStr);
                            } else if (earliestMatchType === 'twitch') {
                                if (earliestMatchPattern.type === 'vod') {
                                    const timeMatchInUrl = matchedText.match(twitchTimestampRegex);
                                    if (timeMatchInUrl && timeMatchInUrl[1]) timestampStr = timeMatchInUrl[1];
                                }
                                embedElement = createTwitchEmbedElement(earliestMatchPattern.type, id, timestampStr);
                            } else if (earliestMatchType === 'streamable') {
                                embedElement = createStreamableEmbedElement(id);
                            } else if (earliestMatchType === 'tiktok') {
                                embedElement = createTikTokEmbedElement(id);
                            } else if (earliestMatchType === 'kick') {
                                embedElement = createKickEmbedElement(id);
                            }
                            if (embedElement) {
                                textElement.appendChild(embedElement);
                            }
                        }
                        currentTextSegment = currentTextSegment.substring(earliestMatch.index + matchedText.length);
                    } else {
                        if (currentTextSegment.length > 0) {
                            if (textElement.lastChild && textElement.lastChild.nodeType === 1 && textElement.lastChild.tagName !== 'BR' && !/^\s/.test(currentTextSegment)) {
                                textElement.appendChild(document.createTextNode(' '));
                            }
                            textElement.appendChild(document.createTextNode(currentTextSegment));
                        }
                        currentTextSegment = "";
                    }
                }
            }
            if (lineIndex < lines.length - 1 && (trimmedLine.length > 0 || processedAsEmbed)) {
                textElement.appendChild(document.createElement('br'));
            }
        });
    } else {
        textElement.textContent = message.text || '';
    }

    if (shouldDisableUnderline && textElement.firstChild && textElement.firstChild.nodeName === 'BR') {
        textElement.removeChild(textElement.firstChild);
    }

    let attachmentDiv = null;
    if (message.attachment && message.attachment.tim) {
        const actualBoardForLink = boardForLink || message.board || 'b';
        attachmentDiv = document.createElement('div');
        attachmentDiv.style.marginTop = '10px';

        const filenameContainer = document.createElement('div');
        filenameContainer.style.cssText = "display: flex; align-items: center; gap: 5px; margin-top: 5px;";

        _populateAttachmentDivWithMedia(
            attachmentDiv, message, actualBoardForLink, mediaLoadPromises,
            uniqueImageViewerHashes, isTopLevelMessage, 'default',
            renderedFullSizeImageHashes, viewerTopLevelAttachedVideoHashes, otkMediaDB,
            effectiveDepthForStyling,
            filenameContainer
        );

        const filenameLink = document.createElement('a');
        const truncatedFilename = truncateFilename(message.attachment.filename, 50);
        filenameLink.textContent = `${truncatedFilename} (${message.attachment.ext.substring(1)})`;
        filenameLink.title = message.attachment.filename; // Show full filename on hover
        filenameLink.href = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;
        filenameLink.target = "_blank";
        filenameLink.style.cssText = "color: #60a5fa;";
        filenameContainer.appendChild(filenameLink);

        attachmentDiv.appendChild(filenameContainer);
    }

    return [textElement, attachmentDiv];
}
    // Signature now includes parentMessageId and ancestors
function _createMessageHeaderIcons(message, messageDiv, isFiltered, headerContainer) {
    const blockIcon = document.createElement('span');
    blockIcon.classList.add('block-icon');
    blockIcon.innerHTML = '&#128711;';
    blockIcon.style.cssText = 'margin-left: 8px; cursor: pointer; font-size: 16px;';

    if (isFiltered) {
        blockIcon.style.color = 'red';
        blockIcon.title = 'This message is blocked by your filters.';
    } else {
        blockIcon.style.visibility = 'hidden';
        blockIcon.title = 'Create filter for this message';
    }
    headerContainer.appendChild(blockIcon);

    const multiQuoteWrapper = document.createElement('div');
    multiQuoteWrapper.className = 'otk-multiquote-checkbox-wrapper';
    const multiQuoteCheckbox = document.createElement('input');
    multiQuoteCheckbox.type = 'checkbox';
    multiQuoteCheckbox.className = 'otk-multiquote-checkbox';
    multiQuoteCheckbox.dataset.messageId = message.id;
    multiQuoteCheckbox.checked = multiQuoteSelections.has(message.id);
    if (multiQuoteCheckbox.checked) {
        multiQuoteWrapper.classList.add('selected');
    }

    multiQuoteCheckbox.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.checked) {
            multiQuoteSelections.add(message.id);
            multiQuoteWrapper.classList.add('selected');
        } else {
            multiQuoteSelections.delete(message.id);
            multiQuoteWrapper.classList.remove('selected');
        }
        consoleLog('Multi-quote selections:', multiQuoteSelections);
    });

    multiQuoteWrapper.appendChild(multiQuoteCheckbox);
    headerContainer.appendChild(multiQuoteWrapper);

    const pinIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    pinIcon.setAttribute('class', 'otk-pin-icon');
    pinIcon.setAttribute('title', 'Pin this message');
    pinIcon.setAttribute('viewBox', '0 0 16 16');
    const pinPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pinPath.setAttribute('d', 'M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354m1.58 1.408-.002-.001zm-.002-.001.002.001A.5.5 0 0 1 6 2v5a.5.5 0 0 1-.276.447h-.002l-.012.007-.054.03a5 5 0 0 0-.827.58c-.318.278-.585.596-.725.936h7.792c-.14-.34-.407-.658-.725-.936a5 5 0 0 0-.881-.61l-.012-.006h-.002A.5.5 0 0 1 10 7V2a.5.5 0 0 1 .295-.458 1.8 1.8 0 0 0 .351-.271c.08-.08.155-.17.214-.271H5.14q.091.15.214.271a1.8 1.8 0 0 0 .37.282');
    pinPath.setAttribute('fill', 'currentColor');
    pinIcon.appendChild(pinPath);
    headerContainer.appendChild(pinIcon);

    // Attach hover listeners regardless of filter status to handle pin icon visibility
    headerContainer.addEventListener('mouseenter', () => {
        if (!isFiltered) { // Only toggle block icon if not filtered
            blockIcon.style.visibility = 'visible';
        }
        if (pinIcon) {
            pinIcon.style.visibility = 'visible';
        }
        if (!multiQuoteWrapper.classList.contains('selected')) {
            multiQuoteWrapper.classList.add('visible');
        }
    });

    headerContainer.addEventListener('mouseleave', () => {
        if (!isFiltered) { // Only toggle block icon if not filtered
            blockIcon.style.visibility = 'hidden';
        }
        if (pinIcon && !messageDiv.classList.contains(PINNED_MESSAGE_CLASS)) {
            pinIcon.style.visibility = 'hidden';
        }
        if (!multiQuoteWrapper.classList.contains('selected')) {
            multiQuoteWrapper.classList.remove('visible');
        }
    });

    blockIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        const hasText = message.text && message.text.replace(/>>\d+(\s\(You\))?/g, '').trim().length > 0;
        const hasAttachment = message.attachment && message.attachment.filehash_db_key;
        const newRule = {
            id: Date.now(),
            action: 'filterOut',
            enabled: true,
            category: 'keyword',
            matchContent: '',
            replaceContent: ''
        };
        if (hasText && hasAttachment) {
            newRule.category = 'entireMessage';
            try {
                newRule.matchContent = JSON.stringify({
                    text: message.text.replace(/>>\d+(\s\(You\))?/g, '').trim(),
                    media: `md5:${message.attachment.filehash_db_key}`
                }, null, 2);
            } catch (err) {
                consoleError("Failed to stringify composite filter", err);
                newRule.category = 'attachedMedia';
                newRule.matchContent = `md5:${message.attachment.filehash_db_key}`;
            }
        } else if (hasText) {
            newRule.category = 'keyword';
            newRule.matchContent = message.text.replace(/>>\d+(\s\(You\))?/g, '').trim();
        } else if (hasAttachment) {
            newRule.category = 'attachedMedia';
            newRule.matchContent = `md5:${message.attachment.filehash_db_key}`;
        }
        const filterWindow = document.getElementById('otk-filter-window');
        if (filterWindow) {
            filterWindow.style.display = 'flex';
            renderFilterEditorView(newRule);
        }
    });

    return pinIcon;
}

function createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor, parentMessageId = null, ancestors = new Set(), visualDepth = null) {
        let pinIcon;
        const filterRules = JSON.parse(localStorage.getItem(FILTER_RULES_V2_KEY) || '[]');

        const shouldBeFilteredOut = isMessageFiltered(message, filterRules);
        if (shouldBeFilteredOut) {
            if (!(currentDepth === 0 && message.text && message.text.includes('>>'))) {
                consoleLog(`[Filter] Filtering out message ${message.id} due to a 'filterOut' rule.`);
                return null;
            }
        }

        const processedMessage = applyFiltersToMessageContent(message, filterRules);
        const isFiltered = shouldBeFilteredOut || doesAnyRuleMatch(message, filterRules);

        // const layoutStyle = localStorage.getItem('otkMessageLayoutStyle') || 'default';

        // Stack overflow prevention: Check for circular references.
        if (ancestors.has(message.id)) {
            consoleWarn(`[CircularRef] Circular reference detected for message ID ${message.id}. Aborting render for this branch.`);
            const circularRefSpan = document.createElement('span');
            circularRefSpan.textContent = `>>${message.id} (Circular Reference Detected)`;
            circularRefSpan.style.color = '#ff6b6b';
            return circularRefSpan;
        }

        // Add current message ID to the set of ancestors for the recursive calls.
        const newAncestors = new Set(ancestors).add(message.id);

        let seenEmbeds = [];
        try {
            seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
        } catch (e) {
            consoleError("Error parsing seen embeds from localStorage:", e);
        }
        let allThemeSettings = {};
        try {
            allThemeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        } catch (e) {
            consoleError("Error parsing theme settings from localStorage:", e);
        }

    let effectiveDepthForStyling = currentDepth;
    if (visualDepth !== null) {
        effectiveDepthForStyling = visualDepth;
    }
    const isEvenDepth = effectiveDepthForStyling % 2 === 0;

    const parity = isEvenDepth ? 'Odd' : 'Even';
    const contentFontSizeVar = `var(--otk-msg-depth-${parity.toLowerCase()}-content-font-size)`;
    let backgroundColorVar = `var(--otk-msg-depth-${parity.toLowerCase()}-bg-color)`;
    const textColorVar = `var(--otk-msg-depth-${parity.toLowerCase()}-text-color)`;
    const headerTextColorVar = `var(--otk-msg-depth-${parity.toLowerCase()}-header-text-color)`;
    const headerBorderVar = `var(--otk-viewer-header-border-color-${parity.toLowerCase()})`;

    let borderColorVar = 'transparent';
    if (userPostIds.has(message.id)) {
        backgroundColorVar = isEvenDepth ? 'var(--otk-own-msg-bg-color-even)' : 'var(--otk-own-msg-bg-color-odd)';
        borderColorVar = isEvenDepth ? 'var(--otk-own-msg-border-color-even)' : 'var(--otk-own-msg-border-color-odd)';
    }

    const shouldDisableUnderline = !isTopLevelMessage;

        // --- Define all media patterns once at the top of the function ---
        const youtubePatterns = [
            { regex: /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?=.*v=([a-zA-Z0-9_-]+))(?:[?&%#\w\-=\.\/;:]+)+$/, idGroup: 1 },
            { regex: /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
            { regex: /^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 }
        ];
        const youtubeTimestampRegex = /[?&]t=([0-9hm_s]+)/;
        const inlineYoutubePatterns = [
            { type: 'watch', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:[^#&?\s]*&)*v=([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 },
            { type: 'short', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 },
            { type: 'youtu.be', regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 }
        ];

        const twitchPatterns = [
            { type: 'clip_direct', regex: /^(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
            { type: 'clip_channel', regex: /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
            { type: 'vod', regex: /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos|v)\/(\d+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 }
        ];
        const twitchTimestampRegex = /[?&]t=((?:\d+h)?(?:\d+m)?(?:\d+s)?)/;
        const inlineTwitchPatterns = [
            { type: 'clip_direct', regex: /(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 },
            { type: 'clip_channel', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 },
            { type: 'vod', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos|v)\/(\d+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 }
        ];

        const streamablePatterns = [
            { type: 'video', regex: /^(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)(?:[?#][^\s]*)?$/, idGroup: 1 }
        ];
        const inlineStreamablePatterns = [
            { type: 'video', regex: /(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 }
        ];
        const tiktokPatterns = [
            { type: 'video', regex: /^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/, idGroup: 1 }
        ];
        const inlineTiktokPatterns = [
            { type: 'video', regex: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/, idGroup: 1 }
        ];
        const kickPatterns = [
            { type: 'clip', regex: /^(?:https?:\/\/)?kick\.com\/[\w.-]+\?clip=([\w-]+)/, idGroup: 1 }
        ];
        const inlineKickPatterns = [
            { type: 'clip', regex: /(?:https?:\/\/)?kick\.com\/[\w.-]+\?clip=([\w-]+)/, idGroup: 1 }
        ];
        // --- End of media pattern definitions ---

        { // layoutStyle === 'default' or unknown (original logic)
            const messageDiv = document.createElement('div');
            messageDiv.setAttribute('data-message-id', message.id);
            if (visualDepth !== null) {
                messageDiv.dataset.visualDepth = visualDepth;
            }
            if (isTopLevelMessage) {
                messageDiv.classList.add('otk-message-container-main');
            }
            messageDiv.classList.add(isEvenDepth ? 'otk-message-depth-odd' : 'otk-message-depth-even');

            let marginLeft = '0';
            let paddingLeft = '10px'; // Default to 10px
            let marginTop = '15px'; // Default top margin
            let marginBottom = '15px'; // Default bottom margin

            if (!isTopLevelMessage) { // Quoted messages
                marginLeft = '0px';
                marginTop = '10px';
                marginBottom = '0px';
            }

    messageDiv.style.cssText = `
        box-sizing: border-box;
        display: block;
        background-color: ${backgroundColorVar};
        color: ${textColorVar};
        font-size: ${contentFontSizeVar};

        margin-top: ${marginTop};
        margin-bottom: ${marginBottom};
        margin-left: ${marginLeft};
        padding-top: 10px;
        padding-bottom: 10px;
        padding-left: ${paddingLeft};
        padding-right: 10px;

        border-radius: 5px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);

        width: calc(100% - ${marginLeft});
        max-width: calc(100% - ${marginLeft});
        overflow-x: hidden;
    `;
    if (borderColorVar !== 'transparent') {
        messageDiv.style.border = `1px solid ${borderColorVar}`;
    }

            // Removed the side rectangle logic that was here:
            // if (isTopLevelMessage && threadColor) { ... }

            const messageHeader = document.createElement('div');

            messageHeader.style.cssText = `
                font-size: 12px;
                color: ${headerTextColorVar};
                font-weight: bold;
                margin-bottom: 8px;
                padding-bottom: 5px;
                border-bottom: 1px solid ${headerBorderVar};
                display: flex;
                align-items: center;
                width: 100%;
            `;


            if (shouldDisableUnderline) {
                messageHeader.style.borderBottom = 'none';
                messageHeader.style.paddingBottom = '0px';
                messageHeader.style.marginBottom = '4px'; // Reduced margin for quoted messages
                messageHeader.style.lineHeight = '1.1';   // Standardized
                messageHeader.style.minHeight = '0';      // Standardized
            }

            const timestampParts = formatTimestampForHeader(message.time);

            if (isTopLevelMessage) {
                messageHeader.style.justifyContent = 'space-between'; // For ID+Time (left) and Date (right)

                // Create a container for the color square and the ID/Time text
                const leftHeaderContent = document.createElement('span');
                leftHeaderContent.style.display = 'flex'; // Use flex to align square and text
                leftHeaderContent.style.alignItems = 'center'; // Vertically align items in the flex container

                if (threadColor) {
                    const colorSquare = document.createElement('span');
                    colorSquare.style.cssText = `
                        display: inline-block;
                        width: 12px; /* Adjust size as needed */
                        height: 12px; /* Adjust size as needed */
                        background-color: ${threadColor};
                        margin-right: 6px; /* Space between square and '#' */
                        border-radius: 2px; /* Optional: for rounded corners */
                        flex-shrink: 0; /* Prevent square from shrinking */
                        border: var(--otk-viewer-thread-box-outline, none);
                    `;
                    leftHeaderContent.appendChild(colorSquare);
                }

                const idSpan = document.createElement('span');
                idSpan.textContent = `#${message.id}`;
                idSpan.style.cursor = 'pointer';
                if (isFiltered) {
                    idSpan.style.textDecoration = 'line-through';
                }
                idSpan.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    triggerQuickReply(message.id, message.originalThreadId);
                });

                const timeTextSpan = document.createElement('span');
                timeTextSpan.textContent = `\u00A0| ${timestampParts.time}`;
                if (isFiltered) {
                    timeTextSpan.style.textDecoration = 'line-through';
                }
                leftHeaderContent.appendChild(idSpan);
                leftHeaderContent.appendChild(timeTextSpan);

                pinIcon = _createMessageHeaderIcons(message, messageDiv, isFiltered, leftHeaderContent);

                const dateSpan = document.createElement('span');
                dateSpan.textContent = timestampParts.date;
                if (isFiltered) {
                    dateSpan.style.textDecoration = 'line-through';
                }

                const rightHeaderContent = document.createElement('span');
                rightHeaderContent.style.display = 'flex';
                rightHeaderContent.style.alignItems = 'center';

                if (hasTruncatedQuotes(message)) { // Use the recursive check for initial display
                    const plusIcon = document.createElement('span');
                    plusIcon.classList.add('otk-plus-icon');
                    plusIcon.id = `otk-plus-icon-${message.id}`;
                    plusIcon.textContent = '+';
                    plusIcon.style.color = 'var(--otk-plus-icon-color)';
                    plusIcon.title = 'Load next reply in truncated chain';
                    plusIcon.style.fontWeight = 'bold';
                    plusIcon.style.fontSize = '18px';
                    plusIcon.style.lineHeight = '24px';
                    plusIcon.style.marginRight = '8px';
                    plusIcon.style.cursor = 'pointer';
                    plusIcon.style.width = '24px';
                    plusIcon.style.height = '24px';
                    plusIcon.style.display = 'flex';
                    plusIcon.style.alignItems = 'center';
                    plusIcon.style.justifyContent = 'center';
                    plusIcon.style.borderRadius = '4px';
                    plusIcon.style.backgroundColor = 'transparent';

                    plusIcon.addEventListener('click', async (e) => {
                        e.stopPropagation();

                        const clickedPlusIcon = e.currentTarget;
                        const topLevelElement = clickedPlusIcon.closest('.otk-message-container-main');
                        if (!topLevelElement) {
                            consoleError("Could not find top-level container for the clicked plus icon.");
                            return;
                        }

                        const truncatedInfo = findNextUnloadedQuoteLink(topLevelElement);

                        if (!truncatedInfo) {
                            consoleWarn(`Plus icon clicked for message ${message.id}, but no further truncated quotes could be found. Removing icon.`);
                            clickedPlusIcon.remove();
                            return;
                        }

                        const { id: messageToLoadId, parentId: parentOfTruncatedId } = truncatedInfo;

                        let messageToLoad = findMessageById(messageToLoadId);
                        if (!messageToLoad) {
                            clickedPlusIcon.style.cursor = 'wait';
                            clickedPlusIcon.style.color = '#aaa';
                            try {
                                await fetchThreadMessages(message.originalThreadId);
                                messageToLoad = findMessageById(messageToLoadId);
                            } catch (error) {
                                consoleError(`Failed to fetch thread for click-to-load:`, error);
                                return;
                            } finally {
                                clickedPlusIcon.style.cursor = 'pointer';
                                clickedPlusIcon.style.color = threadColor;
                            }
                        }

                        if (!messageToLoad) {
                            consoleError(`Message ${messageToLoadId} not found even after fetching thread.`);
                            return;
                        }

                        const insertionParent = topLevelElement.querySelector(`div[data-message-id='${parentOfTruncatedId}']`);
                        if (!insertionParent) {
                            consoleError(`Could not find insertion parent element with ID ${parentOfTruncatedId}`);
                            return;
                        }

                        // We need the actual depth of the parent to correctly render the new child's own quotes.
                        const parentMessageObject = findMessageById(parentOfTruncatedId);
                        const parentActualDepth = findMessageDepth(message, parentOfTruncatedId);


                        const parentVisualDepth = insertionParent.dataset.visualDepth;
                        const newVisualDepth = (parentVisualDepth === undefined) ? 1 : parseInt(parentVisualDepth, 10) + 1;

                        const newElement = createMessageElementDOM(
                            messageToLoad, [], uniqueImageViewerHashes,
                            messageToLoad.board || 'b', false, (parentActualDepth !== null ? parentActualDepth + 1 : 0),
                            null, parentOfTruncatedId, new Set(), newVisualDepth
                        );

                        if (newElement) {
                            insertionParent.appendChild(newElement);

                            // Re-check if there are any more unloaded truncated quotes using the same DOM-based logic.
                            const nextTruncatedInfo = findNextUnloadedQuoteLink(topLevelElement);
                            if (!nextTruncatedInfo) {
                                clickedPlusIcon.remove();
                            }
                        }
                    });

                    rightHeaderContent.appendChild(plusIcon);
                }

                rightHeaderContent.appendChild(dateSpan);

                messageHeader.appendChild(leftHeaderContent);
                messageHeader.appendChild(rightHeaderContent);
            } else { // Simplified header for quoted messages
                messageHeader.style.justifyContent = 'flex-start'; // Align ID to the start

                const headerContentWrapper = document.createElement('span');
                headerContentWrapper.style.display = 'flex';
                headerContentWrapper.style.alignItems = 'center';

                const idSpan = document.createElement('span');
                idSpan.textContent = `#${message.id}`;
                idSpan.style.cursor = 'pointer';
                if (isFiltered) {
                    idSpan.style.textDecoration = 'line-through';
                }
                idSpan.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    triggerQuickReply(message.id, message.originalThreadId);
                });
                headerContentWrapper.appendChild(idSpan);

                pinIcon = _createMessageHeaderIcons(message, messageDiv, isFiltered, headerContentWrapper);
                messageHeader.appendChild(headerContentWrapper);
            }
            messageDiv.appendChild(messageHeader);
            const [textElement, attachmentDiv] = _populateMessageBody(processedMessage, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor, parentMessageId, newAncestors, allThemeSettings, shouldDisableUnderline, effectiveDepthForStyling);

            // Click listener for anchoring
            const persistentInstanceId = `otk-msg-${parentMessageId || 'toplevel'}-${message.id}`;
            messageDiv.id = persistentInstanceId;
            messageDiv.setAttribute('data-original-message-id', message.id);

            if (pinIcon) {
                pinIcon.addEventListener('click', (event) => {
                    event.stopPropagation();

                    const isThisMessageAlreadyPinned = messageDiv.classList.contains(PINNED_MESSAGE_CLASS);

                    // Un-highlight all currently pinned messages
                    document.querySelectorAll(`.${PINNED_MESSAGE_CLASS}`).forEach(el => {
                        el.classList.remove(PINNED_MESSAGE_CLASS);
                    });

                    if (isThisMessageAlreadyPinned) {
                    // If the clicked message was the pin, un-pin it
                    localStorage.removeItem(PINNED_MESSAGE_ID_KEY);
                    consoleLog(`Un-pinned message instance: ${persistentInstanceId}`);
                    } else {
                    // Otherwise, pin this new message
                        messageDiv.classList.add(PINNED_MESSAGE_CLASS);
                    localStorage.setItem(PINNED_MESSAGE_ID_KEY, persistentInstanceId);
                    consoleLog(`Pinned new message instance: ${persistentInstanceId}`);
                    }
                });
            }

            // Initial highlight check when the element is first created
            const initiallyStoredPinnedId = localStorage.getItem(PINNED_MESSAGE_ID_KEY);
            consoleLog("initiallyStoredPinnedId", initiallyStoredPinnedId, "persistentInstanceId", persistentInstanceId);
            if (persistentInstanceId === initiallyStoredPinnedId) {
                messageDiv.classList.add(PINNED_MESSAGE_CLASS);
                if (pinIcon) {
                    pinIcon.style.visibility = 'visible';
                }
            }

            if (unreadIds.has(message.id)) {
                messageDiv.classList.add('is-unread');
            }

            if (isFiltered) {
                const hasQuotes = textElement.querySelector('div[data-message-id]') !== null;
                const hasUnfilteredContent = ((processedMessage.text || '').trim().length > 0) || (processedMessage.attachment !== null);

                if (!hasUnfilteredContent && !hasQuotes) {
                    // Case 1: No unfiltered content and no quotes. Collapse the original message.
                    const [originalTextElement, originalAttachmentDiv] = _populateMessageBody(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor, parentMessageId, newAncestors, allThemeSettings, shouldDisplayFilenames, shouldDisableUnderline);
                    const collapsibleContainer = wrapInCollapsibleContainer([originalTextElement, originalAttachmentDiv]);
                    messageDiv.appendChild(collapsibleContainer);
                } else {
                    // Case 2: Has unfiltered content or quotes. Show processed content with an eye icon to toggle original.
                    // Case 2: Has unfiltered content or quotes. Show processed content with a toggle link.
                    if (pinIcon) { // pinIcon is the SVG element
                        const showFilteredLink = document.createElement('span');
                        showFilteredLink.textContent = 'Show filtered content';
                        showFilteredLink.style.cssText = 'margin-left: 8px; cursor: pointer; text-decoration: underline; visibility: hidden;';
                        showFilteredLink.title = 'Toggle between filtered and original message content';

                        pinIcon.parentNode.insertBefore(showFilteredLink, pinIcon.nextSibling);

                        messageHeader.addEventListener('mouseenter', () => {
                            showFilteredLink.style.visibility = 'visible';
                        });
                        messageHeader.addEventListener('mouseleave', () => {
                            showFilteredLink.style.visibility = 'hidden';
                        });

                        const bodyContainer = document.createElement('div');
                        const processedBodyContainer = document.createElement('div');
                        processedBodyContainer.append(textElement);
                        if (attachmentDiv) {
                            processedBodyContainer.append(attachmentDiv);
                        }

                        const originalBodyContainer = document.createElement('div');
                        originalBodyContainer.style.display = 'none';

                        bodyContainer.appendChild(processedBodyContainer);
                        bodyContainer.appendChild(originalBodyContainer);
                        messageDiv.appendChild(bodyContainer);

                        let originalBodyGenerated = false;

                        showFilteredLink.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (!originalBodyGenerated) {
                                const [originalTextElement, originalAttachmentDiv] = _populateMessageBody(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor, parentMessageId, newAncestors, allThemeSettings, shouldDisplayFilenames, shouldDisableUnderline);
                                if(originalTextElement) originalBodyContainer.append(originalTextElement);
                                if (originalAttachmentDiv) originalBodyContainer.append(originalAttachmentDiv);
                                originalBodyGenerated = true;
                            }

                            const isProcessedVisible = processedBodyContainer.style.display !== 'none';
                            processedBodyContainer.style.display = isProcessedVisible ? 'none' : 'block';
                            originalBodyContainer.style.display = isProcessedVisible ? 'block' : 'none';
                            showFilteredLink.textContent = isProcessedVisible ? 'Show original content' : 'Show filtered content';
                        });
                    } else {
                        // Fallback if block icon isn't found for some reason
                        messageDiv.appendChild(textElement);
                        if (attachmentDiv) {
                            messageDiv.appendChild(attachmentDiv);
                        }
                    }
                }
            } else {
                // Original logic for non-filtered messages
                messageDiv.appendChild(textElement);
                if (attachmentDiv) {
                    messageDiv.appendChild(attachmentDiv);
                }
            }
            return messageDiv;
        } // End of else (default layout)
    }



    function createThumbnailElement(attachment, board) {
        const thumbLink = document.createElement('a');
        thumbLink.href = `https://i.4cdn.org/${board}/${attachment.tim}${attachment.ext}`;
        thumbLink.target = '_blank';

        const thumbImg = document.createElement('img');
        thumbImg.src = `https://i.4cdn.org/${board}/${attachment.tim}s.jpg`; // Standard thumbnail URL format
        thumbImg.alt = attachment.filename;
        thumbImg.style.maxWidth = `${attachment.tn_w}px`;
        thumbImg.style.maxHeight = `${attachment.tn_h}px`;
        thumbImg.style.border = '1px solid #555';
        thumbImg.style.borderRadius = '3px';

        thumbLink.appendChild(thumbImg);
        return thumbLink;
    }

    async function scanCatalog() {
        const url = 'https://a.4cdn.org/b/catalog.json';
        try {
            const response = await fetch(url, { cache: 'no-store' }); // Avoid browser caching catalog
            if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status} ${response.statusText}`);
            const catalog = await response.json();

            let foundThreads = [];
            const keywordsString = localStorage.getItem(OTK_TRACKED_KEYWORDS_KEY) || "otk";
            const keywords = keywordsString.split(',')
                .map(k => k.trim().toLowerCase())
                .filter(k => k.length > 0);

            if (keywords.length === 0) { // Should not happen if default is "otk" but as a safeguard
                consoleWarn("scanCatalog: No valid keywords configured. Defaulting to 'otk'.");
                keywords.push("otk");
            }
            consoleLog(`scanCatalog: Using keywords for search: [${keywords.join(', ')}]`);

            const blockedKeywordsString = localStorage.getItem(OTK_BLOCKED_KEYWORDS_KEY) || "";
            const blockedKeywords = blockedKeywordsString.split(',')
                .map(k => k.trim().toLowerCase())
                .filter(k => k.length > 0);
            if (blockedKeywords.length > 0) {
                consoleLog(`scanCatalog: Using blocked keywords for filtering: [${blockedKeywords.join(', ')}]`);
            }

            catalog.forEach(page => {
                page.threads.forEach(thread => {
                    const title = (thread.sub || '').toLowerCase();
                    // const com = (thread.com || '').toLowerCase(); // No longer needed
                    // const combinedText = title + " " + com; // No longer needed

                    const isBlockedByKeyword = blockedKeywords.some(keyword => title.includes(keyword));

                    if (keywords.some(keyword => title.includes(keyword)) && !blockedThreads.has(Number(thread.no)) && !isBlockedByKeyword) {
                        foundThreads.push({
                            id: Number(thread.no),
                            title: thread.sub || `Thread ${thread.no}` // Store original case title
                        });
                    }
                });
            });
            consoleLog(`scanCatalog: Found ${foundThreads.length} threads matching keywords:`, foundThreads.map(t => t.id));
            return foundThreads;
        } catch (error) {
            consoleError('scanCatalog error:', error);
            return [];
        }
    }

    async function fetchThreadMessages(threadId) {
        // consoleLog('[DebugRefreshV2-FTM] START for threadId:', threadId); // Removed
        const url = `https://a.4cdn.org/b/thread/${threadId}.json`;
        const headers = {}; // Initialize empty headers object
        const metadata = threadFetchMetadata[threadId];

        if (metadata) {
            // consoleLog('[DebugRefreshV2-FTM] Preparing headers for threadId:', threadId, 'Current metadata:', JSON.stringify(metadata)); // Removed
            if (metadata.etag) {
                headers['If-None-Match'] = metadata.etag;
                // consoleLog('[DebugRefreshV2-FTM] Sending If-None-Match for', threadId, ':', headers['If-None-Match']); // Removed
            } else if (metadata.lastModified) {
                headers['If-Modified-Since'] = metadata.lastModified;
                // consoleLog('[DebugRefreshV2-FTM] Sending If-Modified-Since for', threadId, ':', headers['If-Modified-Since']); // Removed
            }
        } else {
            // consoleLog('[DebugRefreshV2-FTM] No metadata found for threadId:', threadId, 'Performing full fetch.'); // Removed
        }

        let response;
        try {
            response = await fetch(url, { headers: headers });
            // consoleLog('[DebugRefreshV2-FTM] Response status for', threadId, ':', response.status, 'OK:', response.ok); // Removed

            if (response.status === 304) {
                consoleLog(`Thread ${threadId} not modified (304).`);
                return { status: 'not_modified', threadId: threadId, messages: [], counts: { fetchedMessages: 0, fetchedImages: 0, fetchedVideos: 0, newlyStoredImages: 0, newlyStoredVideos: 0 } };
            }

            const defaultEmptyReturn = { messages: [], counts: { fetchedMessages: 0, fetchedImages: 0, fetchedVideos: 0, newlyStoredImages: 0, newlyStoredVideos: 0 } };

            if (!response.ok) { // Handles non-304 errors
                consoleWarn(`Fetch error for thread ${threadId}: ${response.status} ${response.statusText}`);
                if (response.status === 404) {
                    delete threadFetchMetadata[threadId]; // Clear metadata on 404
                }
                return defaultEmptyReturn; // Return new structure on error
            }

            // If response is OK (200), store new ETag/Last-Modified
            const newEtag = response.headers.get('ETag');
            const newLastModified = response.headers.get('Last-Modified');

            if (newEtag || newLastModified) {
                threadFetchMetadata[threadId] = {}; // Initialize/clear existing for this thread
                if (newEtag) {
                    threadFetchMetadata[threadId].etag = newEtag;
                }
                if (newLastModified) {
                    threadFetchMetadata[threadId].lastModified = newLastModified;
                }
                // consoleLog('[DebugRefreshV2-FTM] Stored new metadata for threadId:', threadId, 'New metadata:', JSON.stringify(threadFetchMetadata[threadId])); // Removed
                consoleLog(`Stored new ETag/Last-Modified for thread ${threadId}.`); // Standard log
            } else {
                // consoleLog('[DebugRefreshV2-FTM] No new ETag/Last-Modified headers found on 200 OK for threadId:', threadId); // Removed
                if (metadata) { // Only clear if old metadata existed and server stopped sending new ones
                    // consoleLog('[DebugRefreshV2-FTM] Clearing old metadata for threadId:', threadId, 'as no new headers were provided.'); // Removed
                    consoleLog(`No new ETag/Last-Modified for thread ${threadId}, clearing old metadata.`); // Standard log
                    delete threadFetchMetadata[threadId];
                }
            }

            const threadData = await response.json();
            // consoleLog('[DebugRefreshV2-FTM] Successfully got JSON for threadId:', threadId, 'Post count in JSON:', threadData.posts ? threadData.posts.length : 'N/A'); // Removed
            if (!threadData.posts || threadData.posts.length === 0) {
                consoleLog(`No posts in JSON for thread ${threadId}.`);
                return defaultEmptyReturn; // Return new structure if no posts
            }

            const opPost = threadData.posts[0];
            const posts = threadData.posts;
            const processedMessages = [];
            let fetchedMessagesInThread = 0;
            let fetchedImagesInThread = 0;
            let fetchedVideosInThread = 0;
            let newlyStoredImagesInThread = 0;
            let newlyStoredVideosInThread = 0;

            const mediaDownloadQueue = [];
            const messagePromises = posts.map(async (post) => {
            fetchedMessagesInThread++;
            const message = {
                id: post.no,
                time: post.time,
                originalThreadId: threadId,
                text: '',
                title: opPost.sub ? toTitleCase(decodeEntities(opPost.sub)) : `Thread ${threadId}`,
                attachment: null,
                com: post.com
            };

            if (post.com) {
                let rawText = post.com.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
                message.text = decodeAllHtmlEntities(rawText);
            }

            if (post.filename && post.tim && post.ext) {
                let filehash_db_key;
                const postMd5 = post.md5 ? post.md5.trim() : null;

                if (postMd5 && postMd5.length > 0 && postMd5 !== "                                        ") {
                    filehash_db_key = postMd5;
                } else {
                    filehash_db_key = `${post.tim}${post.ext}`;
                }

                message.attachment = {
                    filename: post.filename,
                    ext: post.ext,
                    tim: post.tim,
                    w: post.w, h: post.h, fsize: post.fsize, md5: post.md5,
                    filehash_db_key: filehash_db_key,
                    localStoreId: null,
                    tn_w: post.tn_w, tn_h: post.tn_h
                };

                if (otkMediaDB) {
                    const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                    const store = transaction.objectStore('mediaStore');
                    const dbRequest = store.get(filehash_db_key);
                    const dbResult = await new Promise((resolve, reject) => {
                        dbRequest.onsuccess = () => resolve(dbRequest.result);
                        dbRequest.onerror = (e) => reject(e.target.error);
                    });

                    if (dbResult) {
                        message.attachment.localStoreId = filehash_db_key;
                    } else {
                        mediaDownloadQueue.push({ post, message, filehash_db_key, board: opPost.board || 'b' });
                    }
                }
            }
            return message;
        });

        const initialProcessedMessages = await Promise.all(messagePromises);
        processedMessages.push(...initialProcessedMessages);

        // Process media download queue sequentially
        for (const item of mediaDownloadQueue) {
            const { post, message, filehash_db_key, board } = item;
            const mediaUrl = `https://i.4cdn.org/${board}/${post.tim}${post.ext}`;
            try {
                const mediaResponse = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET", url: mediaUrl, responseType: 'blob',
                        onload: (response) => {
                            if (response.status === 200) resolve(response.response);
                            else reject(new Error(`Fetch failed: ${response.status}`));
                        },
                        onerror: (error) => reject(error)
                    });
                });

                if (mediaResponse) {
                    const blob = mediaResponse;
                    const storeTransaction = otkMediaDB.transaction(['mediaStore'], 'readwrite');
                    const mediaStore = storeTransaction.objectStore('mediaStore');
                    const itemToStore = {
                        filehash: filehash_db_key, blob: blob, originalThreadId: threadId,
                        filename: post.filename, ext: post.ext, timestamp: Date.now(), isThumbnail: false
                    };
                    const putRequest = mediaStore.put(itemToStore);
                    await new Promise((resolve, reject) => {
                        putRequest.onsuccess = () => {
                            message.attachment.localStoreId = filehash_db_key;
                            const extLower = post.ext.toLowerCase();
                            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) newlyStoredImagesInThread++;
                            else if (['.webm', '.mp4'].includes(extLower)) newlyStoredVideosInThread++;
                            updateDisplayedStatistics();
                            resolve();
                        };
                        putRequest.onerror = (e) => reject(e.target.error);
                    });
                }
            } catch (fetchError) {
                consoleError(`Error fetching media for post ${post.no}:`, fetchError);
            }

            const extLower = post.ext.toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
                const thumbnail_filehash_db_key = filehash_db_key + '_thumb';
                const thumbGetTransaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                const thumbGetStore = thumbGetTransaction.objectStore('mediaStore');
                const thumbDbRequest = thumbGetStore.get(thumbnail_filehash_db_key);
                const thumbDbResult = await new Promise((resolve, reject) => {
                    thumbDbRequest.onsuccess = () => resolve(thumbDbRequest.result);
                    thumbDbRequest.onerror = (e) => reject(e.target.error);
                });

                if (thumbDbResult) {
                    message.attachment.localThumbStoreId = thumbnail_filehash_db_key;
                } else {
                    const thumbUrl = `https://i.4cdn.org/${board}/${post.tim}s.jpg`;
                    try {
                        const thumbResponse = await new Promise((resolve, reject) => {
                            GM_xmlhttpRequest({
                                method: "GET", url: thumbUrl, responseType: 'blob',
                                onload: (response) => {
                                    if (response.status === 200) resolve(response.response);
                                    else reject(new Error(`Fetch failed: ${response.status}`));
                                },
                                onerror: (error) => reject(error)
                            });
                        });
                        if (thumbResponse) {
                            const thumbBlob = thumbResponse;
                            const thumbStoreTransaction = otkMediaDB.transaction(['mediaStore'], 'readwrite');
                            const thumbMediaStore = thumbStoreTransaction.objectStore('mediaStore');
                            const thumbItemToStore = {
                                filehash: thumbnail_filehash_db_key, blob: thumbBlob, originalThreadId: threadId,
                                filename: `${post.filename}_thumb.jpg`, ext: '.jpg', timestamp: Date.now(), isThumbnail: true
                            };
                            const thumbPutRequest = thumbMediaStore.put(thumbItemToStore);
                            await new Promise((resolve, reject) => {
                                thumbPutRequest.onsuccess = () => {
                                    message.attachment.localThumbStoreId = thumbnail_filehash_db_key;
                                    resolve();
                                };
                                thumbPutRequest.onerror = (e) => reject(e.target.error);
                            });
                        }
                    } catch (thumbFetchError) {
                        consoleError(`Error fetching thumbnail for post ${post.no}:`, thumbFetchError);
                    }
                }
            }
        }

            // Refined counting for fetched media (regardless of storage status)
            // This ensures fetchedImagesInThread and fetchedVideosInThread are accurate even if media was already in DB.
            // The newlyStoredImagesInThread is correctly counted only upon successful new storage.
            let trueFetchedImages = 0;
            let trueFetchedVideos = 0;
            processedMessages.forEach(msg => {
                if (msg.attachment && msg.attachment.ext) {
                    const ext = msg.attachment.ext.toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                        trueFetchedImages++;
                    } else if (['.webm', '.mp4'].includes(ext)) {
                        trueFetchedVideos++;
                    }
                }
            });
            fetchedImagesInThread = trueFetchedImages;
            fetchedVideosInThread = trueFetchedVideos;


            consoleLog(`[fetchThreadMessages] Processed thread ${threadId}: ${fetchedMessagesInThread} msgs, ${fetchedImagesInThread} imgs, ${fetchedVideosInThread} vids. Stored: ${newlyStoredImagesInThread} imgs, ${newlyStoredVideosInThread} vids.`);
            return {
                messages: processedMessages,
                counts: {
                    fetchedMessages: fetchedMessagesInThread,
                    fetchedImages: fetchedImagesInThread,
                    fetchedVideos: fetchedVideosInThread,
                    newlyStoredImages: newlyStoredImagesInThread,
                    newlyStoredVideos: newlyStoredVideosInThread
                }
            };
        } catch (error) {
            consoleError(`fetchThreadMessages error for thread ${threadId}:`, error);
            return { messages: [], counts: { fetchedMessages: 0, fetchedImages: 0, fetchedVideos: 0, newlyStoredImages: 0, newlyStoredVideos: 0 } }; // Return new structure on error
        }
    }

async function backgroundRefreshThreadsAndMessages(options = {}) { // Added options parameter
        loadUserPostIds();
        const { skipViewerUpdate = false, isBackground = false } = options; // Destructure with default

        if (isManualRefreshInProgress) {
            consoleLog('[BG] Manual refresh in progress, skipping background refresh.');
            return;
        }
        consoleLog('[BG] Performing background refresh...', { isBackground, options });
        try {
            consoleLog('[BG] Calling scanCatalog...');
            const foundThreads = await scanCatalog();
            if (isManualRefreshInProgress) { consoleLog('[BG] Aborting due to manual refresh starting during catalog scan.'); return; }
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            consoleLog(`[BG] scanCatalog found ${foundThreads.length} threads:`, Array.from(foundIds));

            const previousActiveThreadIds = new Set(activeThreads.map(id => Number(id)));
            consoleLog('[BG] Previous active threads:', Array.from(previousActiveThreadIds));

            // A thread is considered 'live' if it's in the catalog scan.
            // Threads that are no longer in the catalog are removed from the active list,
            // but their messages are retained.
            const liveThreadIds = new Set(foundThreads.map(t => Number(t.id)));

            // Add new threads
            liveThreadIds.forEach(threadId => {
                if (!previousActiveThreadIds.has(threadId)) {
                    consoleLog(`[BG] Adding new live thread ${threadId} from catalog scan.`);
                    activeThreads.push(threadId);
                }
            });

            // Remove non-live threads from activeThreads
            const threadsBeforePruning = activeThreads.length;
            activeThreads = activeThreads.filter(threadId => liveThreadIds.has(threadId));
            const threadsAfterPruning = activeThreads.length;

            if (threadsBeforePruning > threadsAfterPruning) {
                consoleLog(`[BG] Pruned ${threadsBeforePruning - threadsAfterPruning} non-live threads from the active list.`);
            }

            // Cleanup color map
            const activeThreadIdsSet = new Set(activeThreads);
            for (const threadId in threadColors) {
                if (!activeThreadIdsSet.has(Number(threadId))) {
                    delete threadColors[threadId];
                }
            }
            consoleLog(`[BG] Cleaned up color map. Retaining colors for ${Object.keys(threadColors).length} active threads.`);

            consoleLog(`[BG] Active threads after catalog sync: ${activeThreads.length}`, activeThreads);

            let newMessages = [];
            // Process threads sequentially to avoid rate-limiting from 4chan API
            for (const threadId of activeThreads) {
                if (isManualRefreshInProgress) {
                    consoleLog('[BG] Aborting due to manual refresh starting during message fetch loop.');
                    return;
                }

                try {
                    const newMessagesResult = await fetchThreadMessages(threadId);

                    if (newMessagesResult && typeof newMessagesResult === 'object' && newMessagesResult.status === 'not_modified') {
                        consoleLog(`[BG] Thread ${threadId} was not modified. Skipping.`);
                        continue; // Skip to the next thread
                    }

                    if (newMessagesResult && Array.isArray(newMessagesResult.messages) && newMessagesResult.messages.length > 0) {
                        consoleLog(`[BG] Processing ${newMessagesResult.messages.length} messages for thread ${threadId}.`);
                        let existing = messagesByThreadId[threadId] || [];
                        let existingIds = new Set(existing.map(m => m.id));
                        let updatedMessages = [...existing];
                        let newMessagesInThread = [];

                        newMessagesResult.messages.forEach(m => {
                            if (!existingIds.has(m.id)) {
                                updatedMessages.push(m);
                                newMessagesInThread.push(m);
                            }
                        });

                        if (newMessagesInThread.length > 0) {
                            newMessages.push(...newMessagesInThread);
                            updatedMessages.sort((a, b) => a.time - b.time);
                            messagesByThreadId[threadId] = updatedMessages;

                            // Ensure OP title is present if it was missing
                            if (messagesByThreadId[threadId].length > 0 && (!messagesByThreadId[threadId][0].title || messagesByThreadId[threadId][0].title === `Thread ${threadId}`)) {
                                messagesByThreadId[threadId][0].title = newMessagesResult.messages[0].title;
                            }
                        }
                    } else if (newMessagesResult && newMessagesResult.messages.length === 0) {
                        consoleLog(`[BG] No new messages returned or thread is empty for active thread ${threadId}.`);
                    }
                } catch (error) {
                    consoleError(`[BG] Error fetching or processing thread ${threadId} in sequence:`, error);
                }
            }

            consoleLog(`[BG] Final active threads after message processing: ${activeThreads.length}`, activeThreads);
            consoleLog('[BG] Saving data...');
            consoleLog("[BG] messagesByThreadId before save: ", messagesByThreadId);
            localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
            for (const threadId of activeThreads) {
                if (messagesByThreadId[threadId]) {
                    await saveMessagesToDB(threadId, messagesByThreadId[threadId]);
                }
            }
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));

            if (isManualRefreshInProgress) { consoleLog('[BG] Aborting due to manual refresh starting during data save.'); return; }

            consoleLog('[BG] Data saved. Dispatching otkMessagesUpdated event.');
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
            renderThreadList();

            if (newMessages.length > 0) {
                const newIds = newMessages.map(m => m.id);
                newIds.forEach(id => unreadIds.add(id));
                localStorage.setItem(UNREAD_MESSAGE_IDS_KEY, JSON.stringify(Array.from(unreadIds)));
                consoleLog(`[BG] Added ${newIds.length} new message IDs to unread list. Total unread: ${unreadIds.size}`);

                // Check for new replies
                newMessages.forEach(message => {
                    if (message.text) {
                        const quotes = message.text.match(/>>(\d+)/g) || [];
                        for (const quote of quotes) {
                            const quoteId = parseInt(quote.substring(2));
                            if (userPostIds.has(quoteId)) {
                                newReplyIds.add(message.id);
                                break; // Only count one reply per message
                            }
                        }
                    }
                });
                localStorage.setItem('otkNewReplyIds', JSON.stringify(Array.from(newReplyIds)));
                consoleLog(`[BG] Found ${newReplyIds.size} new replies to user posts.`);
            }

            // **FIX: Declare viewerIsOpen before it is used.**
            const viewerIsOpen = otkViewer && otkViewer.style.display === 'block';

            updateDisplayedStatistics(isBackground);

            if (viewerIsOpen && !skipViewerUpdate && newMessages.length > 0) {
                const autoLoad = localStorage.getItem('otkAutoLoadUpdates') === 'true';
                if (autoLoad && !document.hidden) {
                    appendNewMessagesToViewer(newMessages);
                } else {
                    // Cache if autoLoad is off OR tab is hidden
                    const cachedIds = new Set(cachedNewMessages.map(m => m.id));
                    const messagesToCache = newMessages.filter(m => !cachedIds.has(m.id));
                    cachedNewMessages.push(...messagesToCache);
                    if (autoLoad && document.hidden) {
                        consoleLog(`[BG] Tab is hidden, caching ${messagesToCache.length} new messages.`);
                    } else {
                        consoleLog(`[BG] Caching ${messagesToCache.length} new messages for manual refresh.`);
                    }
                }
            }

            if (!viewerIsOpen) {
                consoleLog('[BG Refresh] Viewer is closed. Resynchronizing display snapshot with ground truth.');
                const allMessages = getAllMessagesSorted();

                renderedMessageIdsInViewer.clear();
                uniqueImageViewerHashes.clear();
                viewerTopLevelAttachedVideoHashes.clear();
                viewerTopLevelEmbedIds.clear();

                allMessages.forEach(message => {
                    renderedMessageIdsInViewer.add(message.id);
                    if (message.attachment) {
                        const filehash = message.attachment.filehash_db_key || `${message.attachment.tim}${message.attachment.ext}`;
                        const extLower = message.attachment.ext.toLowerCase();
                        if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
                            uniqueImageViewerHashes.add(filehash);
                        } else if (['.webm', '.mp4'].includes(extLower)) {
                            viewerTopLevelAttachedVideoHashes.add(filehash);
                        }
                    }
                    if (message.text) {
                        const inlineYoutubePatterns = [
                            { type: 'watch', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:[^#&?\s]*&)*v=([a-zA-Z0-9_-]+)/g },
                            { type: 'short', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/g },
                            { type: 'youtu.be', regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)/g }
                        ];
                        const inlineTwitchPatterns = [
                             { type: 'clip_direct', regex: /(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/g },
                             { type: 'clip_channel', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)/g },
                             { type: 'vod', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)/g }
                        ];
                        const inlineStreamablePatterns = [
                            { type: 'video', regex: /(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)/g }
                        ];

                        const allPatterns = [...inlineYoutubePatterns, ...inlineTwitchPatterns, ...inlineStreamablePatterns];
                        allPatterns.forEach(patternInfo => {
                            let match;
                            while ((match = patternInfo.regex.exec(message.text)) !== null) {
                                const id = match[1];
                                if (id) {
                                    let canonicalEmbedId;
                                    if (patternInfo.type.startsWith('watch') || patternInfo.type.startsWith('short') || patternInfo.type.startsWith('youtu.be')) {
                                        canonicalEmbedId = `youtube_${id}`;
                                    } else if (patternInfo.type.startsWith('clip') || patternInfo.type.startsWith('vod')) {
                                         canonicalEmbedId = `twitch_${patternInfo.type}_${id}`;
                                    } else {
                                        canonicalEmbedId = `streamable_${id}`;
                                    }
                                    viewerTopLevelEmbedIds.add(canonicalEmbedId);
                                }
                            }
                        });
                    }
                });
                consoleLog(`[BG Refresh] Resync complete. Snapshot counts: ${renderedMessageIdsInViewer.size} msgs, ${uniqueImageViewerHashes.size} imgs, ${viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size} videos.`);
                updateDisplayedStatistics(); // Re-run stats update after sync
            }

            consoleLog('[BG] Background refresh complete.');

        } catch (error) {
            consoleError('[BG] Error during background refresh:', error.message, error.stack);
        }
    }

    async function refreshThreadsAndMessages(options = {}) { // Manual Refresh / Called by Clear
        loadUserPostIds();
        messagesByThreadId = await loadMessagesFromDB(); // Ensure in-memory is synced with DB
        const { skipViewerUpdate = false, isChildCall = false } = options; // Destructure with default

        if (!isChildCall) {
            if (isManualRefreshInProgress) {
                consoleLog('[Manual] Refresh already in progress. Ignoring top-level call.');
                return;
            }
            isManualRefreshInProgress = true;
            resetStatAnimations();
        }

        consoleLog('[Manual] Refreshing threads and messages...', { options });
        showLoadingScreen("Initializing refresh..."); // Initial message
        try {
            await new Promise(resolve => setTimeout(resolve, 50)); // Ensure loading screen renders

            updateLoadingProgress(5, "Scanning catalog for OTK threads...");
            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            consoleLog(`[Manual] scanCatalog found ${foundThreads.length} threads:`, Array.from(foundIds));
            updateLoadingProgress(10, `Catalog scan complete. Found ${foundThreads.length} OTK threads. Syncing with local list...`);

            const previousActiveThreadIds = new Set(activeThreads.map(id => Number(id)));
            let threadsToFetch = []; // Store actual threadIds to fetch

            // A thread is considered 'live' if it's in the catalog scan.
            // Threads that are no longer in the catalog are removed from the active list,
            // but their messages are retained.
            const liveThreadIds = new Set(foundThreads.map(t => Number(t.id)));

            // Add new threads to activeThreads
            liveThreadIds.forEach(threadId => {
                if (!previousActiveThreadIds.has(threadId)) {
                    consoleLog(`[Manual] Adding new live thread ${threadId} to active list.`);
                    activeThreads.push(threadId);
                }
            });

            // Remove non-live threads from activeThreads
            const threadsBeforePruning = activeThreads.length;
            activeThreads = activeThreads.filter(threadId => liveThreadIds.has(threadId));
            const threadsAfterPruning = activeThreads.length;
            if (threadsBeforePruning > threadsAfterPruning) {
                consoleLog(`[Manual] Pruned ${threadsBeforePruning - threadsAfterPruning} non-live threads from the active list.`);
            }

            // Cleanup color map
            const activeThreadIdsSet = new Set(activeThreads);
            for (const threadId in threadColors) {
                if (!activeThreadIdsSet.has(Number(threadId))) {
                    delete threadColors[threadId];
                }
            }
            consoleLog(`[Manual] Cleaned up color map. Retaining colors for ${Object.keys(threadColors).length} active threads.`);

            // threadsToFetch should be all live threads to ensure they are all updated.
            threadsToFetch = Array.from(liveThreadIds);

            consoleLog(`[Manual] Active threads after catalog sync: ${activeThreads.length}`, activeThreads);
            consoleLog(`[Manual] Threads to fetch this cycle: ${threadsToFetch.length}`, threadsToFetch);
            updateLoadingProgress(15, `Preparing to fetch data for ${threadsToFetch.length} threads...`);

            let totalNewMessagesThisRefresh = 0;
            let totalNewImagesThisRefresh = 0; // Fetched images
            let totalNewVideosThisRefresh = 0; // Fetched videos
            let totalImagesStoredThisRefresh = 0;
            let totalVideosStoredThisRefresh = 0;

            let threadsProcessedCount = 0;
            const totalThreadsToProcess = threadsToFetch.length;

        let newMessagesToAppend = [];
            // Use a sequential loop for fetching to update loading screen more granularly per thread
            for (const threadId of threadsToFetch) {
                threadsProcessedCount++;
                const progressPercentage = 15 + Math.round((threadsProcessedCount / totalThreadsToProcess) * 75); // 15% (catalog) + 75% (fetching/processing)

                let statusText = `Processing thread ${threadsProcessedCount}/${totalThreadsToProcess} (ID: ${threadId})...`;
                // Removed detailed message/media counts from this loading screen update
                updateLoadingProgress(progressPercentage, statusText);

                try {
                    const result = await fetchThreadMessages(threadId); // fetchThreadMessages is already async

                    if (result.status === 'not_modified') {
                        consoleLog(`[Manual] Thread ${threadId} not modified. Skipping message update.`);
                        continue; // Next thread
                    }

                    const newMessagesData = result.messages; // This is an array of message objects
                    const counts = result.counts;

                    if (Array.isArray(newMessagesData)) {
                        let actualNewMessagesInThread = 0;
                        if (newMessagesData.length > 0) {
                            let existing = messagesByThreadId[threadId] || [];
                            let existingIds = new Set(existing.map(m => m.id));
                            let updatedMessages = [...existing];
                            newMessagesData.forEach(m => {
                                if (!existingIds.has(m.id)) {
                                    updatedMessages.push(m);
                                newMessagesToAppend.push(m);
                                    actualNewMessagesInThread++;
                                }
                            });
                            updatedMessages.sort((a, b) => a.time - b.time);
                            messagesByThreadId[threadId] = updatedMessages;
                            if (messagesByThreadId[threadId].length > 0 && (!messagesByThreadId[threadId][0].title || messagesByThreadId[threadId][0].title === `Thread ${threadId}`)) {
                                messagesByThreadId[threadId][0].title = newMessagesData[0].title;
                            }
                        }
                        totalNewMessagesThisRefresh += actualNewMessagesInThread;
                        totalNewImagesThisRefresh += counts.fetchedImages;
                        totalNewVideosThisRefresh += counts.fetchedVideos;
                        totalImagesStoredThisRefresh += counts.newlyStoredImages;
                        totalVideosStoredThisRefresh += counts.newlyStoredVideos;

                        consoleLog(`[Manual] Processed thread ${threadId}. Fetched: ${counts.fetchedMessages} msgs, ${counts.fetchedImages} imgs, ${counts.fetchedVideos} vids. Added: ${actualNewMessagesInThread} new msgs. Stored: ${counts.newlyStoredImages} imgs, ${counts.newlyStoredVideos} vids.`);
                    }
                } catch (error) {
                    consoleError(`[Manual] Error processing thread ${threadId} in loop:`, error);
                    // Continue to next thread
                }
            }

            // Final update to loading screen after loop
            let finalStatusText = `Refresh processing complete. Finalizing...`; // Simplified
            updateLoadingProgress(90, finalStatusText);


    // Re-filter activeThreads based on whether messagesByThreadId still has entries for them
    // This was previously commented out as too aggressive. Catalog scan is primary.
    // However, catalog scan is the main authority. This step might be redundant if catalog scan is robust.
    // For now, let's assume catalog scan + the processing logic above correctly maintains activeThreads.
    // activeThreads = activeThreads.filter(id => messagesByThreadId[id] && messagesByThreadId[id].length > 0);
    // This filtering above is too aggressive. A thread can be active and have 0 messages temporarily.
    // The main pruning of activeThreads happens after catalog scan.

    consoleLog(`[Manual] Final active threads after message processing: ${activeThreads.length}`, activeThreads);
            consoleLog("[Manual] messagesByThreadId before save: ", messagesByThreadId);
    localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads)); // activeThreads is already updated by catalog sync
            for (const threadId of activeThreads) {
                if (messagesByThreadId[threadId]) {
                    await saveMessagesToDB(threadId, messagesByThreadId[threadId]);
                }
            }
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));

            consoleLog('[Manual] Core refresh actions complete.');
            updateLoadingProgress(95, "Finalizing data and updating display...");
            renderThreadList();
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));

            unreadIds.clear();
            newReplyIds.clear();
            localStorage.setItem(UNREAD_MESSAGE_IDS_KEY, JSON.stringify([]));
            localStorage.setItem('otkNewReplyIds', JSON.stringify([]));
            consoleLog(`[Manual Refresh] Cleared unread message and new reply lists.`);

        let viewerIsOpen = otkViewer && otkViewer.style.display === 'block';

        if (!viewerIsOpen) {
            consoleLog('[Manual Refresh] Viewer is closed. Resynchronizing display snapshot with ground truth.');
            // This is the key fix: Resync the "Display Snapshot" sets with the "Ground Truth"
            // when a manual refresh is performed with the viewer closed.

            // 1. Recalculate the "Ground Truth" from all stored messages.
            const allMessages = getAllMessagesSorted();

            // 2. Clear the "Display Snapshot" sets.
            renderedMessageIdsInViewer.clear();
            uniqueImageViewerHashes.clear();
            viewerTopLevelAttachedVideoHashes.clear();
            viewerTopLevelEmbedIds.clear();

            // 3. Repopulate the "Display Snapshot" sets with the "Ground Truth".
            allMessages.forEach(message => {
                renderedMessageIdsInViewer.add(message.id);
                if (message.attachment) {
                    const filehash = message.attachment.filehash_db_key || `${message.attachment.tim}${message.attachment.ext}`;
                    const extLower = message.attachment.ext.toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
                        uniqueImageViewerHashes.add(filehash);
                    } else if (['.webm', '.mp4'].includes(extLower)) {
                        viewerTopLevelAttachedVideoHashes.add(filehash);
                    }
                }
                // This logic DOES now account for embeds in the text, which is a massive improvement
                // and aligns with the primary goal of syncing the main stats.
                if (message.text) {
                    const inlineYoutubePatterns = [
                        { type: 'watch', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:[^#&?\s]*&)*v=([a-zA-Z0-9_-]+)/g },
                        { type: 'short', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/g },
                        { type: 'youtu.be', regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)/g }
                    ];
                    const inlineTwitchPatterns = [
                         { type: 'clip_direct', regex: /(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/g },
                         { type: 'clip_channel', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)/g },
                         { type: 'vod', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)/g }
                    ];
                    const inlineStreamablePatterns = [
                        { type: 'video', regex: /(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)/g }
                    ];

                    const allPatterns = [...inlineYoutubePatterns, ...inlineTwitchPatterns, ...inlineStreamablePatterns];
                    allPatterns.forEach(patternInfo => {
                        let match;
                        while ((match = patternInfo.regex.exec(message.text)) !== null) {
                            const id = match[1];
                            if (id) {
                                let canonicalEmbedId;
                                if (patternInfo.type.startsWith('watch') || patternInfo.type.startsWith('short') || patternInfo.type.startsWith('youtu.be')) {
                                    canonicalEmbedId = `youtube_${id}`;
                                } else if (patternInfo.type.startsWith('clip') || patternInfo.type.startsWith('vod')) {
                                     canonicalEmbedId = `twitch_${patternInfo.type}_${id}`;
                                } else {
                                    canonicalEmbedId = `streamable_${id}`;
                                }
                                viewerTopLevelEmbedIds.add(canonicalEmbedId);
                            }
                        }
                    });
                }
            });
             consoleLog(`[Manual Refresh] Resync complete. Snapshot counts: ${renderedMessageIdsInViewer.size} msgs, ${uniqueImageViewerHashes.size} imgs, ${viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size} videos.`);
        }

            updateDisplayedStatistics(false);

        if (!skipViewerUpdate && viewerIsOpen) {
            let allNewMessages = [...cachedNewMessages, ...newMessagesToAppend];
            allNewMessages.sort((a, b) => a.time - b.time);
            cachedNewMessages = [];
            consoleLog('[Manual Refresh] Cleared background message cache.');

            const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
            const messageLimitEnabled = themeSettings.otkMessageLimitEnabled !== false;
            const messageLimitValue = parseInt(themeSettings.otkMessageLimitValue || '500', 10);

            if (messageLimitEnabled && allNewMessages.length > messageLimitValue) {
                consoleLog(`[Manual Refresh] Applying message limit: Culling ${allNewMessages.length - messageLimitValue} oldest messages before rendering.`);
                allNewMessages = allNewMessages.slice(-messageLimitValue);
            }

            const allNewIds = new Set();
            const uniqueNewMessages = allNewMessages.filter(m => {
                if (allNewIds.has(m.id)) return false;
                allNewIds.add(m.id);
                return true;
            });

            const finalMessagesToAppend = uniqueNewMessages.filter(m => !renderedMessageIdsInViewer.has(m.id));
            consoleLog(`[Manual Refresh] Viewer is open, appending ${finalMessagesToAppend.length} new messages.`);
            await appendNewMessagesToViewer(finalMessagesToAppend);
        } else {
            consoleLog(`[Manual Refresh] Viewer not updated. Skip viewer update: ${skipViewerUpdate}, Viewer is open: ${viewerIsOpen}`);
        }
            // If viewer is not open, no specific viewer update action here, it will populate on next open.

            updateLoadingProgress(100, "Refresh complete!");
            setTimeout(hideLoadingScreen, 500);

        } catch (error) {
            consoleError('[Manual] Error during core refresh:', error);
            updateLoadingProgress(100, "Error during refresh. Check console.");
            setTimeout(hideLoadingScreen, 1500); // Keep error message visible a bit longer
        } finally {
            if (!isChildCall) {
                isManualRefreshInProgress = false;
            }
        }
    }

    async function clearAndRefresh() {
        consoleLog('[Clear] Clear and Refresh initiated...');
        resetStatAnimations();
        const viewerWasOpen = otkViewer && otkViewer.style.display === 'block';

        // Clear viewer content and related state immediately if viewer was open
        if (viewerWasOpen) {
            consoleLog('[Clear] Viewer was open, clearing its content and state immediately.');
            otkViewer.innerHTML = ''; // Clear existing viewer DOM
            renderedMessageIdsInViewer.clear(); // Clear the set of rendered message IDs
            uniqueImageViewerHashes.clear();
            viewerTopLevelAttachedVideoHashes.clear();
            viewerTopLevelEmbedIds.clear();
            renderedFullSizeImageHashes.clear();
            viewerActiveImageCount = null; // Reset viewer-specific counts
            viewerActiveVideoCount = null;
            lastViewerScrollTop = 0; // Reset scroll position memory
        }

        isManualRefreshInProgress = true;
        try {
            activeThreads = [];
            messagesByThreadId = {};
            threadColors = {};
            blockedThreads = new Set();
            localStorage.removeItem(THREADS_KEY);
            // No longer need to remove MESSAGES_KEY, as it's not used.
            localStorage.removeItem(COLORS_KEY);
            localStorage.removeItem(DROPPED_THREADS_KEY);
            localStorage.removeItem(SEEN_EMBED_URL_IDS_KEY);
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0');
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0');
            localStorage.removeItem(UNREAD_MESSAGE_IDS_KEY);
            localStorage.removeItem('otkNewReplyIds');
            localStorage.removeItem(BLOCKED_THREADS_KEY);
            consoleLog('[Clear] LocalStorage (threads, messages, seen embeds, media counts, ACTIVE theme) cleared/reset. CUSTOM THEMES PRESERVED.');

            if (otkMediaDB) {
                consoleLog('[Clear] Closing existing IndexedDB connection...');
                otkMediaDB.close();
                otkMediaDB = null; // Important: Set to null after closing
            }

            consoleLog('[Clear] Deleting IndexedDB database...');
            await new Promise((resolve, reject) => {
                const deleteRequest = indexedDB.deleteDatabase('otkMediaDB');
                deleteRequest.onsuccess = () => {
                    consoleLog('[Clear] IndexedDB deleted successfully.');
                    resolve();
                };
                deleteRequest.onerror = (event) => {
                    consoleError('[Clear] Error deleting IndexedDB:', event.target.error);
                    reject(event.target.error);
                };
                deleteRequest.onblocked = () => {
                    consoleWarn('[Clear] IndexedDB deletion blocked. This can happen if a connection is still open elsewhere.');
                    // The operation will be held until the connection is closed, which we already did.
                    // This handler is mostly for logging/debugging.
                };
            });

            // Re-initialize DB and loading screen after clearing, before refreshing.
            // This ensures the handles are valid.
            await initDB();
            setupLoadingScreen();

            consoleLog('[Clear] Calling refreshThreadsAndMessages to repopulate data...');
            await refreshThreadsAndMessages({ skipViewerUpdate: true, isChildCall: true });

            // Explicitly re-render the viewer if it was open, using the fresh data.
            if (viewerWasOpen) {
                consoleLog('[Clear] Re-rendering viewer with fresh data after clear.');
            await renderMessagesInViewer({ isToggleOpen: false });
            }
            consoleLog('[Clear] Clear and Refresh data processing complete.');

        renderThreadList(); // Update GUI bar with (now minimal) live threads
        updateDisplayedStatistics(); // Update stats based on cleared and re-fetched data
        } catch (error) {
            consoleError('[Clear] Error during clear and refresh:', error);
        } finally {
            isManualRefreshInProgress = false;
            consoleLog('[Clear] Manual refresh flag reset.');
        }
    }


    function ensureViewerExists() {
        if (!document.getElementById('otk-viewer')) {
            otkViewer = document.createElement('div');
            otkViewer.id = 'otk-viewer';
            document.body.appendChild(otkViewer);
            consoleLog('Viewer element created.');
        } else {
            otkViewer = document.getElementById('otk-viewer');
            consoleLog('Viewer element already exists.');
        }



        otkViewer.style.cssText = `
            position: fixed;
            top: 89px;
            left: 0;
            width: 100vw;
            height: calc(100vh - 89px);
            bottom: 0;
            /* background-color: #181818; */ /* New background color - replaced by variable below */
            opacity: 1; /* Ensure full opacity */
            z-index: 9998;
            /* overflow-y: hidden; */ /* Ensure viewer itself doesn't show scrollbars */
            box-sizing: border-box;
            background-color: var(--otk-viewer-bg-color); /* Original viewer background */
            color: var(--otk-gui-text-color); /* Viewer default text color, can be same as GUI or new variable later */
            padding: 0; /* No padding, will be handled by messagesContainer */
            border-top: 1px solid #181818; /* Assuming border might be different or themed later, keep for now */
            display: none;
            overflow-x: hidden; /* Prevent horizontal scrollbar on the viewer itself */
        `;
        consoleLog("Applied basic styling to otkViewer: background #181818, default text color #e6e6e6, padding (0), border-top #181818, overflow-x: hidden.");
    }

const scrollButtonContainer = document.getElementById('otk-scroll-button-container');
    function toggleViewer() {
        if (!otkViewer) {
            consoleWarn('Viewer element not found. Attempting to create.');
            ensureViewerExists();
            if (!otkViewer) {
                consoleError('Viewer element could not be initialized.');
                return;
            }
        }

        const isViewerVisible = otkViewer.style.display !== 'none';

        if (isViewerVisible) {
            const messagesContainer = document.getElementById('otk-messages-container');
            if (messagesContainer) {
                lastViewerScrollTop = messagesContainer.scrollTop;
                consoleLog(`Viewer closed. Scroll position saved: ${lastViewerScrollTop}`);
            }
            otkViewer.style.display = 'none';
            if (scrollButtonContainer) scrollButtonContainer.style.display = 'none';
            document.body.style.overflow = 'auto';
            localStorage.setItem(VIEWER_OPEN_KEY, 'false');
            for (const url of createdBlobUrls) {
                URL.revokeObjectURL(url);
            }
            createdBlobUrls.clear();
            videoBlobUrlCache.clear();
            consoleLog('Viewer hidden state saved to localStorage.');
            viewerActiveImageCount = null;
            viewerActiveVideoCount = null;
            updateDisplayedStatistics();
        } else {
            otkViewer.style.display = 'block';
            if (scrollButtonContainer) scrollButtonContainer.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            localStorage.setItem(VIEWER_OPEN_KEY, 'true');
            consoleLog('Viewer shown. State saved to localStorage. Applying layout and rendering all messages.');

            // Apply correct layout class before rendering
            otkViewer.classList.add('otk-message-layout-default');
            otkViewer.classList.remove('otk-message-layout-newdesign');
            // renderMessagesInViewer will calculate and set viewerActive counts and then call updateDisplayedStatistics
            renderMessagesInViewer({isToggleOpen: true}); // Pass flag
        }
    }

    function resetStatAnimations() {
        // Stop all active animation timers
        statAnimationTimers.forEach(timerId => clearInterval(timerId));
        statAnimationTimers = []; // Clear the array

        // Hide the (+n) elements
        const newStatSpans = document.querySelectorAll('.new-stat');
        newStatSpans.forEach(span => {
            span.textContent = '';
        });

        consoleLog('All stat animations have been reset.');
    }

    function animateStat(element, startValue, targetValue) {
        const diff = targetValue - startValue;
        if (diff <= 0) {
            if (targetValue > 0) {
                element.textContent = `(+${targetValue})`;
            } else {
                element.textContent = '';
            }
            return;
        }

        if (tabHidden) {
            element.textContent = `(+${targetValue})`;
            return;
        }

        const duration = Math.min(10000, diff * 333); // Max 10 seconds, ~3 per second
        const stepTime = duration / diff;

        let current = startValue;
        const timer = setInterval(() => {
            current++;
            element.textContent = `(+${current})`;
            if (current >= targetValue) {
                clearInterval(timer);
                statAnimationTimers = statAnimationTimers.filter(t => t !== timer);
            }
        }, stepTime);
        statAnimationTimers.push(timer);
    }

    function updateDisplayedStatistics(isBackgroundUpdate = false) {
        const threadsTrackedElem = document.getElementById('otk-threads-tracked-stat');
        const totalMessagesElem = document.getElementById('otk-total-messages-stat');
        const localImagesElem = document.getElementById('otk-local-images-stat');
        const localVideosElem = document.getElementById('otk-local-videos-stat');

        if (!threadsTrackedElem || !totalMessagesElem || !localImagesElem || !localVideosElem) {
            consoleWarn('One or more statistics elements not found in GUI.');
            return;
        }

        const getOldStatValue = (id) => {
            const elem = document.getElementById(`otk-stat-new-${id}`);
            return elem ? parseInt(elem.textContent.replace(/[^\d]/g, '') || '0', 10) : 0;
        };

        const oldNewMessages = getOldStatValue('messages');

        let totalMessagesInStorage = 0;
        let totalImagesInStorage = 0;
        let totalVideosInStorage = 0;

        for (const threadId in messagesByThreadId) {
            const messages = messagesByThreadId[threadId] || [];
            totalMessagesInStorage += messages.length;
            messages.forEach(msg => {
                if (msg.attachment) {
                    const ext = msg.attachment.ext.toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                        totalImagesInStorage++;
                    } else if (['.webm', '.mp4'].includes(ext)) {
                        totalVideosInStorage++;
                    }
                }
            });
        }

        let newMessages = unreadIds.size;
        const newImages = 0;
        const newVideos = 0;

        const viewerIsOpen = otkViewer && otkViewer.style.display === 'block';
        const autoLoad = localStorage.getItem('otkAutoLoadUpdates') === 'true';

        // If viewer is open and autoloading, don't show the (+n) stat
        // because messages are appended in real-time.
        if (viewerIsOpen && autoLoad) {
            newMessages = 0;
        }

        const mainMessagesCount = viewerIsOpen ? renderedMessageIdsInViewer.size : totalMessagesInStorage;
        const mainImagesCount = viewerIsOpen ? uniqueImageViewerHashes.size : totalImagesInStorage;
        const mainVideosCount = viewerIsOpen ? (viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size) : totalVideosInStorage;

        if(viewerIsOpen) {
            consoleLog(`[StatDebug] Viewer is OPEN. Using viewer-specific counts: Msgs=${mainMessagesCount}, Imgs=${mainImagesCount}, Vids=${mainVideosCount}`);
        } else {
            consoleLog(`[StatDebug] Viewer is CLOSED. Using total storage counts: Msgs=${mainMessagesCount}, Imgs=${mainImagesCount}, Vids=${mainVideosCount}`);
        }

        const liveThreadsCount = activeThreads.length;

        const allMessages = getAllMessagesSorted();
        let totalRepliesCount = 0;
        for (const message of allMessages) {
            if (message.text) {
                const quotes = message.text.match(/>>(\d+)/g) || [];
                for (const quote of quotes) {
                    const quoteId = parseInt(quote.substring(2));
                    if (userPostIds.has(quoteId)) {
                        totalRepliesCount++;
                        break;
                    }
                }
            }
        }

        const newRepliesCount = newReplyIds.size;

        const updateStatLine = (container, baseText, newCount, startCount, id, newReplies = 0) => {
            let lineContainer = document.getElementById(`otk-stat-${id}`);
            if (!lineContainer) {
                lineContainer = document.createElement('div');
                lineContainer.id = `otk-stat-${id}`;
                lineContainer.style.display = 'flex';
                lineContainer.style.justifyContent = 'flex-start';
                lineContainer.style.width = '100%';

                const baseSpan = document.createElement('span');
                baseSpan.id = `otk-stat-base-${id}`;
                lineContainer.appendChild(baseSpan);

                const newCountSpan = document.createElement('span');
                newCountSpan.id = `otk-stat-new-${id}`;
                newCountSpan.className = 'new-stat';
                newCountSpan.style.color = 'var(--otk-background-updates-stats-text-color)';
                newCountSpan.style.marginLeft = '5px';
                lineContainer.appendChild(newCountSpan);

                if (id === 'messages') {
                    const newRepliesSpan = document.createElement('span');
                    newRepliesSpan.id = 'otk-stat-new-replies';
                    newRepliesSpan.className = 'new-stat';
                    newRepliesSpan.style.color = 'var(--otk-replies-stat-color)';
                    newRepliesSpan.style.marginLeft = '5px';
                    lineContainer.appendChild(newRepliesSpan);
                }

                container.appendChild(lineContainer);
            }

            const baseSpan = document.getElementById(`otk-stat-base-${id}`);
            baseSpan.innerHTML = ''; // Clear previous content

            const dashSpan = document.createElement('span');
            dashSpan.textContent = '• ';
            dashSpan.style.color = 'var(--otk-stats-dash-color)';

            const textNode = document.createTextNode(baseText.substring(2));

            baseSpan.appendChild(dashSpan);
            baseSpan.appendChild(textNode);

            const newCountSpan = document.getElementById(`otk-stat-new-${id}`);
            if (newCount > 0) {
                if (isBackgroundUpdate) {
                    animateStat(newCountSpan, startCount, newCount);
                } else {
                    newCountSpan.textContent = `(+${newCount})`;
                }
            } else {
                newCountSpan.textContent = '';
            }

            if (id === 'messages') {
                const newRepliesSpan = document.getElementById('otk-stat-new-replies');
                if (newCount > 0 && newReplies > 0) {
                    newCountSpan.textContent = `(+${newCount} |`;
                    newRepliesSpan.textContent = `+${newReplies})`;
                } else if (newReplies > 0) {
                    newRepliesSpan.textContent = `(+${newReplies})`;
                } else {
                    newRepliesSpan.textContent = '';
                }
            }
        };

        const paddingLength = 4;
        updateStatLine(threadsTrackedElem, `- ${padNumber(liveThreadsCount, paddingLength)} Live Thread${liveThreadsCount === 1 ? '' : 's'}`, 0, 0, 'threads');
        updateStatLine(totalMessagesElem, `- ${padNumber(mainMessagesCount, paddingLength)} Total Message${mainMessagesCount === 1 ? '' : 's'}`, newMessages, oldNewMessages, 'messages', newRepliesCount);
        updateStatLine(localImagesElem, `- ${padNumber(mainImagesCount, paddingLength)} Image${mainImagesCount === 1 ? '' : 's'}`, 0, 0, 'images');
        updateStatLine(localVideosElem, `- ${padNumber(mainVideosCount, paddingLength)} Video${mainVideosCount === 1 ? '' : 's'}`, 0, 0, 'videos');

    }

    function createTrackerButton(text, id = null) {
        const button = document.createElement('button');
        if (id) button.id = id;
        button.textContent = text;
        button.classList.add('otk-tracker-button'); // Add a common class for potential shared base styles not from variables
        button.style.cssText = `
            padding: 12px 15px;
            cursor: pointer;
            background-color: var(--otk-button-bg-color);
            color: var(--otk-button-text-color);
            border: 1px solid var(--otk-button-border-color);
            border-radius: 3px;
            font-size: 13px;
            white-space: nowrap; /* Prevent button text wrapping */
            /* Transition for smooth background color change can be added here or in CSS */
            transition: background-color 0.15s ease-in-out;
        `;

        button.addEventListener('mouseover', () => {
            if (!button.disabled) { // Check if button is not disabled
                button.classList.add('otk-button--hover');
                // Fallback if CSS variables/classes somehow fail, or for non-variable parts of hover
                // button.style.backgroundColor = 'var(--otk-button-hover-bg-color)'; // Direct application as fallback/override example
            }
        });
        button.addEventListener('mouseout', () => {
            if (!button.disabled) {
                button.classList.remove('otk-button--hover');
                button.classList.remove('otk-button--active'); // Ensure active is also removed if mouse leaves while pressed
                // Fallback: reset to base color
                // button.style.backgroundColor = 'var(--otk-button-bg-color)';
            }
        });
        button.addEventListener('mousedown', () => {
            if (!button.disabled) {
                button.classList.add('otk-button--active');
                // Fallback
                // button.style.backgroundColor = 'var(--otk-button-active-bg-color)';
            }
        });
        button.addEventListener('mouseup', () => {
            if (!button.disabled) {
                button.classList.remove('otk-button--active');
                // If mouse is still over, hover effect should apply.
                // If mouseup happens outside, mouseout would have cleared hover.
                // If mouseup happens inside, it should revert to hover state if still over.
                if (button.matches(':hover')) { // Check if mouse is still over the button
                     button.classList.add('otk-button--hover');
                }
                // Fallback
                // if (button.matches(':hover')) button.style.backgroundColor = 'var(--otk-button-hover-bg-color)';
                // else button.style.backgroundColor = 'var(--otk-button-bg-color)';
            }
        });
        return button;
    }

    // --- Button Implementations & Event Listeners ---

    // Timezone Search Container (declared globally to avoid redeclaration)
    const timezoneSearchContainer = document.createElement('div');
    timezoneSearchContainer.id = 'otk-timezone-search-container';
    timezoneSearchContainer.style.cssText = `
        position: fixed;
        /* Position will be set dynamically based on clock position */
        background-color: var(--otk-clock-search-bg-color, #333);
        border: 1px solid #555;
        border-radius: 4px;
        z-index: 100003; /* Above options window */
        display: none;
        padding: 8px;
        width: 250px;
    `;
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'otk-timezone-search-input';
    searchInput.placeholder = 'Search for a city/region...';
    searchInput.style.cssText = 'width: 100%; box-sizing: border-box; margin-bottom: 5px;';
    timezoneSearchContainer.appendChild(searchInput);

    const searchResultsDiv = document.createElement('div');
    searchResultsDiv.id = 'otk-timezone-search-results';
    searchResultsDiv.style.cssText = 'max-height: 200px; overflow-y: auto;';
    timezoneSearchContainer.appendChild(searchResultsDiv);
    document.body.appendChild(timezoneSearchContainer);

    const clockElement = document.createElement('div');
    clockElement.id = 'otk-clock';
    clockElement.style.cssText = `
        position: fixed;
        top: 89px;
        right: 10px;
        background-color: var(--otk-clock-bg-color);
        color: var(--otk-clock-text-color, var(--otk-gui-text-color));
        padding: 5px;
        border: 1px solid var(--otk-clock-border-color);
        border-radius: 5px;
        z-index: 100001;
        display: none;
        cursor: move;
        display: flex; /* Use flexbox to align text and icon */
        align-items: center; /* Center items vertically */
    `;

    document.body.appendChild(clockElement);

    // Make clock draggable
    let isClockDragging = false;
    let clockOffsetX, clockOffsetY;

    // Load saved clock position
    const CLOCK_POSITION_KEY = 'otkClockPosition';
    try {
        const savedClockPos = JSON.parse(localStorage.getItem(CLOCK_POSITION_KEY));
        if (savedClockPos && savedClockPos.top && savedClockPos.left) {
            clockElement.style.top = savedClockPos.top;
            clockElement.style.left = savedClockPos.left;
            clockElement.style.right = 'auto';
        }
    } catch (e) {
        consoleError("Error parsing saved clock position from localStorage:", e);
    }


    clockElement.addEventListener('mousedown', (e) => {
        isClockDragging = true;
        clockOffsetX = e.clientX - clockElement.offsetLeft;
        clockOffsetY = e.clientY - clockElement.offsetTop;
        clockElement.style.userSelect = 'none';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (isClockDragging) {
            let newLeft = e.clientX - clockOffsetX;
            let newTop = e.clientY - clockOffsetY;

            const buffer = 10;
            const maxLeft = window.innerWidth - clockElement.offsetWidth - buffer;
            const maxTop = window.innerHeight - clockElement.offsetHeight - buffer;

            newLeft = Math.max(buffer, Math.min(newLeft, maxLeft));
            newTop = Math.max(buffer, Math.min(newTop, maxTop));

            clockElement.style.left = newLeft + 'px';
            clockElement.style.top = newTop + 'px';
            clockElement.style.right = 'auto';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isClockDragging) {
            isClockDragging = false;
            clockElement.style.userSelect = '';
            document.body.style.userSelect = '';
            // Save position to localStorage
            localStorage.setItem(CLOCK_POSITION_KEY, JSON.stringify({top: clockElement.style.top, left: clockElement.style.left}));
        }
    });

    // --- Draggable Countdown Timer ---
    const countdownElement = document.createElement('div');
    countdownElement.id = 'otk-countdown-timer-movable';
    countdownElement.style.cssText = `
        position: fixed;
        top: 90px;
        left: 50%;
        transform: translateX(-50%);
        background-color: var(--otk-countdown-bg-color, var(--otk-gui-bg-color));
        padding: 5px;
        border-radius: 5px;
        z-index: 100001;
        display: flex;
        align-items: center;
        cursor: move;
        font-size: 14px;
        white-space: nowrap;
    `;
    const countdownTimer = document.createElement('span');
    countdownTimer.id = 'otk-countdown-timer';
    countdownTimer.textContent = '00:00:00';
    const countdownLabel = document.createElement('span');
    countdownLabel.id = 'otk-countdown-label';
    countdownLabel.textContent = 'Next Update:\u00A0';
    countdownLabel.style.color = 'var(--otk-countdown-label-text-color)';
    countdownTimer.style.color = 'var(--otk-countdown-timer-text-color)';
    countdownElement.appendChild(countdownLabel);
    countdownElement.appendChild(countdownTimer);
    document.body.appendChild(countdownElement);

    let isCountdownDragging = false;
    let countdownOffsetX, countdownOffsetY;

    const COUNTDOWN_POSITION_KEY = 'otkCountdownPosition';
    try {
        const savedCountdownPos = JSON.parse(localStorage.getItem(COUNTDOWN_POSITION_KEY));
        if (savedCountdownPos && savedCountdownPos.top && savedCountdownPos.left) {
            countdownElement.style.top = savedCountdownPos.top;
            countdownElement.style.left = savedCountdownPos.left;
            countdownElement.style.transform = 'none'; // Remove transform if we have a saved position
        }
    } catch (e) {
        consoleError("Error parsing saved countdown position from localStorage:", e);
    }

    countdownElement.addEventListener('mousedown', (e) => {
        isCountdownDragging = true;
        countdownOffsetX = e.clientX - countdownElement.offsetLeft;
        countdownOffsetY = e.clientY - countdownElement.offsetTop;
        countdownElement.style.userSelect = 'none';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (isCountdownDragging) {
            let newLeft = e.clientX - countdownOffsetX;
            let newTop = e.clientY - countdownOffsetY;

            countdownElement.style.left = newLeft + 'px';
            countdownElement.style.top = newTop + 'px';
            countdownElement.style.transform = 'none';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isCountdownDragging) {
            isCountdownDragging = false;
            countdownElement.style.userSelect = '';
            document.body.style.userSelect = '';
            localStorage.setItem(COUNTDOWN_POSITION_KEY, JSON.stringify({top: countdownElement.style.top, left: countdownElement.style.left}));
        }
    });

    // Hide search if clicking outside
    document.addEventListener('click', (e) => {
        if (timezoneSearchContainer.style.display === 'block' && !timezoneSearchContainer.contains(e.target)) {
            // The 'Change' button's click handler uses e.stopPropagation(),
            // so we don't need an extra check for it here. Any click that
            // reaches the document and is outside the search container should close it.
            timezoneSearchContainer.style.display = 'none';
        }
    });


    const buttonContainer = document.getElementById('otk-button-container');
    if (buttonContainer) {
        const btnToggleViewer = createTrackerButton('Toggle Viewer', 'otk-toggle-viewer-btn');
        btnToggleViewer.addEventListener('click', toggleViewer);
        // Appended to bottomRowContainer later

        const btnRefresh = createTrackerButton('Refresh Data', 'otk-refresh-data-btn');
        btnRefresh.addEventListener('click', async () => {
            if (isManualRefreshInProgress) {
                consoleLog('[GUI] "Refresh Data" button clicked, but a refresh is already in progress. Ignoring.');
                return; // Ignore click if a refresh is already happening
            }
            consoleLog('[GUI] "Refresh Data" button clicked.');
            // isManualRefreshInProgress is set to true at the start of refreshThreadsAndMessages
            // and false in its finally block. This prevents the race condition without disabling the button.
            try {
                await refreshThreadsAndMessages();
                consoleLog('[GUI] Data refresh complete.');
            } catch (error) {
                consoleError('[GUI] Error during data refresh:', error);
            } finally {
                stopBackgroundRefresh();
                startBackgroundRefresh();
            }
            // No finally block needed here to re-enable the button, as it's never disabled.
        });
        // Appended to bottomRowContainer later

        // Create topRowContainer for the checkbox
        const topRowContainer = document.createElement('div');
        // No specific styles for topRowContainer itself yet, alignment is handled by otk-button-container

        // Create bottomRowContainer for the buttons
        const bottomRowContainer = document.createElement('div');
        bottomRowContainer.style.cssText = `
            display: flex;
            flex-direction: row;
            gap: 10px;
            align-items: center;
        `;

        const controlsWrapper = document.createElement('div');
        controlsWrapper.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: space-around;
            align-items: flex-start;
            gap: 4px; /* Increased gap */
            height: auto; /* Allow it to size based on content */
        `;

        // Debug mode checkbox and label are removed from here.
        // DEBUG_MODE is now only toggled via localStorage or by editing the script.

        // Countdown timer is now a separate draggable element

        const btnClearRefresh = createTrackerButton('Restart Tracker', 'otk-restart-tracker-btn');


        const btnFilter = createTrackerButton('Filter', 'otk-filter-btn');
        btnFilter.addEventListener('click', () => {
            const filterWindow = document.getElementById('otk-filter-window');
            if (filterWindow) {
                filterWindow.style.display = filterWindow.style.display === 'none' ? 'flex' : 'none';
            }
        });


        const thirdButtonColumn = document.createElement('div');
        thirdButtonColumn.style.cssText = `
            display: flex;          /* It's a flex container for controlsWrapper */
            flex-direction: column; /* Stack its children (controlsWrapper) */
            justify-content: center;/* Center controlsWrapper vertically */
            align-items: center;    /* Center controlsWrapper horizontally */
            /* height: 100%; Removed, let it size by content */
            /* min-width: 130px; Removed, let it size by content */
        `;
        // controlsWrapper has align-self: center and width: fit-content, which is good.
        // Ensure controlsWrapper takes appropriate width for its content (checkbox + label)
        // and centers itself within the stretched column.
        controlsWrapper.style.width = 'fit-content';
        controlsWrapper.style.alignSelf = 'center';

        thirdButtonColumn.appendChild(controlsWrapper);
        // btnClearRefresh is handled below
        // buttonContainer.appendChild(thirdButtonColumn); // This is now part of topRowContainer

        // Append elements to their respective row containers
        topRowContainer.appendChild(thirdButtonColumn);

        bottomRowContainer.appendChild(btnToggleViewer);
        bottomRowContainer.appendChild(btnRefresh);
        bottomRowContainer.appendChild(btnClearRefresh);
        bottomRowContainer.appendChild(btnFilter);

        const btnPip = createTrackerButton('Picture-in-Picture', 'otk-pip-btn');
        btnPip.style.display = localStorage.getItem('otkPipModeEnabled') === 'true' ? 'inline-block' : 'none';
        bottomRowContainer.appendChild(btnPip);

        btnPip.addEventListener('click', () => {
            document.body.classList.toggle('otk-pip-mode');

            if (document.body.classList.contains('otk-pip-mode')) {
                enablePipMode();
            } else {
                disablePipMode();
            }
        });


        // Append row containers to the main buttonContainer
        buttonContainer.appendChild(topRowContainer);
        buttonContainer.appendChild(bottomRowContainer);

        btnClearRefresh.addEventListener('click', async () => {
            consoleLog('[GUI] "Restart Thread Tracker" button clicked.');
            if (!confirm("Are you sure you want to restart the tracker? This will clear all tracked threads, messages, and media from IndexedDB.")) {
                consoleLog('[GUI] Restart cancelled by user.');
                return;
            }
            btnClearRefresh.disabled = true;
            // isManualRefreshInProgress will be handled by clearAndRefresh
            try {
                await clearAndRefresh();
                consoleLog('[GUI] Clear and refresh sequence complete.');
            } catch (error) {
                consoleError('[GUI] Error during clear and refresh sequence:', error);
            } finally {
                btnClearRefresh.disabled = false;
                consoleLog('[GUI] Restart operation finished.');
            }
        });

    } else {
        consoleError('Button container not found. GUI buttons cannot be added.');
    }

    // --- Background Refresh Control ---
    let lastActivityTimestamp = Date.now();
    let suspensionCheckIntervalId = null;
    let countdownIntervalId = null;

    function updateCountdown() {
        const nextUpdateTimestamp = parseInt(localStorage.getItem('otkNextUpdateTimestamp') || '0', 10);
        const countdownTimer = document.getElementById('otk-countdown-timer');
        if (!countdownTimer) {
            return;
        }

        const now = Date.now();
        const timeLeft = Math.max(0, nextUpdateTimestamp - now);
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

        countdownTimer.textContent = `${padNumber(hours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}`;
    }

    function startBackgroundRefresh(immediate = false) {
        if (localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) === 'true') {
            consoleLog('Background updates are disabled. Not starting refresh interval.');
            return;
        }
        if (backgroundRefreshIntervalId === null) { // Only start if not already running
            const minUpdateSeconds = parseInt(localStorage.getItem('otkMinUpdateSeconds') || '10', 10);
            const maxUpdateSeconds = parseInt(localStorage.getItem('otkMaxUpdateSeconds') || '300', 10);
            const randomIntervalSeconds = Math.floor(Math.random() * (maxUpdateSeconds - minUpdateSeconds + 1)) + minUpdateSeconds;
            let refreshIntervalMs = immediate ? 0 : randomIntervalSeconds * 1000;

            const nextUpdateTimestamp = Date.now() + refreshIntervalMs;
            localStorage.setItem('otkNextUpdateTimestamp', nextUpdateTimestamp);


            backgroundRefreshIntervalId = setTimeout(() => {
                if (isSuspended) {
                    consoleLog(`[BG] Updates suspended.`);
                    stopBackgroundRefresh();
                    showSuspendedScreen();
                    return;
                }
                backgroundRefreshThreadsAndMessages({ isBackground: true });
                backgroundRefreshIntervalId = null; // Reset for the next cycle
                startBackgroundRefresh(); // Schedule the next update
            }, refreshIntervalMs);

            if(immediate){
                consoleLog(`Background refresh started immediately.`);
            } else {
                const minUpdateMinutes = Math.floor(minUpdateSeconds / 60);
                const maxUpdateMinutes = Math.floor(maxUpdateSeconds / 60);
                consoleLog(`Background refresh scheduled in ${minUpdateMinutes}-${maxUpdateMinutes} minutes. Next update at ~${new Date(Date.now() + refreshIntervalMs).toLocaleTimeString()}`);
            }

            if (countdownIntervalId) {
                clearInterval(countdownIntervalId);
            }
            countdownIntervalId = setInterval(updateCountdown, 1000);
        }
    }

    function stopBackgroundRefresh() {
        if (backgroundRefreshIntervalId) {
            clearTimeout(backgroundRefreshIntervalId);
            backgroundRefreshIntervalId = null;
            consoleLog('Background refresh stopped.');
        } else {
            consoleLog('Background refresh was not running.');
        }
    }

    let activeClockSearchId = null;

    function renderClockOptions() {
        const contentArea = document.getElementById('otk-clock-options-panel');
        if (!contentArea) return;

        contentArea.innerHTML = ''; // Clear previous content

        const clocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');
        let draggedClockId = null;

        const clockListContainer = document.createElement('div');
        contentArea.appendChild(clockListContainer);

        clocks.forEach((clock, index) => {
            const clockRow = document.createElement('div');
            clockRow.classList.add('otk-option-row');
            clockRow.draggable = true;
            clockRow.dataset.clockId = clock.id;
            clockRow.style.cursor = 'grab';

            clockRow.addEventListener('dragstart', (e) => {
                draggedClockId = clock.id;
                e.dataTransfer.effectAllowed = 'move';
                e.target.style.opacity = '0.5';
            });

            clockRow.addEventListener('dragend', (e) => {
                e.target.style.opacity = '1';
                const allRows = [...clockListContainer.querySelectorAll('div[draggable="true"]')];
                allRows.forEach(row => {
                    row.style.borderTop = '';
                    row.style.borderBottom = '';
                });
            });

            clockRow.addEventListener('dragover', (e) => {
                e.preventDefault();
                const allRows = [...clockListContainer.querySelectorAll('div[draggable="true"]')];
                allRows.forEach(row => {
                    row.style.borderTop = '';
                    row.style.borderBottom = '';
                });
                const rect = clockRow.getBoundingClientRect();
                const halfwayY = rect.top + rect.height / 2;
                if (e.clientY < halfwayY) {
                    clockRow.style.borderTop = '2px solid #ff8040';
                } else {
                    clockRow.style.borderBottom = '2px solid #ff8040';
                }
            });

            const clockName = document.createElement('label');
            clockName.innerHTML = `<b>Clock ${index + 1} -</b> ${clock.displayPlace || clock.timezone}`;
            clockRow.appendChild(clockName);

            const buttonsWrapper = document.createElement('div');
            buttonsWrapper.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                justify-content: flex-end;
            `;

            const changeBtn = createTrackerButton('Change');
            changeBtn.style.padding = '2px 8px';
            changeBtn.style.fontSize = '11px';
            changeBtn.style.height = '25px';
            changeBtn.style.boxSizing = 'border-box';
            changeBtn.dataset.clockId = clock.id;
            changeBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent the global click listener from hiding the search box
                activeClockSearchId = clock.id;
                const timezoneSearchContainer = document.getElementById('otk-timezone-search-container');
                if (timezoneSearchContainer) {
                    // Temporarily display off-screen to calculate width
                    timezoneSearchContainer.style.visibility = 'hidden';
                    timezoneSearchContainer.style.display = 'block';
                    const containerWidth = timezoneSearchContainer.offsetWidth;

                    const buttonRect = e.target.getBoundingClientRect();
                    timezoneSearchContainer.style.top = `${buttonRect.bottom + 5}px`;
                    timezoneSearchContainer.style.left = `${buttonRect.right - containerWidth}px`;
                    timezoneSearchContainer.style.visibility = 'visible';

                // Focus the input when the search box appears
                const searchInput = document.getElementById('otk-timezone-search-input');
                if (searchInput) {
                    searchInput.focus();
                }
                }
            });
            buttonsWrapper.appendChild(changeBtn);

            if (index > 0) { // Don't allow removing the first (primary) clock
                const removeBtn = createTrackerButton('Remove');
                removeBtn.style.padding = '2px 8px';
                removeBtn.style.fontSize = '11px';
                removeBtn.style.height = '25px';
                removeBtn.style.boxSizing = 'border-box';
                removeBtn.dataset.clockId = clock.id;
                removeBtn.addEventListener('click', () => {
                    let currentClocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');
                    currentClocks = currentClocks.filter(c => c.id !== clock.id);
                    localStorage.setItem('otkClocks', JSON.stringify(currentClocks));
                    renderClockOptions();
                    renderClocks();
                });
                buttonsWrapper.appendChild(removeBtn);
            }

            clockRow.appendChild(buttonsWrapper);
            clockListContainer.appendChild(clockRow);
        });

        clockListContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const targetRow = e.target.closest('div[draggable="true"]');
            if (!targetRow || draggedClockId === null) return;

            let currentClocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');
            const draggedIndex = currentClocks.findIndex(c => c.id === draggedClockId);
            const targetIndex = currentClocks.findIndex(c => c.id === parseInt(targetRow.dataset.clockId));

            if (draggedIndex === -1 || targetIndex === -1) return;

            const rect = targetRow.getBoundingClientRect();
            const halfwayY = rect.top + rect.height / 2;
            const insertBefore = e.clientY < halfwayY;

            const [draggedClock] = currentClocks.splice(draggedIndex, 1);
            let newIndex;
            if (insertBefore) {
                newIndex = currentClocks.findIndex(c => c.id === parseInt(targetRow.dataset.clockId));
            } else {
                newIndex = currentClocks.findIndex(c => c.id === parseInt(targetRow.dataset.clockId)) + 1;
            }

            currentClocks.splice(newIndex, 0, draggedClock);

            localStorage.setItem('otkClocks', JSON.stringify(currentClocks));
            renderClockOptions();
            renderClocks();
            draggedClockId = null;
        });

        const addClockRow = document.createElement('div');
        addClockRow.classList.add('otk-option-row');

        const addClockControls = document.createElement('div');
        addClockControls.style.cssText = `
            display: flex;
            grid-column: 1 / -1;
        `;

        const addClockBtn = createTrackerButton('Add New Clock');
        addClockBtn.style.padding = '2px 8px';
        addClockBtn.style.fontSize = '11px';
        addClockBtn.style.height = '25px';
        addClockBtn.style.boxSizing = 'border-box';
        addClockBtn.style.width = '100%';
        addClockBtn.addEventListener('click', () => {
            const currentClocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');
            const newClock = {
                id: Date.now(),
                timezone: 'America/New_York',
                displayPlace: 'New York'
            };
            currentClocks.push(newClock);
            localStorage.setItem('otkClocks', JSON.stringify(currentClocks));
            renderClockOptions();
            renderClocks();
        });

        addClockControls.appendChild(addClockBtn);
        addClockRow.appendChild(addClockControls);
        clockListContainer.appendChild(addClockRow);

    const defaultClockRow = document.createElement('div');
    defaultClockRow.classList.add('otk-option-row');
    defaultClockRow.style.paddingTop = '0';

    const defaultClockControls = document.createElement('div');
    defaultClockControls.style.cssText = `
        display: flex;
        grid-column: 1 / -1;
    `;

    const defaultClockBtn = createTrackerButton('Default Clock Options');
    defaultClockBtn.style.padding = '2px 8px';
    defaultClockBtn.style.fontSize = '11px';
    defaultClockBtn.style.height = '25px';
    defaultClockBtn.style.boxSizing = 'border-box';
    defaultClockBtn.style.width = '100%';
    defaultClockBtn.addEventListener('click', () => {
        if (confirm("Are you sure you want to restore the default clock settings? This will reset all clocks and their positions.")) {
            const defaultClocks = [
                { "id": 1756699206552, "timezone": "America/Chicago", "displayPlace": "Austin" },
                { "id": 1756699263949, "timezone": "America/Los_Angeles", "displayPlace": "Los Angeles" }
            ];
            const defaultClockPosition = { "top": "71px", "left": "1284px" };

            localStorage.setItem('otkClocks', JSON.stringify(defaultClocks));
            localStorage.setItem('otkClockPosition', JSON.stringify(defaultClockPosition));

            renderClockOptions();
            renderClocks();

            const clockElement = document.getElementById('otk-clock');
            if (clockElement) {
                clockElement.style.top = defaultClockPosition.top;
                clockElement.style.left = defaultClockPosition.left;
                clockElement.style.right = 'auto';
            }
        }
    });

    defaultClockControls.appendChild(defaultClockBtn);
    defaultClockRow.appendChild(defaultClockControls);
    clockListContainer.appendChild(defaultClockRow);
    }

    function renderClocks() {
        const clockContainer = document.getElementById('otk-clock');
        if (!clockContainer) return;

        clockContainer.innerHTML = ''; // Clear existing clocks
        const clocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');

        clocks.forEach((clock, index) => {
            const clockInstance = document.createElement('div');
            clockInstance.className = 'otk-clock-instance';
            clockInstance.dataset.clockId = clock.id;
            clockInstance.style.display = 'flex';
            clockInstance.style.alignItems = 'center';
            clockInstance.style.padding = '0 5px';
            clockInstance.style.position = 'relative';

            const clockTextSpan = document.createElement('span');
            clockTextSpan.id = `otk-clock-text-${clock.id}`;
            clockInstance.appendChild(clockTextSpan);

            clockContainer.appendChild(clockInstance);

            if (index < clocks.length - 1) {
                const divider = document.createElement('span');
                divider.textContent = '|';
                divider.style.color = 'var(--otk-clock-divider-color, #ff8040)';
                divider.style.padding = '0 5px';
                clockContainer.appendChild(divider);
            }
        });


        updateClockTimes();
    }

    function updateClockTimes() {
        const clocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');
        clocks.forEach(clock => {
            const clockTextElement = document.getElementById(`otk-clock-text-${clock.id}`);
            if (clockTextElement) {
                const timeZoneName = clock.displayPlace || clock.timezone.split('/').pop().replace(/_/g, ' ');
                const now = new Date();
                const timeString = now.toLocaleTimeString('en-US', {
                    timeZone: clock.timezone,
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });

                clockTextElement.innerHTML = ''; // Clear existing content
                const timeSpan = document.createElement('span');
                timeSpan.style.width = '65px'; // Fixed width to prevent "jiggle"
                timeSpan.style.display = 'inline-block'; // Needed for width to apply
                timeSpan.style.textAlign = 'center'; // Center the time within the fixed-width span
                timeSpan.textContent = timeString;

                const tzSpan = document.createElement('span');
                tzSpan.textContent = ` ${timeZoneName}`;

                clockTextElement.appendChild(timeSpan);
                clockTextElement.appendChild(tzSpan);
            }
        });
    }

    function renderThreadTitleColorsOptions() {
        const contentArea = document.getElementById('otk-thread-title-colors-panel');
        if (!contentArea) return;

        contentArea.innerHTML = ''; // Clear previous content

        let titleColors = JSON.parse(localStorage.getItem(THREAD_TITLE_COLORS_KEY)) || [...COLORS];

        const colorListContainer = document.createElement('div');
        contentArea.appendChild(colorListContainer);

        titleColors.forEach((color, index) => {
            const colorRow = document.createElement('div');
            colorRow.classList.add('otk-option-row');
            colorRow.style.display = 'flex';
            colorRow.style.alignItems = 'center';
            colorRow.style.gap = '10px';

            const colorBar = document.createElement('div');
            colorBar.style.flexGrow = '1';
            colorBar.style.height = '25px';
            colorBar.style.backgroundColor = color;
            colorBar.style.border = '1px solid #555';
            colorBar.style.borderRadius = '3px';

            const buttonsWrapper = document.createElement('div');
            buttonsWrapper.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                justify-content: flex-end;
            `;

            const changeBtn = createTrackerButton('Change');
            changeBtn.style.padding = '2px 8px';
            changeBtn.style.fontSize = '11px';
            changeBtn.style.height = '25px';
            changeBtn.style.boxSizing = 'border-box';

            const colorPicker = document.createElement('input');
            colorPicker.type = 'color';
            colorPicker.value = color;
            colorPicker.style.display = 'none'; // Hide the actual picker, trigger it from the button
            colorRow.appendChild(colorPicker);


            changeBtn.addEventListener('click', () => colorPicker.click());

            colorPicker.addEventListener('input', (e) => {
                titleColors[index] = e.target.value;
                localStorage.setItem(THREAD_TITLE_COLORS_KEY, JSON.stringify(titleColors));
                renderThreadTitleColorsOptions(); // Re-render to show change
            });

            buttonsWrapper.appendChild(changeBtn);

            const removeBtn = createTrackerButton('Remove');
            removeBtn.style.padding = '2px 8px';
            removeBtn.style.fontSize = '11px';
            removeBtn.style.height = '25px';
            removeBtn.style.boxSizing = 'border-box';
            if (titleColors.length <= 2) {
                removeBtn.disabled = true;
            }
            removeBtn.addEventListener('click', () => {
                titleColors.splice(index, 1);
                localStorage.setItem(THREAD_TITLE_COLORS_KEY, JSON.stringify(titleColors));
                renderThreadTitleColorsOptions();
            });
            buttonsWrapper.appendChild(removeBtn);

            colorRow.appendChild(colorBar);
            colorRow.appendChild(buttonsWrapper);
            colorListContainer.appendChild(colorRow);
        });

        const addColorRow = document.createElement('div');
        addColorRow.classList.add('otk-option-row');
        addColorRow.style.gridTemplateColumns = '1fr';
        addColorRow.style.marginTop = '15px';

        const addColorBtn = createTrackerButton('Add Colour');
        addColorBtn.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
        addColorBtn.addEventListener('click', () => {
            titleColors.push('#ffffff'); // Add white as a default new color
            localStorage.setItem(THREAD_TITLE_COLORS_KEY, JSON.stringify(titleColors));
            renderThreadTitleColorsOptions();
        });
        addColorRow.appendChild(addColorBtn);
        contentArea.appendChild(addColorRow);

        const defaultColorsRow = document.createElement('div');
        defaultColorsRow.classList.add('otk-option-row');
        defaultColorsRow.style.gridTemplateColumns = '1fr';

        const defaultColorsBtn = createTrackerButton('Default thread title colours');
        defaultColorsBtn.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
        defaultColorsBtn.addEventListener('click', () => {
            if (confirm("Are you sure you want to revert to the default thread title colours?")) {
                const defaultColors = [
                    "#e6194B", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0",
                    "#f032e6", "#bcf60c", "#008080", "#e6beff", "#912499", "#800000", "#aaffc3",
                    "#cbcb25", "#000075", "#ffffff"
                ];
                localStorage.setItem(THREAD_TITLE_COLORS_KEY, JSON.stringify(defaultColors));
                renderThreadTitleColorsOptions();
            }
        });
        defaultColorsRow.appendChild(defaultColorsBtn);
        contentArea.appendChild(defaultColorsRow);
    }

function startAutoEmbedReloader() {
    setInterval(() => {
        if (!otkViewer || otkViewer.style.display === 'none') {
            return;
        }

        const iframes = otkViewer.querySelectorAll('iframe');
        iframes.forEach(iframe => {
            const hasDataSrc = iframe.dataset.src && iframe.dataset.src.trim() !== '';
            const hasSrc = iframe.src && iframe.src.trim() !== '' && iframe.src !== 'about:blank';

            if (hasDataSrc && !hasSrc) {
                consoleLog(`[AutoEmbedReloader] Found failed embed. Reloading src: ${iframe.dataset.src}`);
                iframe.src = iframe.dataset.src;
            }
        });
    }, 5000); // Check every 5 seconds
}





// --- IIFE Scope Helper for Intersection Observer ---
function handleIntersection(entries, observerInstance) {
    entries.forEach(entry => {
        const wrapper = entry.target;
        let iframe = wrapper.querySelector('iframe');

        if (entry.isIntersecting) {
            // Element is now visible
            if (!iframe) {
                // If the iframe was removed, recreate it
                const newIframe = document.createElement('iframe');
                // Copy attributes from a template or stored config if necessary
                // For now, assuming basic recreation is enough
                newIframe.style.position = 'absolute';
                newIframe.style.top = '0';
                newIframe.style.left = '0';
                newIframe.style.width = '100%';
                newIframe.style.height = '100%';
                newIframe.setAttribute('frameborder', '0');
                newIframe.setAttribute('allowfullscreen', 'true');
                if (wrapper.classList.contains('otk-twitch-embed-wrapper')) {
                    newIframe.setAttribute('scrolling', 'no');
                } else if (wrapper.classList.contains('otk-youtube-embed-wrapper')) {
                    newIframe.setAttribute('allow', 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
                }
                newIframe.dataset.src = wrapper.dataset.embedUrl;
                wrapper.innerHTML = '';
    if (window.twttr?.widgets?.load) {
        twttr.widgets.load(wrapper);
    } // Clear placeholder
                wrapper.appendChild(newIframe);
                iframe = newIframe;
            }

            if (iframe && iframe.dataset.src && (!iframe.src || iframe.src === 'about:blank')) {
                consoleLog('[LazyLoad] Iframe is intersecting, loading src:', iframe.dataset.src);
                iframe.src = iframe.dataset.src;
            }
            observerInstance.unobserve(wrapper);
        } else {
            // Element is no longer visible
            if (wrapper.classList.contains('otk-tweet-embed-wrapper')) {
                return; // Do not unload tweet embeds
            }

            if (iframe && iframe.src && iframe.src !== 'about:blank') {
                consoleLog('[LazyLoad] Iframe is no longer intersecting, removing iframe for:', iframe.src);

                // For YouTube, try to pause the video before removing
                if (iframe.contentWindow && iframe.src.includes("youtube.com/embed")) {
                    try {
                        iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', 'https://www.youtube.com');
                    } catch (e) {
                        consoleWarn('[LazyLoad] Error attempting to postMessage pause to YouTube:', e);
                    }
                } else if (iframe.contentWindow && iframe.src.includes("twitch.tv")) {
                    try {
                        iframe.contentWindow.postMessage({"event": "video.pause"}, "*");
                    } catch (e) {
                        consoleWarn('[LazyLoad] Error attempting to postMessage pause to Twitch:', e);
                    }
                }

                // Store the embed URL on the wrapper if it's not already there
                if (!wrapper.dataset.embedUrl) {
                    wrapper.dataset.embedUrl = iframe.dataset.src;
                }

                // Remove the iframe and add a placeholder
                iframe.remove();
                const placeholder = document.createElement('div');
                placeholder.textContent = 'Embed hidden. Scroll to load.';
                placeholder.style.cssText = `
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    height: 100%;
                    background-color: #181818;
                    color: white;
                    font-size: 14px;
                `;
                wrapper.appendChild(placeholder);
                observerInstance.observe(wrapper);
            }
        }
    });
}

// --- Theme Settings Persistence ---
let pendingThemeChanges = {};

function showApplyDiscardButtons() {
    const applyBtn = document.getElementById('otk-apply-settings-btn');
    const discardBtn = document.getElementById('otk-discard-settings-btn');
    if (applyBtn) applyBtn.style.display = 'inline-block';
    if (discardBtn) discardBtn.style.display = 'inline-block';
}

function hideApplyDiscardButtons() {
    const applyBtn = document.getElementById('otk-apply-settings-btn');
    const discardBtn = document.getElementById('otk-discard-settings-btn');
    if (applyBtn) applyBtn.style.display = 'none';
    if (discardBtn) discardBtn.style.display = 'none';
}

async function forceViewerRerenderAfterThemeChange() {
    if (otkViewer && otkViewer.style.display === 'block') {
        consoleLog("Forcing viewer re-render after theme/setting change.");

        // Reload messages from DB to ensure we have the full set before applying limits
        messagesByThreadId = await loadMessagesFromDB();

        // No need to manually trim here, as renderMessagesInViewer will do it.
        // The key is that we've refreshed messagesByThreadId from the source of truth.

        // Clear viewer state
        renderedMessageIdsInViewer.clear();
        otkViewer.innerHTML = ''; // Clear the viewer content

        // Apply layout class
        const currentLayoutToggle = localStorage.getItem('otkMessageLayoutStyle') || 'default';
        if (currentLayoutToggle === 'new_design') {
            otkViewer.classList.add('otk-message-layout-newdesign');
            otkViewer.classList.remove('otk-message-layout-default');
        } else {
            otkViewer.classList.add('otk-message-layout-default');
            otkViewer.classList.remove('otk-message-layout-newdesign');
        }

        // Re-render, which will now use the freshly loaded and correctly trimmed messages
        renderMessagesInViewer({ isToggleOpen: true });
        consoleLog("Viewer force re-rendered with fresh data.");
    }
}

function saveThemeSetting(key, value, requiresRerender = false) {
    const threadListRerenderKeys = [
        'guiThreadListTitleColor',
        'guiThreadListTimeColor',
        'otkThreadTimePosition',
        'otkThreadTimeDividerEnabled',
        'otkThreadTimeDividerSymbol',
        'otkThreadTimeDividerColor',
        'otkThreadTimeBracketStyle',
        'otkThreadTimeBracketColor',
        'otkThreadTitleAnimationSpeed'
    ];

    if (requiresRerender) {
        pendingThemeChanges[key] = value;
        showApplyDiscardButtons();
    } else {
        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        } catch (e) {
            consoleError("Error parsing theme settings from localStorage:", e);
        }
        if (value === null || value === undefined) {
            delete settings[key];
        } else {
            settings[key] = value;
        }
        localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(settings));
        consoleLog("Saved theme setting:", key, value);
        if (key.startsWith('otkMsgDepth')) {
            forceViewerRerenderAfterThemeChange();
        }
        if (threadListRerenderKeys.includes(key)) {
            renderThreadList();
        }
    }
}

async function applyMainTheme() {
    // If theme settings already exist in localStorage, don't overwrite them with the main theme on page load.
    // This preserves user's session changes. Main theme is for initial load or after a reset.
    if (localStorage.getItem(THEME_SETTINGS_KEY)) {
        consoleLog('[Theme] Active theme settings found in localStorage. Skipping main theme load.');
        return;
    }

    try {
        const mainThemeSettings = await GM.getValue(MAIN_THEME_KEY);
        if (mainThemeSettings) {
            const parsedSettings = JSON.parse(mainThemeSettings);
            localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(parsedSettings));
            consoleLog('[Theme] Loaded main theme from GM storage into localStorage.');
        } else {
            consoleLog('[Theme] No main theme found in GM storage. Using localStorage default.');
        }
    } catch (error) {
        consoleError('[Theme] Error loading main theme from GM storage:', error);
    }
}

function applyThemeSettings(options = {}) {
    const { forceRerender = true } = options; // Default to true to not break existing calls

    let settings = {};
    try {
        settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    } catch (e) {
        consoleError("Error parsing theme settings from localStorage:", e);
    }
    consoleLog("Applying theme settings:", settings);
    consoleLog("[Clock BG Debug] Applying theme. clockBgColor is:", settings.clockBgColor);

    // Helper to update a color input pair (hex text and color swatch)
        const updateColorInputs = (idSuffix, colorValue) => {
            const hexInput = document.getElementById(`otk-${idSuffix}-hex`);
            const pickerInput = document.getElementById(`otk-${idSuffix}`); // Correct ID for color swatch
            if (hexInput) hexInput.value = colorValue;
            if (pickerInput) pickerInput.value = colorValue;
        };

        if (settings.guiBgColor) {
            document.documentElement.style.setProperty('--otk-gui-bg-color', settings.guiBgColor);
            updateColorInputs('gui-bg', settings.guiBgColor);
        }

        if (settings.guiTextColor) {
            document.documentElement.style.setProperty('--otk-gui-text-color', settings.guiTextColor);
            updateColorInputs('gui-text', settings.guiTextColor);
        }

        if (settings.titleTextColor) {
            document.documentElement.style.setProperty('--otk-title-text-color', settings.titleTextColor);
            updateColorInputs('title-text', settings.titleTextColor);
        }

        if (settings.optionsTextColor) {
            document.documentElement.style.setProperty('--otk-options-text-color', settings.optionsTextColor);
            updateColorInputs('options-text', settings.optionsTextColor);
        }

        if (settings.actualStatsTextColor) {
            document.documentElement.style.setProperty('--otk-stats-text-color', settings.actualStatsTextColor);
            updateColorInputs('actual-stats-text', settings.actualStatsTextColor);
        }

        if (settings.viewerBgColor) {
            document.documentElement.style.setProperty('--otk-viewer-bg-color', settings.viewerBgColor);
            updateColorInputs('viewer-bg', settings.viewerBgColor);
        }

        if (settings.guiThreadListTitleColor) {
            document.documentElement.style.setProperty('--otk-gui-threadlist-title-color', settings.guiThreadListTitleColor);
            updateColorInputs('threadlist-title', settings.guiThreadListTitleColor);
        }

        if (settings.guiThreadListTimeColor) {
            document.documentElement.style.setProperty('--otk-gui-threadlist-time-color', settings.guiThreadListTimeColor);
            updateColorInputs('threadlist-time', settings.guiThreadListTimeColor);
        }

        // Viewer Header Border Color
        if (settings.viewerHeaderBorderColor) {
            document.documentElement.style.setProperty('--otk-viewer-header-border-color', settings.viewerHeaderBorderColor);
            updateColorInputs('viewer-header-border', settings.viewerHeaderBorderColor);
        }

        // Viewer Quote L1 Border Color
        if (settings.viewerQuote1HeaderBorderColor) {
            document.documentElement.style.setProperty('--otk-viewer-quote1-header-border-color', settings.viewerQuote1HeaderBorderColor);
            updateColorInputs('viewer-quote1-border', settings.viewerQuote1HeaderBorderColor);
        }

        // Viewer Quote L2+ Border Color
        if (settings.viewerQuote2plusHeaderBorderColor) {
            document.documentElement.style.setProperty('--otk-viewer-quote2plus-header-border-color', settings.viewerQuote2plusHeaderBorderColor);
            updateColorInputs('viewer-quote2plus-border', settings.viewerQuote2plusHeaderBorderColor);
        }

        // Message Background Colors, etc. for Even/Odd depths
        ['Even', 'Odd'].forEach(parity => {
            const parityLower = parity.toLowerCase();
            const settingsToApply = [
                { key: `msgDepth${parity}ContentFontSize`, cssVar: `--otk-msg-depth-${parityLower}-content-font-size`, idSuffix: `msg-depth-${parityLower}-content-fontsize`, type: 'font' },
                { key: `msgDepth${parity}BgColor`, cssVar: `--otk-msg-depth-${parityLower}-bg-color`, idSuffix: `msg-depth-${parityLower}-bg`, type: 'color' },
                { key: `msgDepth${parity}TextColor`, cssVar: `--otk-msg-depth-${parityLower}-text-color`, idSuffix: `msg-depth-${parityLower}-text`, type: 'color' },
                { key: `msgDepth${parity}HeaderTextColor`, cssVar: `--otk-msg-depth-${parityLower}-header-text-color`, idSuffix: `msg-depth-${parityLower}-header-text`, type: 'color' },
                { key: `viewerHeaderBorderColor${parity}`, cssVar: `--otk-viewer-header-border-color-${parityLower}`, idSuffix: `viewer-header-border-${parityLower}`, type: 'color' }
            ];

            settingsToApply.forEach(setting => {
                 if (settings[setting.key]) {
                    document.documentElement.style.setProperty(setting.cssVar, settings[setting.key]);
                    if (setting.type === 'color') {
                        updateColorInputs(setting.idSuffix, settings[setting.key]);
                    } else if (setting.type === 'font') {
                        const inputElement = document.getElementById(`otk-${setting.idSuffix}`);
                        if (inputElement) {
                            inputElement.value = settings[setting.key].replace('px', '');
                        }
                    }
                }
            });
        });

        if (settings.ownMsgBgColorOdd) {
            document.documentElement.style.setProperty('--otk-own-msg-bg-color-odd', settings.ownMsgBgColorOdd);
            updateColorInputs('own-msg-bg-odd', settings.ownMsgBgColorOdd);
        }
        if (settings.ownMsgBgColorEven) {
            document.documentElement.style.setProperty('--otk-own-msg-bg-color-even', settings.ownMsgBgColorEven);
            updateColorInputs('own-msg-bg-even', settings.ownMsgBgColorEven);
        }

        if (settings.guiBottomBorderColor) {
            document.documentElement.style.setProperty('--otk-gui-bottom-border-color', settings.guiBottomBorderColor);
            updateColorInputs('gui-bottom-border', settings.guiBottomBorderColor);
        }

        // Cog Icon Color
        if (settings.cogIconColor) {
            document.documentElement.style.setProperty('--otk-cog-icon-color', settings.cogIconColor);
            updateColorInputs('cog-icon', settings.cogIconColor);
        }

        // Disable Background Font Color
        if (settings.disableBgFontColor) {
            document.documentElement.style.setProperty('--otk-disable-bg-font-color', settings.disableBgFontColor);
            updateColorInputs('disable-bg-font', settings.disableBgFontColor);
        }

        if (settings.countdownLabelTextColor) {
            document.documentElement.style.setProperty('--otk-countdown-label-text-color', settings.countdownLabelTextColor);
            updateColorInputs('countdown-label-text', settings.countdownLabelTextColor);
        }

        if (settings.countdownTimerTextColor) {
            document.documentElement.style.setProperty('--otk-countdown-timer-text-color', settings.countdownTimerTextColor);
            updateColorInputs('countdown-timer-text', settings.countdownTimerTextColor);
        }

        // New Messages Divider Color
        if (settings.newMessagesDividerColor) {
            document.documentElement.style.setProperty('--otk-new-messages-divider-color', settings.newMessagesDividerColor);
            updateColorInputs('new-msg-divider', settings.newMessagesDividerColor);
        }

        // New Messages Font Color
        if (settings.newMessagesFontColor) {
            document.documentElement.style.setProperty('--otk-new-messages-font-color', settings.newMessagesFontColor);
            updateColorInputs('new-msg-font', settings.newMessagesFontColor);
        }

        // Pin Highlight Colors
        if (settings.pinHighlightBgColor) {
            document.documentElement.style.setProperty('--otk-pin-highlight-bg-color', settings.pinHighlightBgColor);
            updateColorInputs('pin-bg', settings.pinHighlightBgColor);
        }
        if (settings.pinHighlightBorderColor) {
            document.documentElement.style.setProperty('--otk-pin-highlight-border-color', settings.pinHighlightBorderColor);
            updateColorInputs('pin-border', settings.pinHighlightBorderColor);
        }

        // '+' Icon Background
        if (settings.plusIconBgColor) {
            document.documentElement.style.setProperty('--otk-plus-icon-bg-color', settings.plusIconBgColor);
            updateColorInputs('plus-icon-bg-color', settings.plusIconBgColor);
        }

        // Icon Colors
        if (settings.resizeIconColor) {
            document.documentElement.style.setProperty('--otk-resize-icon-color', settings.resizeIconColor);
            updateColorInputs('resize-icon', settings.resizeIconColor);
        }
        if (settings.resizeIconBgColor) {
            document.documentElement.style.setProperty('--otk-resize-icon-bg-color', settings.resizeIconBgColor);
            updateColorInputs('resize-icon-bg', settings.resizeIconBgColor);
        }
        if (settings.blurIconColor) {
            document.documentElement.style.setProperty('--otk-blur-icon-color', settings.blurIconColor);
            updateColorInputs('blur-icon', settings.blurIconColor);
        }
        if (settings.blurIconBgColor) {
            document.documentElement.style.setProperty('--otk-blur-icon-bg-color', settings.blurIconBgColor);
            updateColorInputs('blur-icon-bg', settings.blurIconBgColor);
        }
        if (settings.mediaIconDividerColor) {
            document.documentElement.style.setProperty('--otk-media-icon-divider-color', settings.mediaIconDividerColor);
            updateColorInputs('media-icon-divider', settings.mediaIconDividerColor);
        }

    // Clock Colors
        if (settings.hasOwnProperty('clockBgColor') && settings.clockBgColor) {
            document.documentElement.style.setProperty('--otk-clock-bg-color', settings.clockBgColor);
            updateColorInputs('clock-bg', settings.clockBgColor);
        } else {
            // If the setting is empty or doesn't exist, remove the inline style property.
            // This makes the element revert to the color defined in the <style> block's :root.
            document.documentElement.style.removeProperty('--otk-clock-bg-color');
            // Update the input to show the computed default color.
            const defaultColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-clock-bg-color').trim();
            updateColorInputs('clock-bg', defaultColor);
        }
        if (settings.clockSearchBgColor) {
            document.documentElement.style.setProperty('--otk-clock-search-bg-color', settings.clockSearchBgColor);
            updateColorInputs('clock-search-bg', settings.clockSearchBgColor);
        }
        if (settings.clockSearchTextColor) {
            document.documentElement.style.setProperty('--otk-clock-search-text-color', settings.clockSearchTextColor);
            updateColorInputs('clock-search-text', settings.clockSearchTextColor);
        }
        // GUI Button Colors
        const buttonColorConfigs = [
            { key: 'guiButtonBgColor', cssVar: '--otk-button-bg-color', idSuffix: 'gui-button-bg' },
            { key: 'guiButtonTextColor', cssVar: '--otk-button-text-color', idSuffix: 'gui-button-text' },
            { key: 'guiButtonBorderColor', cssVar: '--otk-button-border-color', idSuffix: 'gui-button-border' },
            { key: 'guiButtonHoverBgColor', cssVar: '--otk-button-hover-bg-color', idSuffix: 'gui-button-hover-bg' },
            { key: 'guiButtonActiveBgColor', cssVar: '--otk-button-active-bg-color', idSuffix: 'gui-button-active-bg' }
        ];
        buttonColorConfigs.forEach(config => {
            if (settings[config.key]) {
                document.documentElement.style.setProperty(config.cssVar, settings[config.key]);
                updateColorInputs(config.idSuffix, settings[config.key]);
            }
        });

        // Loading Screen Colors
        if (settings.loadingOverlayBaseHexColor) {
            document.documentElement.style.setProperty('--otk-loading-overlay-base-hex-color', settings.loadingOverlayBaseHexColor);
            updateColorInputs('loading-overlay-base-hex', settings.loadingOverlayBaseHexColor);
        }
        if (settings.loadingOverlayOpacity) {
            document.documentElement.style.setProperty('--otk-loading-overlay-opacity', settings.loadingOverlayOpacity);
            const inputEl = document.getElementById('otk-loading-overlay-opacity');
            if (inputEl) inputEl.value = settings.loadingOverlayOpacity;
        }
        if (settings.loadingTextColor) {
            document.documentElement.style.setProperty('--otk-loading-text-color', settings.loadingTextColor);
            updateColorInputs('loading-text', settings.loadingTextColor);
        }
        if (settings.loadingProgressBarBgColor) {
            document.documentElement.style.setProperty('--otk-loading-progress-bar-bg-color', settings.loadingProgressBarBgColor);
            updateColorInputs('loading-progress-bg', settings.loadingProgressBarBgColor);
        }
        if (settings.loadingProgressBarFillColor) {
            document.documentElement.style.setProperty('--otk-loading-progress-bar-fill-color', settings.loadingProgressBarFillColor);
            updateColorInputs('loading-progress-fill', settings.loadingProgressBarFillColor);
        }
        if (settings.loadingProgressBarTextColor) {
            document.documentElement.style.setProperty('--otk-loading-progress-bar-text-color', settings.loadingProgressBarTextColor);
            updateColorInputs('loading-progress-text', settings.loadingProgressBarTextColor);
        }

        // Directly update loading screen styles
        const loadingOverlayElement = document.getElementById('otk-loading-overlay');
        if (loadingOverlayElement) {
            const baseHex = settings.loadingOverlayBaseHexColor || getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-overlay-base-hex-color').trim() || '#000000';
            const rgbParts = hexToRgbParts(baseHex);
            const opacity = settings.loadingOverlayOpacity || getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-overlay-opacity').trim() || '0.8';
            loadingOverlayElement.style.backgroundColor = `rgba(${rgbParts}, ${opacity})`;
            loadingOverlayElement.style.color = `var(--otk-loading-text-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-text-color').trim() || '#ffffff'})`;
            const progressBarContainer = document.getElementById('otk-progress-bar-container');
            if (progressBarContainer) {
                progressBarContainer.style.backgroundColor = `var(--otk-loading-progress-bar-bg-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-progress-bar-bg-color').trim() || '#333333'})`;
            }
            const progressBar = document.getElementById('otk-progress-bar');
            if (progressBar) {
                progressBar.style.backgroundColor = `var(--otk-loading-progress-bar-fill-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-progress-bar-fill-color').trim() || '#4CAF50'})`;
                progressBar.style.color = `var(--otk-loading-progress-bar-text-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-progress-bar-text-color').trim() || '#ffffff'})`;
            }
        }

        // GUI Background Image
        const guiWrapper = document.getElementById('otk-tracker-gui-wrapper');
        if (guiWrapper) {
            if (settings.guiBackgroundImageUrl) {
                guiWrapper.style.backgroundImage = `url('${settings.guiBackgroundImageUrl}')`;
                guiWrapper.style.backgroundSize = settings.guiBgSize || 'cover';
                guiWrapper.style.backgroundRepeat = settings.guiBgRepeat || 'no-repeat';
                guiWrapper.style.backgroundPosition = settings.guiBgPosition || 'center';
            } else {
                guiWrapper.style.backgroundImage = '';
            }
        }

        if (forceRerender) {
            forceViewerRerenderAfterThemeChange();
        }

        // Viewer Background Image
        const viewerWrapper = document.getElementById('otk-viewer');
        if (viewerWrapper) {
            if (settings.viewerBackgroundImageUrl) {
                viewerWrapper.style.backgroundImage = `url('${settings.viewerBackgroundImageUrl}')`;
                viewerWrapper.style.backgroundSize = settings.viewerBgSize || 'cover';
                viewerWrapper.style.backgroundRepeat = settings.viewerBgRepeat || 'no-repeat';
                viewerWrapper.style.backgroundPosition = settings.viewerBgPosition || 'center';
            } else {
                viewerWrapper.style.backgroundImage = '';
            }
        }

        // GUI Thread Box Outline
        if (settings.guiThreadBoxOutlineColor && settings.guiThreadBoxOutlineColor.toLowerCase() !== 'none') {
            document.documentElement.style.setProperty('--otk-gui-thread-box-outline', `1px solid ${settings.guiThreadBoxOutlineColor}`);
        } else {
            document.documentElement.style.setProperty('--otk-gui-thread-box-outline', 'none');
        }

        // Viewer Thread Box Outline
        if (settings.viewerThreadBoxOutlineColor && settings.viewerThreadBoxOutlineColor.toLowerCase() !== 'none') {
            document.documentElement.style.setProperty('--otk-viewer-thread-box-outline', `1px solid ${settings.viewerThreadBoxOutlineColor}`);
        } else {
            document.documentElement.style.setProperty('--otk-viewer-thread-box-outline', 'none');
        }

        // PiP Background
        applyPipBackgroundStyles(); // New centralized function
        if (settings.pipBackgroundColor) {
            document.documentElement.style.setProperty('--otk-pip-bg-color', settings.pipBackgroundColor);
            updateColorInputs('pip-bg', settings.pipBackgroundColor);
        }

        // QR Theming
        const qrColorConfigs = [
            { key: 'mediaControlsBgColorOdd', cssVar: '--otk-media-controls-bg-color-odd', idSuffix: 'media-controls-bg-odd' },
            { key: 'mediaControlsBgColorEven', cssVar: '--otk-media-controls-bg-color-even', idSuffix: 'media-controls-bg-even' },
            { key: 'mediaMenuIconColor', cssVar: '--otk-media-menu-icon-color', idSuffix: 'media-menu-icon' },
            { key: 'qrBgColor', cssVar: '--otk-qr-bg-color', idSuffix: 'qr-bg' },
            { key: 'qrBorderColor', cssVar: '--otk-qr-border-color', idSuffix: 'qr-border' },
            { key: 'qrHeaderBgColor', cssVar: '--otk-qr-header-bg-color', idSuffix: 'qr-header-bg' },
            { key: 'qrHeaderTextColor', cssVar: '--otk-qr-header-text-color', idSuffix: 'qr-header-text' },
            { key: 'qrHeaderTextColor', cssVar: '--otk-qr-header-text-color', idSuffix: 'qr-header-text' },
            { key: 'qrTextareaBgColor', cssVar: '--otk-qr-textarea-bg-color', idSuffix: 'qr-textarea-bg' },
            { key: 'qrTextareaTextColor', cssVar: '--otk-qr-textarea-text-color', idSuffix: 'qr-textarea-text' },
        ];
        qrColorConfigs.forEach(config => {
            if (settings[config.key]) {
                document.documentElement.style.setProperty(config.cssVar, settings[config.key]);
                updateColorInputs(config.idSuffix, settings[config.key]);
            }
        });

        if (settings.repliesStatColor) {
            document.documentElement.style.setProperty('--otk-replies-stat-color', settings.repliesStatColor);
            updateColorInputs('replies-stat', settings.repliesStatColor);
        }
    }


    function createColorOrNoneOptionRow(options) {
        // options = { labelText, storageKey, defaultValue, idSuffix }
        const group = document.createElement('div');
        group.classList.add('otk-option-row');

        const label = document.createElement('label');
        label.textContent = options.labelText;
        label.htmlFor = `otk-${options.idSuffix}-text`;
        label.style.cssText = `
            font-size: 12px;
            text-align: left;
        `;

        const controlsWrapperDiv = document.createElement('div');
        controlsWrapperDiv.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            justify-content: flex-end;
            width: 100%;
        `;

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.id = `otk-${options.idSuffix}-text`;
        textInput.style.cssText = `
            flex: 1 1 70px;
            min-width: 50px;
            height: 25px;
            box-sizing: border-box;
            font-size: 12px;
            text-align: right;
        `;

        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.id = `otk-${options.idSuffix}-picker`;
        colorPicker.style.cssText = `
            flex-grow: 0;
            flex-shrink: 0;
            width: 30px;
            height: 25px;
            padding: 1px;
            box-sizing: border-box;
        `;

        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Default';
        defaultBtn.style.cssText = `
            flex-grow: 0;
            flex-shrink: 0;
            padding: 2px 6px;
            height: 25px;
            font-size: 11px;
            box-sizing: border-box;
            width: 70px;
        `;

        group.appendChild(label);
        controlsWrapperDiv.appendChild(textInput);
        controlsWrapperDiv.appendChild(colorPicker);
        controlsWrapperDiv.appendChild(defaultBtn);
        group.appendChild(controlsWrapperDiv);

        // Logic
        const settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        let initialValue = settings[options.storageKey] || options.defaultValue;
        textInput.value = initialValue;

        const isValidColor = (str) => /^#([0-9A-F]{3}){1,2}$/i.test(str);

        if (isValidColor(initialValue)) {
            colorPicker.value = initialValue;
        } else {
            colorPicker.value = '#000000'; // Default picker to black if value is "none"
        }
        colorPicker.style.visibility = 'visible'; // Always visible

        const updateState = (newValue) => {
            const valueToSave = newValue.trim().toLowerCase();
            textInput.value = valueToSave;
            if (isValidColor(valueToSave)) {
                colorPicker.value = valueToSave;
            }
            // No need to toggle visibility anymore
            saveThemeSetting(options.storageKey, valueToSave);
            applyThemeSettings({ forceRerender: false });
        };

        textInput.addEventListener('change', (e) => {
            const value = e.target.value.trim().toLowerCase();
            if (value === 'none' || isValidColor(value)) {
                updateState(value);
            } else {
                const savedSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
                textInput.value = savedSettings[options.storageKey] || options.defaultValue;
            }
        });

        colorPicker.addEventListener('input', (e) => {
            updateState(e.target.value);
        });

        defaultBtn.addEventListener('click', () => {
            updateState(options.defaultValue);
        });

        return group;
    }


    function applyPipBackgroundStyles() {
        const pipBackground = document.getElementById('otk-pip-background');
        if (!pipBackground) return;

        const settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        pipBackground.style.backgroundColor = settings.pipBackgroundColor || '#1a1a1a';
        if (settings.pipBackgroundImageUrl) {
            pipBackground.style.backgroundImage = `url('${settings.pipBackgroundImageUrl}')`;
            pipBackground.style.backgroundSize = settings.pipBgSize || 'cover';
            pipBackground.style.backgroundRepeat = settings.pipBgRepeat || 'no-repeat';
            pipBackground.style.backgroundPosition = settings.pipBgPosition || 'center';
        } else {
            pipBackground.style.backgroundImage = '';
        }
    }

    function createPipResizer() {
        let resizeHandle = document.getElementById('otk-resize-handle');
        if (resizeHandle) return; // Already exists

        resizeHandle = document.createElement('div');
        resizeHandle.id = 'otk-resize-handle';
        document.body.appendChild(resizeHandle);

        let isResizing = false;
        const viewer = document.getElementById('otk-viewer');
        const pipBackground = document.getElementById('otk-pip-background');

        const onMouseDown = (e) => {
            isResizing = true;
            document.body.classList.add('otk-resizing');
        };

        let latestX = 0;
        let isRafPending = false;

        const updateWidth = () => {
            if (!viewer) return; // Guard against viewer being null
            const newWidth = Math.max(200, Math.min(latestX, window.innerWidth - 200));
            viewer.style.width = newWidth + 'px';
            resizeHandle.style.left = newWidth + 'px';
            if (pipBackground) {
                pipBackground.style.left = newWidth + 'px';
                pipBackground.style.width = (window.innerWidth - newWidth) + 'px';
            }
            isRafPending = false;
        };

        const onMouseMove = (e) => {
            if (!isResizing) return;
            latestX = e.clientX;
            if (!isRafPending) {
                isRafPending = true;
                requestAnimationFrame(updateWidth);
            }
        };

        const onMouseUp = () => {
            isResizing = false;
            document.body.classList.remove('otk-resizing');
        };

        resizeHandle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Store listeners so they can be removed
        resizeHandle.otkListeners = { onMouseDown, onMouseMove, onMouseUp };
    }

    function destroyPipResizer() {
        const resizeHandle = document.getElementById('otk-resize-handle');
        if (resizeHandle && resizeHandle.otkListeners) {
            const { onMouseDown, onMouseMove, onMouseUp } = resizeHandle.otkListeners;
            resizeHandle.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            resizeHandle.remove();
        }
    }

    function enablePipMode() {
        const viewer = document.getElementById('otk-viewer');
        if (!viewer) return;

        viewer.style.width = '50vw';
        viewer.style.right = 'auto';

        let pipBackground = document.getElementById('otk-pip-background');
        if (!pipBackground) {
            pipBackground = document.createElement('div');
            pipBackground.id = 'otk-pip-background';
            pipBackground.style.position = 'fixed';
            pipBackground.style.top = '89px';
            pipBackground.style.left = '50vw';
            pipBackground.style.width = '50vw';
            pipBackground.style.height = 'calc(100% - 89px)';
            pipBackground.style.zIndex = '9997';
            document.body.appendChild(pipBackground);
        }

        applyPipBackgroundStyles();
        createPipResizer();
    }

    function disablePipMode() {
        const viewer = document.getElementById('otk-viewer');
        if (viewer) {
            viewer.style.width = '100vw';
            viewer.style.right = '0';
        }

        const pipBackground = document.getElementById('otk-pip-background');
        if (pipBackground) {
            pipBackground.remove();
        }

        destroyPipResizer();
    }

function createSectionHeading(text) {
    const h = document.createElement('h5');
    h.textContent = text;
    // Adjusted margins for more space, removed border-bottom
    h.style.cssText = "margin: 0; color: #cccccc; font-size: 13px; padding: 4px 10px 4px 30px; font-weight: bold; text-align: left; display: flex; align-items: center;";
    return h;
}
function createThemeOptionRow(options) {
    // options = { labelText, storageKey, cssVariable, defaultValue, inputType, unit, min, max, step, idSuffix, requiresRerender }
    const group = document.createElement('div');
    group.classList.add('otk-option-row');

    const label = document.createElement('label');
    label.textContent = options.labelText;
    label.htmlFor = `otk-${options.idSuffix}`;
    label.style.cssText = `
        font-size: 12px;
        text-align: left;
    `;

    const controlsWrapperDiv = document.createElement('div');
    controlsWrapperDiv.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
    `;

    const mainInput = document.createElement('input');
    mainInput.type = options.inputType || 'text';
    mainInput.id = `otk-${options.idSuffix}`;
    mainInput.style.cssText = `
        flex: 1 1 70px;
        min-width: 50px;
        height: 25px;
        box-sizing: border-box;
        font-size: 12px;
        text-align: right;
    `;

    if (options.inputType === 'number') {
        if (options.min !== undefined) mainInput.min = options.min;
        if (options.max !== undefined) mainInput.max = options.max;
        if (options.step !== undefined) mainInput.step = options.step;
    }

    let hexInput;
    if (options.inputType === 'color') {
        hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.id = `otk-${options.idSuffix}-hex`;
        hexInput.style.cssText = `
            flex: 1 1 70px;
            min-width: 50px;
            height: 25px;
            box-sizing: border-box;
            font-size: 12px;
            text-align: right;
        `;
        mainInput.style.flexGrow = '0';
        mainInput.style.flexShrink = '0';
        mainInput.style.width = '30px';
        mainInput.style.padding = '1px';
    }


    const defaultBtn = document.createElement('button');
    defaultBtn.textContent = 'Default';
    defaultBtn.style.cssText = `
        flex-grow: 0;
        flex-shrink: 0;
        padding: 2px 6px;
        height: 25px;
        font-size: 11px;
        box-sizing: border-box;
        width: 70px;
    `;

    group.appendChild(label);
    if (hexInput) {
        controlsWrapperDiv.appendChild(hexInput);
    }
    controlsWrapperDiv.appendChild(mainInput);
    controlsWrapperDiv.appendChild(defaultBtn);
    group.appendChild(controlsWrapperDiv);

    const settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    let initialValue = settings[options.storageKey] || options.defaultValue;

    const updateInputs = (value) => {
        let displayValue = value;
        if (options.unit && typeof displayValue === 'string' && displayValue.endsWith(options.unit)) {
            displayValue = displayValue.replace(options.unit, '');
        }
        mainInput.value = displayValue;
        if (hexInput) {
            hexInput.value = value;
            mainInput.value = value;
        }
    };

    updateInputs(initialValue);

    const saveValue = (newValue) => {
        let valueToSave = newValue;
        if (options.unit && !String(newValue).endsWith(options.unit)) {
            valueToSave += options.unit;
        }
        saveThemeSetting(options.storageKey, valueToSave, options.requiresRerender || false);
        if (options.cssVariable) {
            document.documentElement.style.setProperty(options.cssVariable, valueToSave);
        }
    };

    mainInput.addEventListener('change', (e) => {
        saveValue(e.target.value);
        if (hexInput) {
            hexInput.value = e.target.value;
        }
    });

    if (hexInput) {
        hexInput.addEventListener('change', (e) => {
            saveValue(e.target.value);
            mainInput.value = e.target.value;
        });
    }

    defaultBtn.addEventListener('click', () => {
        updateInputs(options.defaultValue);
        saveValue(options.defaultValue);
        // After setting to default, re-apply all theme settings to ensure consistency
        applyThemeSettings({ forceRerender: false });
    });

    return group;
}

    function setupOptionsWindow() {
        let prePreviewSettings = null;
        let currentlyPreviewingThemeName = null;
        consoleLog("Setting up Options Window...");

        // Check if window already exists
        if (document.getElementById('otk-options-window')) {
            consoleLog("Options window already exists.");
            return;
        }

        const optionsWindow = document.createElement('div');
        optionsWindow.id = 'otk-options-window';
        optionsWindow.style.cssText = `
            position: fixed;
            top: 0;
            left: -50%;
            width: 50%;
            height: 100vh;
            background-color: var(--otk-options-main-bg-color);
            border: none;
            border-radius: 0;
            z-index: 100002; /* Above clock, loading screen, etc. */
            box-shadow: 5px 0 5px -2px #000;
            display: none; /* Hidden by default */
            flex-direction: column;
            color: var(--otk-options-text-color); /* Use specific variable for options window text */
            transition: left 0.3s ease-in-out;
        `;

        const titleBar = document.createElement('div');
        titleBar.id = 'otk-options-title-bar';
        titleBar.style.cssText = `
            padding: 8px 30px 8px 30px;
            background-color: var(--otk-gui-bg-color);
            color: #f0f0f0;
            font-weight: bold;
            border-bottom: 1px solid #444;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        const titleContainer = document.createElement('div');
        titleContainer.style.display = 'flex';

        const optionsTab = document.createElement('span');
        optionsTab.id = 'otk-options-tab-main';
        optionsTab.textContent = 'Main Options';
        optionsTab.style.cursor = 'pointer';
        optionsTab.style.display = 'inline-block';

        const threadTitleColorsTab = document.createElement('span');
        threadTitleColorsTab.id = 'otk-options-tab-thread-title-colors';
        threadTitleColorsTab.textContent = 'Thread Title Colours';
        threadTitleColorsTab.style.cursor = 'pointer';

        const clockOptionsText = document.createElement('span');
        clockOptionsText.id = 'otk-options-tab-clock';
        clockOptionsText.textContent = 'Clock Options';
        clockOptionsText.style.cursor = 'pointer';

        const settingsManagementTab = document.createElement('span');
        settingsManagementTab.id = 'otk-options-tab-settings-management';
        settingsManagementTab.textContent = 'Settings Management';
        settingsManagementTab.style.cursor = 'pointer';

        const divider1 = document.createElement('span');
        divider1.innerHTML = '&nbsp;|&nbsp;';
        const divider2 = document.createElement('span');
        divider2.innerHTML = '&nbsp;|&nbsp;';
        const divider3 = document.createElement('span');
        divider3.innerHTML = '&nbsp;|&nbsp;';

        titleContainer.appendChild(optionsTab);
        titleContainer.appendChild(divider1);
        titleContainer.appendChild(threadTitleColorsTab);
        titleContainer.appendChild(divider2);
        titleContainer.appendChild(clockOptionsText);
        titleContainer.appendChild(divider3);
        titleContainer.appendChild(settingsManagementTab);
        titleBar.appendChild(titleContainer);

        const hideAllPanels = () => {
            document.getElementById('otk-main-options-panel').style.display = 'none';
            document.getElementById('otk-thread-title-colors-panel').style.display = 'none';
            document.getElementById('otk-clock-options-panel').style.display = 'none';
            document.getElementById('otk-settings-management-panel').style.display = 'none';
            optionsTab.style.textDecoration = 'none';
            threadTitleColorsTab.style.textDecoration = 'none';
            clockOptionsText.style.textDecoration = 'none';
            settingsManagementTab.style.textDecoration = 'none';
        };

        optionsTab.addEventListener('click', () => {
            hideAllPanels();
            document.getElementById('otk-main-options-panel').style.display = 'block';
            optionsTab.style.textDecoration = 'underline';
        });

        threadTitleColorsTab.addEventListener('click', () => {
            hideAllPanels();
            document.getElementById('otk-thread-title-colors-panel').style.display = 'block';
            threadTitleColorsTab.style.textDecoration = 'underline';
            renderThreadTitleColorsOptions();
        });

        clockOptionsText.addEventListener('click', () => {
            hideAllPanels();
            document.getElementById('otk-clock-options-panel').style.display = 'block';
            clockOptionsText.style.textDecoration = 'underline';
            renderClockOptions();
        });

        settingsManagementTab.addEventListener('click', () => {
            hideAllPanels();
            document.getElementById('otk-settings-management-panel').style.display = 'block';
            settingsManagementTab.style.textDecoration = 'underline';
            renderSettingsManagementPanel();
        });

        // Set initial state
        optionsTab.style.textDecoration = 'underline';

        const titleBarButtons = document.createElement('div');
        titleBarButtons.style.display = 'flex';
        titleBarButtons.style.alignItems = 'center';
        titleBarButtons.style.gap = '8px';

        const applyButton = createTrackerButton('Apply', 'otk-apply-settings-btn');
        applyButton.style.display = 'none'; // Hidden by default
        titleBarButtons.appendChild(applyButton);

        const discardButton = createTrackerButton('Discard', 'otk-discard-settings-btn');
        discardButton.style.display = 'none'; // Hidden by default;
        discardButton.style.backgroundColor = '#803333';
        discardButton.onmouseover = () => discardButton.style.backgroundColor = '#a04444';
        discardButton.onmouseout = () => discardButton.style.backgroundColor = '#803333';
        titleBarButtons.appendChild(discardButton);

        const closeButton = document.createElement('span');
        closeButton.id = 'otk-options-close-btn';
        closeButton.innerHTML = '&#x2715;'; // 'X' character
        closeButton.style.cssText = `
            cursor: pointer;
            font-size: 16px;
            padding: 0 5px;
        `;
        closeButton.title = "Close Settings";
        titleBarButtons.appendChild(closeButton);

        titleBar.appendChild(titleBarButtons);
        optionsWindow.appendChild(titleBar);

        applyButton.addEventListener('click', () => {
            let settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
            settings = { ...settings, ...pendingThemeChanges };
            localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(settings));
            pendingThemeChanges = {};
            hideApplyDiscardButtons();
            applyThemeSettings();
            renderThreadList();
        });

        discardButton.addEventListener('click', () => {
            pendingThemeChanges = {};
            hideApplyDiscardButtons();
            applyThemeSettings(); // Re-apply original settings to reset inputs
            renderThreadList();
        });

        const contentArea = document.createElement('div');
        contentArea.id = 'otk-options-content';
        contentArea.style.cssText = `
            flex-grow: 1;
            overflow-y: auto;
            box-sizing: border-box;
        `;
        optionsWindow.appendChild(contentArea);

        const mainOptionsPanel = document.createElement('div');
        mainOptionsPanel.id = 'otk-main-options-panel';
        mainOptionsPanel.style.cssText = 'padding: 15px 0; display: block;';

        const threadTitleColorsPanel = document.createElement('div');
        threadTitleColorsPanel.id = 'otk-thread-title-colors-panel';
        threadTitleColorsPanel.style.cssText = 'padding: 15px 0; display: none;';

        const clockOptionsPanel = document.createElement('div');
        clockOptionsPanel.id = 'otk-clock-options-panel';
        clockOptionsPanel.style.cssText = 'padding: 15px 0; display: none;';

        const settingsManagementPanel = document.createElement('div');
        settingsManagementPanel.id = 'otk-settings-management-panel';
        settingsManagementPanel.style.cssText = 'padding: 5px 0; display: none;';

        contentArea.appendChild(mainOptionsPanel);
        contentArea.appendChild(threadTitleColorsPanel);
        contentArea.appendChild(clockOptionsPanel);
        contentArea.appendChild(settingsManagementPanel);

        renderClockOptions();

        // --- Main Sections Container (for tabs or collapsible sections later) ---
        // This container might not be strictly necessary anymore if we are just stacking sections.
        // For now, let's keep it but add general settings directly to contentArea or sectionsContainer.
        // Let's add general settings directly to contentArea, above the theme section.

        const generalSettingsContainer = document.createElement('div');
        generalSettingsContainer.id = 'otk-general-settings-container';
        generalSettingsContainer.style.cssText = `
            padding: 0;
            box-sizing: border-box;
        `;
        mainOptionsPanel.appendChild(generalSettingsContainer);

        const generalSettingsHeading = createSectionHeading('General Settings');
        generalSettingsHeading.style.position = 'relative'; // For icon positioning
        generalSettingsHeading.style.marginBottom = "6px";
        // Vertically center the text content
        generalSettingsHeading.style.display = 'flex';
        generalSettingsHeading.style.alignItems = 'center';

        const generalSettingsSection = document.createElement('div');
        generalSettingsSection.id = 'otk-general-settings-section';
        generalSettingsSection.style.cssText = `
            display: flex; /* Always open */
            flex-direction: column;
            gap: 2px;
            padding: 0;
            box-sizing: border-box;
        `;

        generalSettingsContainer.appendChild(generalSettingsHeading);
        generalSettingsContainer.appendChild(generalSettingsSection);

        // --- Tracked Keyword(s) Option ---
        const trackedKeywordsGroup = document.createElement('div');
        trackedKeywordsGroup.classList.add('otk-option-row');

        const trackedKeywordsLabel = document.createElement('label');
        trackedKeywordsLabel.textContent = "Tracked Keyword(s):";
        trackedKeywordsLabel.htmlFor = 'otk-tracked-keywords-input';
        trackedKeywordsLabel.style.cssText = "font-size: 12px; text-align: left;";

        const trackedKeywordsControlsWrapper = document.createElement('div');
        trackedKeywordsControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px;"; // Removed grid-column

        const trackedKeywordsInput = document.createElement('input');
        trackedKeywordsInput.type = 'text';
        trackedKeywordsInput.id = 'otk-tracked-keywords-input';
        trackedKeywordsInput.placeholder = "e.g., otk, item2, phrase three";
        trackedKeywordsInput.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align: right;";
        trackedKeywordsInput.value = localStorage.getItem(OTK_TRACKED_KEYWORDS_KEY) || "otk"; // Load saved value or default

        trackedKeywordsInput.addEventListener('change', () => { // Save on change (after blur or Enter)
            const valueToSave = trackedKeywordsInput.value.trim();
            if (valueToSave) {
                localStorage.setItem(OTK_TRACKED_KEYWORDS_KEY, valueToSave);
                consoleLog(`Tracked keywords saved: ${valueToSave}`);
            } else { // If input is cleared, revert to default and save that
                localStorage.setItem(OTK_TRACKED_KEYWORDS_KEY, "otk");
                trackedKeywordsInput.value = "otk"; // Reflect default in input
                consoleLog(`Tracked keywords reset to default: "otk"`);
            }
        });

        trackedKeywordsControlsWrapper.appendChild(trackedKeywordsInput);
        trackedKeywordsGroup.appendChild(trackedKeywordsLabel);
        trackedKeywordsGroup.appendChild(trackedKeywordsControlsWrapper);
        generalSettingsSection.appendChild(trackedKeywordsGroup);

        // --- Blocked Keyword(s) Option ---
        const blockedKeywordsGroup = document.createElement('div');
        blockedKeywordsGroup.classList.add('otk-option-row');

        const blockedKeywordsLabel = document.createElement('label');
        blockedKeywordsLabel.textContent = "Blocked Keyword(s):";
        blockedKeywordsLabel.htmlFor = 'otk-blocked-keywords-input';
        blockedKeywordsLabel.style.cssText = "font-size: 12px; text-align: left;";

        const blockedKeywordsControlsWrapper = document.createElement('div');
        blockedKeywordsControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px;";

        const blockedKeywordsInput = document.createElement('input');
        blockedKeywordsInput.type = 'text';
        blockedKeywordsInput.id = 'otk-blocked-keywords-input';
        blockedKeywordsInput.placeholder = "e.g., word1, word2, phrase three";
        blockedKeywordsInput.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align: right;";
        blockedKeywordsInput.value = localStorage.getItem(OTK_BLOCKED_KEYWORDS_KEY) || "";

        blockedKeywordsInput.addEventListener('change', () => {
            const valueToSave = blockedKeywordsInput.value.trim();
            localStorage.setItem(OTK_BLOCKED_KEYWORDS_KEY, valueToSave);
            consoleLog(`Blocked keywords saved: ${valueToSave}`);
        });

        blockedKeywordsControlsWrapper.appendChild(blockedKeywordsInput);
        blockedKeywordsGroup.appendChild(blockedKeywordsLabel);
        blockedKeywordsGroup.appendChild(blockedKeywordsControlsWrapper);
        generalSettingsSection.appendChild(blockedKeywordsGroup);

        // --- Background Update Frequency Option ---
        // Helper to create a time input row
        const createTimeInputRow = (options) => {
            const { labelText, storageKey, defaultValueSeconds, idSuffix } = options;

            const group = document.createElement('div');
            group.classList.add('otk-option-row');

            const label = document.createElement('label');
            label.textContent = labelText;
            label.htmlFor = `otk-${idSuffix}-input`;
            label.style.cssText = "font-size: 12px; text-align: left;";

            const timeInput = document.createElement('input');
            timeInput.type = 'text';
            timeInput.id = `otk-${idSuffix}-input`;
            timeInput.placeholder = "hh:mm:ss";
            timeInput.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align: right;";

            const savedSeconds = localStorage.getItem(storageKey);
            timeInput.value = secondsToHHMMSS(savedSeconds !== null ? savedSeconds : defaultValueSeconds);

            timeInput.addEventListener('change', () => {
                const seconds = hhmmssToSeconds(timeInput.value);
                if (seconds === 0 && timeInput.value !== '00:00:00') {
                    timeInput.value = secondsToHHMMSS(defaultValueSeconds);
                    localStorage.setItem(storageKey, defaultValueSeconds);
                    alert("Invalid time format. Please use hh:mm:ss.");
                } else {
                    localStorage.setItem(storageKey, seconds);
                    consoleLog(`${labelText} saved: ${seconds} seconds`);
                }
            });

            const upButton = document.createElement('button');
            upButton.textContent = '▲';
            upButton.style.cssText = "width: 25px; height: 25px; padding: 0; font-size: 10px;";

            const downButton = document.createElement('button');
            downButton.textContent = '▼';
            downButton.style.cssText = "width: 25px; height: 25px; padding: 0; font-size: 10px;";

            const handleArrowClick = (amount) => {
                let currentSeconds = hhmmssToSeconds(timeInput.value);
                currentSeconds += amount;
                if (currentSeconds < 0) currentSeconds = 0;
                timeInput.value = secondsToHHMMSS(currentSeconds);
                timeInput.dispatchEvent(new Event('change'));
            };

            upButton.addEventListener('click', () => handleArrowClick(10));
            downButton.addEventListener('click', () => handleArrowClick(-10));

            const controlsWrapper = document.createElement('div');
            controlsWrapper.style.cssText = "display: flex; align-items: center; gap: 4px; width: 100%;";
            timeInput.style.flexGrow = '1';

            controlsWrapper.appendChild(timeInput);
            controlsWrapper.appendChild(upButton);
            controlsWrapper.appendChild(downButton);

            group.appendChild(label);
            group.appendChild(controlsWrapper);
            return group;
        };

        // Minimum update time
        generalSettingsSection.appendChild(createTimeInputRow({
            labelText: "Minimum Time Between Updates:",
            storageKey: 'otkMinUpdateSeconds',
            defaultValueSeconds: 10,
            idSuffix: 'min-update-time'
        }));

        // Maximum update time
        generalSettingsSection.appendChild(createTimeInputRow({
            labelText: "Maximum Time Between Updates:",
            storageKey: 'otkMaxUpdateSeconds',
            defaultValueSeconds: 300, // 5 minutes
            idSuffix: 'max-update-time'
        }));

        // --- Suspend After Inactive Option ---
        const suspendGroup = document.createElement('div');
        suspendGroup.classList.add('otk-option-row');

        const suspendLabel = document.createElement('label');
        suspendLabel.textContent = "Suspend After Inactivity:";
        suspendLabel.htmlFor = 'otk-suspend-after-inactive-select';
        suspendLabel.style.cssText = "font-size: 12px; text-align: left;";

        const suspendSelect = document.createElement('select');
        suspendSelect.id = 'otk-suspend-after-inactive-select';
        suspendSelect.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align-last: right;";

        const suspendOptions = ["Disabled", "1", "5", "10", "15", "30", "60"];
        suspendOptions.forEach(opt => {
            const optionElement = document.createElement('option');
            optionElement.value = opt;
            optionElement.textContent = opt;
            suspendSelect.appendChild(optionElement);
        });

        suspendSelect.value = localStorage.getItem('otkSuspendAfterInactiveMinutes') || '1';

        suspendSelect.addEventListener('change', () => {
            localStorage.setItem('otkSuspendAfterInactiveMinutes', suspendSelect.value);
            consoleLog(`Suspend after inactive time saved: ${suspendSelect.value}`);
        });

        suspendGroup.appendChild(suspendLabel);
        suspendGroup.appendChild(suspendSelect);
        generalSettingsSection.appendChild(suspendGroup);

        // --- Media Load Mode Option ---
        const mediaLoadModeGroup = document.createElement('div');
        mediaLoadModeGroup.classList.add('otk-option-row');

        const mediaLoadModeLabel = document.createElement('label');
        mediaLoadModeLabel.textContent = "Attached Media Load Mode:";
        mediaLoadModeLabel.htmlFor = 'otk-media-load-mode-select';
        mediaLoadModeLabel.style.cssText = "font-size: 12px; text-align: left;";

        const mediaLoadModeSelect = document.createElement('select');
        mediaLoadModeSelect.id = 'otk-media-load-mode-select';
        mediaLoadModeSelect.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align-last: right;";

        const mediaLoadOptions = [
            { label: 'Source First (Default)', value: 'source_first' },
            { label: 'Cache Only', value: 'cache_only' }
        ];

        mediaLoadOptions.forEach(opt => {
            const optionElement = document.createElement('option');
            optionElement.value = opt.value;
            optionElement.textContent = opt.label;
            mediaLoadModeSelect.appendChild(optionElement);
        });

        mediaLoadModeSelect.value = localStorage.getItem('otkMediaLoadMode') || 'source_first';

        mediaLoadModeSelect.addEventListener('change', () => {
            localStorage.setItem('otkMediaLoadMode', mediaLoadModeSelect.value);
            consoleLog(`Media load mode saved: ${mediaLoadModeSelect.value}`);
            alert('Media loading preference saved. This will take effect for newly rendered messages.');
        });

        mediaLoadModeGroup.appendChild(mediaLoadModeLabel);
        mediaLoadModeGroup.appendChild(mediaLoadModeSelect);
        generalSettingsSection.appendChild(mediaLoadModeGroup);

        // --- Enable Message Number Limiting & Set Value ---
        const initialThemeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};

        const messageLimitGroup = createTimeInputRow({
            labelText: "Message Number Limiting:",
            storageKey: 'otkMessageLimitValue',
            defaultValueSeconds: 500, // This is not seconds, but reusing the function structure
            idSuffix: 'message-limit-value'
        });
        // Adapt the time input row for a simple number input
        const messageLimitValueInput = messageLimitGroup.querySelector('input[type="text"]');
        messageLimitValueInput.type = 'number';
        messageLimitValueInput.placeholder = '';
        messageLimitValueInput.value = initialThemeSettings.otkMessageLimitValue || '500';
        messageLimitValueInput.addEventListener('change', () => {
             const numValue = parseInt(messageLimitValueInput.value, 10);
             if (!isNaN(numValue) && numValue >= 0) {
                 saveThemeSetting('otkMessageLimitValue', String(numValue), true);
             } else {
                 const savedSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
                 messageLimitValueInput.value = savedSettings.otkMessageLimitValue || '500';
             }
        });
        // Remove the hh:mm:ss conversion logic from this specific instance
        const upButton = messageLimitGroup.querySelector('button:nth-of-type(1)');
        const downButton = messageLimitGroup.querySelector('button:nth-of-type(2)');
        upButton.onclick = () => {
            messageLimitValueInput.stepUp(10);
            messageLimitValueInput.dispatchEvent(new Event('change'));
        };
        downButton.onclick = () => {
            messageLimitValueInput.stepDown(10);
            messageLimitValueInput.dispatchEvent(new Event('change'));
        };


        const messageLimitEnableGroup = document.createElement('div');
        messageLimitEnableGroup.classList.add('otk-option-row');

        const messageLimitEnableLabel = document.createElement('label');
        messageLimitEnableLabel.textContent = "Enable Limiting:";
        messageLimitEnableLabel.htmlFor = 'otk-message-limit-enable-checkbox';
        messageLimitEnableLabel.style.cssText = "font-size: 12px; text-align: left;";

        const messageLimitControlsWrapper = document.createElement('div');
        messageLimitControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px; justify-content: flex-end;";

        const messageLimitEnableCheckbox = document.createElement('input');
        messageLimitEnableCheckbox.type = 'checkbox';
        messageLimitEnableCheckbox.id = 'otk-message-limit-enable-checkbox';
        messageLimitEnableCheckbox.style.cssText = "height: 16px; width: 16px;";
        messageLimitEnableCheckbox.checked = initialThemeSettings.otkMessageLimitEnabled !== false;

        messageLimitControlsWrapper.appendChild(messageLimitEnableCheckbox);
        messageLimitEnableGroup.appendChild(messageLimitEnableLabel);
        messageLimitEnableGroup.appendChild(messageLimitControlsWrapper);


        const toggleValueInput = (enabled) => {
            messageLimitValueInput.disabled = !enabled;
            messageLimitValueInput.style.opacity = enabled ? '1' : '0.5';
            upButton.disabled = !enabled;
            downButton.disabled = !enabled;
        };

        messageLimitEnableCheckbox.addEventListener('change', () => {
            const isEnabled = messageLimitEnableCheckbox.checked;
            saveThemeSetting('otkMessageLimitEnabled', isEnabled, true);
            toggleValueInput(isEnabled);
        });

        generalSettingsSection.appendChild(messageLimitGroup);
        generalSettingsSection.appendChild(messageLimitEnableGroup);
        toggleValueInput(messageLimitEnableCheckbox.checked); // Set initial state


        // --- Enable Background Updates Option ---
        const bgUpdateGroup = document.createElement('div');
        bgUpdateGroup.classList.add('otk-option-row');

        const bgUpdateLabel = document.createElement('label');
        bgUpdateLabel.textContent = "Enable Background Updates:";
        bgUpdateLabel.htmlFor = 'otk-enable-bg-update-checkbox';
        bgUpdateLabel.style.cssText = "font-size: 12px; text-align: left;";

        const bgUpdateControlsWrapper = document.createElement('div');
        bgUpdateControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px; justify-content: flex-end;";

        const bgUpdateCheckbox = document.createElement('input');
        bgUpdateCheckbox.type = 'checkbox';
        bgUpdateCheckbox.id = 'otk-enable-bg-update-checkbox';
        bgUpdateCheckbox.style.cssText = "height: 16px; width: 16px;";
        bgUpdateCheckbox.checked = localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) !== 'true';

        bgUpdateCheckbox.addEventListener('change', () => {
            stopBackgroundRefresh();
            if (bgUpdateCheckbox.checked) {
                // If checked, updates are ENABLED
                localStorage.setItem(BACKGROUND_UPDATES_DISABLED_KEY, 'false');
                startBackgroundRefresh(true); // Start immediately
                consoleLog('Background updates enabled via checkbox.');
            } else {
                // If not checked, updates are DISABLED
                if (countdownIntervalId) {
                    clearInterval(countdownIntervalId);
                    countdownIntervalId = null;
                }
                const countdownTimer = document.getElementById('otk-countdown-timer');
                if (countdownTimer) {
                    countdownTimer.textContent = 'n/a';
                }
                localStorage.setItem(BACKGROUND_UPDATES_DISABLED_KEY, 'true');
                consoleLog('Background updates disabled via checkbox.');
            }
        });

        bgUpdateControlsWrapper.appendChild(bgUpdateCheckbox);
        bgUpdateGroup.appendChild(bgUpdateLabel);
        bgUpdateGroup.appendChild(bgUpdateControlsWrapper);
        generalSettingsSection.appendChild(bgUpdateGroup);

        // --- Automatically Load Background Updates Option ---
        const autoLoadGroup = document.createElement('div');
        autoLoadGroup.classList.add('otk-option-row');
        const autoLoadLabel = document.createElement('label');
        autoLoadLabel.textContent = "Automatically Load Background Updates:";
        autoLoadLabel.htmlFor = 'otk-auto-load-updates-checkbox';
        autoLoadLabel.style.cssText = "font-size: 12px; text-align: left;";
        const autoLoadControlsWrapper = document.createElement('div');
        autoLoadControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px; justify-content: flex-end;";
        const autoLoadCheckbox = document.createElement('input');
        autoLoadCheckbox.type = 'checkbox';
        autoLoadCheckbox.id = 'otk-auto-load-updates-checkbox';
        autoLoadCheckbox.style.cssText = "height: 16px; width: 16px;";
        autoLoadCheckbox.checked = localStorage.getItem('otkAutoLoadUpdates') === 'true'; // Default to false
        autoLoadCheckbox.addEventListener('change', () => {
            localStorage.setItem('otkAutoLoadUpdates', autoLoadCheckbox.checked);
        });
        autoLoadControlsWrapper.appendChild(autoLoadCheckbox);
        autoLoadGroup.appendChild(autoLoadLabel);
        autoLoadGroup.appendChild(autoLoadControlsWrapper);
        generalSettingsSection.appendChild(autoLoadGroup);

        // --- Clock Toggle Option ---
        const clockToggleGroup = document.createElement('div');
        clockToggleGroup.classList.add('otk-option-row');

        const clockToggleLabel = document.createElement('label');
        clockToggleLabel.textContent = "Enable Clock:";
        clockToggleLabel.htmlFor = 'otk-clock-toggle-checkbox';
        clockToggleLabel.style.cssText = "font-size: 12px; text-align: left;";

        const clockToggleControlsWrapper = document.createElement('div');
        clockToggleControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px; justify-content: flex-end;";

        const clockToggleCheckbox = document.createElement('input');
        clockToggleCheckbox.type = 'checkbox';
        clockToggleCheckbox.id = 'otk-clock-toggle-checkbox';
        clockToggleCheckbox.style.cssText = "height: 16px; width: 16px;";
        clockToggleCheckbox.checked = localStorage.getItem('otkClockEnabled') === 'true';

        clockToggleCheckbox.addEventListener('change', () => {
            const isEnabled = clockToggleCheckbox.checked;
            localStorage.setItem('otkClockEnabled', isEnabled);
            const clockElement = document.getElementById('otk-clock');
            if (clockElement) {
                clockElement.style.display = isEnabled ? 'flex' : 'none';
                if (isEnabled) {
                    renderClocks(); // Re-render to apply layout
                }
            }
        });

        clockToggleControlsWrapper.appendChild(clockToggleCheckbox);
        clockToggleGroup.appendChild(clockToggleLabel);
        clockToggleGroup.appendChild(clockToggleControlsWrapper);
        generalSettingsSection.appendChild(clockToggleGroup);


        // --- Picture-in-Picture Toggle Option ---
        const pipToggleGroup = document.createElement('div');
        pipToggleGroup.classList.add('otk-option-row');

        const pipToggleLabel = document.createElement('label');
        pipToggleLabel.textContent = "Enable Picture-in-Picture Mode:";
        pipToggleLabel.htmlFor = 'otk-pip-mode-checkbox';
        pipToggleLabel.style.cssText = "font-size: 12px; text-align: left;";

        const pipToggleControlsWrapper = document.createElement('div');
        pipToggleControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px; justify-content: flex-end;";

        const pipToggleCheckbox = document.createElement('input');
        pipToggleCheckbox.type = 'checkbox';
        pipToggleCheckbox.id = 'otk-pip-mode-checkbox';
        pipToggleCheckbox.style.cssText = "height: 16px; width: 16px;";
        pipToggleCheckbox.checked = localStorage.getItem('otkPipModeEnabled') === 'true';

        pipToggleCheckbox.addEventListener('change', () => {
            const isEnabled = pipToggleCheckbox.checked;
            localStorage.setItem('otkPipModeEnabled', isEnabled);
            const pipButton = document.getElementById('otk-pip-btn');
            if (pipButton) {
                pipButton.style.display = isEnabled ? 'inline-block' : 'none';
            }
        });

        pipToggleControlsWrapper.appendChild(pipToggleCheckbox);
        pipToggleGroup.appendChild(pipToggleLabel);
        pipToggleGroup.appendChild(pipToggleControlsWrapper);
        generalSettingsSection.appendChild(pipToggleGroup);


        // --- Debugging Toggle Option ---
        const debugToggleGroup = document.createElement('div');
        debugToggleGroup.classList.add('otk-option-row');

        const debugToggleLabel = document.createElement('label');
        debugToggleLabel.textContent = "Enable Console Debugging:";
        debugToggleLabel.htmlFor = 'otk-debug-mode-checkbox';
        debugToggleLabel.style.cssText = "font-size: 12px; text-align: left;";

        const debugToggleControlsWrapper = document.createElement('div');
        debugToggleControlsWrapper.style.cssText = "display: flex; align-items: center; gap: 8px; justify-content: flex-end;";

        const debugToggleCheckbox = document.createElement('input');
        debugToggleCheckbox.type = 'checkbox';
        debugToggleCheckbox.id = 'otk-debug-mode-checkbox';
        // Specific styling for checkbox
        debugToggleCheckbox.style.cssText = "height: 16px; width: 16px;";
        debugToggleCheckbox.checked = DEBUG_MODE;

        debugToggleCheckbox.addEventListener('change', () => {
            DEBUG_MODE = debugToggleCheckbox.checked;
            localStorage.setItem(DEBUG_MODE_KEY, DEBUG_MODE.toString());
            consoleLog(`Debug mode ${DEBUG_MODE ? 'enabled' : 'disabled'}.`);
            if (DEBUG_MODE) {
                 consoleLog('[OTK Tracker]', `Debug mode explicitly enabled via UI.`);
            }
        });

        debugToggleControlsWrapper.appendChild(debugToggleCheckbox);
        debugToggleGroup.appendChild(debugToggleLabel);
        debugToggleGroup.appendChild(debugToggleControlsWrapper);
        generalSettingsSection.appendChild(debugToggleGroup);

        const resetGeneralSettingsRow = document.createElement('div');
        resetGeneralSettingsRow.classList.add('otk-option-row');
        resetGeneralSettingsRow.style.gridTemplateColumns = '1fr';
        resetGeneralSettingsRow.style.marginTop = '10px';
        const resetGeneralSettingsButton = createTrackerButton("Reset All General Settings to Default");
        resetGeneralSettingsButton.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
        resetGeneralSettingsButton.addEventListener('click', () => {
            if (confirm("Are you sure you want to reset all general settings to default?")) {
                const generalSettingsKeys = [
                    OTK_TRACKED_KEYWORDS_KEY,
                    OTK_BLOCKED_KEYWORDS_KEY,
                    'otkMinUpdateSeconds',
                    'otkMaxUpdateSeconds',
                    'otkSuspendAfterInactiveMinutes',
                    'otkMediaLoadMode',
                    BACKGROUND_UPDATES_DISABLED_KEY,
                    'otkClockEnabled',
                    'otkPipModeEnabled',
                    DEBUG_MODE_KEY,
                    'otkAutoLoadUpdates'
                ];
                generalSettingsKeys.forEach(key => localStorage.removeItem(key));

                // Reflect defaults in UI
                document.getElementById('otk-tracked-keywords-input').value = "otk";
                document.getElementById('otk-blocked-keywords-input').value = "";
                document.getElementById('otk-min-update-time-input').value = secondsToHHMMSS(10);
                document.getElementById('otk-max-update-time-input').value = secondsToHHMMSS(300);
                document.getElementById('otk-suspend-after-inactive-select').value = '1';
                document.getElementById('otk-media-load-mode-select').value = 'source_first';
                const bgUpdateCheckbox = document.getElementById('otk-enable-bg-update-checkbox');
                if(bgUpdateCheckbox) bgUpdateCheckbox.checked = true;
                const autoLoadCheckbox = document.getElementById('otk-auto-load-updates-checkbox');
                if(autoLoadCheckbox) autoLoadCheckbox.checked = false;
                const clockToggleCheckbox = document.getElementById('otk-clock-toggle-checkbox');
                if(clockToggleCheckbox) clockToggleCheckbox.checked = false;
                const pipToggleCheckbox = document.getElementById('otk-pip-mode-checkbox');
                if(pipToggleCheckbox) pipToggleCheckbox.checked = false;
                const debugToggleCheckbox = document.getElementById('otk-debug-mode-checkbox');
                if(debugToggleCheckbox) debugToggleCheckbox.checked = true;

                alert("General settings have been reset to default. Some changes may require a page refresh to take full effect.");
            }
        });
        resetGeneralSettingsRow.appendChild(resetGeneralSettingsButton);
        generalSettingsSection.appendChild(resetGeneralSettingsRow);

        // --- Spacer ---
        const spacerAfterGeneral = document.createElement('div');
        spacerAfterGeneral.style.height = '15px'; // Adjust this value for more or less space
        generalSettingsSection.appendChild(spacerAfterGeneral);


        // --- Theme/Appearance Section ---
        // This section will now be added after the general settings.
        // The 'sectionsContainer' might be redundant if themeSection is the athing in it.
        // Let's append themeSection directly to contentArea as well, after generalSettingsSection.
        const sectionsContainer = document.createElement('div'); // Keep for potential future use if more sections are added here
        mainOptionsPanel.appendChild(sectionsContainer);


        const themeSection = document.createElement('div');
        themeSection.id = 'otk-options-theme-section';
        themeSection.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 2px; /* Space between color option groups */
            padding: 0;
            box-sizing: border-box;
        `;
        // Add a heading for the section (optional)
        const themeOptionsContainer = document.createElement('div');
        themeOptionsContainer.id = 'otk-theme-options-container';
        themeOptionsContainer.style.display = 'flex'; // Always visible
        themeOptionsContainer.style.cssText += `
            display: flex; /* Reiterate, will be toggled */
            flex-direction: column;
            /* gap: 10px; Will be handled by margins/padding of new structure or individual rows */
            box-sizing: border-box; /* Ensure padding is included */
        `;
        themeSection.appendChild(themeOptionsContainer);

        sectionsContainer.appendChild(themeSection); // Add theme section to main content

        document.body.appendChild(optionsWindow);

        // Helper function to create a checkbox option row
        function createCheckboxOptionRow(options) {
            // options = { labelText, storageKey, defaultValue, idSuffix, requiresRerender }
            const group = document.createElement('div');
            group.classList.add('otk-option-row');

            const label = document.createElement('label');
            label.textContent = options.labelText;
            label.htmlFor = `otk-${options.idSuffix}-checkbox`;
            label.style.cssText = `
                font-size: 12px;
                text-align: left;
            `;

            const controlsWrapperDiv = document.createElement('div');
            controlsWrapperDiv.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: flex-end; /* Align checkbox to the right */
                width: 100%;
            `;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `otk-${options.idSuffix}-checkbox`;
            checkbox.style.cssText = `
                height: 16px;
                width: 16px;
                flex-shrink: 0;
            `;

            // Initialize checkbox state from theme settings
            const settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
            const savedValue = settings[options.storageKey];
            checkbox.checked = (savedValue !== undefined) ? savedValue : options.defaultValue;

            checkbox.addEventListener('change', () => {
                saveThemeSetting(options.storageKey, checkbox.checked, options.requiresRerender);
            });

            controlsWrapperDiv.appendChild(checkbox);
            group.appendChild(label);
            group.appendChild(controlsWrapperDiv);
            return group;
        }

        function createImagePickerRow(options) {
            const { labelText, storageKey, idSuffix } = options;

            const row = document.createElement('div');
            row.classList.add('otk-option-row');
            row.style.marginBottom = '5px';

            const label = document.createElement('label');
            label.textContent = labelText;
            label.htmlFor = `otk-${idSuffix}-url-input`;
            label.style.cssText = "font-size: 12px; text-align: left;";

            const controlsWrapper = document.createElement('div');
            controlsWrapper.style.cssText = "display: flex; width: 100%; align-items: center; gap: 8px; min-width: 0;";

            const input = document.createElement('input');
            input.type = 'text';
            input.id = `otk-${idSuffix}-url-input`;
            input.placeholder = 'Enter image URL or browse';
            input.style.cssText = "flex: 1 1 70px; min-width: 50px; height: 25px; box-sizing: border-box; font-size: 12px; text-align: right;";

            const initialUrl = (JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {})[storageKey] || '';
            if (initialUrl.startsWith('data:image')) {
                input.value = '(Local file is selected)';
                input.dataset.fullUrl = initialUrl;
            } else {
                input.value = initialUrl;
            }

            input.addEventListener('input', () => {
                input.dataset.fullUrl = '';
            });

            input.addEventListener('change', () => {
                const valueToSave = input.dataset.fullUrl || input.value;
                saveThemeSetting(storageKey, valueToSave, false);
                applyThemeSettings({ forceRerender: false });
            });

            const browseButton = document.createElement('button');
            browseButton.textContent = "Browse...";
            browseButton.style.cssText = "height: 25px; flex-shrink: 0; padding: 2px 10px; font-size: 11px; box-sizing: border-box; width: 108px;";

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';

            browseButton.addEventListener('click', (e) => {
                e.preventDefault();
                fileInput.click();
            });

            fileInput.addEventListener('change', (event) => {
                const file = event.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const dataUrl = e.target.result;
                        input.value = `(Local file: ${file.name})`;
                        input.dataset.fullUrl = dataUrl;
                        input.dispatchEvent(new Event('change'));
                    };
                    reader.readAsDataURL(file);
                }
            });

            controlsWrapper.appendChild(input);
            controlsWrapper.appendChild(browseButton);
            controlsWrapper.appendChild(fileInput);

            row.appendChild(label);
            row.appendChild(controlsWrapper);

            return row;
        }


        function createDivider() {
            const hr = document.createElement('hr');
            hr.style.cssText = "width: 100%; border: none; border-top: 1px solid #555; margin: 12px 0 8px 0;";
            return hr;
        }

        // Clear existing content from themeOptionsContainer before repopulating
        themeOptionsContainer.innerHTML = '';

        const createCollapsibleSubSection = (title, { isH6 = false, defaultCollapsed = true, parent = themeOptionsContainer } = {}) => {
            const sectionId = `otk-section-${title.toLowerCase().replace(/\s+/g, '-')}`;
            const storageKey = 'otkCollapsibleStates';

            const heading = isH6 ? document.createElement('h6') : createSectionHeading('');
            if (isH6) {
                heading.style.cssText = "margin-top: 20px; margin-bottom: 15px; color: #cccccc; font-size: 12px; font-weight: bold; text-align: left;";
            } else {
                heading.style.marginTop = "10px";
                heading.style.marginBottom = "6px";
            }

            heading.style.position = 'relative';

            const icon = document.createElement('span');
            icon.style.cssText = 'position: absolute; left: 13px; top: 50%; transform: translateY(-50%);';
            heading.textContent = title;
            heading.insertBefore(icon, heading.firstChild);
            heading.style.cursor = 'pointer';

            const content = document.createElement('div');
            content.style.paddingLeft = '0px';
            content.style.width = '100%';
            content.style.boxSizing = 'border-box';

            // Restore state from localStorage
            let states = {};
            try {
                states = JSON.parse(localStorage.getItem(storageKey)) || {};
            } catch (e) { consoleError(e); }
            const isCollapsed = states[sectionId] !== undefined ? states[sectionId] === 'closed' : defaultCollapsed;
            content.style.display = isCollapsed ? 'none' : 'block';
            icon.textContent = isCollapsed ? '► ' : '▼ ';

            heading.addEventListener('click', () => {
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'block' : 'none';
                icon.textContent = isHidden ? '▼ ' : '► ';

                let currentStates = {};
                try {
                    currentStates = JSON.parse(localStorage.getItem(storageKey)) || {};
                } catch (e) { consoleError(e); }
                currentStates[sectionId] = isHidden ? 'open' : 'closed';
                localStorage.setItem(storageKey, JSON.stringify(currentStates));
            });

            parent.appendChild(heading);
            parent.appendChild(content);
            return content;
        };

        // --- GUI Section ---
        const guiSectionContent = createCollapsibleSubSection('GUI', { defaultCollapsed: false });
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "General GUI Text Colour:", storageKey: 'guiTextColor', cssVariable: '--otk-gui-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'gui-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Title Font Colour:", storageKey: 'titleTextColor', cssVariable: '--otk-title-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'title-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Background Colour:", storageKey: 'guiBgColor', cssVariable: '--otk-gui-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'gui-bg' }));

        guiSectionContent.appendChild(createImagePickerRow({
            labelText: 'Background Image URL:',
            storageKey: 'guiBackgroundImageUrl',
            idSuffix: 'gui-bg'
        }));

        guiSectionContent.appendChild(createDropdownRow({
            labelText: 'Background Image Size:',
            storageKey: 'guiBgSize',
            options: ['auto', 'cover', 'contain'],
            defaultValue: 'cover',
            requiresRerender: false
        }));
        guiSectionContent.appendChild(createDropdownRow({
            labelText: 'Background Image Repeat Mode:',
            storageKey: 'guiBgRepeat',
            options: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'],
            defaultValue: 'no-repeat',
            requiresRerender: false
        }));
        guiSectionContent.appendChild(createDropdownRow({
            labelText: 'Background Image Position:',
            storageKey: 'guiBgPosition',
            options: ['center', 'top', 'bottom', 'left', 'right'],
            defaultValue: 'center',
            requiresRerender: false
        }));

        guiSectionContent.appendChild(createColorOrNoneOptionRow({ labelText: "Thread Title Box Outline Colour:", storageKey: 'guiThreadBoxOutlineColor', defaultValue: 'none', idSuffix: 'gui-thread-box-outline' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Thread Titles Text:", storageKey: 'guiThreadListTitleColor', cssVariable: '--otk-gui-threadlist-title-color', defaultValue: '#e0e0e0', inputType: 'color', idSuffix: 'threadlist-title' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Thread Times Text:", storageKey: 'guiThreadListTimeColor', cssVariable: '--otk-gui-threadlist-time-color', defaultValue: '#aaa', inputType: 'color', idSuffix: 'threadlist-time' }));

        guiSectionContent.appendChild(createDropdownRow({
            labelText: 'Thread Time Position:',
            storageKey: 'otkThreadTimePosition',
            options: ['After Title', 'Before Title'],
            defaultValue: 'Before Title',
            requiresRerender: false
        }));

        const dividerSymbolRow = createThemeOptionRow({
            labelText: "Thread Title/Thread Clock Divider:",
            storageKey: 'otkThreadTimeDividerSymbol',
            cssVariable: '--otk-thread-time-divider-symbol',
            defaultValue: '|',
            inputType: 'text',
            idSuffix: 'thread-time-divider-symbol'
        });

        // Customization for the divider row
        const dividerControls = dividerSymbolRow.querySelector('div:last-child');
        const dividerDefaultButton = dividerControls.querySelector('button');
        dividerControls.removeChild(dividerDefaultButton); // Remove the original 'Default' button

        const dividerDropdown = document.createElement('select');
        dividerDropdown.style.cssText = `
            flex-grow: 0;
            flex-shrink: 0;
            height: 25px;
            font-size: 11px;
            box-sizing: border-box;
            width: 108px;
        `;
        const dividerOptions = ['Enabled', 'Disabled', 'Default'];
        dividerOptions.forEach(opt => {
            const optionEl = document.createElement('option');
            optionEl.value = opt.toLowerCase();
            optionEl.textContent = opt;
            dividerDropdown.appendChild(optionEl);
        });

        const dividerInput = dividerSymbolRow.querySelector('input');
        const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        const isDividerEnabled = themeSettings.otkThreadTimeDividerEnabled !== false; // Default to true
        dividerDropdown.value = isDividerEnabled ? 'enabled' : 'disabled';
        dividerInput.disabled = !isDividerEnabled;

        dividerDropdown.addEventListener('change', () => {
            const selected = dividerDropdown.value;
            if (selected === 'default') {
                dividerInput.value = '|';
                saveThemeSetting('otkThreadTimeDividerSymbol', '|', false);
                saveThemeSetting('otkThreadTimeDividerEnabled', true, false);
                dividerInput.disabled = false;
                dividerDropdown.value = 'enabled'; // Revert dropdown to 'Enabled'
            } else {
                const isEnabled = selected === 'enabled';
                saveThemeSetting('otkThreadTimeDividerEnabled', isEnabled, false);
                dividerInput.disabled = !isEnabled;
            }
            renderThreadList();
        });

        dividerControls.appendChild(dividerDropdown);
        guiSectionContent.appendChild(dividerSymbolRow);


        const dividerColorRow = createThemeOptionRow({
            labelText: "Thread Title/Thread Time Divider Colour:",
            storageKey: 'otkThreadTimeDividerColor',
            cssVariable: '--otk-thread-time-divider-color',
            defaultValue: '#ff8040',
            inputType: 'color',
            idSuffix: 'thread-time-divider-color'
        });
        guiSectionContent.appendChild(dividerColorRow);

        if (dividerInput) {
            dividerInput.style.flex = '1 1 70px';
        }

        guiSectionContent.appendChild(createDropdownRow({
            labelText: 'Thread Time Bracket Style:',
            storageKey: 'otkThreadTimeBracketStyle',
            options: ['[]', '()', 'none'],
            defaultValue: '[]',
            requiresRerender: false
        }));

        guiSectionContent.appendChild(createThemeOptionRow({
            labelText: "Thread Time Bracket Colour:",
            storageKey: 'otkThreadTimeBracketColor',
            cssVariable: '--otk-thread-time-bracket-color',
            defaultValue: '#aaa',
            inputType: 'color',
            idSuffix: 'thread-time-bracket-color'
        }));

        guiSectionContent.appendChild(createThemeOptionRow({
            labelText: "Thread Title Animation Speed:",
            storageKey: 'otkThreadTitleAnimationSpeed',
            cssVariable: '--otk-thread-title-animation-speed',
            defaultValue: '1',
            inputType: 'number',
            unit: null,
            min: 0,
            max: 10,
            step: 0.5,
            idSuffix: 'thread-title-animation-speed',
            requiresRerender: false
        }));

        guiSectionContent.appendChild(createDropdownRow({
            labelText: 'Thread Title Animation Direction:',
            storageKey: 'otkThreadTitleAnimationDirection',
            options: ['Up', 'Down'],
            defaultValue: 'Up',
            requiresRerender: false
        }));

        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Thread(s) Stats Font Colour:", storageKey: 'actualStatsTextColor', cssVariable: '--otk-stats-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'actual-stats-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Thread(s) Stats Bullet point Colour:", storageKey: 'statsDashColor', cssVariable: '--otk-stats-dash-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'stats-dash' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Replies Stat Colour:", storageKey: 'repliesStatColor', cssVariable: '--otk-replies-stat-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'replies-stat' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Background Updates Stats Font Colour:", storageKey: 'backgroundUpdatesStatsTextColor', cssVariable: '--otk-background-updates-stats-text-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'background-updates-stats-text' }));

        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Options Icon Colour:", storageKey: 'cogIconColor', cssVariable: '--otk-cog-icon-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'cog-icon' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Background Updates Background Colour:", storageKey: 'countdownBgColor', cssVariable: '--otk-countdown-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'countdown-bg' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Background Updates Main Font Colour:", storageKey: 'countdownLabelTextColor', cssVariable: '--otk-countdown-label-text-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'countdown-label-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Background Updates Timer Font Colour:", storageKey: 'countdownTimerTextColor', cssVariable: '--otk-countdown-timer-text-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'countdown-timer-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Clock(s) Background Colour:", storageKey: 'clockBgColor', cssVariable: '--otk-clock-bg-color', defaultValue: '', inputType: 'color', idSuffix: 'clock-bg' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Clock(s) Font Colour:", storageKey: 'clockTextColor', cssVariable: '--otk-clock-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'clock-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Clock(s) Border Colour:", storageKey: 'clockBorderColor', cssVariable: '--otk-clock-border-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'clock-border' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Clock Divider Colour:", storageKey: 'clockDividerColor', cssVariable: '--otk-clock-divider-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'clock-divider' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Clock Search Background Colour:", storageKey: 'clockSearchBgColor', cssVariable: '--otk-clock-search-bg-color', defaultValue: '#333', inputType: 'color', idSuffix: 'clock-search-bg' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Clock Search Font Colour:", storageKey: 'clockSearchTextColor', cssVariable: '--otk-clock-search-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'clock-search-text' }));

        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Button Background Colour:", storageKey: 'guiButtonBgColor', cssVariable: '--otk-button-bg-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'gui-button-bg' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Button Mouseover Background Colour:", storageKey: 'guiButtonHoverBgColor', cssVariable: '--otk-button-hover-bg-color', defaultValue: '#666666', inputType: 'color', idSuffix: 'gui-button-hover-bg' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Button Clicked Background Colour:", storageKey: 'guiButtonActiveBgColor', cssVariable: '--otk-button-active-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'gui-button-active-bg' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Button Font Colour:", storageKey: 'guiButtonTextColor', cssVariable: '--otk-button-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'gui-button-text' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Button Border Colour:", storageKey: 'guiButtonBorderColor', cssVariable: '--otk-button-border-color', defaultValue: '#777777', inputType: 'color', idSuffix: 'gui-button-border' }));
        guiSectionContent.appendChild(createThemeOptionRow({ labelText: "Bottom Border:", storageKey: 'guiBottomBorderColor', cssVariable: '--otk-gui-bottom-border-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'gui-bottom-border' }));

        function createDropdownRow(options) {
            const group = document.createElement('div');
            group.classList.add('otk-option-row');
            const label = document.createElement('label');
            label.textContent = options.labelText;
            label.style.cssText = "font-size: 12px; text-align: left;";
            const controlsWrapperDiv = document.createElement('div');
            controlsWrapperDiv.style.cssText = "display: flex; width: 100%; align-items: center; gap: 8px; min-width: 0; justify-content: flex-end;";
            const select = document.createElement('select');
            select.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align-last: right;";
            options.options.forEach(opt => {
                const optionElement = document.createElement('option');
                optionElement.value = opt;
                optionElement.textContent = opt;
                select.appendChild(optionElement);
            });
            select.value = (JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {})[options.storageKey] || options.defaultValue;
            select.addEventListener('change', () => {
                saveThemeSetting(options.storageKey, select.value, options.requiresRerender || false);
                if (options.storageKey === 'otkScrollButtonPosition') {
                    applyScrollButtonPosition();
                }
            });
            controlsWrapperDiv.appendChild(select);
            group.appendChild(label);
            group.appendChild(controlsWrapperDiv);
            return group;
        }

        // --- Viewer Section ---
        const viewerSectionContent = createCollapsibleSubSection('Viewer');
        viewerSectionContent.appendChild(createThemeOptionRow({
            labelText: 'Provider and Format for YouTube Fallback:',
            storageKey: 'youtubeFallbackProviderFormat',
            cssVariable: '--otk-youtube-fallback-provider-format',
            defaultValue: 'https://invidious.tiekoetter.com/embed/{videoId}',
            inputType: 'text',
            idSuffix: 'youtube-fallback-provider'
        }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "Viewer Background Colour:", storageKey: 'viewerBgColor', cssVariable: '--otk-viewer-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'viewer-bg' }));
        viewerSectionContent.appendChild(createImagePickerRow({
            labelText: 'Viewer Background Image:',
            storageKey: 'viewerBackgroundImageUrl',
            idSuffix: 'viewer-bg'
        }));
        viewerSectionContent.appendChild(createDropdownRow({
            labelText: 'Viewer Background Image Size:',
            storageKey: 'viewerBgSize',
            options: ['auto', 'cover', 'contain'],
            defaultValue: 'cover',
            requiresRerender: false
        }));
        viewerSectionContent.appendChild(createDropdownRow({
            labelText: 'Viewer Background Image Repeat Mode:',
            storageKey: 'viewerBgRepeat',
            options: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'],
            defaultValue: 'no-repeat',
            requiresRerender: false
        }));
        viewerSectionContent.appendChild(createDropdownRow({
            labelText: 'Viewer Background Image Position:',
            storageKey: 'viewerBgPosition',
            options: ['center', 'top', 'bottom', 'left', 'right'],
            defaultValue: 'center',
            requiresRerender: false
        }));
        viewerSectionContent.appendChild(createColorOrNoneOptionRow({ labelText: "Thread Title Box Outline Colour:", storageKey: 'viewerThreadBoxOutlineColor', defaultValue: 'none', idSuffix: 'viewer-thread-box-outline' }));

        const showNewMessagesGroup = document.createElement('div');
        showNewMessagesGroup.classList.add('otk-option-row');
        const showNewMessagesLabel = document.createElement('label');
        showNewMessagesLabel.textContent = 'Show New Messages Elements:';
        showNewMessagesLabel.style.cssText = "font-size: 12px; text-align: left;";
        const showNewMessagesControlsWrapper = document.createElement('div');
        showNewMessagesControlsWrapper.style.cssText = "display: flex; width: 100%; align-items: center; gap: 8px; min-width: 0; justify-content: flex-end;";
        const showNewMessagesSelect = document.createElement('select');
        showNewMessagesSelect.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align-last: right;";
        ['Show', 'Hide'].forEach(opt => {
            const optionElement = document.createElement('option');
            optionElement.value = opt;
            optionElement.textContent = opt;
            showNewMessagesSelect.appendChild(optionElement);
        });
        showNewMessagesSelect.value = (JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {}).otkShowNewMessagesElements || 'Show';
        showNewMessagesSelect.addEventListener('change', () => {
            saveThemeSetting('otkShowNewMessagesElements', showNewMessagesSelect.value, false);
            applyThemeSettings({ forceRerender: false });
        });
        showNewMessagesControlsWrapper.appendChild(showNewMessagesSelect);
        showNewMessagesGroup.appendChild(showNewMessagesLabel);
        showNewMessagesGroup.appendChild(showNewMessagesControlsWrapper);
        viewerSectionContent.appendChild(showNewMessagesGroup);

        viewerSectionContent.appendChild(createDropdownRow({
            labelText: 'New Messages Indicator Position:',
            storageKey: 'otkNewMessagesSeparatorAlignment',
            options: ['Left', 'Center', 'Right'],
            defaultValue: 'Left',
            requiresRerender: false
        }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "New Messages Indicator Divider Colour:", storageKey: 'newMessagesDividerColor', cssVariable: '--otk-new-messages-divider-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'new-msg-divider' }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "New Messages Indicator Font Size:", storageKey: 'newMessagesFontSize', cssVariable: '--otk-new-messages-font-size', defaultValue: '16px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'new-msg-font-size', requiresRerender: false }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "New Messages Indicator Font Colour:", storageKey: 'newMessagesFontColor', cssVariable: '--otk-new-messages-font-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'new-msg-font' }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "Blocked Content Indicator Font Colour:", storageKey: 'blockedContentFontColor', cssVariable: '--otk-blocked-content-font-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'blocked-content-font' }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "Pinned Message Highlight Colour:", storageKey: 'pinHighlightBgColor', cssVariable: '--otk-pin-highlight-bg-color', defaultValue: '#4a4a3a', inputType: 'color', idSuffix: 'pin-bg', requiresRerender: true }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "Pinned Message Outline Colour:", storageKey: 'pinHighlightBorderColor', cssVariable: '--otk-pin-highlight-border-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'pin-border', requiresRerender: true }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "Next Message Icon Background Colour:", storageKey: 'plusIconBgColor', cssVariable: '--otk-plus-icon-bg-color', defaultValue: '#d9d9d9', inputType: 'color', idSuffix: 'plus-icon-bg-color', requiresRerender: false }));
        viewerSectionContent.appendChild(createThemeOptionRow({ labelText: "Next Message Icon Colour:", storageKey: 'plusIconColor', cssVariable: '--otk-plus-icon-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'plus-icon-color', requiresRerender: false }));

        // --- PiP Mode Section ---
        const pipBgSection = createCollapsibleSubSection('PiP Mode');
        pipBgSection.appendChild(createThemeOptionRow({ labelText: "PiP Mode Background Colour:", storageKey: 'pipBackgroundColor', cssVariable: '--otk-pip-bg-color', defaultValue: '#1a1a1a', inputType: 'color', idSuffix: 'pip-bg' }));
        pipBgSection.appendChild(createImagePickerRow({
            labelText: 'Pip Mode Background Image URL:',
            storageKey: 'pipBackgroundImageUrl',
            idSuffix: 'pip-bg'
        }));
        pipBgSection.appendChild(createDropdownRow({
            labelText: 'PiP Mode Background Image Size:',
            storageKey: 'pipBgSize',
            options: ['auto', 'cover', 'contain'],
            defaultValue: 'cover',
            requiresRerender: false
        }));
        pipBgSection.appendChild(createDropdownRow({
            labelText: 'PiP Mode Background Repeat Mode:',
            storageKey: 'pipBgRepeat',
            options: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'],
            defaultValue: 'no-repeat',
            requiresRerender: false
        }));
        pipBgSection.appendChild(createDropdownRow({
            labelText: 'PiP Mode Background Position:',
            storageKey: 'pipBgPosition',
            options: ['center', 'top', 'bottom', 'left', 'right'],
            defaultValue: 'center',
            requiresRerender: false
        }));

        // --- Image Blurring Section ---
        const imageBlurSection = createCollapsibleSubSection('Image Blur');
        const blurGroup = document.createElement('div');
        blurGroup.classList.add('otk-option-row');

        const blurLabel = document.createElement('label');
        blurLabel.textContent = "Blur Amount (%):";
        blurLabel.htmlFor = `otk-image-blur-amount`;

        const blurControlsWrapper = document.createElement('div');
        blurControlsWrapper.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            justify-content: flex-end;
            width: 100%;
        `;

        const blurInput = document.createElement('input');
        blurInput.type = 'number';
        blurInput.id = 'otk-image-blur-amount';
        blurInput.min = 0;
        blurInput.max = 100;
        blurInput.style.cssText = `
            flex: 1 1 70px;
            min-width: 50px;
            height: 25px;
            box-sizing: border-box;
            font-size: 12px;
            text-align: right;
        `;
        blurInput.value = localStorage.getItem(IMAGE_BLUR_AMOUNT_KEY) || '60';
        blurInput.addEventListener('change', (e) => {
            let value = parseInt(e.target.value, 10);
            if (isNaN(value) || value < 0 || value > 100) {
                value = 60; // reset to default if invalid
            }
            e.target.value = value;
            localStorage.setItem(IMAGE_BLUR_AMOUNT_KEY, value);
            consoleLog(`Image blur amount saved: ${value}%`);
        });

        const blurDefaultBtn = document.createElement('button');
        blurDefaultBtn.textContent = 'Default';
        blurDefaultBtn.style.cssText = `
            flex-grow: 0;
            flex-shrink: 0;
            padding: 2px 6px;
            height: 25px;
            font-size: 11px;
            box-sizing: border-box;
            width: 70px;
        `;
        blurDefaultBtn.addEventListener('click', () => {
            blurInput.value = '60';
            localStorage.setItem(IMAGE_BLUR_AMOUNT_KEY, '60');
            consoleLog(`Image blur amount reset to default: 60%`);
        });

        const clearBlurredBtn = document.createElement('button');
        clearBlurredBtn.textContent = 'Clear All';
        clearBlurredBtn.style.cssText = `
            flex-grow: 0;
            flex-shrink: 0;
            padding: 2px 6px;
            height: 25px;
            font-size: 11px;
            box-sizing: border-box;
            width: 70px;
            background-color: #803333;
            color: white;
        `;
        clearBlurredBtn.onmouseover = () => clearBlurredBtn.style.backgroundColor = '#a04444';
        clearBlurredBtn.onmouseout = () => clearBlurredBtn.style.backgroundColor = '#803333';
        clearBlurredBtn.addEventListener('click', () => {
            if (confirm("Are you sure you want to clear all blurred images? This cannot be undone.")) {
                blurredImages.clear();
                localStorage.removeItem(BLURRED_IMAGES_KEY);
                const allImagesOnPage = document.querySelectorAll('img[data-filehash]');
                allImagesOnPage.forEach(img => {
                    img.style.filter = '';
                });
                consoleLog("Cleared all blurred images.");
                alert("All blurred images have been cleared.");
            }
        });

        blurControlsWrapper.appendChild(blurInput);
        blurControlsWrapper.appendChild(clearBlurredBtn);
        blurControlsWrapper.appendChild(blurDefaultBtn);
        blurGroup.appendChild(blurLabel);
        blurGroup.appendChild(blurControlsWrapper);
        imageBlurSection.appendChild(blurGroup);

        // --- Quick Reply Theming Section ---
        const qrThemingSection = createCollapsibleSubSection('Quick Reply Window');
        qrThemingSection.appendChild(createThemeOptionRow({ labelText: "Header Background Colour:", storageKey: 'qrHeaderBgColor', cssVariable: '--otk-qr-header-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'qr-header-bg' }));
        qrThemingSection.appendChild(createThemeOptionRow({ labelText: "Header Font Colour:", storageKey: 'qrHeaderTextColor', cssVariable: '--otk-qr-header-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'qr-header-text' }));
        qrThemingSection.appendChild(createThemeOptionRow({ labelText: "Background Colour:", storageKey: 'qrBgColor', cssVariable: '--otk-qr-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'qr-bg' }));
        qrThemingSection.appendChild(createThemeOptionRow({ labelText: "Border Colour:", storageKey: 'qrBorderColor', cssVariable: '--otk-qr-border-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'qr-border' }));
        qrThemingSection.appendChild(createThemeOptionRow({ labelText: "Text Area Background Colour:", storageKey: 'qrTextareaBgColor', cssVariable: '--otk-qr-textarea-bg-color', defaultValue: '#222222', inputType: 'color', idSuffix: 'qr-textarea-bg' }));
        qrThemingSection.appendChild(createThemeOptionRow({ labelText: "Text Area Font Colour:", storageKey: 'qrTextareaTextColor', cssVariable: '--otk-qr-textarea-text-color', defaultValue: '#eeeeee', inputType: 'color', idSuffix: 'qr-textarea-text' }));

        // --- Messages (Odds) Section ---
        const oddMessagesSection = createCollapsibleSubSection('Messages (Odds)');
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Header Font Colour:", storageKey: 'msgDepthOddHeaderTextColor', cssVariable: '--otk-msg-depth-odd-header-text-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'msg-depth-odd-header-text', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Header Underline Colour:", storageKey: 'viewerHeaderBorderColorOdd', cssVariable: '--otk-viewer-header-border-color-odd', defaultValue: '#000000', inputType: 'color', idSuffix: 'viewer-header-border-odd', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Content Font Colour:", storageKey: 'msgDepthOddTextColor', cssVariable: '--otk-msg-depth-odd-text-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'msg-depth-odd-text', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Font Size (px):", storageKey: 'msgDepthOddContentFontSize', cssVariable: '--otk-msg-depth-odd-content-font-size', defaultValue: '16px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth-odd-content-fontsize', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Background Colour:", storageKey: 'msgDepthOddBgColor', cssVariable: '--otk-msg-depth-odd-bg-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'msg-depth-odd-bg', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Own Post Background Colour:", storageKey: 'ownMsgBgColorOdd', cssVariable: '--otk-own-msg-bg-color-odd', defaultValue: '#d1e7ff', inputType: 'color', idSuffix: 'own-msg-bg-odd', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Own Post Border Colour:", storageKey: 'ownMsgBorderColorOdd', cssVariable: '--otk-own-msg-border-color-odd', defaultValue: '#c1d7ef', inputType: 'color', idSuffix: 'own-msg-border-odd', requiresRerender: true }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Media Controls BG (Odd):", storageKey: 'mediaControlsBgColorOdd', cssVariable: '--otk-media-controls-bg-color-odd', defaultValue: 'rgba(255, 255, 255, 0.8)', inputType: 'color', idSuffix: 'media-controls-bg-odd' }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Filter Icon:", storageKey: 'blockIconColorOdd', cssVariable: '--otk-block-icon-color-odd', defaultValue: '#999999', inputType: 'color', idSuffix: 'block-icon-odd' }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Pin Icon:", storageKey: 'pinIconColorOdd', cssVariable: '--otk-pin-icon-color-odd', defaultValue: '#666666', inputType: 'color', idSuffix: 'pin-icon-odd' }));
        oddMessagesSection.appendChild(createThemeOptionRow({ labelText: "Pin Icon (Active):", storageKey: 'pinIconColorActiveOdd', cssVariable: '--otk-pin-icon-color-active-odd', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'pin-icon-active-odd' }));

        // --- Messages (Evens) Section ---
        const evenMessagesSection = createCollapsibleSubSection('Messages (Evens)');
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Header Font Colour:", storageKey: 'msgDepthEvenHeaderTextColor', cssVariable: '--otk-msg-depth-even-header-text-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'msg-depth-even-header-text', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Header Underline Colour:", storageKey: 'viewerHeaderBorderColorEven', cssVariable: '--otk-viewer-header-border-color-even', defaultValue: '#777777', inputType: 'color', idSuffix: 'viewer-header-border-even', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Content Font Colour:", storageKey: 'msgDepthEvenTextColor', cssVariable: '--otk-msg-depth-even-text-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'msg-depth-even-text', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Font Size (px):", storageKey: 'msgDepthEvenContentFontSize', cssVariable: '--otk-msg-depth-even-content-font-size', defaultValue: '16px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth-even-content-fontsize', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Background Colour:", storageKey: 'msgDepthEvenBgColor', cssVariable: '--otk-msg-depth-even-bg-color', defaultValue: '#d9d9d9', inputType: 'color', idSuffix: 'msg-depth-even-bg', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Own Post Background Colour:", storageKey: 'ownMsgBgColorEven', cssVariable: '--otk-own-msg-bg-color-even', defaultValue: '#c1d7ef', inputType: 'color', idSuffix: 'own-msg-bg-even', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Own Post Border Colour:", storageKey: 'ownMsgBorderColorEven', cssVariable: '--otk-own-msg-border-color-even', defaultValue: '#c1d7ef', inputType: 'color', idSuffix: 'own-msg-border-even', requiresRerender: true }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Media Controls BG (Even):", storageKey: 'mediaControlsBgColorEven', cssVariable: '--otk-media-controls-bg-color-even', defaultValue: 'rgba(217, 217, 217, 0.8)', inputType: 'color', idSuffix: 'media-controls-bg-even' }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Media Menu Icon Colour:", storageKey: 'mediaMenuIconColor', cssVariable: '--otk-media-menu-icon-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'media-menu-icon' }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Filter Icon:", storageKey: 'blockIconColorEven', cssVariable: '--otk-block-icon-color-even', defaultValue: '#999999', inputType: 'color', idSuffix: 'block-icon-even' }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Pin Icon:", storageKey: 'pinIconColorEven', cssVariable: '--otk-pin-icon-color-even', defaultValue: '#666666', inputType: 'color', idSuffix: 'pin-icon-even' }));
        evenMessagesSection.appendChild(createThemeOptionRow({ labelText: "Pin Icon (Active):", storageKey: 'pinIconColorActiveEven', cssVariable: '--otk-pin-icon-color-active-even', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'pin-icon-active-even' }));
        // --- Misc Section ---
        const miscSectionContent = createCollapsibleSubSection('Misc');
        miscSectionContent.appendChild(createDropdownRow({
            labelText: 'Scroll Button Position:',
            storageKey: 'otkScrollButtonPosition',
            options: ['Default', 'Bottom of Page'],
            defaultValue: 'Default',
            requiresRerender: false
        }));
        miscSectionContent.appendChild(createDropdownRow({
            labelText: 'Tab Title Stats Animation:',
            storageKey: 'tabTitleStatsAnimation',
            options: ['Flash', 'None'],
            defaultValue: 'Flash',
            requiresRerender: false
        }));
        miscSectionContent.appendChild(createThemeOptionRow({
            labelText: "Scroll to Top/Bottom Icon Colour:",
            storageKey: 'scrollTopBottomIconColor',
            cssVariable: '--otk-scroll-top-bottom-icon-color',
            defaultValue: '#FFFFFF',
            inputType: 'color',
            idSuffix: 'scroll-top-bottom-icon'
        }));
        miscSectionContent.appendChild(createThemeOptionRow({
            labelText: "Tab Title Stats Animation Speed:",
            storageKey: 'tabTitleStatsAnimationSpeed',
            defaultValue: '1',
            inputType: 'number',
            unit: null,
            min: 0.1,
            max: 10,
            step: 0.1,
            idSuffix: 'tab-title-stats-animation-speed',
            requiresRerender: false
        }));
        themeOptionsContainer.appendChild(miscSectionContent);

        // --- Options Panel Section ---
        const optionsPanelSection = createCollapsibleSubSection('Options Panel');
        optionsPanelSection.appendChild(createThemeOptionRow({ labelText: "Panel Text:", storageKey: 'optionsTextColor', cssVariable: '--otk-options-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'options-text' }));
        optionsPanelSection.appendChild(createThemeOptionRow({ labelText: "Main Background Colour:", storageKey: 'optionsMainBgColor', cssVariable: '--otk-options-main-bg-color', defaultValue: '#2c2c2c', inputType: 'color', idSuffix: 'options-main-bg', requiresRerender: false }));
        optionsPanelSection.appendChild(createThemeOptionRow({ labelText: "Alternate Background Colour:", storageKey: 'optionsAltBgColor', cssVariable: '--otk-options-alt-bg-color', defaultValue: '#383838', inputType: 'color', idSuffix: 'options-alt-bg', requiresRerender: false }));

        // --- Loading Screen Sub-Section (within Theme) ---
        const loadingScreenSection = createCollapsibleSubSection('Loading Screen');
        loadingScreenSection.appendChild(createThemeOptionRow({ labelText: "Overlay Background Colour:", storageKey: 'loadingOverlayBaseHexColor', cssVariable: '--otk-loading-overlay-base-hex-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'loading-overlay-base-hex' }));
        loadingScreenSection.appendChild(createThemeOptionRow({ labelText: "Overlay Opacity:", storageKey: 'loadingOverlayOpacity', cssVariable: '--otk-loading-overlay-opacity', defaultValue: '0.8', inputType: 'number', min:0.0, max:1.0, step:0.05, idSuffix: 'loading-overlay-opacity' }));
        loadingScreenSection.appendChild(createThemeOptionRow({ labelText: "Font Colour:", storageKey: 'loadingTextColor', cssVariable: '--otk-loading-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-text' }));
        loadingScreenSection.appendChild(createThemeOptionRow({ labelText: "Progress Bar Background colour:", storageKey: 'loadingProgressBarBgColor', cssVariable: '--otk-loading-progress-bar-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'loading-progress-bg' }));
        loadingScreenSection.appendChild(createThemeOptionRow({ labelText: "Progress Bar Fill Colour:", storageKey: 'loadingProgressBarFillColor', cssVariable: '--otk-loading-progress-bar-fill-color', defaultValue: '#4CAF50', inputType: 'color', idSuffix: 'loading-progress-fill' }));
        loadingScreenSection.appendChild(createThemeOptionRow({ labelText: "Progress Bar Font Colour:", storageKey: 'loadingProgressBarTextColor', cssVariable: '--otk-loading-progress-bar-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-progress-text' }));

        const resetAllColorsRow = document.createElement('div');
        resetAllColorsRow.classList.add('otk-option-row');
        resetAllColorsRow.style.gridTemplateColumns = '1fr';
        resetAllColorsRow.style.marginTop = '20px';
        resetAllColorsRow.style.paddingTop = '15px'; // Add padding to the top of the row

        const resetAllColorsButton = createTrackerButton("Reset All Colors to Default");
        resetAllColorsButton.id = 'otk-reset-all-colors-btn';
        resetAllColorsButton.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
        resetAllColorsRow.appendChild(resetAllColorsButton);
        themeOptionsContainer.appendChild(resetAllColorsRow);


        function resetAllThemeSettingsToDefault(promptUser = true) {
            if (promptUser && !confirm("Are you sure you want to reset all theme settings to their defaults?")) {
                return;
            }

            consoleLog("Resetting all theme settings to default...");
            // Clear the active theme settings from localStorage.
            localStorage.removeItem(THEME_SETTINGS_KEY);

            const allOptionConfigs = getAllOptionConfigs();

            allOptionConfigs.forEach(opt => {
                const defaultValue = opt.defaultValue;
                // Set the CSS variable to the default value.
                if (opt.cssVariable) {
                    document.documentElement.style.setProperty(opt.cssVariable, defaultValue);
                }

                // Update the input fields in the options panel to reflect the default values.
                const mainInput = document.getElementById(`otk-${opt.idSuffix}`);
                const hexInput = opt.inputType === 'color' ? document.getElementById(`otk-${opt.idSuffix}-hex`) : null;

                let displayValue = defaultValue;
                if (opt.unit && displayValue.endsWith(opt.unit)) {
                    displayValue = displayValue.replace(opt.unit, '');
                }

                if (mainInput) mainInput.value = displayValue;
                if (hexInput) hexInput.value = displayValue;

                if (opt.storageKey === 'cogIconColor') {
                    const cogIcon = document.getElementById('otk-settings-cog');
                    if (cogIcon) cogIcon.style.color = defaultValue;
                }
            });

            const newBooleanSettings = [
                { key: 'otkMsgDepthOddDisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth-odd-disable-header-underline' },
                { key: 'otkMsgDepthEvenDisableHeaderUnderline', defaultValue: true, idSuffix: 'msg-depth-even-disable-header-underline' }
            ];
            newBooleanSettings.forEach(opt => {
                const checkbox = document.getElementById(`otk-${opt.idSuffix}-checkbox`);
                if (checkbox) {
                    checkbox.checked = opt.defaultValue;
                }
            });

            // The applyThemeSettings() call is no longer needed here if called by the initiator.
            // If called from the reset button, it should call it.
            // Let's call it for the standalone reset case.
            if (promptUser) {
                // No need to call applyThemeSettings() as we have manually set all the properties.
                // Calling it might re-apply old settings from memory before a refresh.
                forceViewerRerenderAfterThemeChange(); // Force a re-render if the viewer is open.
                alert("All theme settings have been reset to their defaults.");
            }
        }

        resetAllColorsButton.addEventListener('click', () => {
            resetAllThemeSettingsToDefault(true); // true to prompt user
        });

        // Event Listeners for cog and close
        const toggleOptionsPanelAndOverlays = (show) => {
            if (show) {
                optionsWindow.style.display = 'flex';
                setTimeout(() => {
                    optionsWindow.style.left = '0';
                }, 10);
            } else {
                optionsWindow.style.left = '-50%';
                setTimeout(() => {
                    if (optionsWindow.style.left === '-50%') {
                        optionsWindow.style.display = 'none';
                    }
                }, 300); // Match CSS transition duration
            }
            consoleLog(`Toggled options window visibility to: ${show}`);
        };

        const cogIcon = document.getElementById('otk-settings-cog');
        if (cogIcon) {
            cogIcon.addEventListener('click', () => {
                const isHidden = optionsWindow.style.display === 'none';
                toggleOptionsPanelAndOverlays(isHidden);
            });
        } else {
            consoleError("Cog icon not found for options window toggle.");
        }

        closeButton.addEventListener('click', () => {
            // Reversion logic for theme preview
            if (prePreviewSettings) {
                consoleLog("[OptionsClose] Reverting to pre-preview settings as options window is closing.");
                localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(prePreviewSettings));
                applyThemeSettings(); // Apply the restored settings

                prePreviewSettings = null; // Clear the stored pre-preview settings
                currentlyPreviewingThemeName = null; // Clear the currently previewing theme name

                // Reset dropdown to "Active Settings"
                const dropdown = document.getElementById('otk-custom-themes-dropdown');
                if (dropdown) {
                    dropdown.value = "__REVERT__";
                }
            } else {
                consoleLog("[OptionsClose] No active preview to revert. Closing options window.");
            }

            toggleOptionsPanelAndOverlays(false);
        });


window.addEventListener('otkMultiQuoteApplied', () => {
    multiQuoteSelections.clear();
    document.querySelectorAll('.otk-multiquote-checkbox-wrapper.selected').forEach(wrapper => {
        wrapper.classList.remove('selected');
        const checkbox = wrapper.querySelector('input');
        if (checkbox) {
            checkbox.checked = false;
        }
    });
    consoleLog('Multi-quote selections have been cleared after being applied.');
});

        consoleLog("Options Window setup complete with drag functionality.");
    }

function renderFilterEditorView(ruleToEdit = null) {
    const rightContent = document.getElementById('otk-filter-content');
    if (!rightContent) return;

    rightContent.innerHTML = ''; // Clear previous content

    const allRules = JSON.parse(localStorage.getItem(FILTER_RULES_V2_KEY) || '[]');
    const isEditing = ruleToEdit ? allRules.some(r => r.id === ruleToEdit.id) : false;

    const rule = ruleToEdit || {
        id: Date.now(),
        category: 'keyword',
        action: 'filterOut',
        matchContent: '',
        replaceContent: '',
        enabled: true
    };

    const form = document.createElement('div');
    form.style.cssText = 'display: flex; flex-direction: column; gap: 10px; height: 100%;';

    // Helper to create a labeled row
    const createRow = (labelText, ...elements) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 10px;';
        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.width = '120px';
        label.style.flexShrink = '0';
        row.appendChild(label);
        elements.forEach(el => row.appendChild(el));
        return row;
    };

    // Category Dropdown
    const categorySelect = document.createElement('select');
    categorySelect.style.flexGrow = '1';
    const categories = [
        { value: 'keyword', text: 'Keyword/Text' },
        { value: 'embeddedLink', text: 'Embedded Link' },
        { value: 'attachedMedia', text: 'Attached Media' },
        { value: 'entireMessage', text: 'Entire Message' }
    ];
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.value;
        option.textContent = cat.text;
        categorySelect.appendChild(option);
    });
    categorySelect.value = rule.category;
    form.appendChild(createRow('Category:', categorySelect));

    // Action Dropdown
    const actionSelect = document.createElement('select');
    actionSelect.style.flexGrow = '1';
    const actions = [
        { value: 'filterOut', text: 'Filter out entire message' },
        { value: 'remove', text: 'Remove matching content only' },
        { value: 'replace', text: 'Replace matching content' }
    ];
    actions.forEach(act => {
        const option = document.createElement('option');
        option.value = act.value;
        option.textContent = act.text;
        actionSelect.appendChild(option);
    });
    actionSelect.value = rule.action;
    form.appendChild(createRow('Action:', actionSelect));

    // Match Content Input
    const matchContentRow = createRow('Match Content:', document.createElement('textarea'));
    const matchContentInput = matchContentRow.querySelector('textarea');
    matchContentInput.placeholder = 'Content to match...';
    matchContentInput.value = rule.matchContent;

    // Make this row and its textarea grow to fill available space
    matchContentRow.style.flexGrow = '1';
    matchContentRow.style.alignItems = 'stretch';
    matchContentInput.style.cssText = 'flex-grow: 1; width: 100%; box-sizing: border-box; resize: vertical; height: 100%;';
    form.appendChild(matchContentRow);

    // Replace Content Input (conditionally displayed)
    const replaceContentRow = createRow('Replace With:', document.createElement('textarea'));
    const replaceContentInput = replaceContentRow.querySelector('textarea');
    replaceContentInput.placeholder = 'Replacement content...';
    replaceContentInput.style.cssText = 'flex-grow: 1; width: 100%; box-sizing: border-box; resize: vertical; height: 60px;';
    replaceContentInput.value = rule.replaceContent;
    form.appendChild(replaceContentRow);

    const toggleReplaceRow = () => {
        replaceContentRow.style.display = actionSelect.value === 'replace' ? 'flex' : 'none';
    };
    actionSelect.addEventListener('change', toggleReplaceRow);
    toggleReplaceRow(); // Initial check

    const saveRuleLogic = () => {
        const newRuleData = {
            id: rule.id,
            category: categorySelect.value,
            action: actionSelect.value,
            matchContent: matchContentInput.value.trim(),
            replaceContent: replaceContentInput.value.trim(),
            enabled: rule.enabled
        };

        if (!newRuleData.matchContent) {
            alert('Match Content cannot be empty.');
            return false;
        }

        let currentRules = JSON.parse(localStorage.getItem(FILTER_RULES_V2_KEY) || '[]');
        const ruleIndex = currentRules.findIndex(r => r.id === rule.id);

        if (ruleIndex > -1) {
            currentRules[ruleIndex] = newRuleData;
        } else {
            currentRules.push(newRuleData);
        }
        localStorage.setItem(FILTER_RULES_V2_KEY, JSON.stringify(currentRules));
        return true;
    };

    // Buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: auto;';

    const saveBtn = createTrackerButton(isEditing ? 'Save Changes' : 'Create Filter');
    saveBtn.addEventListener('click', () => {
        if (saveRuleLogic()) {
            renderFilterList();
        }
    });

    const cancelBtn = createTrackerButton('Cancel');
    cancelBtn.addEventListener('click', () => {
        renderFilterList();
    });

    const saveAndCloseBtn = createTrackerButton(isEditing ? 'Save and Close' : 'Create Filter and Close');
    saveAndCloseBtn.addEventListener('click', () => {
        if (saveRuleLogic()) {
            document.getElementById('otk-filter-window').style.display = 'none';
        }
    });

    buttonContainer.appendChild(cancelBtn);
    buttonContainer.appendChild(saveBtn);
    buttonContainer.appendChild(saveAndCloseBtn);
    form.appendChild(buttonContainer);

    rightContent.appendChild(form);
}
function renderFilterList() {
    const rightContent = document.getElementById('otk-filter-content');
    if (!rightContent) return;
    rightContent.innerHTML = ''; // Clear previous content

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-right: 15px;'; // Add padding for scrollbar

    const checkAllContainer = document.createElement('div');
    checkAllContainer.style.cssText = 'display: flex; align-items: center;';
    const checkAllBox = document.createElement('input');
    checkAllBox.type = 'checkbox';
    checkAllBox.id = 'otk-filter-select-all';
    const checkAllLabel = document.createElement('label');
    checkAllLabel.textContent = 'Select All';
    checkAllLabel.htmlFor = 'otk-filter-select-all';
    checkAllLabel.style.marginLeft = '5px';

    checkAllContainer.appendChild(checkAllBox);
    checkAllContainer.appendChild(checkAllLabel);
    header.appendChild(checkAllContainer);

    const buttonGroup = document.createElement('div');
    buttonGroup.style.cssText = 'display: flex; gap: 10px;';

    const editSelectedBtn = createTrackerButton('Edit Selected');
    editSelectedBtn.id = 'otk-edit-selected-filter-btn';
    editSelectedBtn.style.display = 'none';
    buttonGroup.appendChild(editSelectedBtn);

    const deleteSelectedBtn = createTrackerButton('Delete Selected');
    deleteSelectedBtn.id = 'otk-delete-selected-filters-btn';
    deleteSelectedBtn.style.display = 'none';
    buttonGroup.appendChild(deleteSelectedBtn);

    header.appendChild(buttonGroup);

    rightContent.appendChild(header);

    const ruleListContainer = document.createElement('div');
    ruleListContainer.id = 'otk-filter-rule-list-container';
    ruleListContainer.style.cssText = 'display: flex; flex-direction: column; max-height: 280px; overflow-y: auto; padding-right: 15px;';
    rightContent.appendChild(ruleListContainer);

    const rules = JSON.parse(localStorage.getItem(FILTER_RULES_V2_KEY) || '[]');
    if (rules.length === 0) {
        ruleListContainer.textContent = 'No filter rules saved.';
        return;
    }

    const categoryDisplayMap = {
        keyword: 'Keyword',
        embeddedLink: 'Link',
        attachedMedia: 'Media',
        entireMessage: 'Message'
    };

    const actionDisplayMap = {
        filterOut: 'Filter Out',
        remove: 'Remove',
        replace: 'Replace'
    };

    rules.forEach((rule, index) => {
        const ruleDiv = document.createElement('div');
        ruleDiv.style.cssText = `
            display: grid;
            grid-template-columns: auto 1fr auto;
            align-items: center;
            gap: 10px;
            padding: 10px;
            border-top: 1px solid #444;
            background-color: ${rule.enabled ? '#3a3a3a' : '#2a2a2a'};
        `;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.ruleId = rule.id;
        ruleDiv.appendChild(checkbox);

        const mainContentDiv = document.createElement('div');
        mainContentDiv.style.cssText = 'display: flex; flex-direction: column; gap: 5px; overflow: hidden;';

        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display: flex; align-items: center; gap: 10px;';

        const title = document.createElement('h5');
        const categoryStr = categoryDisplayMap[rule.category] || rule.category;
        const actionStr = actionDisplayMap[rule.action] || rule.action;
        title.textContent = `Filter #${index + 1} (${categoryStr}, ${actionStr})`;
        title.style.cssText = 'margin: 0; font-size: 14px; color: #f0f0f0;';

        headerDiv.appendChild(title);
        mainContentDiv.appendChild(headerDiv);

        const matchContentDiv = document.createElement('div');
        matchContentDiv.style.whiteSpace = 'nowrap';
        matchContentDiv.style.overflow = 'hidden';
        matchContentDiv.style.textOverflow = 'ellipsis';
        matchContentDiv.title = rule.matchContent;

        const strongEl = document.createElement('strong');
        strongEl.textContent = 'Match: ';
        matchContentDiv.appendChild(strongEl);

        const codeSpan = document.createElement('span');
        codeSpan.style.fontFamily = 'monospace';
        codeSpan.style.padding = '2px 4px';
        codeSpan.style.borderRadius = '3px';

        let mediaHashForPopup = null;
        let hoverTarget = null;

        if (rule.category === 'attachedMedia') {
            mediaHashForPopup = rule.matchContent.replace('md5:', '');
            codeSpan.textContent = rule.matchContent;
            hoverTarget = codeSpan;
        } else if (rule.category === 'entireMessage') {
            try {
                const conditions = JSON.parse(rule.matchContent);
                if (conditions.media) {
                    mediaHashForPopup = conditions.media.replace('md5:', '');
                    const mediaValue = conditions.media;
                    const textBefore = rule.matchContent.substring(0, rule.matchContent.indexOf(mediaValue));
                    const textAfter = rule.matchContent.substring(rule.matchContent.indexOf(mediaValue) + mediaValue.length);

                    codeSpan.appendChild(document.createTextNode(textBefore));
                    const hashSpan = document.createElement('span');
                    hashSpan.className = 'otk-media-hash-preview';
                    hashSpan.textContent = mediaValue;
                    hashSpan.style.textDecoration = 'underline';
                    hashSpan.style.cursor = 'pointer';
                    codeSpan.appendChild(hashSpan);
                    codeSpan.appendChild(document.createTextNode(textAfter));
                    hoverTarget = hashSpan;
                } else {
                    codeSpan.textContent = rule.matchContent;
                }
            } catch (e) {
                codeSpan.textContent = rule.matchContent;
            }
        } else {
            codeSpan.textContent = rule.matchContent;
        }

        matchContentDiv.appendChild(codeSpan);
        mainContentDiv.appendChild(matchContentDiv);

        if (hoverTarget && mediaHashForPopup) {
            let thumbnailPopup = null;
            let blobUrl = null;

            const hideThumbnail = () => {
                if (thumbnailPopup) {
                    thumbnailPopup.remove();
                    thumbnailPopup = null;
                }
                if (blobUrl) {
                    URL.revokeObjectURL(blobUrl);
                    blobUrl = null;
                }
            };

            hoverTarget.addEventListener('mouseenter', (e) => {
                hideThumbnail();
                if (!otkMediaDB) return;
                const thumbKey = `${mediaHashForPopup}_thumb`;

                const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                const store = transaction.objectStore('mediaStore');
                const request = store.get(thumbKey);

                request.onsuccess = (event) => {
                    const storedItem = event.target.result;
                    thumbnailPopup = document.createElement('div');
                    thumbnailPopup.id = 'otk-thumbnail-popup';
                    thumbnailPopup.style.cssText = `
                        position: fixed; z-index: 10005; background: #1a1a1a;
                        border: 1px solid #555; border-radius: 3px; padding: 5px;
                        pointer-events: none; max-width: 250px; max-height: 250px;
                    `;
                    if (storedItem && storedItem.blob) {
                        blobUrl = URL.createObjectURL(storedItem.blob);
                        const img = document.createElement('img');
                        img.src = blobUrl;
                        img.style.cssText = 'max-width: 100%; max-height: 100%; display: block;';
                        thumbnailPopup.appendChild(img);
                    } else {
                        thumbnailPopup.textContent = 'Thumbnail not in cache';
                        thumbnailPopup.style.color = '#ccc';
                        thumbnailPopup.style.fontSize = '12px';
                    }
                    document.body.appendChild(thumbnailPopup);
                    thumbnailPopup.style.left = `${e.clientX + 15}px`;
                    thumbnailPopup.style.top = `${e.clientY + 15}px`;
                };
                request.onerror = (event) => consoleError("Error fetching thumbnail for popup:", event.target.error);
            });

            hoverTarget.addEventListener('mouseleave', hideThumbnail);
        }

        if (rule.action === 'replace') {
            const replaceContentDiv = document.createElement('div');
            replaceContentDiv.innerHTML = `<strong>Replace:</strong> <span style="font-family: monospace; padding: 2px 4px; border-radius: 3px;"></span>`;
            replaceContentDiv.querySelector('span').textContent = rule.replaceContent;
            replaceContentDiv.style.whiteSpace = 'nowrap';
            replaceContentDiv.style.overflow = 'hidden';
            replaceContentDiv.style.textOverflow = 'ellipsis';
            replaceContentDiv.title = rule.replaceContent;
            mainContentDiv.appendChild(replaceContentDiv);
        }

        ruleDiv.appendChild(mainContentDiv);

        const toggleSwitch = document.createElement('label');
        toggleSwitch.className = 'otk-switch';
        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.checked = rule.enabled;
        toggleInput.addEventListener('change', () => {
            rule.enabled = toggleInput.checked;
            const updatedRules = JSON.parse(localStorage.getItem(FILTER_RULES_V2_KEY) || '[]');
            const ruleIndex = updatedRules.findIndex(r => r.id === rule.id);
            if (ruleIndex > -1) {
                updatedRules[ruleIndex].enabled = rule.enabled;
                localStorage.setItem(FILTER_RULES_V2_KEY, JSON.stringify(updatedRules));
                ruleDiv.style.backgroundColor = rule.enabled ? '#3a3a3a' : '#2a2a2a';
            }
        });
        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'otk-slider round';
        toggleSwitch.appendChild(toggleInput);
        toggleSwitch.appendChild(toggleSlider);
        ruleDiv.appendChild(toggleSwitch);

        ruleListContainer.appendChild(ruleDiv);
    });

    const checkboxes = Array.from(ruleListContainer.querySelectorAll('input[type="checkbox"][data-rule-id]'));

    const updateBulkActionButtons = () => {
        const checkedCount = checkboxes.filter(cb => cb.checked).length;
        deleteSelectedBtn.style.display = checkedCount > 0 ? 'inline-block' : 'none';
        editSelectedBtn.style.display = checkedCount === 1 ? 'inline-block' : 'none';

        const allChecked = checkboxes.every(cb => cb.checked);
        checkAllBox.checked = checkboxes.length > 0 && allChecked;
    };

    checkboxes.forEach(cb => cb.addEventListener('change', updateBulkActionButtons));

    checkAllBox.addEventListener('change', () => {
        checkboxes.forEach(cb => cb.checked = checkAllBox.checked);
        updateBulkActionButtons();
    });

    deleteSelectedBtn.addEventListener('click', () => {
        if (!confirm('Are you sure you want to delete the selected rules?')) return;
        let currentRules = JSON.parse(localStorage.getItem(FILTER_RULES_V2_KEY) || '[]');
        const idsToDelete = new Set(checkboxes.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.ruleId, 10)));
        const newRules = currentRules.filter(rule => !idsToDelete.has(rule.id));
        localStorage.setItem(FILTER_RULES_V2_KEY, JSON.stringify(newRules));
        renderFilterList();
    });

    editSelectedBtn.addEventListener('click', () => {
        const selectedCheckbox = checkboxes.find(cb => cb.checked);
        if (selectedCheckbox) {
            const ruleId = parseInt(selectedCheckbox.dataset.ruleId, 10);
            const ruleToEdit = rules.find(r => r.id === ruleId);
            if (ruleToEdit) {
                renderFilterEditorView(ruleToEdit);
            }
        }
    });

    if (!document.getElementById('otk-switch-styles')) {
        const style = document.createElement('style');
        style.id = 'otk-switch-styles';
        style.innerHTML = `
            .otk-switch { position: relative; display: inline-block; width: 34px; height: 20px; }
            .otk-switch input { opacity: 0; width: 0; height: 0; }
            .otk-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; }
            .otk-slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 4px; bottom: 4px; background-color: white; transition: .4s; }
            input:checked + .otk-slider { background-color: #4CAF50; }
            input:focus + .otk-slider { box-shadow: 0 0 1px #4CAF50; }
            input:checked + .otk-slider:before { transform: translateX(14px); }
            .otk-slider.round { border-radius: 20px; }
            .otk-slider.round:before { border-radius: 50%; }
        `;
        document.head.appendChild(style);
    }
}

function applyScrollButtonPosition() {
    const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    const position = themeSettings.otkScrollButtonPosition || 'Default';
    const scrollButtonContainer = document.getElementById('otk-scroll-button-container');

    if (scrollButtonContainer) {
        if (position === 'Bottom of Page') {
            scrollButtonContainer.style.top = 'auto';
            scrollButtonContainer.style.bottom = '15px';
        } else { // Default
            scrollButtonContainer.style.top = '95px';
            scrollButtonContainer.style.bottom = 'auto';
        }
    }
}

function getAllOptionConfigs() {
            // Note: labelText is not part of this config object, it's passed directly to createThemeOptionRow.
            // This function is primarily for mapping storageKey, cssVariable, defaultValue, inputType, etc.
            // The spelling change from "Color" to "Colour" happens in the createThemeOptionRow calls.
            return [
                { storageKey: 'guiTextColor', cssVariable: '--otk-gui-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'gui-text' },
                { storageKey: 'guiBgColor', cssVariable: '--otk-gui-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'gui-bg' },
                { storageKey: 'titleTextColor', cssVariable: '--otk-title-text-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'title-text' },
                { storageKey: 'guiThreadListTitleColor', cssVariable: '--otk-gui-threadlist-title-color', defaultValue: '#e0e0e0', inputType: 'color', idSuffix: 'threadlist-title' },
                { storageKey: 'guiThreadListTimeColor', cssVariable: '--otk-gui-threadlist-time-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'threadlist-time' },
                { storageKey: 'actualStatsTextColor', cssVariable: '--otk-stats-text-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'actual-stats-text' },
                { storageKey: 'statsDashColor', cssVariable: '--otk-stats-dash-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'stats-dash' },
                { storageKey: 'backgroundUpdatesStatsTextColor', cssVariable: '--otk-background-updates-stats-text-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'background-updates-stats-text' },
                { storageKey: 'viewerBgColor', cssVariable: '--otk-viewer-bg-color', defaultValue: '#ffd1a4', inputType: 'color', idSuffix: 'viewer-bg' },
                { storageKey: 'guiBottomBorderColor', cssVariable: '--otk-gui-bottom-border-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'gui-bottom-border' },
                // Messages (Odds) - Corresponds to Depth 0, 2, 4...
                { storageKey: 'msgDepthOddContentFontSize', cssVariable: '--otk-msg-depth-odd-content-font-size', defaultValue: '16px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth-odd-content-fontsize'},
                { storageKey: 'msgDepthOddBgColor', cssVariable: '--otk-msg-depth-odd-bg-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'msg-depth-odd-bg' },
                { storageKey: 'msgDepthOddTextColor', cssVariable: '--otk-msg-depth-odd-text-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'msg-depth-odd-text' },
                { storageKey: 'msgDepthOddHeaderTextColor', cssVariable: '--otk-msg-depth-odd-header-text-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'msg-depth-odd-header-text' },
                { storageKey: 'viewerHeaderBorderColorOdd', cssVariable: '--otk-viewer-header-border-color-odd', defaultValue: '#000000', inputType: 'color', idSuffix: 'viewer-header-border-odd' },
                // Messages (Evens) - Corresponds to Depth 1, 3, 5...
                { storageKey: 'msgDepthEvenContentFontSize', cssVariable: '--otk-msg-depth-even-content-font-size', defaultValue: '16px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth-even-content-fontsize'},
                { storageKey: 'msgDepthEvenBgColor', cssVariable: '--otk-msg-depth-even-bg-color', defaultValue: '#d9d9d9', inputType: 'color', idSuffix: 'msg-depth-even-bg' },
                { storageKey: 'msgDepthEvenTextColor', cssVariable: '--otk-msg-depth-even-text-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'msg-depth-even-text' },
                { storageKey: 'msgDepthEvenHeaderTextColor', cssVariable: '--otk-msg-depth-even-header-text-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'msg-depth-even-header-text' },
                { storageKey: 'ownMsgBgColorOdd', cssVariable: '--otk-own-msg-bg-color-odd', defaultValue: '#d1e7ff', inputType: 'color', idSuffix: 'own-msg-bg-odd' },
                { storageKey: 'ownMsgBgColorEven', cssVariable: '--otk-own-msg-bg-color-even', defaultValue: '#c1d7ef', inputType: 'color', idSuffix: 'own-msg-bg-even' },
                { storageKey: 'cogIconColor', cssVariable: '--otk-cog-icon-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'cog-icon' },
                { storageKey: 'disableBgFontColor', cssVariable: '--otk-disable-bg-font-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'disable-bg-font' },
                { storageKey: 'countdownBgColor', cssVariable: '--otk-countdown-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'countdown-bg' },
                { storageKey: 'countdownLabelTextColor', cssVariable: '--otk-countdown-label-text-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'countdown-label-text' },
                { storageKey: 'countdownTimerTextColor', cssVariable: '--otk-countdown-timer-text-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'countdown-timer-text' },
                { storageKey: 'separatorColor', cssVariable: '--otk-separator-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'separator' },
                { storageKey: 'optionsTextColor', cssVariable: '--otk-options-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'options-text' },
                { storageKey: 'newMessagesDividerColor', cssVariable: '--otk-new-messages-divider-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'new-msg-divider' },
                { storageKey: 'newMessagesFontColor', cssVariable: '--otk-new-messages-font-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'new-msg-font' },
                { storageKey: 'newMessagesFontSize', cssVariable: '--otk-new-messages-font-size', defaultValue: '16px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'new-msg-font-size', requiresRerender: false },
                { storageKey: 'blockedContentFontColor', cssVariable: '--otk-blocked-content-font-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'blocked-content-font' },

                // Pin Highlight Colors
                { storageKey: 'pinHighlightBgColor', cssVariable: '--otk-pin-highlight-bg-color', defaultValue: '#ffd1a4', inputType: 'color', idSuffix: 'pin-bg' },
                { storageKey: 'pinHighlightBorderColor', cssVariable: '--otk-pin-highlight-border-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'pin-border' },

                // '+' Icon Background
                { storageKey: 'plusIconBgColor', cssVariable: '--otk-plus-icon-bg-color', defaultValue: '#d9d9d9', inputType: 'color', idSuffix: 'plus-icon-bg-color' },
                { storageKey: 'plusIconColor', cssVariable: '--otk-plus-icon-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'plus-icon-color' },

                // GUI Button Colours
                { storageKey: 'guiButtonBgColor', cssVariable: '--otk-button-bg-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'gui-button-bg' },
                { storageKey: 'guiButtonTextColor', cssVariable: '--otk-button-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'gui-button-text' },
                { storageKey: 'guiButtonBorderColor', cssVariable: '--otk-button-border-color', defaultValue: '#777777', inputType: 'color', idSuffix: 'gui-button-border' },
                { storageKey: 'guiButtonHoverBgColor', cssVariable: '--otk-button-hover-bg-color', defaultValue: '#666666', inputType: 'color', idSuffix: 'gui-button-hover-bg' },
                { storageKey: 'guiButtonActiveBgColor', cssVariable: '--otk-button-active-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'gui-button-active-bg' },

                // Loading Screen Colours
                { storageKey: 'loadingOverlayBaseHexColor', cssVariable: '--otk-loading-overlay-base-hex-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'loading-overlay-base-hex' },
                { storageKey: 'loadingOverlayOpacity', cssVariable: '--otk-loading-overlay-opacity', defaultValue: '1', inputType: 'number', unit: null, min:0.0, max:1.0, step:0.05, idSuffix: 'loading-overlay-opacity' },
                { storageKey: 'loadingTextColor', cssVariable: '--otk-loading-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-text' },
                { storageKey: 'loadingProgressBarBgColor', cssVariable: '--otk-loading-progress-bar-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'loading-progress-bg' },
                { storageKey: 'loadingProgressBarFillColor', cssVariable: '--otk-loading-progress-bar-fill-color', defaultValue: '#4CAF50', inputType: 'color', idSuffix: 'loading-progress-fill' },
                { storageKey: 'loadingProgressBarTextColor', cssVariable: '--otk-loading-progress-bar-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-progress-text' },

                // Clock Colours
                { storageKey: 'clockBgColor', cssVariable: '--otk-clock-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'clock-bg' },
                { storageKey: 'clockTextColor', cssVariable: '--otk-clock-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'clock-text' },
                { storageKey: 'clockBorderColor', cssVariable: '--otk-clock-border-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'clock-border' },
                { storageKey: 'clockSearchBgColor', cssVariable: '--otk-clock-search-bg-color', defaultValue: '#333', inputType: 'color', idSuffix: 'clock-search-bg' },
                { storageKey: 'clockSearchTextColor', cssVariable: '--otk-clock-search-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'clock-search-text' },

                // QR Theming
                { storageKey: 'qrBgColor', cssVariable: '--otk-qr-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'qr-bg' },
                { storageKey: 'qrBorderColor', cssVariable: '--otk-qr-border-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'qr-border' },
                { storageKey: 'qrHeaderBgColor', cssVariable: '--otk-qr-header-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'qr-header-bg' },
                { storageKey: 'qrHeaderTextColor', cssVariable: '--otk-qr-header-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'qr-header-text' },
                { storageKey: 'qrTextareaBgColor', cssVariable: '--otk-qr-textarea-bg-color', defaultValue: '#222222', inputType: 'color', idSuffix: 'qr-textarea-bg' },
                { storageKey: 'qrTextareaTextColor', cssVariable: '--otk-qr-textarea-text-color', defaultValue: '#eeeeee', inputType: 'color', idSuffix: 'qr-textarea-text' },

                // Message Header Icon Colors
                { storageKey: 'blockIconColorOdd', cssVariable: '--otk-block-icon-color-odd', defaultValue: '#999999', inputType: 'color', idSuffix: 'block-icon-odd' },
                { storageKey: 'blockIconColorEven', cssVariable: '--otk-block-icon-color-even', defaultValue: '#999999', inputType: 'color', idSuffix: 'block-icon-even' },
                { storageKey: 'pinIconColorOdd', cssVariable: '--otk-pin-icon-color-odd', defaultValue: '#666666', inputType: 'color', idSuffix: 'pin-icon-odd' },
                { storageKey: 'pinIconColorEven', cssVariable: '--otk-pin-icon-color-even', defaultValue: '#666666', inputType: 'color', idSuffix: 'pin-icon-even' },
                { storageKey: 'pinIconColorActive', cssVariable: '--otk-pin-icon-color-active', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'pin-icon-active' },
                { storageKey: 'mediaControlsBgColorOdd', cssVariable: '--otk-media-controls-bg-color-odd', defaultValue: 'rgba(255, 255, 255, 0.8)', inputType: 'color', idSuffix: 'media-controls-bg-odd' },
                { storageKey: 'mediaControlsBgColorEven', cssVariable: '--otk-media-controls-bg-color-even', defaultValue: 'rgba(217, 217, 217, 0.8)', inputType: 'color', idSuffix: 'media-controls-bg-even' },
                { storageKey: 'mediaMenuIconColor', cssVariable: '--otk-media-menu-icon-color', defaultValue: '#ff8040', inputType: 'color', idSuffix: 'media-menu-icon' },
                { storageKey: 'optionsMainBgColor', cssVariable: '--otk-options-main-bg-color', defaultValue: '#2c2c2c', inputType: 'color', idSuffix: 'options-main-bg' },
                { storageKey: 'optionsAltBgColor', cssVariable: '--otk-options-alt-bg-color', defaultValue: '#383838', inputType: 'color', idSuffix: 'options-alt-bg' },
                { storageKey: 'scrollTopBottomIconColor', cssVariable: '--otk-scroll-top-bottom-icon-color', defaultValue: '#FFFFFF', inputType: 'color', idSuffix: 'scroll-top-bottom-icon' }
            ];
}

function setupFilterWindow() {
    consoleLog("Setting up Filter Window...");

    if (document.getElementById('otk-filter-window')) {
        consoleLog("Filter window already exists.");
        return;
    }

    const filterWindow = document.createElement('div');
    filterWindow.id = 'otk-filter-window';
    filterWindow.style.cssText = `
        position: fixed;
        top: 120px;
        left: 120px;
        width: 900px;
        height: 400px;
        background-color: #2c2c2c;
        border: 1px solid #444;
        border-radius: 5px;
        z-index: 10001;
        display: none;
        flex-direction: column;
        box-shadow: 0 5px 15px rgba(0,0,0,0.5);
        color: var(--otk-options-text-color);
    `;

    const titleBar = document.createElement('div');
    titleBar.style.cssText = `
        padding: 8px 12px;
        background-color: #383838;
        color: #f0f0f0;
        font-weight: bold;
        cursor: move;
        border-bottom: 1px solid #444;
        border-top-left-radius: 5px;
        border-top-right-radius: 5px;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;
    titleBar.textContent = 'Filter Settings';

    const closeButton = document.createElement('span');
    closeButton.innerHTML = '&#x2715;';
    closeButton.style.cssText = 'cursor: pointer; font-size: 16px;';
    closeButton.addEventListener('click', () => {
        filterWindow.style.display = 'none';
    });

    titleBar.appendChild(closeButton);
    filterWindow.appendChild(titleBar);

    let isDragging = false;
    let offsetX, offsetY;

    titleBar.addEventListener('mousedown', (e) => {
        if (e.target === closeButton) return;
        isDragging = true;
        offsetX = e.clientX - filterWindow.offsetLeft;
        offsetY = e.clientY - filterWindow.offsetTop;
        titleBar.style.userSelect = 'none';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            filterWindow.style.left = `${e.clientX - offsetX}px`;
            filterWindow.style.top = `${e.clientY - offsetY}px`;
        }
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        titleBar.style.userSelect = '';
        document.body.style.userSelect = '';
    });

    const mainContent = document.createElement('div');
    mainContent.style.cssText = 'display: flex; flex-grow: 1;';
    filterWindow.appendChild(mainContent);

    const leftMenu = document.createElement('div');
    leftMenu.id = 'otk-filter-menu';
    leftMenu.style.cssText = `
        width: 120px;
        padding: 10px;
        border-right: 1px solid #444;
        display: flex;
        flex-direction: column;
        gap: 10px;
    `;
    mainContent.appendChild(leftMenu);

    const rightContent = document.createElement('div');
    rightContent.id = 'otk-filter-content';
    rightContent.style.cssText = 'padding: 10px; flex-grow: 1; display: flex; flex-direction: column;';
    mainContent.appendChild(rightContent);

    // ... (rest of the setupFilterWindow code remains unchanged, including the titleBar, closeButton, mainContent, leftMenu, rightContent, dragging logic, etc.)

    const filterListBtn = createTrackerButton('Filter List');
    filterListBtn.addEventListener('click', renderFilterList);
    leftMenu.appendChild(filterListBtn);

    const newFilterBtn = createTrackerButton('New Filter');
    newFilterBtn.addEventListener('click', () => renderFilterEditorView());
    leftMenu.appendChild(newFilterBtn);

    const closeMenuBtn = createTrackerButton('Close');
    closeMenuBtn.addEventListener('click', () => {
        filterWindow.style.display = 'none';
    });
    leftMenu.appendChild(closeMenuBtn);

    document.body.appendChild(filterWindow);
    consoleLog("Filter Window setup complete.");
}




    // --- Initial Actions / Main Execution ---
    function applyDefaultSettings() {
        const defaults = {
            "otkTrackedKeywords": "otk",
            "otkSuspendAfterInactiveMinutes": 30,
            "otkMediaLoadMode": "source_first",
            "otkBackgroundUpdatesDisabled": false,
            "otkClockEnabled": true,
            "otkPipModeEnabled": true,
            "otkDebugModeEnabled": false,
            "otkThemeSettings": {
                "guiBackgroundImageUrl": "https://image2url.com/images/1761529475654-4c7bfbea-a390-4b5e-aef2-07667b77c17d.jpeg",
                "countdownLabelTextColor": "#ffffff",
                "pipBackgroundColor": "#1a1a1a",
                "viewerBackgroundImageUrl": "",
                "guiBgRepeat": "repeat",
                "guiBgSize": "cover",
                "viewerBgRepeat": "repeat-x",
                "viewerBgSize": "contain",
                "clockCogIconColor": "#ff8040",
                "clockCogColor": "#FFD700",
                "cogIconColor": "#FFD700",
                "guiThreadListTimeColor": "#ffffff",
                "msgDepth0TextColor": null,
                "msgDepth0HeaderTextColor": null,
                "viewerHeaderBorderColor": null,
                "otkThreadTimePosition": "Before Title",
                "otkThreadTimeDividerEnabled": true,
                "otkThreadTimeDividerSymbol": "|",
                "separatorColor": "#ff0505",
                "otkThreadTimeDividerColor": "#ff8040",
                "otkMaxUpdateSeconds": "4",
                "otkThreadTimeBracketStyle": "none",
                "otkNewMessagesSeparatorAlignment": "Left",
                "blockedContentFontColor": "#a60c0c",
                "msgDepth1BgColor": null,
                "msgDepth2plusBgColor": null,
                "guiThreadBoxOutlineColor": "#919191",
                "viewerMessageOutlineColor": "#ff8040",
                "viewerThreadBoxOutlineColor": "#919191",
                "plusIconBgColor": "#ffffff",
                "otkThreadTitleAnimationSpeed": "1.5",
                "qrBgColor": "#ffd1a4",
                "qrBorderColor": "#ff8000",
                "qrTextareaBgColor": "#ffffff",
                "qrTextareaTextColor": "#000000",
                "pinHighlightBgColor": "#ff8040",
                "qrHeaderBgColor": "#000000",
                "qrHeaderTextColor": "#ffffff",
                "loadingProgressBarFillColor": "#ff8000",
                "guiButtonActiveBgColor": "#ff8040",
                "ownMsgBgColorOdd": "#fce573",
                "ownMsgBgColorEven": "#fce573",
                "otkThreadTitleAnimationDirection": "Down"
            },
            "otkThreadTitleColors": [
                "#e6194B", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#008080", "#e6beff", "#912499", "#800000", "#aaffc3", "#cbcb25", "#000075", "#ffffff"
            ],
            "otkClockPosition": {
                "top": "71px",
                "left": "1284px"
            },
            "otkCountdownPosition": {
                "top": "-5px",
                "left": "1522px"
            },
            "otkClocks": [
                { "id": 1756699206552, "timezone": "America/Chicago", "displayPlace": "Austin" },
                { "id": 1756699263949, "timezone": "America/Los_Angeles", "displayPlace": "Los Angeles" }
            ]
        };

        Object.keys(defaults).forEach(key => {
            if (localStorage.getItem(key) === null) {
                let valueToSet = defaults[key];
                if (typeof valueToSet === 'object') {
                    valueToSet = JSON.stringify(valueToSet);
                }
                localStorage.setItem(key, valueToSet);
            }
        });
        console.log("Default settings applied if not already present.");
    }


function setupTitleObserver() {
    const totalMessagesNode = document.getElementById('otk-total-messages-stat');

    if (!totalMessagesNode) {
        consoleWarn('[TitleObserver] Could not find the total messages stat node for title updates.');
        return;
    }

    const observer = new MutationObserver(() => {
        if (typeof updateTabTitle === 'function') updateTabTitle();
    });
    const observerConfig = { childList: true, subtree: true, characterData: true };
    observer.observe(totalMessagesNode, observerConfig);
    if (typeof updateTabTitle === 'function') updateTabTitle();
}

function setupScrollButtons() {
    const scrollTopButton = document.getElementById('otk-scroll-top-btn');
    const scrollBottomButton = document.getElementById('otk-scroll-bottom-btn');

    scrollTopButton.addEventListener('click', () => {
        const messagesContainer = document.getElementById('otk-messages-container');
        if (messagesContainer) {
            messagesContainer.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });

    scrollBottomButton.addEventListener('click', () => {
        const messagesContainer = document.getElementById('otk-messages-container');
        if (messagesContainer) {
            messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
        }
    });
}

    async function main() {
        applyDefaultSettings();
        // Ensure default animation speed is set on first run
        let settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        if (settings.otkThreadTitleAnimationSpeed === undefined) {
            settings.otkThreadTitleAnimationSpeed = '1';
            localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(settings));
            consoleLog("Initialized default animation speed to 1.");
        }

        // Migration: Remove old filter rules key if it exists
        if (localStorage.getItem('otkFilterRules')) {
            localStorage.removeItem('otkFilterRules');
            consoleLog('[Migration] Removed outdated otkFilterRules from localStorage.');
        }

        // Clock data migration
        if (!localStorage.getItem('otkClocks')) {
            const oldTimezone = localStorage.getItem('otkClockTimezone');
            const oldDisplayPlace = localStorage.getItem('otkClockDisplayPlace');
            let initialClocks = [];
            if (oldTimezone) {
                initialClocks.push({
                    id: Date.now(),
                    timezone: oldTimezone,
                    displayPlace: oldDisplayPlace || oldTimezone.split('/').pop().replace(/_/g, ' ')
                });
            } else {
                // Default clock if no old settings exist
                initialClocks.push({
                    id: Date.now(),
                    timezone: 'America/Chicago',
                    displayPlace: 'Chicago'
                });
            }
            localStorage.setItem('otkClocks', JSON.stringify(initialClocks));
            consoleLog('Clock settings migrated to new multi-clock format.');
        }

        consoleLog("Starting OTK Thread Tracker script (v2.8)...");

        try {
            const storedBlurred = JSON.parse(localStorage.getItem(BLURRED_IMAGES_KEY));
            if (Array.isArray(storedBlurred)) {
                blurredImages = new Set(storedBlurred);
            }
            consoleLog(`Loaded ${blurredImages.size} blurred image hashes.`);
        } catch (e) {
            consoleError("Error parsing blurred images from localStorage:", e);
            blurredImages = new Set();
        }

        try {
            const storedBlocked = JSON.parse(localStorage.getItem(BLOCKED_THREADS_KEY));
            if (Array.isArray(storedBlocked)) {
                blockedThreads = new Set(storedBlocked);
            }
            consoleLog(`Loaded ${blockedThreads.size} blocked thread hashes.`);
        } catch (e) {
            consoleError("Error parsing blocked threads from localStorage:", e);
            blockedThreads = new Set();
        }

        loadUserPostIds();

        // Inject CSS for anchored messages
        const styleElement = document.createElement('style');
        styleElement.textContent = `
            :root {
                --otk-clock-cog-color: #FFD700;
                --otk-clock-bg-color: #181818;
                --otk-clock-text-color: #e6e6e6;
                --otk-clock-border-color: #181818;
                --otk-clock-search-bg-color: #333;
                --otk-clock-search-text-color: #e6e6e6;
                --otk-countdown-bg-color: #181818;
                --otk-gui-bg-color: #181818;
                --otk-gui-text-color: #e6e6e6; /* General text in the main GUI bar */
                --otk-options-text-color: #e6e6e6; /* For text within the options panel */
                --otk-title-text-color: #ff8040; /* Default for main title */
                --otk-stats-text-color: #e6e6e6; /* For the actual stats text numbers in GUI bar */
                --otk-stats-dash-color: #FFD700; /* For the dashes in the stats display */
                --otk-background-updates-stats-text-color: #FFD700; /* For the 'new' stats text */
                --otk-viewer-bg-color: #ffd1a4;
                --otk-gui-threadlist-title-color: #e0e0e0;
                --otk-gui-threadlist-time-color: #FFD700;
                /* Message Styles (Odd Depths: 0, 2, 4...) */
                --otk-msg-depth-odd-content-font-size: 16px;
                --otk-msg-depth-odd-bg-color: #ffffff;
                --otk-msg-depth-odd-text-color: #333333;
                --otk-msg-depth-odd-header-text-color: #555555;
                --otk-viewer-header-border-color-odd: #000000;

                /* Message Styles (Even Depths: 1, 3, 5...) */
                --otk-own-msg-bg-color-odd: #d1e7ff;
                --otk-own-msg-bg-color-even: #c1d7ef;
                --otk-msg-depth-even-content-font-size: 16px;
                --otk-msg-depth-even-bg-color: #d9d9d9;
                --otk-msg-depth-even-text-color: #333333;
                --otk-msg-depth-even-header-text-color: #555555;
                --otk-viewer-header-border-color-even: #777777;

                --otk-viewer-message-font-size: 13px; /* Default font size for message text - remains common */
                --otk-gui-bottom-border-color: #ff8040; /* Default for GUI bottom border - remains common */
                --otk-cog-icon-color: #FFD700; /* Default for settings cog icon */
                --otk-disable-bg-font-color: #ff8040; /* Default for "Disable Background Updates" text */
                --otk-countdown-timer-text-color: #ff8040; /* Default for countdown timer text */
                --otk-new-messages-divider-color: #000000; /* Default for new message separator line */
                --otk-new-messages-font-color: #000000; /* Default for new message separator text */
                --otk-new-messages-font-size: 16px;

                /* New Depth-Specific Content Font Sizes */
                --otk-msg-depth0-content-font-size: 16px;
                --otk-msg-depth1-content-font-size: 16px;
                --otk-msg-depth2plus-content-font-size: 16px;

                /* GUI Button Colors */
                --otk-button-bg-color: #555;
                --otk-button-text-color: white;
                --otk-button-border-color: #777;
                --otk-button-hover-bg-color: #666;
                --otk-button-active-bg-color: #444444; /* Ensured hex */

                /* Loading Screen Colors */
                --otk-loading-overlay-base-hex-color: #000000; /* Hex base for overlay */
                --otk-loading-overlay-opacity: 1.0;
                --otk-loading-text-color: #ffffff; /* Hex for white */
                --otk-loading-progress-bar-bg-color: #333333; /* Hex for dark grey */
                --otk-loading-progress-bar-fill-color: #4CAF50; /* Already hex */
                --otk-loading-progress-bar-text-color: #ffffff; /* Hex for white */
                /* Add more variables here as they are identified */

                /* Anchor Highlight Colors */
                --otk-pin-highlight-bg-color: #ffd1a4;    /* Default: dark yellow/greenish */
                --otk-pin-highlight-border-color: #000000; /* Default: gold */

                /* Icon Colors */
                --otk-plus-icon-bg-color: #d9d9d9;
                --otk-plus-icon-color: #000000;
                --otk-resize-icon-color: #000000;
                --otk-resize-icon-bg-color: #d9d9d9;
                --otk-blur-icon-color: #000000;
                --otk-blur-icon-bg-color: #d9d9d9;
                --otk-blocked-content-font-color: #e6e6e6;

                /* QR Theming */
                --otk-qr-bg-color: #333333;
                --otk-qr-border-color: #555555;
                --otk-qr-header-bg-color: #444444;
                --otk-qr-header-text-color: #ffffff;
                --otk-qr-textarea-bg-color: #222222;
                --otk-qr-textarea-text-color: #eeeeee;

                /* Message Header Icon Colors */
                --otk-block-icon-color-odd: #999999;
                --otk-block-icon-color-even: #999999;
                --otk-pin-icon-color-odd: #666666;
                --otk-pin-icon-color-even: #666666;
                --otk-pin-icon-color-active-odd: #ffffff;
                --otk-pin-icon-color-active-even: #ffffff;
                --otk-media-controls-bg-color-odd: rgba(255, 255, 255, 0.8);
                --otk-media-controls-bg-color-even: rgba(217, 217, 217, 0.8);
                --otk-media-menu-icon-color: #ff8040;
                --otk-options-main-bg-color: #2C2C2C;
                --otk-options-alt-bg-color: #383838;
                --otk-replies-stat-color: #ff8040;
                --otk-scroll-top-bottom-icon-color: #FFFFFF;
            }

            /* Refined Chrome Scrollbar Styling for Overlay Effect */
            #otk-messages-container::-webkit-scrollbar {
                width: 8px; /* Thinner for a more subtle overlay appearance */
            }

            #otk-messages-container::-webkit-scrollbar-track {
                background: transparent; /* Make track transparent for overlay effect */
            }

            #otk-messages-container::-webkit-scrollbar-thumb {
                background-color: var(--otk-stats-text-color, #888); /* Use a theme variable, fallback to #888 */
                border-radius: 4px; /* Slightly smaller radius for a thinner bar */
                /* The border creates a visual separation from content, enhancing overlay feel */
                border: 2px solid transparent; /* Keep border transparent initially */
                background-clip: padding-box; /* Ensures background doesn't go under the border */
            }

            #otk-messages-container::-webkit-scrollbar-thumb:hover {
                background-color: #aaa; /* Lighter on hover for better visibility */
                border-color: var(--otk-viewer-bg-color, #181818); /* Show border matching background on hover */
            }
            /* Make scrollbar visible only when scrolling or hovering over the container */
            /* This is harder to achieve with pure CSS for ::-webkit-scrollbar if not natively supported by OS/Browser settings */
            /* The transparent track and subtle thumb provide a good approximation. */
            /* True auto-hide on non-interaction often requires JavaScript or browser/OS support for overlay scrollbars. */

            /* Placeholder styling */
            #otk-custom-theme-name-input::placeholder {
                text-align: center;
            }

            /* GUI Button States */
            .otk-button--hover {
                background-color: var(--otk-button-hover-bg-color) !important;
            }
            .otk-button--active {
                background-color: var(--otk-button-active-bg-color) !important;
            }

            .image-wrapper:not(:hover) .blur-icon {
                display: none;
            }

            #otk-clock-search-icon {
                display: none;
            }
            #otk-clock:hover #otk-clock-search-icon {
                display: inline-block;
            }
            .${PINNED_MESSAGE_CLASS} {
                background-color: var(--otk-pin-highlight-bg-color) !important;
                border: 1px solid var(--otk-pin-highlight-border-color) !important;
                /* Add other styles if needed, e.g., box-shadow */
            }

            .otk-pin-icon {
                visibility: hidden; /* Hidden by default, visibility is controlled by JS */
                cursor: pointer;
                margin-left: 8px; /* Space between icons */
                vertical-align: middle;
            width: 18px;
            height: 18px;
                transition: color 0.2s ease-in-out; /* Transition color now */
            }

            /* Block Icon Colors */
            .otk-message-depth-odd .block-icon {
                color: var(--otk-block-icon-color-odd);
            }
            .otk-message-depth-even .block-icon {
                color: var(--otk-block-icon-color-even);
            }

            /* Pin Icon Colors */
            .otk-message-depth-odd .otk-pin-icon {
                color: var(--otk-pin-icon-color-odd);
            }
            .otk-message-depth-even .otk-pin-icon {
                color: var(--otk-pin-icon-color-even);
            }
            .otk-message-depth-odd.${PINNED_MESSAGE_CLASS} > div:first-child .otk-pin-icon {
                color: var(--otk-pin-icon-color-active-odd);
            }
            .otk-message-depth-even.${PINNED_MESSAGE_CLASS} > div:first-child .otk-pin-icon {
                color: var(--otk-pin-icon-color-active-even);
            }
                .otk-youtube-embed-wrapper.otk-embed-inline {
                    /* max-width and margins are now controlled by inline styles in createYouTubeEmbedElement */
                    /* This class can be used for other common styles for these embeds if needed */
                }

            /* --- Picture-in-Picture (PiP) Mode --- */
            #otk-resize-handle {
                position: fixed;
                top: 86px; /* Align with bottom of GUI */
                left: 50vw; /* Initial position, will be updated by JS */
                width: 5px;
                height: calc(100% - 86px);
                background-color: #888;
                cursor: col-resize;
                z-index: 10000; /* Above viewer, below options windows */
            }

            /* Class added to body during resize drag to prevent text selection */
            .otk-resizing {
                user-select: none;
                -webkit-user-select: none; /* For Safari */
            }

            /* Multi-Quote Checkbox Styling */
            .otk-multiquote-checkbox-wrapper {
                display: inline-block;
                margin-left: 8px;
                visibility: hidden; /* Hidden by default */
            }
            .otk-multiquote-checkbox-wrapper.visible,
            .otk-multiquote-checkbox-wrapper.selected {
                visibility: visible;
            }
            .otk-multiquote-checkbox {
                vertical-align: middle;
            }

            /* Quick Reply Theming */
            #quickReply {
                background-color: var(--otk-qr-bg-color) !important;
                border: 1px solid var(--otk-qr-border-color) !important;
            }
            #quickReply .move, #qrHeader, #quickReply > div:first-child { /* Header */
                background-color: var(--otk-qr-header-bg-color) !important;
                color: var(--otk-qr-header-text-color) !important;
            }
            #quickReply .move a, #qrHeader a, #quickReply > div:first-child a { /* Header links */
                color: var(--otk-qr-header-text-color) !important;
            }
            #quickReply textarea[name="com"] {
                background-color: var(--otk-qr-textarea-bg-color) !important;
                color: var(--otk-qr-textarea-text-color) !important;
            }
            .otk-option-row {
                display: grid;
                grid-template-columns: 240px 1fr;
                gap: 8px;
                align-items: center;
                padding: 4px 30px 4px 30px;
                margin: 0;
                width: 100%;
                box-sizing: border-box;
            }
            .otk-option-row > label {
                white-space: nowrap;
            }
            .otk-option-row {
                background-color: var(--otk-options-main-bg-color);
            }
            .otk-option-row:nth-child(even) {
                background-color: var(--otk-options-alt-bg-color);
                border-radius: 4px;
            }
            @keyframes otk-flash {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        `;
        document.head.appendChild(styleElement);
        consoleLog("Injected CSS for anchored messages and multi-quote.");

        await applyMainTheme();
        setupOptionsWindow(); // Call to create the options window shell and event listeners
        setupFilterWindow();
        applyThemeSettings(); // Apply any saved theme settings

            // Explicitly set the scroll icon color from storage, falling back to the default if not set.
            const themeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
            const scrollIconColor = themeSettings.scrollTopBottomIconColor || '#FFFFFF';
            document.documentElement.style.setProperty('--otk-scroll-top-bottom-icon-color', scrollIconColor);

        applyScrollButtonPosition();
        await fetchTimezones();
        setupTimezoneSearch();

        consoleLog('Attempting to call setupLoadingScreen...');
        setupLoadingScreen(); // Create loading screen elements early
        consoleLog('Call to setupLoadingScreen finished.');
        ensureViewerExists(); // Ensure viewer div is in DOM early

        // Note: mediaIntersectionObserver itself is initialized within renderMessagesInViewer

        try {
            consoleLog("Main function start.");
            await initDB();
                consoleLog("IndexedDB initialization attempt complete.");
                messagesByThreadId = await loadMessagesFromDB();
                consoleLog("messagesByThreadId after load:", messagesByThreadId);



                // Recalculate and display initial media stats
                await recalculateAndStoreMediaStats(); // This updates localStorage
                updateDisplayedStatistics(); // This reads from localStorage and updates GUI
                consoleLog("Stats updated.");

                // Restore viewer state
                if (localStorage.getItem(VIEWER_OPEN_KEY) === 'true' && otkViewer) {
                    otkViewer.classList.add('otk-message-layout-default');
                    otkViewer.classList.remove('otk-message-layout-newdesign');
                    consoleLog('Viewer state restored to open. Layout class applied. Rendering all messages.');
                    otkViewer.style.display = 'block';
            if (scrollButtonContainer) scrollButtonContainer.style.display = 'flex';
                    document.body.style.overflow = 'hidden';
                    renderMessagesInViewer({isToggleOpen: true}); // Auto-populate with all messages
                }


                // Load initial data and render list (stats are already updated)
                renderThreadList();
                updateDisplayedStatistics(); // Already called after recalculate

                // Background refresh is no longer started automatically on page load.
                // It is started by clicking "Refresh Data" or by unchecking "Disable Background Updates".
                if (localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) !== 'true') {
                    consoleLog("Background updates are enabled, initiating first check.");
                    startBackgroundRefresh();
                } else {
                    consoleLog("Background updates are disabled by user preference.");
                    const countdownTimer = document.getElementById('otk-countdown-timer');
                    if (countdownTimer) {
                        countdownTimer.textContent = 'n/a';
                    }
                }

                consoleLog("OTK Thread Tracker script initialized and running.");
                const observer = new MutationObserver((mutationsList, observer) => {
                    for(const mutation of mutationsList) {
                        if (mutation.type === 'childList') {
                            const statsWrapper = document.getElementById('otk-stats-wrapper');
                            if (statsWrapper) {
                                createStatsDisplayElements(statsWrapper);
                                observer.disconnect(); // We found it, no need to observe anymore
                            }
                        }
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });


                setupTitleObserver();
        setupScrollButtons();

            } catch (error) {
                consoleError("Critical error during main initialization sequence:", error);
                const errorDisplay = document.getElementById('otk-thread-title-display');
                if (errorDisplay) {
                    errorDisplay.textContent = "Tracker Error! Check Console.";
                    errorDisplay.style.color = "red";
                }
            }
        }

        startAutoEmbedReloader();
        startSuspensionChecker();

        async function renderSettingsManagementPanel() {
    const panel = document.getElementById('otk-settings-management-panel');
    if (!panel) return;

    panel.innerHTML = ''; // Clear existing content

    // --- Dynamic Profiles Section ---
    const profilesContainer = document.createElement('div');
    profilesContainer.id = 'otk-profiles-container';
    // This container is for the list of saved profiles. It's added before the static buttons.
    panel.appendChild(profilesContainer);

    try {
        const profiles = await GM.getValue('otkSettingsProfiles', {});
        const profileNames = Object.keys(profiles);

        if (profileNames.length > 0) {
            profilesContainer.innerHTML = ''; // Clear any previous content

            profileNames.forEach(profileName => {
                // The rendering for each profile is also wrapped in a try-catch
                try {
                    const profileRow = document.createElement('div');
                    profileRow.classList.add('otk-option-row');
                    profileRow.style.display = 'flex';
                    profileRow.style.alignItems = 'center';
                    profileRow.style.gap = '10px';

                    const themeSettings = JSON.parse(profiles[profileName][THEME_SETTINGS_KEY] || '{}');
                    const viewerBg = themeSettings.viewerBgColor || '#181818';
                    const oddMsgBg = themeSettings.ownMsgBgColorOdd || '#d1e7ff';
                    const evenMsgBg = themeSettings.ownMsgBgColorEven || '#c1d7ef';

                    const colorBar = document.createElement('div');
                    colorBar.style.cssText = `
                        flex-grow: 1; height: 30px; border: 1px solid #555; border-radius: 3px;
                        display: flex; align-items: center; justify-content: flex-start; position: relative;
                        background: linear-gradient(90deg, ${viewerBg} 0%, ${evenMsgBg} 40%, ${oddMsgBg} 50%, ${evenMsgBg} 60%, ${viewerBg} 100%);
                        padding-left: 10px;
                    `;

                    const profileNameSpan = document.createElement('span');
                    profileNameSpan.textContent = profileName;
                    profileNameSpan.style.cssText = 'color: white; text-shadow: 0 0 2px black, 0 0 2px black, 0 0 2px black; font-weight: bold; cursor: pointer;';

                    profileNameSpan.addEventListener('click', () => {
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.value = profileName;
                        input.style.cssText = 'background: rgba(0,0,0,0.5); border: 1px solid white; color: white; font-weight: bold; text-shadow: 0 0 2px black; width: 150px;';

                        colorBar.replaceChild(input, profileNameSpan);
                        input.focus();
                        input.select();

                        const saveName = async () => {
                            const newName = input.value.trim();
                            if (newName && newName !== profileName) {
                                let currentProfiles = await GM.getValue('otkSettingsProfiles', {});
                                if (currentProfiles[newName]) {
                                    alert('A profile with this name already exists.');
                                    colorBar.replaceChild(profileNameSpan, input); // revert
                                    return;
                                }
                                currentProfiles[newName] = currentProfiles[profileName];
                                delete currentProfiles[profileName];
                                await GM.setValue('otkSettingsProfiles', currentProfiles);
                                renderSettingsManagementPanel(); // Re-render to update everything
                            } else {
                                colorBar.replaceChild(profileNameSpan, input); // Revert if name is empty or unchanged
                            }
                        };

                        input.addEventListener('blur', saveName);
                        input.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter') {
                                saveName();
                            } else if (e.key === 'Escape') {
                                colorBar.replaceChild(profileNameSpan, input);
                            }
                        });
                    });

                    colorBar.appendChild(profileNameSpan);

                    const buttonsWrapper = document.createElement('div');
                    buttonsWrapper.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                    const loadProfileBtn = createTrackerButton('Load');
                    loadProfileBtn.style.padding = '2px 8px';
                    loadProfileBtn.addEventListener('click', () => {
                        if (confirm(`Are you sure you want to load the "${profileName}" settings profile? This will overwrite your current settings.`)) {
                            const profileSettings = profiles[profileName];
                            Object.keys(profileSettings).forEach(key => localStorage.setItem(key, profileSettings[key]));
                            alert('Settings loaded. The page will now reload.');
                            location.reload();
                        }
                    });

                    const removeProfileBtn = createTrackerButton('Remove');
                    removeProfileBtn.style.padding = '2px 8px';
                    removeProfileBtn.addEventListener('click', async () => {
                        if (confirm(`Are you sure you want to remove the "${profileName}" settings profile?`)) {
                            let currentProfiles = await GM.getValue('otkSettingsProfiles', {});
                            delete currentProfiles[profileName];
                            await GM.setValue('otkSettingsProfiles', currentProfiles);
                            renderSettingsManagementPanel();
                        }
                    });

                    buttonsWrapper.appendChild(loadProfileBtn);
                    buttonsWrapper.appendChild(removeProfileBtn);
                    profileRow.appendChild(colorBar);
                    profileRow.appendChild(buttonsWrapper);
                    profilesContainer.appendChild(profileRow);
                } catch (e) {
                    consoleError(`Error rendering profile "${profileName}":`, e);
                    const errorRow = document.createElement('div');
                    errorRow.classList.add('otk-option-row');
                    errorRow.style.color = 'red';
                    errorRow.textContent = `Error rendering profile: ${profileName}`;
                    profilesContainer.appendChild(errorRow);
                }
            });
        }
    } catch (e) {
        consoleError("Error loading or rendering settings profiles:", e);
        profilesContainer.innerHTML = '<div class="otk-option-row" style="color: red;">Could not load saved profiles.</div>';
    }


    // --- Static Buttons ---
    // This section creates the buttons that should always be visible, after the profiles.

    // 1. Save Settings to System Button
    const saveToSystemButtonRow = document.createElement('div');
    saveToSystemButtonRow.classList.add('otk-option-row');
    saveToSystemButtonRow.style.gridTemplateColumns = '1fr';

    const saveToSystemButton = createTrackerButton('Save Settings to System');
    saveToSystemButton.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
    saveToSystemButton.addEventListener('click', async () => {
        const profileName = prompt("Enter a name for this settings profile:");
        if (!profileName) return;

        const allSettings = {};
        const keysToExport = [
            OTK_TRACKED_KEYWORDS_KEY, OTK_BLOCKED_KEYWORDS_KEY, 'otkMinUpdateSeconds',
            'otkMaxUpdateSeconds', 'otkSuspendAfterInactiveMinutes', 'otkMediaLoadMode',
            BACKGROUND_UPDATES_DISABLED_KEY, 'otkAutoLoadUpdates', 'otkClockEnabled',
            'otkPipModeEnabled', DEBUG_MODE_KEY, THEME_SETTINGS_KEY, THREAD_TITLE_COLORS_KEY,
            IMAGE_BLUR_AMOUNT_KEY, CLOCK_POSITION_KEY, COUNTDOWN_POSITION_KEY, 'otkClocks',
            // Begin missing keys
            FILTER_RULES_V2_KEY,
            PINNED_MESSAGE_ID_KEY,
            BLURRED_IMAGES_KEY,
            BLOCKED_THREADS_KEY,
            UNREAD_MESSAGE_IDS_KEY,
            'otkCollapsibleStates'
            // End missing keys
        ];

        keysToExport.forEach(key => {
            let value = localStorage.getItem(key);
            if (value !== null) allSettings[key] = value;
        });

        let profiles = await GM.getValue('otkSettingsProfiles', {});
        profiles[profileName] = allSettings;
        await GM.setValue('otkSettingsProfiles', profiles);

        renderSettingsManagementPanel(); // Re-render the whole panel
    });

    saveToSystemButtonRow.appendChild(saveToSystemButton);
    panel.appendChild(saveToSystemButtonRow);

    // 2. Save Settings to File Button
    const saveButtonRow = document.createElement('div');
    saveButtonRow.classList.add('otk-option-row');
    saveButtonRow.style.gridTemplateColumns = '1fr';

    const saveButton = createTrackerButton('Save Settings to File');
    saveButton.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
    saveButton.addEventListener('click', () => {
        const filename = prompt("Enter a name for your settings file:", "otk-tracker-settings.json");
        if (!filename) return;

        const allSettings = {};
        const currentThemeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY) || '{}');
        const snapshotThemeSettings = { ...currentThemeSettings, ...pendingThemeChanges };
        const keysToExport = [
            OTK_TRACKED_KEYWORDS_KEY, OTK_BLOCKED_KEYWORDS_KEY, 'otkMinUpdateSeconds',
            'otkMaxUpdateSeconds', 'otkSuspendAfterInactiveMinutes', 'otkMediaLoadMode',
            BACKGROUND_UPDATES_DISABLED_KEY, 'otkAutoLoadUpdates', 'otkClockEnabled',
            'otkPipModeEnabled', DEBUG_MODE_KEY, THEME_SETTINGS_KEY, THREAD_TITLE_COLORS_KEY,
            IMAGE_BLUR_AMOUNT_KEY, CLOCK_POSITION_KEY, COUNTDOWN_POSITION_KEY, 'otkClocks',
            // Begin missing keys
            FILTER_RULES_V2_KEY,
            PINNED_MESSAGE_ID_KEY,
            BLURRED_IMAGES_KEY,
            BLOCKED_THREADS_KEY,
            UNREAD_MESSAGE_IDS_KEY,
            'otkCollapsibleStates'
            // End missing keys
        ];

        keysToExport.forEach(key => {
            let value = localStorage.getItem(key);
            if (value !== null) {
                try {
                    let parsedValue = (key === THEME_SETTINGS_KEY) ? snapshotThemeSettings : JSON.parse(value);
                    if (key === THEME_SETTINGS_KEY && typeof parsedValue === 'object') {
                        Object.keys(parsedValue).forEach(themeKey => {
                            if (typeof parsedValue[themeKey] === 'string' && parsedValue[themeKey].startsWith('data:image')) {
                                parsedValue[themeKey] = '(Local file used)';
                            }
                        });
                    }
                    allSettings[key] = parsedValue;
                } catch (e) {
                    allSettings[key] = value;
                }
            }
        });

        const settingsString = JSON.stringify(allSettings, null, 2);
        const blob = new Blob([settingsString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.endsWith('.json') ? filename : `${filename}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    saveButtonRow.appendChild(saveButton);
    panel.appendChild(saveButtonRow);

    // 3. Load Settings From File Button
    const loadButtonRow = document.createElement('div');
    loadButtonRow.classList.add('otk-option-row');
    loadButtonRow.style.gridTemplateColumns = '1fr';

    const loadButton = createTrackerButton('Load Settings From File');
    loadButton.style.cssText += "padding: 2px 8px; font-size: 11px; height: 25px; box-sizing: border-box; width: 100%;";
    loadButton.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const settings = JSON.parse(event.target.result);
                    Object.keys(settings).forEach(key => {
                        const value = settings[key];
                        localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : value);
                    });
                    alert('Settings loaded successfully. The page will now reload to apply all changes.');
                    location.reload();
                } catch (err) {
                    consoleError('Error parsing settings file:', err);
                    alert('Error: Could not parse the settings file. Please ensure it is a valid JSON file.');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    loadButtonRow.appendChild(loadButton);
    panel.appendChild(loadButtonRow);
}

        // Kick off the script using the main async function
        main().finally(() => {
            // Final verification log after main execution sequence
            const centerInfo = document.getElementById('otk-center-info-container');
            if (centerInfo) {
                consoleLog('[Final Check] Computed flex-grow for centerInfoContainer:', window.getComputedStyle(centerInfo).flexGrow);
            } else {
                consoleWarn('[Final Check] centerInfoContainer not found for flex-grow check.');
            }
        });

        document.addEventListener('visibilitychange', () => {
            const viewerIsOpen = otkViewer && otkViewer.style.display === 'block';
            if (!document.hidden && viewerIsOpen && cachedNewMessages.length > 0) {
                const autoLoad = localStorage.getItem('otkAutoLoadUpdates') === 'true';
                if (autoLoad) {
                    consoleLog(`[Visibility] Tab is visible, appending ${cachedNewMessages.length} cached messages.`);
                    appendNewMessagesToViewer(cachedNewMessages);
                    cachedNewMessages = []; // Clear cache after appending
                }
            }
        });

        if (localStorage.getItem('otkClockEnabled') === 'true') {
            const clockElement = document.getElementById('otk-clock');
            if (clockElement) {
                clockElement.style.display = 'flex';
                renderClocks();
            }
        }

        setInterval(updateClockTimes, 1000);

        // Final re-render of clocks to ensure they are populated correctly
        renderClocks();

        function handleActivity() {
            lastActivityTimestamp = Date.now();
            if (isSuspended) {
                consoleLog("[Activity] Activity detected, resuming background updates.");
                isSuspended = false;
                hideSuspendedScreen();
                startBackgroundRefresh(); // Restart the refresh cycle
            }
        }

        function checkSuspension() {
            if (isSuspended || isManualRefreshInProgress) {
                return;
            }

            const suspendAfterInactiveMinutesValue = localStorage.getItem('otkSuspendAfterInactiveMinutes') || '1';
            if (suspendAfterInactiveMinutesValue === 'Disabled') {
                return;
            }

            const suspendAfterInactiveMinutes = parseInt(suspendAfterInactiveMinutesValue, 10);
            const inactiveMinutes = (Date.now() - lastActivityTimestamp) / (1000 * 60);

            if (inactiveMinutes >= suspendAfterInactiveMinutes) {
                consoleLog(`[Activity] No activity for ${suspendAfterInactiveMinutes} minutes, suspending background updates.`);
                isSuspended = true;
                stopBackgroundRefresh();
                showSuspendedScreen();
            }
        }

        function startSuspensionChecker() {
            if (suspensionCheckIntervalId) {
                clearInterval(suspensionCheckIntervalId);
            }
            suspensionCheckIntervalId = setInterval(checkSuspension, 5000); // Check every 5 seconds

            window.addEventListener('scroll', handleActivity, { passive: true });
            window.addEventListener('mousemove', handleActivity, { passive: true });
            window.addEventListener('mousedown', handleActivity, { passive: true });
            window.addEventListener('keydown', handleActivity, { passive: true });
            window.addEventListener('touchstart', handleActivity, { passive: true });
            document.addEventListener('visibilitychange', handleActivity);
        }


async function fetchTimezones() {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: "GET",
            url: 'https://github.com/johnt1884/ff/releases/download/firefox/cities_geonames.json',
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        cityData = JSON.parse(response.responseText);
                        consoleLog(`Successfully fetched and parsed ${cityData.length} cities.`);
                        resolve();
                    } catch (e) {
                        consoleError('Error parsing city data:', e);
                        cityData = [];
                        reject(e);
                    }
                } else {
                    const errorMsg = `Failed to fetch city data: ${response.status} ${response.statusText}`;
                    consoleError(errorMsg);
                    cityData = [];
                    reject(new Error(errorMsg));
                }
            },
            onerror: function(error) {
                consoleError('Error fetching city data with GM_xmlhttpRequest:', error);
                cityData = [];
                reject(error);
            }
        });
    });
}

function setupTimezoneSearch() {
    const searchInput = document.getElementById('otk-timezone-search-input');
    const searchResultsDiv = document.getElementById('otk-timezone-search-results');

    const addZoneItem = (city) => {
        const resultDiv = document.createElement('div');
        const displayText = `${city.city}, ${city.admin1} (${city.country_code})`;
        resultDiv.textContent = displayText;
        resultDiv.dataset.timezone = city.timezone;
        resultDiv.dataset.city = city.city;
        resultDiv.style.cssText = `
            padding: 4px;
            cursor: pointer;
            color: var(--otk-clock-search-text-color, #e6e6e6);
        `;
        resultDiv.addEventListener('mouseenter', () => resultDiv.style.backgroundColor = '#555');
        resultDiv.addEventListener('mouseleave', () => resultDiv.style.backgroundColor = '');
        resultDiv.addEventListener('click', () => {
            const selectedTimezone = resultDiv.dataset.timezone;
            const selectedCity = resultDiv.dataset.city;
            let clocks = JSON.parse(localStorage.getItem('otkClocks') || '[]');
            const clockIndex = clocks.findIndex(c => c.id === activeClockSearchId);

            if (clockIndex !== -1) {
                clocks[clockIndex].timezone = selectedTimezone;
                clocks[clockIndex].displayPlace = selectedCity;
                localStorage.setItem('otkClocks', JSON.stringify(clocks));
            }

            renderClocks();
            renderClockOptions();
            document.getElementById('otk-timezone-search-container').style.display = 'none';
            searchInput.value = '';
            searchResultsDiv.innerHTML = '';
            activeClockSearchId = null;
        });
        searchResultsDiv.appendChild(resultDiv);
    };

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        searchResultsDiv.innerHTML = '';

        if (query.length < 2) return;

        const queryWords = query.split(/\s+/).filter(w => w.length > 0);
        const results = cityData.filter(city => {
            const fullCityName = `${city.city}, ${city.admin1}`.toLowerCase();
            return queryWords.every(word => fullCityName.includes(word));
        }).sort((a, b) => b.population - a.population).slice(0, 50);

        results.forEach(addZoneItem);
    });
}

})();


