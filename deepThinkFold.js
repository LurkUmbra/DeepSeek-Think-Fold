// ==UserScript==
// @name         DeepSeek Think Stable Collapse
// @namespace    https://github.com/local/deepseek-think-stable
// @version      4.0.0
// @description  Collapse DeepSeek thinking blocks. Dynamic navigation-complete detection, per-block tracking, setter-level scroll guard, inline copy button.
// @license      MIT
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        THINK_CONTAINER: '_74c0879',
        COLLAPSED_CLASS: 'e47135bc',
        TOGGLE_BUTTON: '_5ab5d64',
        THINK_CONTENT: 'ds-think-content',

        POLL_INTERVAL_MS: 200,
        STABLE_MS: 800,
        HISTORY_ABANDON_MS: 500,        // reduced: navigation detection already guarantees readiness
        HISTORY_GAP_MS: 40,
        PIN_FRAMES: 8,
        SNAP_BACK_GUARD_MS: 1500,       // reduced: navigation is complete before fold
        USER_SCROLL_WINDOW_MS: 300,
        COLLAPSE_ANIM_MS: 300,

        // Navigation completion detection (replaces fixed grace)
        NAV_CHECK_INTERVAL_MS: 100,
        NAV_SCROLL_STABLE_CHECKS: 4,    // 4 * 100ms = 400ms scrollTop unchanged
        NAV_CONTENT_STABLE_CHECKS: 4,   // 4 * 100ms = 400ms content length unchanged
        NAV_MIN_MS: 300,                // at least 300ms after navigation start
        NAV_TIMEOUT_MS: 8000,           // safety net

        LIVE_CONFIRM_TICKS: 2,
        COPY_BTN_MARGIN_PX: 4,
        COPY_BTN_SIZE_PX: 18,
        DEBUG: false,
    };

    const log = (...a) => { if (CONFIG.DEBUG) console.log('[ThinkStable]', ...a); };
    const selContainer = '.' + CONFIG.THINK_CONTAINER;
    const selToggle = '.' + CONFIG.TOGGLE_BUTTON;
    const selContent = '.' + CONFIG.THINK_CONTENT;

    const state = {
        scrollEl: null,
        originalScrollTopDesc: null,
        originalScrollTo: null,
        originalScrollBy: null,
        originalScrollIntoView: null,
        originalWinScrollTo: null,
        originalFocus: null,

        hijacked: new WeakSet(),
        scrollResetInstalled: new WeakSet(),

        guard: { active: false, target: 0, allowWrite: false, releaseAt: 0 },
        scrollBehaviorBackup: new Map(),
        anchorBackup: new Map(),

        userScrollingUntil: 0,
        userExpanded: new WeakSet(),
        processed: new WeakSet(),
        trackers: new Map(),
        textCache: new WeakMap(),
        copyBtn: new WeakMap(),
        deferCounts: new WeakMap(),

        historyQueue: [],
        historyRunning: false,
        historyEpoch: 0,

        currentUrl: location.href,
        navigationComplete: true,        // initial load: no navigation in progress
        navDetector: {
            timer: null,
            startTime: 0,
            lastScrollTop: -1,
            scrollStableCount: 0,
            lastContentLen: -1,
            contentStableCount: 0,
        },
    };

    // ============================================================
    // Scroll container
    // ============================================================
    function findScrollableAncestor(block) {
        let n = block.parentElement;
        while (n && n !== document.documentElement) {
            const s = getComputedStyle(n);
            if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 10) return n;
            n = n.parentElement;
        }
        return null;
    }

    function getScrollEl() {
        if (state.scrollEl && state.scrollEl.isConnected) return state.scrollEl;
        const firstBlock = document.querySelector(selContainer);
        if (firstBlock) {
            const el = findScrollableAncestor(firstBlock);
            if (el) { state.scrollEl = el; return el; }
        }
        let best = null, bestScore = -1;
        for (const el of document.querySelectorAll('div, main, [role="main"]')) {
            const s = getComputedStyle(el);
            if (!/auto|scroll/.test(s.overflowY)) continue;
            if (el.scrollHeight <= el.clientHeight + 10) continue;
            const score = el.scrollHeight - el.clientHeight;
            if (score > bestScore) { bestScore = score; best = el; }
        }
        state.scrollEl = best;
        return best;
    }
    const getScrollElFrom = (b) => findScrollableAncestor(b) || getScrollEl();

    function getTotalContentLen() {
        let total = 0;
        for (const block of document.querySelectorAll(selContainer)) {
            const c = block.querySelector(selContent);
            if (c) total += (c.textContent || '').length;
        }
        return total;
    }

    // ============================================================
    // API interception — guard only blocks when navigation is COMPLETE
    // ============================================================
    function shouldBlockScroll() {
        if (!state.guard.active) return false;
        if (!state.navigationComplete) return false; // navigation in progress: let DeepSeek scroll freely
        return true;
    }

    function installApiInterceptors() {
        state.originalScrollTo = Element.prototype.scrollTo;
        Element.prototype.scrollTo = function (...a) {
            if (shouldBlockScroll()) { log('blocked Element.scrollTo'); return; }
            return state.originalScrollTo.apply(this, a);
        };
        state.originalScrollBy = Element.prototype.scrollBy;
        Element.prototype.scrollBy = function (...a) {
            if (shouldBlockScroll()) { log('blocked Element.scrollBy'); return; }
            return state.originalScrollBy.apply(this, a);
        };
        state.originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (...a) {
            if (shouldBlockScroll()) { log('blocked scrollIntoView'); return; }
            return state.originalScrollIntoView.apply(this, a);
        };
        state.originalWinScrollTo = window.scrollTo;
        window.scrollTo = function (...a) {
            if (shouldBlockScroll()) { log('blocked window.scrollTo'); return; }
            return state.originalWinScrollTo.apply(this, a);
        };
        state.originalFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...a) {
            if (shouldBlockScroll() && !state.guard.allowWrite) {
                const el = getScrollEl();
                const r = state.originalFocus.apply(this, a);
                if (el && Math.abs(el.scrollTop - state.guard.target) > 0.5) {
                    writeScrollTop(el, state.guard.target);
                }
                return r;
            }
            return state.originalFocus.apply(this, a);
        };
    }

    // ============================================================
    // scrollTop hijack — same navigation-aware guard
    // ============================================================
    function ensureHijack(el) {
        if (!el || state.hijacked.has(el)) return;
        const desc = state.originalScrollTopDesc;
        if (!desc || !desc.set) return;
        Object.defineProperty(el, 'scrollTop', {
            configurable: true,
            get() { return desc.get.call(this); },
            set(v) {
                if (shouldBlockScroll() && !state.guard.allowWrite) {
                    desc.set.call(this, state.guard.target);
                    return;
                }
                desc.set.call(this, v);
            },
        });
        state.hijacked.add(el);
        ensureScrollReset(el);
    }

    function ensureScrollReset(el) {
        if (!el || state.scrollResetInstalled.has(el)) return;
        state.scrollResetInstalled.add(el);
        el.addEventListener('scroll', () => {
            if (!shouldBlockScroll() || state.guard.allowWrite) return;
            if (Date.now() < state.userScrollingUntil) {
                state.guard.target = el.scrollTop;
                return;
            }
            if (Math.abs(el.scrollTop - state.guard.target) > 0.5) {
                state.guard.allowWrite = true;
                try { state.originalScrollTopDesc.set.call(el, state.guard.target); }
                finally { state.guard.allowWrite = false; }
            }
        }, { passive: true });
    }

    // ============================================================
    // Guard
    // ============================================================
    function activateGuard(target) {
        const el = getScrollEl();
        if (!el) return;
        ensureHijack(el);
        if (!state.guard.active) {
            state.guard.active = true;
            state.guard.target = (typeof target === 'number') ? target : el.scrollTop;
            if (!state.scrollBehaviorBackup.has(el)) state.scrollBehaviorBackup.set(el, el.style.scrollBehavior);
            el.style.scrollBehavior = 'auto';
            if (!state.anchorBackup.has(el)) state.anchorBackup.set(el, el.style.overflowAnchor);
            el.style.overflowAnchor = 'none';
        } else if (typeof target === 'number') {
            state.guard.target = target;
        }
        extendGuard(CONFIG.SNAP_BACK_GUARD_MS);
    }

    function extendGuard(ms) {
        state.guard.releaseAt = Math.max(state.guard.releaseAt, Date.now() + ms);
    }

    function deactivateGuard() {
        if (!state.guard.active) return;
        state.guard.active = false;
        state.guard.releaseAt = 0;
        for (const [el, v] of state.scrollBehaviorBackup) { try { el.style.scrollBehavior = v || ''; } catch (_) { } }
        state.scrollBehaviorBackup.clear();
        for (const [el, v] of state.anchorBackup) { try { el.style.overflowAnchor = v || ''; } catch (_) { } }
        state.anchorBackup.clear();
    }

    function writeScrollTop(el, top) {
        if (!el) return;
        const desc = state.originalScrollTopDesc;
        if (!desc || !desc.set) { el.scrollTop = top; return; }
        state.guard.allowWrite = true;
        try { desc.set.call(el, top); } finally { state.guard.allowWrite = false; }
        state.guard.target = el.scrollTop;
    }

    // ============================================================
    // User scroll intent
    // ============================================================
    function installUserScrollDetection() {
        const mark = () => { state.userScrollingUntil = Date.now() + CONFIG.USER_SCROLL_WINDOW_MS; };
        document.addEventListener('wheel', mark, { passive: true, capture: true });
        document.addEventListener('touchstart', mark, { passive: true, capture: true });
        document.addEventListener('touchmove', mark, { passive: true, capture: true });
        document.addEventListener('keydown', (e) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) mark();
        }, { passive: true, capture: true });
    }
    const userIsScrolling = () => Date.now() < state.userScrollingUntil;

    // ============================================================
    // Navigation detection (replaces fixed grace)
    //
    // Goal: mark navigationComplete = true only when DeepSeek has
    // truly finished scrolling AND rendering. Until then, guard is
    // inert and DeepSeek scrolls freely.
    // ============================================================
    function startNavigationDetection() {
        if (state.navDetector.timer) {
            clearInterval(state.navDetector.timer);
            state.navDetector.timer = null;
        }
        // CRITICAL: release guard immediately so navigation scroll is not blocked
        deactivateGuard();
        state.navigationComplete = false;

        const d = state.navDetector;
        d.startTime = Date.now();
        d.lastScrollTop = -1;
        d.scrollStableCount = 0;
        d.lastContentLen = getTotalContentLen();
        d.contentStableCount = 0;

        d.timer = setInterval(checkNavigationComplete, CONFIG.NAV_CHECK_INTERVAL_MS);
        log('navigation detection started');
    }

    function checkNavigationComplete() {
        const now = Date.now();
        const elapsed = now - state.navDetector.startTime;
        const d = state.navDetector;

        if (elapsed > CONFIG.NAV_TIMEOUT_MS) {
            log('navigation timeout, forcing complete');
            finishNavigation();
            return;
        }

        const el = getScrollEl();
        if (!el) return; // container not yet in DOM

        // Scroll stability
        const top = el.scrollTop;
        if (d.lastScrollTop < 0) {
            d.lastScrollTop = top;
            d.scrollStableCount = 0;
        } else if (Math.abs(top - d.lastScrollTop) < 1) {
            d.scrollStableCount++;
        } else {
            d.scrollStableCount = 0;
            d.lastScrollTop = top;
        }

        // Content stability
        const contentLen = getTotalContentLen();
        if (contentLen === d.lastContentLen) {
            d.contentStableCount++;
        } else {
            d.contentStableCount = 0;
            d.lastContentLen = contentLen;
        }

        // User scrolling: navigation not complete until user stops
        if (userIsScrolling()) {
            d.scrollStableCount = 0;
            d.contentStableCount = 0;
            return;
        }

        const scrollStable = d.scrollStableCount >= CONFIG.NAV_SCROLL_STABLE_CHECKS;
        const contentStable = d.contentStableCount >= CONFIG.NAV_CONTENT_STABLE_CHECKS;
        const minTime = elapsed >= CONFIG.NAV_MIN_MS;

        if (scrollStable && contentStable && minTime) {
            log('navigation complete: scrollStable=' + d.scrollStableCount + ', contentStable=' + d.contentStableCount);
            finishNavigation();
        }
    }

    function finishNavigation() {
        if (state.navDetector.timer) {
            clearInterval(state.navDetector.timer);
            state.navDetector.timer = null;
        }
        state.navigationComplete = true;
        // Start tracking blocks that are now safe to process
        processPendingBlocks();
    }

    function processPendingBlocks() {
        for (const block of document.querySelectorAll(selContainer)) {
            injectCopyButton(block);
            if (isCollapsed(block)) { cacheText(block); continue; }
            if (state.userExpanded.has(block)) continue;
            if (state.processed.has(block)) continue;
            trackBlock(block);
        }
    }

    // ============================================================
    // Sidebar / link click detection
    // ============================================================
    function installNavigationClickListener() {
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ds-copy-think')) return;
            if (e.target.closest(selContainer)) return; // links inside thinking blocks are not navigation
            const link = e.target.closest('a[href]');
            if (!link) return;
            // Any anchor click is potentially a navigation. Start detection immediately.
            log('navigation click detected');
            startNavigationDetection();
        }, true);
    }

    // ============================================================
    // Think block helpers
    // ============================================================
    const isCollapsed = (b) => b.classList.contains(CONFIG.COLLAPSED_CLASS);
    const getToggle = (b) => b.querySelector(selToggle);
    const getContent = (b) => b.querySelector(selContent);
    const getLen = (b) => { const c = getContent(b); return c ? (c.textContent || '').length : 0; };
    function getText(block) {
        if (state.textCache.has(block)) return state.textCache.get(block);
        const c = getContent(block);
        return c ? (c.textContent || '') : '';
    }
    function cacheText(block) {
        const c = getContent(block);
        if (c) { const t = c.textContent || ''; if (t) state.textCache.set(block, t); }
    }

    // ============================================================
    // Copy button
    // ============================================================
    const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="20 6 9 17 4 12"/></svg>';

    function injectCopyButton(block) {
        if (state.copyBtn.has(block)) return;
        const toggle = getToggle(block);
        if (!toggle) return;
        if (toggle.querySelector('.ds-copy-think')) return;
        const span = document.createElement('span');
        span.className = 'ds-copy-think';
        span.setAttribute('role', 'button');
        span.setAttribute('tabindex', '0');
        span.title = '复制思考内容';
        span.setAttribute('aria-label', '复制思考内容');
        span.innerHTML = COPY_SVG;
        span.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${CONFIG.COPY_BTN_SIZE_PX}px;height:${CONFIG.COPY_BTN_SIZE_PX}px;margin-left:${CONFIG.COPY_BTN_MARGIN_PX}px;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer;opacity:0.55;flex-shrink:0;vertical-align:middle;line-height:1;user-select:none;`;
        const doCopy = (e) => {
            e.stopPropagation(); e.preventDefault();
            const text = getText(block);
            if (!text) return;
            const finish = (ok) => {
                if (!ok) { span.title = '复制失败'; return; }
                span.innerHTML = CHECK_SVG; span.style.color = '#22c55e'; span.title = '已复制';
                setTimeout(() => { span.innerHTML = COPY_SVG; span.style.color = ''; span.title = '复制思考内容'; }, 1200);
            };
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(() => finish(true), () => finish(false));
            } else {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                const ok = document.execCommand('copy'); ta.remove(); finish(ok);
            }
        };
        span.addEventListener('click', doCopy);
        span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') doCopy(e); });
        span.addEventListener('mousedown', (e) => e.stopPropagation());
        const ts = getComputedStyle(toggle);
        if (ts.display !== 'flex' && ts.display !== 'inline-flex') {
            toggle.style.display = 'inline-flex'; toggle.style.alignItems = 'center';
        }
        toggle.appendChild(span);
        state.copyBtn.set(block, span);
    }

    // ============================================================
    // Manual expansion protection
    // ============================================================
    function installManualExpansionListener() {
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ds-copy-think')) return;
            const toggle = e.target.closest(selToggle);
            if (!toggle) return;
            const block = toggle.closest(selContainer);
            if (!block) return;
            if (isCollapsed(block)) {
                state.userExpanded.add(block);
                const tr = state.trackers.get(block);
                if (tr && tr.timer) { clearInterval(tr.timer); tr.timer = null; }
                state.trackers.delete(block);
            }
        }, true);
    }

    // ============================================================
    // History queue
    // ============================================================
    function enqueueHistory(block) {
        if (state.processed.has(block)) return;
        if (state.historyQueue.includes(block)) return;
        state.historyQueue.push(block);
        runHistoryQueue();
    }

    async function runHistoryQueue() {
        if (state.historyRunning) return;
        state.historyRunning = true;
        const epoch = state.historyEpoch;
        try {
            // Wait for navigation to be truly complete before folding
            while (!state.navigationComplete) {
                if (epoch !== state.historyEpoch) return;
                await new Promise(r => setTimeout(r, 100));
            }
            while (state.historyQueue.length > 0) {
                if (epoch !== state.historyEpoch) break;
                if (!state.navigationComplete) {
                    // Navigation restarted mid-queue (user clicked another link)
                    await new Promise(r => setTimeout(r, 100));
                    continue;
                }
                const block = state.historyQueue.shift();
                if (!block.isConnected || isCollapsed(block) || state.userExpanded.has(block) || state.processed.has(block)) continue;
                await foldHistoryBlock(block, epoch);
                await new Promise(r => setTimeout(r, CONFIG.HISTORY_GAP_MS));
            }
        } finally {
            if (epoch === state.historyEpoch) state.historyRunning = false;
        }
    }

    function resetHistoryQueue() {
        state.historyEpoch++;
        state.historyQueue = [];
        state.historyRunning = false;
    }

    // ============================================================
    // History fold
    // ============================================================
    async function foldHistoryBlock(block, epoch) {
        if (epoch !== state.historyEpoch) return;
        if (!state.navigationComplete) return;

        const el = getScrollElFrom(block);
        const toggle = getToggle(block);
        if (!el || !toggle) return;

        ensureHijack(el);
        if (!state.guard.active) activateGuard(el.scrollTop);

        const foldStartTarget = state.guard.target;
        const containerRect = el.getBoundingClientRect();
        const blockRect = block.getBoundingClientRect();
        const aboveViewport = Math.max(0, containerRect.top - blockRect.top);
        const h1 = block.offsetHeight;
        const btnH = toggle.offsetHeight || 40;
        const estShrink = Math.max(0, h1 - btnH);
        const estComp = Math.min(estShrink, aboveViewport);

        if (estComp > 0) writeScrollTop(el, Math.max(0, foldStartTarget - estComp));
        cacheText(block);
        try { toggle.click(); } catch (_) { }

        await new Promise((resolve) => {
            let left = CONFIG.PIN_FRAMES;
            const step = () => {
                if (left-- <= 0 || userIsScrolling() || epoch !== state.historyEpoch) { resolve(); return; }
                if (estComp > 0) {
                    const h2 = block.offsetHeight;
                    const realShrink = Math.max(0, h1 - h2);
                    const realComp = Math.min(realShrink, aboveViewport);
                    const corrected = Math.max(0, foldStartTarget - realComp);
                    if (Math.abs(corrected - state.guard.target) > 0.5) writeScrollTop(el, corrected);
                    else if (Math.abs(el.scrollTop - state.guard.target) > 0.5) writeScrollTop(el, state.guard.target);
                } else {
                    if (Math.abs(el.scrollTop - state.guard.target) > 0.5) writeScrollTop(el, state.guard.target);
                }
                requestAnimationFrame(step);
            };
            step();
        });

        if (epoch !== state.historyEpoch) return;
        state.processed.add(block);
        extendGuard(CONFIG.SNAP_BACK_GUARD_MS);
    }

    // ============================================================
    // Per-block tracker
    // ============================================================
    function trackBlock(block) {
        if (state.trackers.has(block)) return;
        if (state.userExpanded.has(block)) return;
        if (state.processed.has(block)) return;
        if (isCollapsed(block)) return;
        if (!state.navigationComplete) return; // never track during navigation

        if (getLen(block) === 0) {
            const count = state.deferCounts.get(block) || 0;
            if (count < 5) {
                state.deferCounts.set(block, count + 1);
                setTimeout(() => trackBlock(block), 300);
            }
            return;
        }

        const now = Date.now();
        const st = {
            lastLen: getLen(block),
            lastChange: now,
            startTime: now,
            sawGrowth: false,
            growthTicks: 0,
            done: false,
            timer: null,
        };
        state.trackers.set(block, st);

        st.timer = setInterval(() => {
            if (st.done) return;
            if (!block.isConnected) { stopTracker(block, st); return; }
            if (state.userExpanded.has(block)) { stopTracker(block, st); return; }
            if (state.processed.has(block)) { stopTracker(block, st); return; }

            // If navigation restarted, pause tracking (block may be re-rendered)
            if (!state.navigationComplete) {
                st.done = true;
                stopTracker(block, st);
                return;
            }

            injectCopyButton(block);
            cacheText(block);

            const len = getLen(block);
            if (len !== st.lastLen) {
                st.lastLen = len;
                st.lastChange = Date.now();
                st.growthTicks++;
                if (!st.sawGrowth && st.growthTicks >= CONFIG.LIVE_CONFIRM_TICKS) {
                    st.sawGrowth = true;
                    const el = getScrollElFrom(block);
                    if (el && !userIsScrolling() && !state.guard.active) {
                        activateGuard(el.scrollTop);
                    }
                }
                return;
            }

            st.growthTicks = 0;

            if (!st.sawGrowth) {
                if (Date.now() - st.lastChange >= CONFIG.HISTORY_ABANDON_MS) {
                    st.done = true;
                    stopTracker(block, st);
                    enqueueHistory(block);
                }
                return;
            }

            if (Date.now() - st.lastChange < CONFIG.STABLE_MS) return;
            if (isCollapsed(block)) { stopTracker(block, st); return; }

            st.done = true;
            stopTracker(block, st);
            collapseLive(block);
        }, CONFIG.POLL_INTERVAL_MS);
    }

    function stopTracker(block, st) {
        if (st.timer) { clearInterval(st.timer); st.timer = null; }
        state.trackers.delete(block);
    }

    // ============================================================
    // Live collapse
    // ============================================================
    function collapseLive(block) {
        if (!block.isConnected || isCollapsed(block) || state.userExpanded.has(block)) return;
        if (!state.navigationComplete) return;
        const toggle = getToggle(block);
        const el = getScrollElFrom(block);
        if (!toggle || !el) return;

        ensureHijack(el);
        if (!state.guard.active) activateGuard(el.scrollTop);
        cacheText(block);

        const h1 = block.offsetHeight;
        let endH = toggle.offsetHeight || 40;
        if (endH < 20) endH = 40;
        block.style.overflow = 'hidden';
        block.style.height = h1 + 'px';
        block.style.transition = `height ${CONFIG.COLLAPSE_ANIM_MS}ms ease, opacity ${CONFIG.COLLAPSE_ANIM_MS}ms ease`;
        block.style.willChange = 'height, opacity';
        void block.offsetHeight;
        requestAnimationFrame(() => {
            block.style.height = endH + 'px';
            block.style.opacity = '0.35';
        });

        setTimeout(() => {
            try { toggle.click(); } catch (_) { }
            block.style.height = '';
            block.style.overflow = '';
            block.style.transition = '';
            block.style.opacity = '';
            block.style.willChange = '';
            state.processed.add(block);
            extendGuard(CONFIG.SNAP_BACK_GUARD_MS);
            monitorAnswerStability(el);
        }, CONFIG.COLLAPSE_ANIM_MS + 30);
    }

    function monitorAnswerStability(el) {
        let lastH = el.scrollHeight;
        let lastChange = Date.now();
        const timer = setInterval(() => {
            if (!state.guard.active || !el.isConnected) { clearInterval(timer); return; }
            const h = el.scrollHeight;
            if (h !== lastH) { lastH = h; lastChange = Date.now(); return; }
            if (Date.now() - lastChange >= CONFIG.STABLE_MS) {
                clearInterval(timer);
                if (Date.now() >= state.guard.releaseAt && !userIsScrolling()) deactivateGuard();
            }
        }, CONFIG.POLL_INTERVAL_MS);
    }

    // ============================================================
    // Scan
    // ============================================================
    function scan() {
        const first = document.querySelector(selContainer);
        if (first) {
            const el = getScrollElFrom(first);
            if (el) ensureHijack(el);
        }
        for (const block of document.querySelectorAll(selContainer)) {
            injectCopyButton(block);
            if (isCollapsed(block)) { cacheText(block); continue; }
            if (state.userExpanded.has(block)) continue;
            if (state.processed.has(block)) continue;
            if (!state.navigationComplete) continue;
            trackBlock(block);
        }
    }

    // ============================================================
    // SPA routing
    // ============================================================
    function installUrlListener() {
        const onUrl = () => {
            const url = location.href;
            if (url === state.currentUrl) return;
            log('URL change', state.currentUrl, '->', url);
            state.currentUrl = url;

            resetHistoryQueue();
            for (const [block, st] of state.trackers) {
                if (st.timer) clearInterval(st.timer);
                st.done = true;
            }
            state.trackers.clear();
            state.scrollEl = null;

            // Start dynamic navigation detection (releases guard immediately)
            startNavigationDetection();

            setTimeout(scan, 300);
            setTimeout(scan, 900);
            setTimeout(scan, 2000);
            setTimeout(scan, 4000);
        };
        const op = history.pushState, or = history.replaceState;
        history.pushState = function (...a) { op.apply(this, a); onUrl(); };
        history.replaceState = function (...a) { or.apply(this, a); onUrl(); };
        window.addEventListener('popstate', onUrl);
    }

    function installObserver() {
        let scheduled = false;
        const mo = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => { scheduled = false; scan(); }, 200);
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    function installGuardWatchdog() {
        setInterval(() => {
            if (!state.guard.active) return;
            if (userIsScrolling()) return;
            if (Date.now() >= state.guard.releaseAt) deactivateGuard();
        }, CONFIG.POLL_INTERVAL_MS);
    }

    function init() {
        state.originalScrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        installApiInterceptors();
        installUserScrollDetection();
        installNavigationClickListener();
        installManualExpansionListener();
        installUrlListener();
        installObserver();
        installGuardWatchdog();
        let tries = 0;
        const boot = setInterval(() => {
            if (document.querySelector(selContainer) || ++tries > 50) {
                clearInterval(boot);
                scan();
            }
        }, 200);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();