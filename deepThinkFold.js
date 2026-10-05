// ==UserScript==
// @name         DeepSeek Think Auto-Collapse (Collapse After Thinking + Copy Button + Scroll Lock)
// @namespace    https://github.com/hza2002/deepseek-collapse-think
// @version      3.2
// @description  Smoothly collapse DeepSeek's Think block after reasoning completes. Adds a copy button and locks scroll position. Fixes jitter by force-cancelling ongoing smooth-scroll animations.
// @license      MIT
// @match        https://chat.deepseek.com/*
// @icon         https://chat.deepseek.com/favicon.svg
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ==================== Configuration ====================
    const DEFAULT_CONFIG = {
        enabled: true,
        debug: false,
        navigationDelay: 500,
        userInteractionCooldown: 2000,
        autoScrollToBottom: true,
        bottomThreshold: 200,
        collapseDuration: 350,
        smoothCollapse: true,
        stableThreshold: 800,
        pollInterval: 200,
        lockScrollDuringThinking: true,
        scrollToAnswerAfterCollapse: true,
        userScrollIntentWindow: 800,
        keepLockUntilAnswerStable: true,
        releaseLockOnOutsideClick: true,
        historicalStartDelay: 1500,
        historicalGap: 40,
        historicalAbandonMs: 1200,
        // Number of frames to keep scrollTop pinned after a fold, cancelling smooth animations.
        pinFrames: 20
    };

    const CONFIG = {
        get enabled() {
            return typeof GM_getValue !== 'undefined' ? GM_getValue('enabled', DEFAULT_CONFIG.enabled) : DEFAULT_CONFIG.enabled;
        },
        set enabled(value) {
            if (typeof GM_setValue !== 'undefined') GM_setValue('enabled', value);
        },
        debug: DEFAULT_CONFIG.debug,
        navigationDelay: DEFAULT_CONFIG.navigationDelay,
        userInteractionCooldown: DEFAULT_CONFIG.userInteractionCooldown,
        autoScrollToBottom: DEFAULT_CONFIG.autoScrollToBottom,
        bottomThreshold: DEFAULT_CONFIG.bottomThreshold,
        collapseDuration: DEFAULT_CONFIG.collapseDuration,
        smoothCollapse: DEFAULT_CONFIG.smoothCollapse,
        stableThreshold: DEFAULT_CONFIG.stableThreshold,
        pollInterval: DEFAULT_CONFIG.pollInterval,
        lockScrollDuringThinking: DEFAULT_CONFIG.lockScrollDuringThinking,
        scrollToAnswerAfterCollapse: DEFAULT_CONFIG.scrollToAnswerAfterCollapse,
        userScrollIntentWindow: DEFAULT_CONFIG.userScrollIntentWindow,
        keepLockUntilAnswerStable: DEFAULT_CONFIG.keepLockUntilAnswerStable,
        releaseLockOnOutsideClick: DEFAULT_CONFIG.releaseLockOnOutsideClick,
        historicalStartDelay: DEFAULT_CONFIG.historicalStartDelay,
        historicalGap: DEFAULT_CONFIG.historicalGap,
        historicalAbandonMs: DEFAULT_CONFIG.historicalAbandonMs,
        pinFrames: DEFAULT_CONFIG.pinFrames
    };

    // ==================== Selectors ====================
    const SELECTORS = {
        thinkBlockContainer: '_74c0879',
        collapsedStateClass: 'e47135bc',
        toggleButton: '_5ab5d64',
        thinkContent: 'ds-think-content'
    };

    const COPY_BTN_CLASS = 'ds-copy-think-btn';
    const STYLE_ID = 'ds-copy-think-style';
    const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    // ==================== State ====================
    let currentUrl = location.href;
    let lastUserInteraction = 0;
    // Timestamp of the last sidebar/navigation-related click. Used to suppress
    // spurious "user expanded" detection during page transitions.
    let lastNavigationClick = 0;
    const blockStates = new WeakMap();
    const userExpandedBlocks = new WeakSet();
    const thinkTextCache = new WeakMap();

    function log(...args) {
        if (CONFIG.debug) console.log('[DeepSeek Think]', ...args);
    }

    function isInCooldown() {
        return Date.now() - lastUserInteraction < CONFIG.userInteractionCooldown;
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand === 'undefined') return;
        const statusText = CONFIG.enabled ? '✅ Enabled' : '❌ Disabled';
        GM_registerMenuCommand(`${statusText} - Click to toggle`, () => {
            CONFIG.enabled = !CONFIG.enabled;
            alert(`DeepSeek Think Auto-Collapse: ${CONFIG.enabled ? 'Enabled' : 'Disabled'}\n\nReload the page to apply.`);
            location.reload();
        });
    }

    // ==================== Style Injection ====================
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${COPY_BTN_CLASS} {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                padding: 0;
                margin-left: 4px;
                border: none;
                border-radius: 4px;
                background: transparent;
                color: inherit;
                cursor: pointer;
                opacity: 0.55;
                transition: opacity 0.15s, background 0.15s, color 0.15s;
                flex-shrink: 0;
                vertical-align: middle;
                line-height: 1;
                user-select: none;
            }
            .${COPY_BTN_CLASS}:hover {
                opacity: 1;
                background: rgba(128,128,128,0.18);
            }
            .${COPY_BTN_CLASS}.copied {
                opacity: 1;
                color: #22c55e;
            }
            .${COPY_BTN_CLASS} svg {
                width: 12px;
                height: 12px;
                pointer-events: none;
                display: block;
            }
        `;
        document.head.appendChild(style);
    }

    // ==================== Scroll Utilities ====================
    function getScrollContainer(fromEl) {
        let node = fromEl ? fromEl.parentElement : document.body;
        while (node && node !== document.documentElement) {
            const style = window.getComputedStyle(node);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                if (node.scrollHeight > node.clientHeight) return node;
            }
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function isNearBottom(container) {
        return (container.scrollHeight - container.scrollTop - container.clientHeight) < CONFIG.bottomThreshold;
    }

    function scrollToBottom(container) {
        container.scrollTop = container.scrollHeight;
    }

    // ==================== Pin ScrollTop ====================
    // Force the scroll container's scrollTop to a fixed value over multiple
    // frames, cancelling any in-progress smooth-scroll animation from DeepSeek.
    function pinScrollTop(container, targetTop, frames) {
        return new Promise(resolve => {
            let left = frames;
            let lastTarget = targetTop;

            const step = () => {
                if (left <= 0) {
                    resolve(lastTarget);
                    return;
                }
                if (Math.abs(container.scrollTop - lastTarget) > 0.5) {
                    container.scrollTop = lastTarget;
                }
                left--;
                requestAnimationFrame(step);
            };

            // Allow the caller to update the target mid-flight via this handle
            const handle = {
                setTarget: (t) => { lastTarget = t; },
                stop: () => { left = 0; }
            };
            step();
            // Expose handle via closure by attaching to the promise for convenience
            pinScrollTop._handle = handle;
            resolve(); // Early resolve, caller keeps frame count via setTarget
        });
    }

    // More flexible: caller controls target over frames
    function pinScrollTopFrames(container, getTarget, frames) {
        return new Promise(resolve => {
            let left = frames;
            const step = () => {
                if (left <= 0) { resolve(); return; }
                const target = getTarget();
                if (Math.abs(container.scrollTop - target) > 0.5) {
                    container.scrollTop = target;
                }
                left--;
                requestAnimationFrame(step);
            };
            step();
        });
    }

    // ==================== Scroll Lock ====================
    const scrollLock = {
        active: false,
        container: null,
        scrollTop: 0,
        userIntentUntil: 0,
        onScroll: null,
        owner: null,
        monitorTimer: null,
        pinTimer: null
    };

    function markUserScrollIntent() {
        scrollLock.userIntentUntil = Date.now() + CONFIG.userScrollIntentWindow;
    }

    function setupUserScrollIntentListeners() {
        ['wheel', 'touchstart', 'touchmove'].forEach(evt => {
            document.addEventListener(evt, markUserScrollIntent, { passive: true, capture: true });
        });
        document.addEventListener('keydown', (e) => {
            const keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
            if (keys.includes(e.key)) markUserScrollIntent();
        }, { passive: true, capture: true });
    }

    // ==================== Scroll Guards ====================
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const originalElementScrollTo = Element.prototype.scrollTo;
    const originalWindowScrollTo = window.scrollTo;
    let allowProgrammaticScroll = false;

    function installScrollGuards() {
        Element.prototype.scrollIntoView = function(...args) {
            if (scrollLock.active && !allowProgrammaticScroll) {
                log('Blocked scrollIntoView during lock');
                return;
            }
            return originalScrollIntoView.apply(this, args);
        };

        Element.prototype.scrollTo = function(...args) {
            if (scrollLock.active && !allowProgrammaticScroll) {
                log('Blocked element.scrollTo during lock');
                return;
            }
            return originalElementScrollTo.apply(this, args);
        };

        window.scrollTo = function(...args) {
            if (scrollLock.active && !allowProgrammaticScroll) {
                log('Blocked window.scrollTo during lock');
                return;
            }
            return originalWindowScrollTo.apply(this, args);
        };

        log('Scroll guards installed');
    }

    function setupOutsideClickRelease() {
        document.addEventListener('click', (event) => {
            if (!CONFIG.releaseLockOnOutsideClick) return;
            if (!scrollLock.active || !scrollLock.container) return;

            if (event.target.closest('.' + COPY_BTN_CLASS)) return;
            if (event.target.closest(`.${SELECTORS.toggleButton}`)) return;
            if (scrollLock.container.contains(event.target)) return;

            log('Click outside locked container, releasing scroll lock');
            stopScrollLock();
        }, true);
    }

    function startScrollLock(container, owner) {
        if (!CONFIG.lockScrollDuringThinking) return;
        if (!container) return;

        if (scrollLock.active) {
            if (scrollLock.container === container) {
                if (!scrollLock.owner) scrollLock.owner = owner;
                return;
            }
            stopScrollLock();
        }

        scrollLock.active = true;
        scrollLock.container = container;
        scrollLock.scrollTop = container.scrollTop;
        scrollLock.userIntentUntil = 0;
        scrollLock.owner = owner || null;

        scrollLock.onScroll = () => {
            if (!scrollLock.active || scrollLock.container !== container) return;
            const now = Date.now();
            if (now < scrollLock.userIntentUntil) {
                scrollLock.scrollTop = container.scrollTop;
                return;
            }
            if (Math.abs(container.scrollTop - scrollLock.scrollTop) > 1) {
                container.scrollTop = scrollLock.scrollTop;
            }
        };
        container.addEventListener('scroll', scrollLock.onScroll, { passive: true });

        // Force-cancel any smooth-scroll animation that was already in progress.
        // This is the key fix for jitter: DeepSeek may have called
        // element.scrollTo({behavior:'smooth'}) BEFORE our guard kicked in,
        // and that animation runs for ~300-500ms. Pinning scrollTop for the
        // first several frames overrides the animation frame-by-frame.
        pinScrollTopFrames(container, () => scrollLock.scrollTop, CONFIG.pinFrames);

        log('Scroll lock engaged at', scrollLock.scrollTop);
    }

    function stopScrollLock() {
        if (scrollLock.monitorTimer) {
            clearInterval(scrollLock.monitorTimer);
            scrollLock.monitorTimer = null;
        }
        if (!scrollLock.active) return;
        if (scrollLock.container && scrollLock.onScroll) {
            scrollLock.container.removeEventListener('scroll', scrollLock.onScroll);
        }
        scrollLock.active = false;
        scrollLock.container = null;
        scrollLock.onScroll = null;
        scrollLock.owner = null;
        log('Scroll lock released');
    }

    function updateLockTarget(container, newTop) {
        if (!scrollLock.active) return;
        if (scrollLock.container !== container) return;
        scrollLock.scrollTop = newTop;
    }

    function scrollToAnswer(block, container) {
        if (!CONFIG.scrollToAnswerAfterCollapse || !container) return;
        try {
            const containerRect = container.getBoundingClientRect();
            const blockRect = block.getBoundingClientRect();
            const offset = 16;
            const target = container.scrollTop + (blockRect.top - containerRect.top) - offset;
            const newTop = Math.max(0, target);
            container.scrollTop = newTop;
            updateLockTarget(container, newTop);
            // Pin for a few frames to cancel any pending smooth animation
            pinScrollTopFrames(container, () => newTop, 6);
        } catch (e) {
            log('scrollToAnswer failed:', e);
        }
    }

    function monitorAnswerStability(container) {
        if (!CONFIG.keepLockUntilAnswerStable) {
            stopScrollLock();
            return;
        }
        if (scrollLock.monitorTimer) {
            clearInterval(scrollLock.monitorTimer);
            scrollLock.monitorTimer = null;
        }

        let lastHeight = container.scrollHeight;
        let lastChange = Date.now();

        scrollLock.monitorTimer = setInterval(() => {
            if (!scrollLock.active || scrollLock.container !== container) {
                clearInterval(scrollLock.monitorTimer);
                scrollLock.monitorTimer = null;
                return;
            }
            if (!document.body.contains(container)) {
                clearInterval(scrollLock.monitorTimer);
                scrollLock.monitorTimer = null;
                stopScrollLock();
                return;
            }

            const h = container.scrollHeight;
            if (h !== lastHeight) {
                lastHeight = h;
                lastChange = Date.now();
                return;
            }

            if (Date.now() - lastChange >= CONFIG.stableThreshold) {
                clearInterval(scrollLock.monitorTimer);
                scrollLock.monitorTimer = null;
                log('Answer streaming stable, releasing scroll lock');
                stopScrollLock();
            }
        }, CONFIG.pollInterval);
    }

    // ==================== Copy Button ====================
    function extractThinkText(block) {
        if (thinkTextCache.has(block)) {
            const cached = thinkTextCache.get(block);
            if (cached) return cached;
        }
        const content = block.querySelector('.' + SELECTORS.thinkContent);
        let text = '';
        if (content) {
            text = content.textContent || '';
        } else {
            const clone = block.cloneNode(true);
            clone.querySelector('.' + COPY_BTN_CLASS)?.remove();
            clone.querySelector('.' + SELECTORS.toggleButton)?.remove();
            text = clone.textContent || '';
        }
        return text.trim();
    }

    function cacheThinkText(block) {
        const content = block.querySelector('.' + SELECTORS.thinkContent);
        if (!content) return;
        const text = (content.textContent || '').trim();
        if (text) thinkTextCache.set(block, text);
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return ok;
            } catch (err) {
                return false;
            }
        }
    }

    function injectCopyButton(block) {
        if (block.querySelector('.' + COPY_BTN_CLASS)) return;
        const toggleButton = block.querySelector('.' + SELECTORS.toggleButton);
        if (!toggleButton) return;

        ensureStyle();

        const btn = document.createElement('span');
        btn.className = COPY_BTN_CLASS;
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.title = 'Copy thinking process';
        btn.setAttribute('aria-label', 'Copy thinking process');
        btn.innerHTML = COPY_ICON;

        const doCopy = async (e) => {
            e.stopPropagation();
            e.preventDefault();
            const text = extractThinkText(block);
            if (!text) { btn.title = 'Nothing to copy'; return; }
            const ok = await copyToClipboard(text);
            if (ok) {
                btn.innerHTML = CHECK_ICON;
                btn.classList.add('copied');
                btn.title = 'Copied';
                setTimeout(() => {
                    btn.innerHTML = COPY_ICON;
                    btn.classList.remove('copied');
                    btn.title = 'Copy thinking process';
                }, 1500);
            } else {
                btn.title = 'Copy failed';
            }
        };

        btn.addEventListener('click', doCopy);
        btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') doCopy(e); });
        btn.addEventListener('mousedown', (e) => e.stopPropagation());

        const tbStyle = getComputedStyle(toggleButton);
        if (tbStyle.display !== 'flex' && tbStyle.display !== 'inline-flex') {
            toggleButton.style.display = 'inline-flex';
            toggleButton.style.alignItems = 'center';
        }
        toggleButton.appendChild(btn);
    }

    // ==================== Smooth Collapse (Live) ====================
    function smoothCollapseBlock(block, toggleButton) {
        const duration = CONFIG.collapseDuration;
        if (!CONFIG.smoothCollapse || duration <= 0) {
            try { toggleButton.click(); } catch (e) {}
            return Promise.resolve();
        }
        return new Promise(resolve => {
            const startHeight = block.offsetHeight;
            let endHeight = toggleButton.offsetHeight || 40;
            if (endHeight < 20) endHeight = 40;

            block.style.overflow = 'hidden';
            block.style.height = startHeight + 'px';
            block.style.transition = `height ${duration}ms ease, opacity ${duration}ms ease`;
            block.style.willChange = 'height, opacity';
            void block.offsetHeight;

            requestAnimationFrame(() => {
                block.style.height = endHeight + 'px';
                block.style.opacity = '0.35';
            });

            setTimeout(() => {
                try { toggleButton.click(); } catch (e) {}
                block.style.height = '';
                block.style.overflow = '';
                block.style.transition = '';
                block.style.opacity = '';
                block.style.willChange = '';
                resolve();
            }, duration + 30);
        });
    }

    // ==================== Historical Quiet Collapse ====================
    // Fold a historical block while pinning scrollTop frame-by-frame to a
    // target value. This neutralizes any smooth-scroll animation that
    // DeepSeek may have started before our guard was in place.
    async function quietCollapseBlock(block, container) {
        if (!document.body.contains(block)) return;
        if (block.classList.contains(SELECTORS.collapsedStateClass)) return;

        const toggleButton = block.querySelector('.' + SELECTORS.toggleButton);
        if (!toggleButton) return;

        const H1 = block.offsetHeight;
        const buttonH = toggleButton.offsetHeight || 40;
        const estimatedD = Math.max(0, H1 - buttonH);

        const containerRect = container.getBoundingClientRect();
        const blockRect = block.getBoundingClientRect();
        const aboveViewport = Math.max(0, containerRect.top - blockRect.top);
        const beforeTop = container.scrollTop;

        // Initial target based on estimated shrink
        let targetTop = beforeTop - Math.min(estimatedD, aboveViewport);

        // Click fold. React commit happens asynchronously.
        try { toggleButton.click(); } catch (e) {}

        // Pin scrollTop for several frames, updating the target each frame
        // as the real height becomes known.
        await pinScrollTopFrames(container, () => {
            const H2 = block.offsetHeight;
            const realD = Math.max(0, H1 - H2);
            const realComp = Math.min(realD, aboveViewport);
            targetTop = beforeTop - realComp;
            return targetTop;
        }, CONFIG.pinFrames);
    }

    // ==================== Historical Fold Queue ====================
    const histQueue = [];
    let histRunning = false;
    let histEpoch = 0;

    function enqueueHistorical(block) {
        histQueue.push(block);
        if (!histRunning) runHistoricalQueue();
    }

    async function runHistoricalQueue() {
        histRunning = true;
        const myEpoch = histEpoch;
        while (histQueue.length > 0) {
            if (myEpoch !== histEpoch) break;
            const block = histQueue.shift();
            if (!document.body.contains(block)) continue;
            if (block.classList.contains(SELECTORS.collapsedStateClass)) continue;
            if (userExpandedBlocks.has(block)) continue;

            const container = getScrollContainer(block);
            if (!container) continue;

            await quietCollapseBlock(block, container);
            await new Promise(r => setTimeout(r, CONFIG.historicalGap));
        }
        histRunning = false;
    }

    function resetHistoricalQueue() {
        histEpoch++;
        histQueue.length = 0;
        histRunning = false;
    }

    // ==================== Track Until Stable, Then Collapse ====================
    function trackUntilStable(block) {
        if (blockStates.has(block)) return;
        if (userExpandedBlocks.has(block)) return;
        if (block.classList.contains(SELECTORS.collapsedStateClass)) return;

        const now = Date.now();
        const state = {
            lastLen: (block.textContent || '').length,
            lastChangeTime: now,
            startTime: now,
            timerId: null,
            done: false,
            sawGrowth: false,
            abandoned: false
        };
        blockStates.set(block, state);

        log('Start tracking think block, initial length:', state.lastLen);

        state.timerId = setInterval(() => {
            if (state.done) return;

            if (!document.body.contains(block)) {
                clearInterval(state.timerId);
                state.timerId = null;
                if (scrollLock.owner === block) stopScrollLock();
                return;
            }
            if (userExpandedBlocks.has(block)) {
                clearInterval(state.timerId);
                state.timerId = null;
                if (scrollLock.owner === block) stopScrollLock();
                return;
            }

            cacheThinkText(block);
            injectCopyButton(block);

            const len = (block.textContent || '').length;
            if (len !== state.lastLen) {
                state.lastLen = len;
                state.lastChangeTime = Date.now();

                if (!state.sawGrowth) {
                    state.sawGrowth = true;
                    log('Content growth detected, engaging scroll lock');
                }
                if (!scrollLock.active || scrollLock.owner !== block) {
                    const c = getScrollContainer(block);
                    startScrollLock(c, block);
                }
                return;
            }

            if (!state.sawGrowth) {
                if (Date.now() - state.startTime >= CONFIG.historicalAbandonMs) {
                    state.done = true;
                    state.abandoned = true;
                    clearInterval(state.timerId);
                    state.timerId = null;
                    log('Historical block detected, scheduling quiet collapse');
                    enqueueHistorical(block);
                }
                return;
            }

            if (Date.now() - state.lastChangeTime < CONFIG.stableThreshold) return;

            if (block.classList.contains(SELECTORS.collapsedStateClass)) {
                state.done = true;
                clearInterval(state.timerId);
                state.timerId = null;
                if (scrollLock.owner === block) stopScrollLock();
                return;
            }

            const toggleButton = block.querySelector('.' + SELECTORS.toggleButton);
            if (!toggleButton) return;
            if (isInCooldown()) return;

            state.done = true;
            clearInterval(state.timerId);
            state.timerId = null;

            cacheThinkText(block);

            const scrollContainer = getScrollContainer(block);
            log('Thinking complete (live), starting smooth collapse');

            smoothCollapseBlock(block, toggleButton).then(() => {
                if (scrollLock.active && scrollLock.container === scrollContainer) {
                    scrollLock.owner = block;
                } else {
                    startScrollLock(scrollContainer, block);
                }
                scrollToAnswer(block, scrollContainer);
                monitorAnswerStability(scrollContainer);
            });
        }, CONFIG.pollInterval);
    }

    function scanAndTrack() {
        if (!CONFIG.enabled) return;

        const selector = `.${SELECTORS.thinkBlockContainer}:not(.${SELECTORS.collapsedStateClass})`;
        document.querySelectorAll(selector).forEach(block => {
            injectCopyButton(block);
            trackUntilStable(block);
        });

        const collapsedSelector = `.${SELECTORS.thinkBlockContainer}.${SELECTORS.collapsedStateClass}`;
        document.querySelectorAll(collapsedSelector).forEach(block => {
            injectCopyButton(block);
        });
    }

    // ==================== Listeners ====================
    function setupUserInteractionListener() {
        // Detect clicks on sidebar/conversation list BEFORE they bubble up,
        // so we can suppress the "user expanded" mis-detection during navigation.
        document.addEventListener('click', (event) => {
            // Heuristic: a click that is NOT inside the message list area and
            // has some anchor-like or list-item ancestor is likely navigation.
            const navEl = event.target.closest('a[href*="/a/chat/"], [role="listitem"], [data-testid*="chat"]');
            if (navEl) {
                lastNavigationClick = Date.now();
            }
        }, true);

        document.addEventListener('click', (event) => {
            if (event.target.closest('.' + COPY_BTN_CLASS)) return;

            const toggleButton = event.target.closest(`.${SELECTORS.toggleButton}`);
            if (!toggleButton) return;

            lastUserInteraction = Date.now();

            const block = toggleButton.closest(`.${SELECTORS.thinkBlockContainer}`);
            if (!block) return;

            // Suppress mis-detection right after a navigation click.
            // React may reorder DOM, and the toggleButton we detect could be a
            // leftover element in a block that just got re-rendered.
            if (Date.now() - lastNavigationClick < 500) {
                log('Ignoring toggle click right after navigation');
                return;
            }

            const wasExpanded = Array.from(block.querySelectorAll('div, p, pre')).some(el => {
                if (el === toggleButton) return false;
                const h = el.getBoundingClientRect().height;
                return h > 60 && (el.textContent || '').trim().length > 30;
            });

            if (!wasExpanded) {
                userExpandedBlocks.add(block);
                const st = blockStates.get(block);
                if (st && st.timerId) {
                    clearInterval(st.timerId);
                    st.timerId = null;
                }
                if (scrollLock.owner === block) stopScrollLock();
                log('User manually expanded, added to protected list');
            }
        }, true);
    }

    function setupUrlChangeListener() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(...args) {
            originalPushState.apply(this, args);
            onUrlChange();
        };
        history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            onUrlChange();
        };
        window.addEventListener('popstate', onUrlChange);
    }

    function onUrlChange() {
        const newUrl = location.href;
        if (newUrl === currentUrl) return;
        log(`URL changed: ${currentUrl} -> ${newUrl}`);
        currentUrl = newUrl;
        stopScrollLock();
        resetHistoricalQueue();
        if (newUrl.includes('/a/chat/')) {
            setTimeout(scanAndTrack, CONFIG.navigationDelay);
            setTimeout(scanAndTrack, CONFIG.navigationDelay * 2);
            setTimeout(scanAndTrack, CONFIG.historicalStartDelay);
            setTimeout(scanAndTrack, CONFIG.historicalStartDelay + 800);
        }
    }

    function setupObserver() {
        let scheduled = false;
        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => {
                scheduled = false;
                scanAndTrack();
            }, 200);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function init() {
        log('Script loaded');
        registerMenuCommands();
        if (!CONFIG.enabled) return;
        installScrollGuards();
        setupUserScrollIntentListeners();
        setupOutsideClickRelease();
        setupUserInteractionListener();
        setupUrlChangeListener();
        setupObserver();
        setTimeout(scanAndTrack, CONFIG.navigationDelay);
    }

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();