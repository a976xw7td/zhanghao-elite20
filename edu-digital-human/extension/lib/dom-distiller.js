/**
 * DOM Distiller — 意图驱动的页面结构蒸馏管线
 *
 * 核心升级：先拿到用户意图，再决定采集哪些区域
 * 管线: 过滤 → 去重 → 意图感知聚类 → 语义摘要 → 选择器增强 → Prompt拼装
 *
 * @module dom-distiller
 */

const DomDistiller = (() => {
  'use strict';

  // --- 配置常量 ---

  const INTERACTIVE_TAGS = new Set([
    'BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION'
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'tab', 'switch', 'checkbox', 'radio', 'combobox', 'textbox'
  ]);

  const MAX_ELEMENTS_PER_REGION = 16;
  const MAX_PRIORITY_PER_REGION = 28;
  const MAX_OFFTRACK_PER_REGION  = 8;
  const MAX_PROMPT_ELEMENTS      = 35;
  const MAX_PROMPT_ELEMENTS_FOCUSED = 60;
  const MAX_RAW_ELEMENTS = 500;
  const PRECOLLECT_TTL_MS = 30000; // 预收集缓存有效期 30 秒

  // --- 预收集缓存（在用户按下麦克风时收集，ASR 完成后直接用，省去重复扫描） ---
  let _preCollected = null;
  let _preCollectTime = 0;
  let _preCollectUrl  = '';  // URL 追踪：SPA 路由切换时自动失效缓存

  // --- 页面上下文（标题/描述/标题层级）---
  function collectPageContext(doc) {
    const title = doc.title?.replace(/\s+/g, ' ').trim().slice(0, 80) || '';
    const meta  = doc.querySelector('meta[name="description"]')?.content?.trim().slice(0, 120) || '';
    const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
      .slice(0, 6)
      .map(h => h.textContent.replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length < 80);
    return { title, meta, headings };
  }

  // --- 意图 → 优先区域 映射 ---

  const INTENT_PATTERNS = [
    // describe 意图：只问页面功能，不需要优先区域，由 LLM 根据页面上下文回答
    {
      pattern: /这个(网页|网站|页面|平台|系统).*?(是|做|干|有|能|功能|作用|用来|介绍|说明)/,
      regions: []  // 空 = 均匀采集，LLM 自行综合
    },
    {
      pattern: /(介绍|说明|解释|总结).*(网页|网站|页面|这里|这个)/,
      regions: []
    },
    {
      pattern: /登录|登陆|注册|sign[\s-]?in|log[\s-]?in|login|register|账号|账户|密码/,
      regions: ['header-bar', 'navigation', 'banner']
    },
    {
      pattern: /搜索|查找|搜一下|search|look[\s-]?for|找一下|帮我找/,
      regions: ['search', 'header-bar', 'navigation']
    },
    {
      pattern: /设置|配置|偏好|个人资料|setting|preference|profile|account/,
      regions: ['sidebar', 'navigation', 'complementary']
    },
    {
      pattern: /提交|确认|保存|发送|发布|下一步|submit|confirm|save|send|next|continue/,
      regions: ['form', 'main-content', 'main']
    },
    {
      pattern: /导航|菜单|侧边栏|menu|nav|sidebar/,
      regions: ['navigation', 'sidebar', 'complementary', 'header-bar']
    },
    {
      pattern: /购买|加入购物车|结算|checkout|cart|buy|支付|付款|order/,
      regions: ['main-content', 'main', 'sidebar']
    },
    {
      pattern: /上传|导入|文件|图片|upload|import|attach/,
      regions: ['main-content', 'form', 'main']
    },
    {
      pattern: /关闭|退出|取消|返回|close|exit|cancel|back|go[\s-]?back/,
      regions: ['header-bar', 'main-content', 'main']
    },
    // --- 教育场景（窄匹配，避免与通用意图冲突） ---
    // 仅覆盖教育特有的、通用 pattern 无法命中的意图
    {
      pattern: /(查|看|在哪|怎么).*(成绩|分数|绩点|学分)|GPA|grade|score|credit/,
      regions: ['navigation', 'sidebar', 'main-content']
    },
    {
      pattern: /(选课|退课|课表|培养方案|学籍)|(enrollment|schedule|curriculum)/,
      regions: ['navigation', 'main-content', 'sidebar']
    },
  ];

  /**
   * 根据用户意图推断需要重点采集的区域
   * 返回空数组表示无法判断意图，均匀采集
   */
  function inferPriorityRegions(intent) {
    if (!intent || intent.length < 2) return [];
    const text = intent.toLowerCase();
    for (const { pattern, regions } of INTENT_PATTERNS) {
      if (pattern.test(text)) return regions;
    }
    return [];
  }

  // --- 步骤 1: 过滤 ---

  function collectInteractive(doc) {
    const selector =
      'button, a[href], input:not([type="hidden"]), select, textarea, ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
      '[role="switch"], [role="checkbox"], [role="combobox"], ' +
      '[role="navigation"] a, [role="navigation"] button, ' +
      '[role="tablist"] [role="tab"], [role="menubar"] [role="menuitem"], ' +
      'header a, header button, nav a, nav button, ' +
      '[onclick], [tabindex]:not([tabindex="-1"])';
    const result = [];
    const candidates = doc.querySelectorAll(selector);
    for (const el of candidates) {
      result.push(el);
      if (result.length >= MAX_RAW_ELEMENTS) break;
    }
    return result;
  }

  function isVisible(el) {
    if (!el.checkVisibility) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    } else {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  function isInteractive(el) {
    const tag = el.tagName;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabIdx = el.getAttribute('tabindex');
    if (tabIdx !== null && tabIdx !== '-1') return true;
    if (el.closest('a') || el.closest('button')) return true;
    // header/nav 内的元素往往是导航项（教学平台顶部标签等）
    if (el.closest('header, nav, [role="navigation"], [role="banner"]')) return true;
    return false;
  }

  function getVisibleText(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    if (text) return text;
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 50);
  }

  // --- 步骤 2: 去重 ---

  function deduplicate(elements) {
    const seen = new Map();
    const result = [];
    for (const el of elements) {
      const key = `${el.tagName}|${getVisibleText(el)}`;
      if (!seen.has(key)) { seen.set(key, true); result.push(el); }
      else if (el.id) result.push(el);
    }
    return result;
  }

  // --- 步骤 3: 意图感知聚类 ---

  function getRegion(el) {
    const landmark = el.closest(
      '[role="banner"], [role="navigation"], [role="main"], ' +
      '[role="complementary"], [role="contentinfo"], [role="search"], [role="form"]'
    );
    if (landmark) return { name: landmark.getAttribute('role'), label: landmark.getAttribute('aria-label') || '' };

    const semantic = el.closest('header, nav, main, aside, footer');
    if (semantic) return { name: semantic.tagName.toLowerCase(), label: '' };

    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const topRatio = rect.top / vh;
    if (topRatio < 0.15) return { name: 'header-bar', label: '' };
    if (topRatio > 0.85) return { name: 'footer-bar', label: '' };
    if (rect.left > window.innerWidth * 0.7) return { name: 'sidebar', label: '' };
    return { name: 'main-content', label: '' };
  }

  /**
   * 意图感知聚类：
   * - 命中意图的区域放宽到 MAX_PRIORITY_PER_REGION（2倍）
   * - 有意图时非相关区域严格限制（4个，只作背景信息）
   * - 无意图时均匀采集（均为 MAX_ELEMENTS_PER_REGION）
   */
  function clusterByRegion(elements, priorityRegions) {
    const prioritySet = new Set(priorityRegions);
    const hasPriority  = priorityRegions.length > 0;
    const regions = {};

    for (const el of elements) {
      const region = getRegion(el);
      if (!regions[region.name]) {
        regions[region.name] = { name: region.name, label: region.label, elements: [], isPriority: prioritySet.has(region.name) };
      }

      const limit = prioritySet.has(region.name)
        ? MAX_PRIORITY_PER_REGION    // 重点区域：放宽到 28
        : hasPriority
          ? MAX_OFFTRACK_PER_REGION  // 有意图但非重点：提高到 8
          : MAX_ELEMENTS_PER_REGION; // 无意图：均匀 16

      if (regions[region.name].elements.length < limit) {
        regions[region.name].elements.push(el);
      }
    }
    return Object.values(regions);
  }

  // --- 步骤 4: 语义摘要 ---

  const REGION_LABELS_ZH = {
    'banner': '页头', 'navigation': '导航栏', 'main': '主内容区',
    'complementary': '侧边栏', 'contentinfo': '底部信息', 'search': '搜索区域',
    'form': '表单', 'header': '页头', 'nav': '导航', 'aside': '侧栏',
    'footer': '页脚', 'header-bar': '顶部区域', 'footer-bar': '底部区域',
    'sidebar': '右侧面板', 'main-content': '主内容区'
  };

  function summarizeRegion(region) {
    const label = REGION_LABELS_ZH[region.name] || region.name;
    const prefix = region.isPriority ? '★ ' : '';
    const items = region.elements.map(el => {
      const text = getVisibleText(el);
      const tag = el.tagName;
      if (tag === 'INPUT')    return `[${text || '输入框'}]`;
      if (tag === 'TEXTAREA') return `[${text || '文本区'}]`;
      if (tag === 'SELECT')   return `[${text || '下拉选择'}]`;
      return `[${text}]`;
    }).join(' ');
    return `${prefix}${label}：${items}`;
  }

  function buildPageType(regions) {
    const names = regions.map(r => r.name);
    if (names.includes('nav') || names.includes('navigation')) return '含导航栏的网页';
    if (names.includes('form')) return '表单页面';
    if (names.includes('search')) return '搜索页面';
    return '通用网页';
  }

  // --- 步骤 5: 选择器增强 ---

  function buildWeakSelector(el) {
    const tag = el.tagName.toLowerCase();
    const cls = el.classList.length > 0 ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
    return `${tag}${cls}`;
  }

  function buildStrongSelector(el) {
    const tag = el.tagName.toLowerCase();
    let sel = tag;
    if (el.id) sel += `#${CSS.escape(el.id)}`;
    if (el.classList.length > 0) sel += '.' + Array.from(el.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
    for (const attr of ['data-testid', 'data-id', 'data-qa', 'name', 'type', 'aria-label']) {
      const val = el.getAttribute(attr);
      if (val && val.length < 30) { sel += `[${attr}="${CSS.escape(val)}"]`; break; }
    }
    return sel;
  }

  function buildTextFallback(el) {
    const text = getVisibleText(el);
    if (!text) return null;
    return `//${el.tagName.toLowerCase()}[contains(text(),"${text.slice(0, 20).replace(/"/g, '')}")]`;
  }

  function toDescriptor(el) {
    return {
      tag:            el.tagName.toLowerCase(),
      text:           getVisibleText(el),
      weakSelector:   buildWeakSelector(el),
      strongSelector: buildStrongSelector(el),
      textFallback:   buildTextFallback(el),
      rect:           (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()
    };
  }

  // --- 步骤 6: Prompt 拼装 ---

  function assemblePrompt(distilled, userIntent, promptLimit) {
    const regionLines = distilled.regions.map(r => r.summary).join('\n');

    // 动态调整元素数量：大页面（如GitHub）元素文本长，超阈值时减半
    const effectiveLimit = regionLines.length > 1200 ? Math.min(promptLimit, 30) : promptLimit;

    const elements = distilled.elements
      .slice(0, effectiveLimit)
      .map(e => `  ${e.tag}[${(e.text || '').slice(0, 25)}] → ${e.strongSelector}`)
      .join('\n');
    const truncated = distilled.elements.length > effectiveLimit
      ? `\n  …省略${distilled.elements.length - effectiveLimit}个元素` : '';

    const priorityHint = distilled.focusedRegions?.length
      ? `\n重点关注区域：${distilled.focusedRegions.join('、')}\n` : '';

    // 页面上下文（标题/描述/标题层级），供"描述网页功能"类意图使用
    const ctx = distilled.pageContext;
    const contextLines = [
      ctx?.title    ? `页面标题：${ctx.title}` : '',
      ctx?.meta     ? `页面描述：${ctx.meta}`  : '',
      ctx?.headings?.length ? `主要内容：${ctx.headings.join(' / ')}` : ''
    ].filter(Boolean).join('\n');

    return `## 页面信息
${contextLines || '（无元数据）'}

## 页面类型
${distilled.pageType}
${priorityHint}
## 页面结构（★ 为与意图最相关区域）
${regionLines}

## 可交互元素（共${distilled.elements.length}个，相关区域优先排列）
${elements}${truncated}

## 用户意图
${userIntent}

请返回导航指令 JSON。`;
  }

  // --- 公共 API ---

  /**
   * @param {Document} doc
   * @param {string}   userIntent - 用户的实际意图文字（空串 = 通用采集）
   */
  /**
   * 预收集 DOM 元素（按下麦克风时调用，与录音并行，ASR 完成后 distill 直接用缓存）
   * 节省 distill 中的 collectInteractive + isVisible + deduplicate 时间（~80-150ms）
   */
  function precollect(doc) {
    const raw = collectInteractive(doc);
    _preCollected    = deduplicate(raw.filter(isVisible).filter(isInteractive));
    _preCollectTime  = Date.now();
    _preCollectUrl   = location.href;  // 记录采集时的 URL
  }

  function distill(doc, userIntent) {
    // 缓存有效条件：存在 + TTL 内 + URL 未变（防止 SPA 路由切换后用旧数据）
    const cacheValid = _preCollected
      && (Date.now() - _preCollectTime) < PRECOLLECT_TTL_MS
      && _preCollectUrl === location.href;
    const unique = cacheValid ? _preCollected : (() => {
      const raw = collectInteractive(doc);
      return deduplicate(raw.filter(isVisible).filter(isInteractive));
    })();
    _preCollected = null; // 使用后清除，避免页面变化时数据过时

    // 根据意图推断优先区域
    const priorityRegions = inferPriorityRegions(userIntent);

    // 意图感知聚类（优先区域宽限，非优先区域严格）
    const regions = clusterByRegion(unique, priorityRegions);

    // 优先区域排在前，非优先区域排在后 → LLM 首先看到最相关内容
    const sortedRegions = [...regions].sort((a, b) => {
      const ai = priorityRegions.indexOf(a.name);
      const bi = priorityRegions.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    // 按排序后的区域顺序构建元素列表（确保重点元素排在前面）
    const elements = sortedRegions.flatMap(r => r.elements).map(toDescriptor);

    const promptLimit = priorityRegions.length > 0
      ? MAX_PROMPT_ELEMENTS_FOCUSED  // 有意图：60 个，集中在相关区域
      : MAX_PROMPT_ELEMENTS;         // 无意图：35 个，均匀分布

    const pageContext = collectPageContext(doc);

    const result = {
      pageType: buildPageType(regions),
      pageContext,
      regions:  sortedRegions.map(r => ({
        name:       r.name,
        label:      r.label,
        itemCount:  r.elements.length,
        summary:    summarizeRegion(r),
        isPriority: r.isPriority
      })),
      elements,
      focusedRegions: priorityRegions.length > 0
        ? priorityRegions.map(n => REGION_LABELS_ZH[n] || n)
        : null,
      prompt: ''
    };

    result.prompt = assemblePrompt(result, userIntent, promptLimit);
    return result;
  }

  return { distill, precollect };
})();
