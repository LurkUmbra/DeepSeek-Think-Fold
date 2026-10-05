// ==UserScript==
// @name         DeepSeek Think Auto-Collapse (Collapse After Thinking + Copy Button + Scroll Lock)
// @namespace    https://github.com/hza2002/deepseek-collapse-think
// @version      3.1
// @description  Smoothly collapse DeepSeek's Think block after reasoning completes. Adds a copy button and locks scroll position only for the message you just sent.
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
        releaseLockOnOutsideClick: true
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
        releaseLockOnOutsideClick: DEFAULT_CONFIG.releaseLockOnOutsideClick
    };

    // ==================== Selectors ====================
    const SELECTORS = {
        thinkBlockContainer: '_74c0879',
        collapsedStateClass: '_e47135bc',
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

    // ==================== Scroll Lock ====================
    const scrollLock = {
        active: false,
        container: null,
        scrollTop: 0,
        userIntentUntil: 0,
        onScroll: null,
        owner: null,
        monitorTimer: null
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

    // ==================== Smooth Collapse ====================
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

    // ==================== Track Until Stable, Then Collapse ====================
    function trackUntilStable(block) {
        if (blockStates.has(block)) return;
        if (userExpandedBlocks.has(block)) return;
        if (block.classList.contains(SELECTORS.collapsedStateClass)) return;

        const state = {
            lastLen: (block.textContent || '').length,
            lastChangeTime: Date.now(),
            timerId: null,
            done: false,
            // KEY: only true if we ever saw the content grow.
            // Historical replays have fixed content, so this stays false
            // and no scroll lock / scroll-to-answer is triggered.
            sawGrowth: false
        };
        blockStates.set(block, state);

        log('Start tracking think block, initial length:', state.lastLen);

        // NOTE: intentionally NOT starting the scroll lock here.
        // We only lock once we observe the content growing.

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

                // Content is growing => this is the live generation.
                // Engage the scroll lock now (and only now).
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
            const shouldScroll = state.sawGrowth && CONFIG.scrollToAnswerAfterCollapse;

            log('Thinking complete, starting smooth collapse. willScroll=' + shouldScroll);

            smoothCollapseBlock(block, toggleButton).then(() => {
                if (shouldScroll) {
                    // Live generation: keep the lock and re-anchor to the folded block.
                    if (scrollLock.active && scrollLock.container === scrollContainer) {
                        scrollLock.owner = block;
                    } else {
                        startScrollLock(scrollContainer, block);
                    }
                    scrollToAnswer(block, scrollContainer);
                    monitorAnswerStability(scrollContainer);
                } else {
                    // Historical replay: fold quietly, no scrolling, no locking.
                    if (scrollLock.owner === block) stopScrollLock();
                }
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
        document.addEventListener('click', (event) => {
            if (event.target.closest('.' + COPY_BTN_CLASS)) return;

            const toggleButton = event.target.closest(`.${SELECTORS.toggleButton}`);
            if (!toggleButton) return;

            lastUserInteraction = Date.now();

            const block = toggleButton.closest(`.${SELECTORS.thinkBlockContainer}`);
            if (!block) return;

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
        if (newUrl.includes('/a/chat/')) {
            setTimeout(scanAndTrack, CONFIG.navigationDelay);
            setTimeout(scanAndTrack, CONFIG.navigationDelay * 2);
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