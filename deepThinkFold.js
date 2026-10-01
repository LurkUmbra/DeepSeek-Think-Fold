// ==UserScript==
// @name         DeepSeek Think 自动收起（思考完成后折叠）
// @namespace    https://github.com/hza2002/deepseek-collapse-think
// @version      1.0
// @description  等 DeepSeek 的 Think 思考过程完成后，再平滑折叠，避免流式渲染回弹。
// @license      MIT
// @match        https://chat.deepseek.com/*
// @icon         https://chat.deepseek.com/favicon.svg
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置项 ====================
    const DEFAULT_CONFIG = {
        enabled: true,
        debug: false,
        navigationDelay: 500,
        userInteractionCooldown: 2000,
        autoScrollToBottom: true,
        bottomThreshold: 200,
        collapseDuration: 350,
        smoothCollapse: true,
        // 【核心】内容稳定多久后认为思考结束（毫秒）
        stableThreshold: 800,
        // 轮询间隔（毫秒）
        pollInterval: 200
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
        pollInterval: DEFAULT_CONFIG.pollInterval
    };

    const SELECTORS = {
        thinkBlockContainer: '_74c0879',
        collapsedStateClass: 'e47135bc',
        toggleButton: '_5ab5d64',
        thinkContent: 'ds-think-content'
    };

    // ==================== 状态 ====================
    let currentUrl = location.href;
    let lastUserInteraction = 0;
    const blockStates = new WeakMap();
    const userExpandedBlocks = new WeakSet();

    function log(...args) {
        if (CONFIG.debug) console.log('[DeepSeek Think]', ...args);
    }

    function isInCooldown() {
        return Date.now() - lastUserInteraction < CONFIG.userInteractionCooldown;
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand === 'undefined') return;
        const statusText = CONFIG.enabled ? '✅ 已启用' : '❌ 已禁用';
        GM_registerMenuCommand(`${statusText} - 点击切换`, () => {
            CONFIG.enabled = !CONFIG.enabled;
            alert(`DeepSeek Think 自动收起: ${CONFIG.enabled ? '已启用' : '已禁用'}\n\n刷新页面后生效`);
            location.reload();
        });
    }

    // ==================== 滚动工具 ====================
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

    // ==================== 平滑折叠 ====================
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

    // ==================== 核心：追踪直到稳定 ====================
    function trackUntilStable(block) {
        if (blockStates.has(block)) return;
        if (userExpandedBlocks.has(block)) return;
        if (block.classList.contains(SELECTORS.collapsedStateClass)) return;

        const state = {
            lastLen: (block.textContent || '').length,
            lastChangeTime: Date.now(),
            timerId: null,
            done: false
        };
        blockStates.set(block, state);

        log('开始追踪思考块，初始长度:', state.lastLen);

        state.timerId = setInterval(() => {
            if (state.done) return;

            if (!document.body.contains(block)) {
                clearInterval(state.timerId);
                state.timerId = null;
                return;
            }
            if (userExpandedBlocks.has(block)) {
                clearInterval(state.timerId);
                state.timerId = null;
                log('块被用户展开，停止追踪');
                return;
            }

            const len = (block.textContent || '').length;
            if (len !== state.lastLen) {
                state.lastLen = len;
                state.lastChangeTime = Date.now();
                return;
            }

            if (Date.now() - state.lastChangeTime < CONFIG.stableThreshold) return;

            if (block.classList.contains(SELECTORS.collapsedStateClass)) {
                state.done = true;
                clearInterval(state.timerId);
                state.timerId = null;
                return;
            }

            const toggleButton = block.querySelector('.' + SELECTORS.toggleButton);
            if (!toggleButton) return;

            if (isInCooldown()) {
                // 用户在操作，等一会儿再试
                return;
            }

            state.done = true;
            clearInterval(state.timerId);
            state.timerId = null;

            const scrollContainer = getScrollContainer(block);
            const wasNearBottom = CONFIG.autoScrollToBottom ? isNearBottom(scrollContainer) : false;

            log('思考结束，开始平滑折叠');

            smoothCollapseBlock(block, toggleButton).then(() => {
                if (wasNearBottom) {
                    requestAnimationFrame(() => {
                        scrollToBottom(scrollContainer);
                        setTimeout(() => scrollToBottom(scrollContainer), 80);
                        setTimeout(() => scrollToBottom(scrollContainer), 200);
                    });
                }
            });
        }, CONFIG.pollInterval);
    }

    function scanAndTrack() {
        if (!CONFIG.enabled) return;
        const selector = `.${SELECTORS.thinkBlockContainer}:not(.${SELECTORS.collapsedStateClass})`;
        document.querySelectorAll(selector).forEach(block => {
            trackUntilStable(block);
        });
    }

    // ==================== 监听器 ====================
    function setupUserInteractionListener() {
        document.addEventListener('click', (event) => {
            const toggleButton = event.target.closest(`.${SELECTORS.toggleButton}`);
            if (!toggleButton) return;

            lastUserInteraction = Date.now();

            const block = toggleButton.closest(`.${SELECTORS.thinkBlockContainer}`);
            if (!block) return;

            // 判断点击前是否已展开
            const wasExpanded = Array.from(block.querySelectorAll('div, p, pre')).some(el => {
                if (el === toggleButton) return false;
                const h = el.getBoundingClientRect().height;
                return h > 60 && (el.textContent || '').trim().length > 30;
            });

            if (!wasExpanded) {
                // 用户正在展开，加入保护名单，停止追踪
                userExpandedBlocks.add(block);
                const st = blockStates.get(block);
                if (st && st.timerId) {
                    clearInterval(st.timerId);
                    st.timerId = null;
                }
                log('用户手动展开，加入保护名单');
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
        log(`URL 变化: ${currentUrl} -> ${newUrl}`);
        currentUrl = newUrl;
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
        log('脚本已加载');
        registerMenuCommands();
        if (!CONFIG.enabled) return;
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