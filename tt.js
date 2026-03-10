// ==UserScript==
// @name TikTok Video Counter + Multi-Select + Test New Videos (more robust)
// @namespace http://tampermonkey.net/
// @version 1.13
// @description Improved Test New accuracy: ID-based comparison vs a larger saved ID-set (up to 128), waits for DOM stability, timestamps snapshot. SPA-friendly. Multi-select + internal clipboard unchanged. Added copy selected (clear/appended) and safer alert/confirm handling. Removed popups, added bottom-right notifications. Added top-right row-select checkbox per video (position-based row detection). Removed '+' buttons. Fixed checkbox size to static scale(3).
// @author You
// @match https://www.tiktok.com/@*
// @grant none
// ==/UserScript==
// ==UserScript==
// @name TikTok Video Counter + Multi-Select + Test New Videos (more robust)
// @namespace http://tampermonkey.net/
// @version 1.13
// @description Improved Test New accuracy: ID-based comparison vs a larger saved ID-set (up to 128), waits for DOM stability, timestamps snapshot. SPA-friendly. Multi-select + internal clipboard unchanged. Added copy selected (clear/appended) and safer alert/confirm handling. Removed popups, added bottom-right notifications. Added top-right row-select checkbox per video (position-based row detection). Removed '+' buttons. Fixed checkbox size to static scale(3).
// @author You
// @match https://www.tiktok.com/@*
// @grant none
// ==/UserScript==
(function() {
    'use strict';
    const selectedLinks = new Set();
    const CLIPBOARD_KEY = 'tmk_internal_clipboard';
    let internalClipboard = []; // Will be loaded by readClipboard

    // --- Centralized, Safe Clipboard Management ---
    function readClipboard() {
        try {
            const raw = localStorage.getItem(CLIPBOARD_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function appendToClipboard(items) {
        const currentItems = readClipboard();
        const newSet = new Set([...currentItems, ...items]);
        const merged = Array.from(newSet);
        try {
            localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(merged));
            internalClipboard = merged; // Update local state *after* successful write
            return merged;
        } catch (e) {
            console.error("Failed to save to clipboard:", e);
            return currentItems; // Return original on failure
        }
    }

    function clearClipboard() {
        try {
            localStorage.removeItem(CLIPBOARD_KEY);
            internalClipboard = [];
        } catch (e) {
            console.error("Failed to clear clipboard:", e);
        }
    }

    // Initial load
    internalClipboard = readClipboard();

    let lastExtractionData = null;
    function refreshUI() {
        if (lastExtractionData) {
            displayCount(
                lastExtractionData.username,
                lastExtractionData.count,
                lastExtractionData.testNewCount,
                lastExtractionData.newUrls,
                lastExtractionData.savedSnapshot
            );
        }
    }

    if (!window._tmk_extractRetry) window._tmk_extractRetry = 0;
    let notificationContainer = null;
    // ------------------ Basic Helpers ------------------
    function getUsernameFromUrl() {
        const match = location.pathname.match(/^\/@([^\/]+)/);
        return match ? match[1] : null;
    }
    function isProfilePage() {
        return location.pathname.startsWith('/@') &&
               !location.pathname.includes('/video/') &&
               !location.pathname.includes('/photo/');
    }
    function normalizeUrl(u) {
        try {
            const url = u.split('?')[0];
            return url.endsWith('/') ? url.slice(0, -1) : url;
        } catch {
            return u;
        }
    }
    function isPostLink(url) {
        return /\/(video|photo)\/\d+/.test(url);
    }
    // ------------------ Notification System (replaces popups) ------------------
    function initNotifications() {
        if (notificationContainer) return;
        notificationContainer = document.createElement('div');
        Object.assign(notificationContainer.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: 99999,
            maxWidth: '300px',
            fontSize: '14px',
            lineHeight: '1.3'
        });
        document.body.appendChild(notificationContainer);
    }
    function showNotification(msg, color = '#fff', duration = 3000) {
        initNotifications();
        const note = document.createElement('div');
        Object.assign(note.style, {
            padding: '10px 15px',
            background: `rgba(0,0,0,0.85)`,
            color: color,
            borderRadius: '6px',
            marginBottom: '10px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            opacity: '0',
            transform: 'translateY(20px)',
            transition: 'opacity 0.3s ease, transform 0.3s ease'
        });
        note.textContent = msg;
        notificationContainer.appendChild(note);
        requestAnimationFrame(() => {
            note.style.opacity = '1';
            note.style.transform = 'translateY(0)';
        });
        setTimeout(() => {
            note.style.opacity = '0';
            note.style.transform = 'translateY(20px)';
            setTimeout(() => note.remove(), 300);
        }, duration);
    }
    // ------------------ Post Extraction ------------------
    function getPostLinks() {
        const links = [];
        document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach(a => {
            const href = a.href.split('?')[0];
            if (isPostLink(href) && !links.includes(href)) links.push(href);
        });
        return links;
    }
    function getPostIdsFromLinks(links, limit = 128) {
        const ids = [];
        const seen = new Set();
        const re = /\/(?:video|photo)\/(\d+)/;
        for (const l of links) {
            const m = l.match(re);
            if (m && m[1] && !seen.has(m[1])) {
                seen.add(m[1]);
                ids.push(m[1]);
                if (ids.length >= limit) break;
            }
        }
        return ids;
    }
    function findUrlsForIds(ids, username) {
        const anchors = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'));
        return ids.map(id => {
            const found = anchors.find(a => a.href.includes(`/video/${id}`) || a.href.includes(`/photo/${id}`));
            return found ? found.href.split('?')[0] : `https://www.tiktok.com/@${username}/video/${id}`;
        });
    }
    // ------------------ Wait for DOM Stability ------------------
    function waitForStableAnchors({minAnchors = 4, stableMs = 700, timeout = 10000} = {}) {
        return new Promise(resolve => {
            let lastCount = getPostLinks().length;
            let stableTimer = null;
            let timeoutTimer = null;
            function checkStable() {
                const currentCount = getPostLinks().length;
                if (currentCount !== lastCount) {
                    lastCount = currentCount;
                    if (stableTimer) clearTimeout(stableTimer);
                    stableTimer = setTimeout(() => {
                        cleanup();
                        resolve({stable: true, count: currentCount});
                    }, stableMs);
                } else {
                    if (!stableTimer && currentCount >= minAnchors) {
                        stableTimer = setTimeout(() => {
                            cleanup();
                            resolve({stable: true, count: currentCount});
                        }, stableMs);
                    }
                }
            }
            function onMutations() {
                checkStable();
            }
            const obs = new MutationObserver(onMutations);
            obs.observe(document.body, {childList: true, subtree: true, attributes: false});
            timeoutTimer = setTimeout(() => {
                cleanup();
                resolve({stable: false, count: getPostLinks().length});
            }, timeout);
            checkStable();
            function cleanup() {
                if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
                if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
                try { obs.disconnect(); } catch (e) {}
            }
        });
    }
    // ------------------ Main Extraction ------------------
    async function extractVideoCount() {
        if (!isProfilePage()) {
            removeDisplay();
            return;
        }
        const scriptElement = document.getElementById('SIGI_STATE') ||
            document.querySelector('script[id^="__UNIVERSAL_DATA_FOR_REHYDRATION__"]');
        if (!scriptElement) {
            if (window._tmk_extractRetry < 5) {
                window._tmk_extractRetry++;
                const delay = 1000 * window._tmk_extractRetry;
                setTimeout(extractVideoCount, delay);
                return;
            } else {
                removeDisplay();
                return;
            }
        }
        try {
            const jsonData = JSON.parse(scriptElement.textContent);
            const userDetail = jsonData?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
            const videoCount = userDetail?.userInfo?.stats?.videoCount;
            const username = getUsernameFromUrl();
            if (typeof videoCount !== 'number' || !username) {
                removeDisplay();
                return;
            }
            const waitResult = await waitForStableAnchors({minAnchors: 4, stableMs: 700, timeout: 10000});
            if (waitResult.count === 0 && window._tmk_extractRetry < 10) {
                window._tmk_extractRetry++;
                const delay = Math.min(1500 * Math.pow(1.5, window._tmk_extractRetry - 1), 10000);
                if (window._tmk_extractRetry % 2 === 0) (document.scrollingElement || document.documentElement).scrollBy(0, 1000);
                setTimeout(extractVideoCount, delay);
                return;
            }
            const rawLinks = getPostLinks().map(normalizeUrl);
            const currentIdsLarge = getPostIdsFromLinks(rawLinks, 128);
            const currentFirst32 = currentIdsLarge.slice(0, 32);
            const storageKey = 'tiktok_recent_ids_' + username;
            const rawSaved = localStorage.getItem(storageKey);
            let savedObj = null;
            try { savedObj = rawSaved ? JSON.parse(rawSaved) : null; } catch(e) { savedObj = null; }
            const savedIds = Array.isArray(savedObj?.ids) ? savedObj.ids : [];
            let testNewCount = 'n/a';
            let newIds = [];
            if (savedIds.length === 0) {
                testNewCount = 'n/a';
            } else {
                const savedSet = new Set(savedIds);
                newIds = currentFirst32.filter(id => !savedSet.has(id));
                testNewCount = newIds.length;
            }
            const toSave = { ids: currentIdsLarge.slice(0, 128), ts: Date.now() };
            try {
                localStorage.setItem(storageKey, JSON.stringify(toSave));
            } catch (e) {
                // no-op
            }
            const newUrls = newIds.length > 0 ? findUrlsForIds(newIds, username) : [];
            displayCount(username, videoCount, testNewCount, newUrls, toSave);
            saveVideoCount(username, videoCount);
            injectCheckboxes();
            window._tmk_extractRetry = 0;
        } catch (e) {
            console.error('extractVideoCount error:', e);
            removeDisplay();
        }
    }
    // ------------------ Storage ------------------
    function saveVideoCount(username, count) {
        try { localStorage.setItem('tiktok_video_count_' + username, count); } catch {}
    }
    function getSavedVideoCount(username) {
        const val = localStorage.getItem('tiktok_video_count_' + username);
        return val ? parseInt(val, 10) : null;
    }
    // ------------------ Display ------------------
    function removeDisplay() {
        const box = document.getElementById('exactVideoCountDisplay');
        if (box) box.remove();
    }
    function formatTimestamp(ts) {
        try {
            const d = new Date(ts);
            return d.toLocaleString();
        } catch { return ''; }
    }
    function displayCount(username, count, testNewCount = 0, newUrls = [], savedSnapshot = null) {
        lastExtractionData = { username, count, testNewCount, newUrls, savedSnapshot };
        let box = document.getElementById('exactVideoCountDisplay');
        if (!box) {
            box = document.createElement('div');
            box.id = 'exactVideoCountDisplay';
            Object.assign(box.style, {
                position: 'fixed',
                top: '80px',
                right: '20px',
                padding: '10px 20px',
                background: 'rgba(0,0,0,0.75)',
                color: '#fff',
                fontSize: '14px',
                zIndex: 99999,
                borderRadius: '8px',
                boxShadow: '0 0 12px rgba(0,0,0,0.6)',
                maxWidth: '300px',
                lineHeight: '1.3'
            });
            document.body.appendChild(box);
        }
        const prev = getSavedVideoCount(username);
        const newVideos = prev !== null ? count - prev : 0;
        let html = `<a href="#" style="color:#0ff;" id="copyAllPosts">Total Videos: ${count}</a>`;
        if (newVideos !== 0) html += `<br><a href="#" style="color:#0f0;" id="copyNewPosts">New Videos: ${newVideos > 0 ? '+' : ''}${newVideos}</a>`;
        if (testNewCount === 'n/a') {
            html += `<br><span style="color:#aaa;">Test New Videos: n/a</span>`;
        } else if (testNewCount > 0) {
            html += `<br><a href="#" style="color:#ffa500;" id="copyTestNew">Test New Videos: +${testNewCount}</a>`;
        } else {
            html += `<br><span style="color:#aaa;">Test New Videos: 0</span>`;
        }
        // ---- show the two copy-selected options ----
        if (selectedLinks.size > 0) {
            // Copy Selected (Clear Memory First)
            html += `<br><a href="#" style="color:#0ff;" id="copySelectedClear">
                        Copy Selected (Clear Memory First)
                     </a>`;
            // Copy Selected (Append)
            html += `<br><a href="#" style="color:#ff0;" id="copySelectedAppend">
                        Copy Selected (Append)
                     </a>`;
            // Existing controls
            html += `<br><a href="#" style="color:#f80;" id="clearSelection">
                        Clear Selection
                     </a>`;
            html += `<br><a href="#" style="color:#f44;" id="clearMemory">
                        Clear Memory
                     </a>`;
            html += `<br><span style="color:#fff; font-size:12px;">Selected: ${selectedLinks.size}</span>`;
        }
        // Debug info: show saved snapshot timestamp and saved count if provided
        if (savedSnapshot && savedSnapshot.ids) {
            html += `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;">`;
            html += `<div style="font-size:11px;color:#bbb;">Saved IDs: ${savedSnapshot.ids.length} <br>Snapshot: ${formatTimestamp(savedSnapshot.ts)}</div>`;
        }
        box.innerHTML = html;
        // ------------------ Button Handlers ------------------
        const copyAll = document.getElementById('copyAllPosts');
        if (copyAll) copyAll.onclick = e => { e.preventDefault(); scrollAndCollectAllPosts(); };
        const newBtn = document.getElementById('copyNewPosts');
        if (newBtn) newBtn.onclick = e => { e.preventDefault(); scrollAndCollectAllPosts(true, prev); };
        const testBtn = document.getElementById('copyTestNew');
        if (testBtn) {
            testBtn.onclick = e => {
                e.preventDefault();
                if (!newUrls || newUrls.length === 0) return showNotification('No new URLs found.', '#ff6b6b');
                const updatedClipboard = appendToClipboard(newUrls);
                try {
                    // Always copy the full, updated list to the system clipboard
                    navigator.clipboard.writeText(updatedClipboard.join('\n')).catch(err =>{
                        console.error("Clipboard write failed (async):", err);
                        showNotification('Clipboard write failed.', '#ff6b6b');
                    });
                } catch(e){
                    console.error("Clipboard write failed (sync):", e);
                }
                showNotification(`Copied ${newUrls.length} new link(s).\nTotal in memory: ${updatedClipboard.length}`, '#4ecdc4');
                highlightUrls(newUrls);
            };
        }
        // --- Copy selected & CLEAR memory first ---
        const copySelClear = document.getElementById('copySelectedClear');
        if (copySelClear) copySelClear.onclick = e => {
            e.preventDefault();
            if (!confirm('Are you sure you want to clear memory and copy selected?')) return;
            const arr = Array.from(selectedLinks);
            clearClipboard(); // Safe clear
            const updatedClipboard = appendToClipboard(arr); // Safe append
            try {
                navigator.clipboard.writeText(updatedClipboard.join('\n')).catch(err =>{
                    console.error("Clipboard write failed (async):", err);
                    showNotification('Clipboard write failed.', '#ff6b6b');
                });
            } catch(e){
                console.error("Clipboard write failed (sync):", e);
            }
            showNotification(`Copied ${arr.length} selected link(s)!\n(Memory cleared first)`, '#4ecdc4');
        };
        // --- Copy selected & APPEND to memory ---
        const copySelAppend = document.getElementById('copySelectedAppend');
        if (copySelAppend) copySelAppend.onclick = e => {
            e.preventDefault();
            const arr = Array.from(selectedLinks);
            const updatedClipboard = appendToClipboard(arr);
            try {
                navigator.clipboard.writeText(updatedClipboard.join('\n')).catch(err =>{
                    console.error("Clipboard write failed (async):", err);
                    showNotification('Clipboard write failed.', '#ff6b6b');
                });
            } catch(e){
                console.error("Clipboard write failed (sync):", e);
            }
            showNotification(`Appended ${arr.length} link(s).\nTotal in memory: ${updatedClipboard.length}`, '#4ecdc4');
        };
        const clearSelBtn = document.getElementById('clearSelection');
        if (clearSelBtn) clearSelBtn.onclick = e => {
            e.preventDefault();
            selectedLinks.clear();
            document.querySelectorAll('.tmk-custom-checkbox').forEach(cb => cb.checked = false);
            refreshUI();
            showNotification('Selection cleared!', '#95e1d3');
        };
        const clearMemBtn = document.getElementById('clearMemory');
        if (clearMemBtn) clearMemBtn.onclick = e => {
            e.preventDefault();
            if (!confirm('Are you sure you want to clear memory?')) return;
            clearClipboard();
            showNotification('Internal clipboard cleared!', '#95e1d3');
        };
    }
    // ------------------ Visual helpers ------------------
    function highlightUrls(urls) {
        if (!urls || urls.length === 0) return;
        const normalized = urls.map(normalizeUrl);
        document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach(a => {
            const n = normalizeUrl(a.href);
            if (normalized.includes(n)) {
                a.style.outline = '3px solid rgba(255,223,0,0.95)';
                a.style.transition = 'outline 0.25s ease';
                setTimeout(() => { a.style.outline = ''; }, 3500);
            }
        });
    }
    // ------------------ Scroll copy ------------------
    function scrollAndCollectAllPosts(onlyNew = false, oldCount = 0) {
        let lastHeight = 0, retry = 0;
        const scroller = document.scrollingElement || document.documentElement;
        function step() {
            const totalLinks = getPostLinks().length;
            scroller.scrollTo(0, scroller.scrollHeight);
            if (scroller.scrollHeight !== lastHeight) {
                lastHeight = scroller.scrollHeight;
                retry = 0;
                setTimeout(step, 800);
            } else {
                retry++;
                if (retry < 3) setTimeout(step, 1000);
                else {
                    const links = getPostLinks();
                    const filtered = onlyNew ? links.slice(0, oldCount ? links.length - oldCount : links.length) : links;
                    const updatedClipboard = appendToClipboard(filtered);
                    try {
                        // Always copy the full, updated list to the system clipboard
                        navigator.clipboard.writeText(updatedClipboard.join('\n')).catch(err =>{
                            console.error("Clipboard write failed (async):", err);
                            showNotification('Clipboard write failed.', '#ff6b6b');
                        });
                    } catch(e){
                        console.error("Clipboard write failed (sync):", e);
                    }
                    showNotification(`Copied ${filtered.length} link(s).\nTotal in memory: ${updatedClipboard.length}`, '#4ecdc4');
                }
            }
        }
        step();
    }
    // ------------------ Checkbox Injection ------------------
    function injectCheckboxes() {
        if (!isProfilePage()) {
            document.querySelectorAll('.tmk-custom-checkbox, .tmk-row-select-checkbox').forEach(el => el.remove());
            selectedLinks.clear();
            extractVideoCount();
            return;
        }
        document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach(a => {
            if (a.dataset.checkboxesAdded) return;
            a.dataset.checkboxesAdded = "true";
            const href = a.href.split('?')[0];
            // Individual checkbox (top-left)
            const leftWrapper = document.createElement('div');
            leftWrapper.style.position = 'absolute';
            leftWrapper.style.top = '5px';
            leftWrapper.style.left = '5px';
            leftWrapper.style.zIndex = '10000';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'tmk-custom-checkbox';
            cb.style.transform = 'scale(2)';
            ['click','mousedown','mouseup'].forEach(evt => cb.addEventListener(evt, e => e.stopPropagation()));
            cb.addEventListener('change', () => {
                if (cb.checked) selectedLinks.add(href);
                else selectedLinks.delete(href);
                refreshUI();
            });
            leftWrapper.appendChild(cb);
            a.style.position = 'relative';
            a.appendChild(leftWrapper);
            // Row-select checkbox (top-right) - position-based
            const rightWrapper = document.createElement('div');
            rightWrapper.style.position = 'absolute';
            rightWrapper.style.top = '5px';
            rightWrapper.style.right = '5px';
            rightWrapper.style.zIndex = '10000';
            const rowCb = document.createElement('input');
            rowCb.type = 'checkbox';
            rowCb.className = 'tmk-row-select-checkbox';
            rowCb.style.transform = 'scale(2)';
            ['click','mousedown','mouseup'].forEach(evt => rowCb.addEventListener(evt, e => e.stopPropagation()));
            rowCb.addEventListener('change', () => {
                // Position-based row selection
                const currentTop = a.getBoundingClientRect().top;
                const allContainers = document.querySelectorAll('[class*="-DivItemContainerV2"], .video-feed-item-wrapper, [data-e2e="user-post-item"]');
                const rowContainers = Array.from(allContainers).filter(cont => {
                    const link = cont.querySelector ? cont.querySelector('a[href*="/video/"], a[href*="/photo/"]') : null;
                    if (link) {
                        const top = link.getBoundingClientRect().top;
                        return Math.abs(top - currentTop) < 20; // Threshold for same row (adjust if needed)
                    }
                    return false;
                });
                rowContainers.forEach(cont => {
                    const checkbox = cont.querySelector('.tmk-custom-checkbox');
                    if (checkbox) {
                        const linkHref = checkbox.closest('a').href.split('?')[0];
                        checkbox.checked = rowCb.checked;
                        if (rowCb.checked) {
                            selectedLinks.add(linkHref);
                        } else {
                            selectedLinks.delete(linkHref);
                        }
                        // Avoid multiple re-renders during row selection
                    }
                });
                refreshUI();
            });
            rightWrapper.appendChild(rowCb);
            a.appendChild(rightWrapper);
            // Click on video toggles individual if no selection
            a.addEventListener('click', e => {
                if (selectedLinks.size > 0) {
                    if (a._tmk_leaving) return;
                    e.preventDefault();
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            });
        });
    }
    // ------------------ Cross-Tab Sync ------------------
    window.addEventListener('storage', e => {
        if (e.key === CLIPBOARD_KEY) {
            internalClipboard = readClipboard(); // Re-read from storage to ensure consistency
            showNotification('Clipboard updated from another tab.', '#88d8b0', 2000);
            if (isProfilePage()) {
                extractVideoCount(); // Re-render the display
            }
        }
    });
    // ------------------ Leave Confirmation ------------------
    window.addEventListener('click', e => {
        const anchor = e.target.closest('a');
        if (anchor && selectedLinks.size > 0) {
            const href = anchor.getAttribute('href');
            if (!href || href === '#' || href.startsWith('javascript:')) return;

            if (anchor.closest('#exactVideoCountDisplay')) return;
            if (e.target.closest('.tmk-custom-checkbox, .tmk-row-select-checkbox')) return;

            if (!confirm('You have videos selected. Are you sure you want to leave this page?')) {
                e.preventDefault();
                e.stopImmediatePropagation();

                // If staying on page and it was a video link, toggle it
                if (isPostLink(href)) {
                    const cb = anchor.querySelector('.tmk-custom-checkbox');
                    if (cb) {
                        cb.checked = !cb.checked;
                        if (cb.checked) selectedLinks.add(href);
                        else selectedLinks.delete(href);
                        refreshUI();
                    }
                }
            } else {
                // User confirmed leave. Mark it so our other listeners don't block it.
                anchor._tmk_leaving = true;
            }
        }
    }, true);


    // ------------------ SPA Detection ------------------
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            window._tmk_extractRetry = 0;
            setTimeout(extractVideoCount, 1000);
        }
        injectCheckboxes();
    }, 2000);
    window.addEventListener('load', () => setTimeout(extractVideoCount, 3000));
})();
