/**
 * Selector Engine — 5级选择器降级策略
 *
 * L1: 精确CSS选择器 → querySelector
 * L2: 弱化选择器 → 去掉属性和id，只用tag+class；多匹配时用 fallbackText 文本筛选
 * L3: XPath文本匹配 → //tag[contains(text(),"...")]
 * L4: LLM重试 → 返回retry信号
 * L5: 语音降级 → 返回口头指引
 *
 * @module selector-engine
 */

const SelectorEngine = (() => {
  'use strict';

  const LEVELS = Object.freeze({
    EXACT: 'exact',
    WEAK: 'weak',
    XPATH: 'xpath',
    RETRY: 'retry',
    VERBAL: 'verbal'
  });

  // --- L1: 精确匹配 ---

  function tryExact(selector) {
    try {
      const el = document.querySelector(selector);
      return el ? { element: el, level: LEVELS.EXACT } : null;
    } catch (_) {
      return null;
    }
  }

  // --- L2: 弱化选择器 ---

  function weakenSelector(selector) {
    const parts = [];

    const segments = selector.split(/\s*>\s*|\s+/);
    for (const seg of segments) {
      let s = seg;

      s = s.replace(/\[[^\]]*\]/g, '');

      s = s.replace(/#[a-zA-Z_][\w-]*/g, '');

      s = s.replace(/::?(after|before|first-child|last-child|nth-child\([^)]*\))/g, '');

      const clsMatch = s.match(/^([a-zA-Z_][\w-]*)(\.[a-zA-Z_][\w-]*)/);
      if (clsMatch) {
        s = clsMatch[1] + clsMatch[2];
      }

      s = s.replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();

      if (s && s !== '.') parts.push(s);
    }

    return parts.join(' ') || null;
  }

  // BUG FIX: 多个弱化选择器匹配时，用 fallbackText 文本内容进一步筛选，而不是直接放弃
  function tryWeak(selector, fallbackText) {
    const weak = weakenSelector(selector);
    if (!weak) return null;
    try {
      const results = Array.from(document.querySelectorAll(weak));
      if (results.length === 0) return null;
      if (results.length === 1) return { element: results[0], level: LEVELS.WEAK };

      // 多个匹配：用 fallbackText 从候选中精确筛选
      if (fallbackText) {
        const norm = fallbackText.toLowerCase().replace(/\s+/g, ' ').trim();
        const match = results.find(el => {
          const t = (
            el.textContent ||
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            ''
          ).toLowerCase().replace(/\s+/g, ' ').trim();
          return t.includes(norm.slice(0, 25)) || norm.includes(t.slice(0, 25));
        });
        if (match) return { element: match, level: LEVELS.WEAK };
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  // --- L3: XPath文本匹配 ---

  function tryXPath(textFallback) {
    if (!textFallback) return null;
    try {
      const result = document.evaluate(
        textFallback,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      const el = result.singleNodeValue;
      return el ? { element: el, level: LEVELS.XPATH } : null;
    } catch (_) {
      return null;
    }
  }

  // --- L4: LLM重试信号 ---

  function signalRetry(selector, reason) {
    return {
      element: null,
      level: LEVELS.RETRY,
      retryContext: { failedSelector: selector, reason }
    };
  }

  // --- L5: 语音降级 ---

  function verbalFallback(targetText, action) {
    const guidance = buildVerbalGuidance(targetText, action);
    return { element: null, level: LEVELS.VERBAL, guidance };
  }

  function buildVerbalGuidance(targetText, action) {
    const actionMap = {
      click: `请点击页面上的"${targetText}"`,
      input: `请在"${targetText}"输入框中输入内容`,
      scroll: `请滚动到"${targetText}"所在的位置`,
      highlight: `请注意查看"${targetText}"`
    };
    return actionMap[action] || `请操作页面上的"${targetText}"`;
  }

  // --- 公共 API ---

  /**
   * 执行5级降级查找
   *
   * @param {string} selector - 目标CSS选择器
   * @param {string} fallbackText - XPath文本降级用的元素文本
   * @param {'click'|'input'|'scroll'|'highlight'} action - 操作类型
   * @returns {{ element: Element|null, level: string, guidance?: string, retryContext?: Object }}
   */
  // --- L3b: 广域文本搜索（L3 XPath 标签名写死时的兜底） ---
  // L3 生成的 XPath 形如 //button[contains(text(),"...")] 只匹配一种标签
  // 这里对所有可交互元素做全量文本比对，覆盖 div/span/a 等任意容器
  function tryBroadTextSearch(fallbackText) {
    if (!fallbackText) return null;
    // 从 XPath 格式里提取原始文本，或直接使用 fallbackText
    const match = fallbackText.match(/contains\([^,]+,"([^"]+)"\)/);
    const searchText = (match ? match[1] : fallbackText).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 25);
    if (!searchText || searchText.length < 2) return null;

    const candidates = document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, select, [onclick], [tabindex]'
    );
    for (const el of candidates) {
      const text = (
        el.textContent ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        el.value || ''
      ).toLowerCase().replace(/\s+/g, ' ').trim();
      if (text && (text.includes(searchText) || searchText.includes(text.slice(0, 20)))) {
        return { element: el, level: 'text-search' };
      }
    }
    return null;
  }

  function resolve(selector, fallbackText, action) {
    const exact = tryExact(selector);
    if (exact) return exact;

    const weak = tryWeak(selector, fallbackText);
    if (weak) return weak;

    const xpath = tryXPath(fallbackText);
    if (xpath) return xpath;

    // L3b: 广域文本搜索（L3 XPath 标签名不匹配时的兜底，覆盖 div/span/a 等任意容器）
    const textSearch = tryBroadTextSearch(fallbackText);
    if (textSearch) return textSearch;

    const targetText = fallbackText || selector;
    return verbalFallback(targetText, action);
  }

  /**
   * 带重试的全流程：L1-L3由resolve处理，L4由调用方处理
   */
  function resolveWithRetry(selector, fallbackText, action, retryCount) {
    if (retryCount > 0) {
      return signalRetry(selector, `exact/weak/xpath all failed after ${retryCount} attempts`);
    }
    return resolve(selector, fallbackText, action);
  }

  return { resolve, resolveWithRetry, LEVELS, weakenSelector, buildVerbalGuidance };
})();
