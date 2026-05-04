/**
 * Background Service Worker — 编排中枢
 *
 * 唯一状态持有者 + 消息路由 + API 编排
 * ES Module，通过 import 加载 llm-client
 */

import { infer, inferMinimal, MODELS } from '../lib/llm-client.js';
import { transcribe } from '../lib/asr-client.js';

// --- 应用状态 (单一数据源) ---
// 注意：demo 阶段保留默认密钥供快速演示；生产/开源前应通过设置面板覆盖并从源码移除
const STATE = {
  apiKey: '',
  model: 'v4flash',
  asrApiKey: '',
  asrEndpoint: '',
  currentPage: null,
  currentPageUrl: null,
  animState: 'idle',
  isProcessing: false,
  isRecording: false,
  activeTabId: null,
  domDistillPromise: null,
  recordingTimer: null
};

// 设置是否已从 storage 加载（避免每次语音查询都读 storage，节省 ~20ms）
// 声明在 onMessage 之前，避免 let TDZ 问题
let _settingsLoaded = false;

// --- 懒加载用户设置 ---
// MV3 Service Worker 随时可能被 Chrome 回收；onInstalled/onStartup 不覆盖任意重启
// 每次进入关键流程前从 storage 同步，确保用户保存的 key 生效
async function ensureSettings() {
  const stored = await chrome.storage.local.get(['apiKey', 'model', 'asrApiKey', 'asrEndpoint']);
  if (stored.apiKey) STATE.apiKey = stored.apiKey;
  if (stored.model) STATE.model = stored.model;
  if (stored.asrApiKey !== undefined) STATE.asrApiKey = stored.asrApiKey;
  if (stored.asrEndpoint !== undefined) STATE.asrEndpoint = stored.asrEndpoint;
}

// --- 推送状态文本到侧边栏 ---
function pushStatus(state, text) {
  chrome.runtime.sendMessage({ type: 'STATUS_TEXT', payload: { state, text } }).catch(() => {});
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'STATUS_TEXT', payload: { state, text } }).catch(() => {});
  }).catch(() => {});
}

// --- 初始化 ---
chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  console.log('[智引灵] AI 导航导师已就绪');
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
});

// --- Content Script 存活检测 + 按需注入 ---
// 针对扩展安装前已打开的标签页（content script 未注入的情况）
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'lib/dom-distiller.js',
          'lib/selector-engine.js',
          'lib/task-queue.js',
          'content/content.js'
        ]
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css']
      });
      // 等待脚本初始化完成
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.warn('[SW] Content script inject failed:', e.message);
    }
  }
}

// --- 消息路由 ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { type, payload } = msg;

  switch (type) {
    case 'CTRL_START_REC': {
      if (STATE.isRecording || STATE.isProcessing) {
        sendResponse({ ok: false, error: 'BUSY' });
        break;
      }
      STATE.isRecording = true;
      if (STATE.recordingTimer) clearTimeout(STATE.recordingTimer);
      STATE.recordingTimer = setTimeout(() => {
        if (STATE.isRecording) {
          console.warn('[SW] Recording timeout, resetting');
          STATE.isRecording = false;
          STATE.activeTabId = null;
          STATE.recordingTimer = null;
          pushStatus('idle', '⚠️ 录音超时，请重试');
          setAnim('idle');
        }
      }, 30000);

      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) {
            STATE.isRecording = false;
            sendResponse({ ok: false, error: 'NO_TAB' });
            pushStatus('idle', '⚠️ 无法获取当前页面');
            return;
          }
          if (/^(chrome|about|data|javascript):/i.test(tab.url || '')) {
            STATE.isRecording = false;
            sendResponse({ ok: false, error: 'INVALID_TAB' });
            pushStatus('idle', '⚠️ 请先打开一个普通网页再使用语音功能');
            return;
          }
          STATE.activeTabId = tab.id;

          // 确保 content script 已注入（处理扩展安装前已打开的标签）
          await ensureContentScript(tab.id);

          // 按下麦克风时触发 DOM 预收集（与录音并行，不等结果）
          // ASR 完成后 distill 会直接用这份缓存，省去重复 DOM 扫描（~80-150ms）
          chrome.tabs.sendMessage(tab.id, { type: 'DOM_PRECOLLECT' }).catch(() => {});

          chrome.tabs.sendMessage(tab.id, { type: 'START_REC' }).catch(() => {
            STATE.isRecording = false;
            STATE.activeTabId = null;
            if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
            pushStatus('idle', '⚠️ 无法连接页面，请刷新后重试');
            setAnim('idle');
          });
          sendResponse({ ok: true });
        } catch (e) {
          STATE.isRecording = false;
          STATE.activeTabId = null;
          if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
          console.error('[SW] CTRL_START_REC error:', e.message);
          pushStatus('idle', '⚠️ 无法连接页面，请刷新后重试');
          setAnim('idle');
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    case 'CTRL_STOP_REC': {
      const tabId = STATE.activeTabId;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'STOP_REC' }).catch(() => {});
      } else {
        pushStatus('idle', '准备就绪 — 按住麦克风说话');
      }
      sendResponse({ ok: true });
      break;
    }

    case 'RECORDING_DONE':
      STATE.isRecording = false;
      STATE.activeTabId = null;
      if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
      if (payload.error === 'NO_AUDIO') {
        pushStatus('idle', '⚠️ 未录到声音，请重试');
        setAnim('idle');
      } else if (payload.error) {
        pushStatus('idle', '⚠️ 录音失败，请重试');
        setAnim('idle');
      } else {
        handleVoiceInput(payload.audio, payload.mimeType).catch(() => {});
      }
      sendResponse({ ack: true });
      break;

    case 'RECORDING_ERROR': {
      STATE.isRecording = false;
      STATE.activeTabId = null;
      if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
      const errMsg = payload.error === 'NotAllowedError'
        ? '⚠️ 请点击地址栏麦克风图标，允许此网站使用麦克风'
        : payload.error === 'NotFoundError'
          ? '⚠️ 未检测到麦克风设备'
          : '⚠️ 录音失败: ' + payload.message;
      console.error('[SW] Recording error:', payload.error, payload.message);
      pushStatus('idle', errMsg);
      setAnim('idle');
      sendResponse({ ack: true });
      break;
    }

    case 'VOICE_INPUT':
      handleVoiceInput(payload.audio, payload.mimeType).then(sendResponse);
      return true;

    case 'ASR_RESULT':
      handleAsrResult(payload.transcript).then(sendResponse);
      return true;

    case 'PAGE_CHANGED':
      STATE.currentPage = null;
      STATE.domDistillPromise = null;
      sendResponse({ ack: true });
      break;

    case 'OPEN_SIDE_PANEL':
      chrome.sidePanel.open({ windowId: sender.tab?.windowId }).catch(() => {});
      sendResponse({ ack: true });
      break;

    case 'SET_API_KEY':
      _settingsLoaded = false; // 设置变更，下次强制重新加载
      setApiKey(payload.key).then(sendResponse);
      return true;

    case 'SET_MODEL':
      _settingsLoaded = false;
      STATE.model = payload.model;
      chrome.storage.local.set({ model: payload.model });
      sendResponse({ success: true });
      break;

    case 'SET_ASR_CONFIG':
      _settingsLoaded = false;
      STATE.asrApiKey = payload.key || '';
      STATE.asrEndpoint = payload.endpoint || '';
      chrome.storage.local.set({ asrApiKey: STATE.asrApiKey, asrEndpoint: STATE.asrEndpoint });
      sendResponse({ success: true, message: 'ASR 配置已保存' });
      break;

    case 'GET_STATE':
      sendResponse({
        apiKeySet: !!STATE.apiKey,
        model: STATE.model,
        asrApiKeySet: !!STATE.asrApiKey,
        asrEndpoint: STATE.asrEndpoint
      });
      break;

    default:
      sendResponse({ error: 'UNKNOWN_TYPE' });
  }
});

// --- 语音输入：先 ASR 拿到意图，再针对性蒸馏 ---
async function handleVoiceInput(audioBase64, mimeType) {
  if (STATE.isProcessing) return { error: 'BUSY' };

  if (!_settingsLoaded) { await ensureSettings(); _settingsLoaded = true; }

  if (!STATE.asrApiKey) {
    setAnim('idle');
    pushStatus('idle', '⚠️ 请在设置面板填入 ASR API Key');
    await speakText('请先配置语音识别的 API Key');
    return { error: 'NO_ASR_KEY' };
  }
  if (!STATE.apiKey) {
    setAnim('idle');
    pushStatus('idle', '⚠️ 请在设置面板填入 DeepSeek API Key');
    await speakText('请先配置 DeepSeek API Key');
    return { error: 'NO_API_KEY' };
  }

  STATE.isProcessing = true;
  setAnim('thinking');
  console.log('[SW] Voice input, audio size:', audioBase64?.length);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('NO_TAB');
    console.log('[SW] Tab:', tab.url);

    // ── 第一步：ASR 语音识别 ──
    const asrResult = await transcribe(audioBase64, mimeType, STATE.asrApiKey, STATE.asrEndpoint);
    const transcript = asrResult.text?.trim();
    if (!transcript) throw new Error('ASR_EMPTY');
    console.log('[SW] ASR done:', transcript);

    // ── 第二步：用实际意图做针对性 DOM 蒸馏 ──
    // 知道"用户要找登录按钮"后，只重点扫描顶部导航，不再收集整页所有元素
    const domResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'DOM_DISTILL',
      payload: { intent: transcript }
    });
    if (!domResult || domResult.error) throw new Error('DOM_DISTILL_FAILED');
    console.log('[SW] DOM distilled with intent, focused on:', domResult.focusedRegions?.join(', ') || 'all regions');

    return await processIntent(transcript, domResult, tab);

  } catch (e) {
    console.error('[智引灵] Voice error:', e.message);
    setAnim('idle');

    const msgs = {
      'ASR_KEY_MISSING': '请配置 ASR API Key',
      'ASR_AUTH_ERROR': 'ASR Key 无效',
      'ASR_TIMEOUT': '语音识别超时，请重试',
      'ASR_NETWORK': '网络连接失败',
      'ASR_EMPTY': '没听到说话，请按住按钮说完再松开',
      'ASR_NO_AUDIO': '未收到音频数据',
      'NO_TAB': '无法获取当前页面',
      'DOM_DISTILL_FAILED': '页面分析失败',
      'API_EMPTY_RESPONSE': '页面元素太多，请重试',
      'API_JSON_ERROR': '响应格式异常，请重试'
    };
    const msg = msgs[e.message] || '出错了，请再试一次';
    await speakText(msg);
    return { error: e.message, message: msg };

  } finally {
    STATE.isProcessing = false;
  }
}

// --- 文字输入 ---
async function handleAsrResult(transcript) {
  if (STATE.isProcessing) return { error: 'BUSY' };

  if (!_settingsLoaded) { await ensureSettings(); _settingsLoaded = true; }

  if (!STATE.apiKey) {
    setAnim('idle');
    pushStatus('idle', '⚠️ 请在设置面板填入 DeepSeek API Key');
    await speakText('请先配置 DeepSeek API Key');
    return { error: 'NO_API_KEY' };
  }

  STATE.isProcessing = true;
  setAnim('thinking');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('NO_TAB');

    const domResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'DOM_DISTILL',
      payload: { intent: transcript }
    });

    if (!domResult || domResult.error) throw new Error('DOM_DISTILL_FAILED');

    STATE.currentPage = domResult;
    return await processIntent(transcript, domResult, tab);

  } catch (e) {
    console.error('[智引灵] Error:', e.message);
    setAnim('idle');

    const msgs = {
      'API_KEY_MISSING': '请先配置 API Key',
      'API_AUTH_ERROR': 'API Key 无效，请检查',
      'API_TIMEOUT': '请求超时，请重试',
      'API_RATE_LIMIT': '请求太频繁，请稍等',
      'NO_TAB': '无法获取当前页面',
      'DOM_DISTILL_FAILED': '页面分析失败'
    };
    const msg = msgs[e.message] || '出错了，请再试一次';
    await speakText(msg);
    return { error: e.message, speech: msg };

  } finally {
    STATE.isProcessing = false;
  }
}

// --- 共享: LLM 推理 → 执行 → TTS ---
async function processIntent(transcript, domResult, tab) {
  const prompt = domResult.prompt.replace(
    /(## 用户意图\n)[\s\S]*?(\n请返回导航指令 JSON。)/,
    (_, p1, p2) => `${p1}${transcript}${p2}`
  );

  let instruction;
  try {
    instruction = await infer(prompt, transcript, STATE.apiKey, STATE.model);
  } catch (e) {
    if (e.message !== 'API_EMPTY_RESPONSE') throw e;

    // 全量 prompt 触发了安全过滤或 token 耗尽 → 极简 prompt 重试
    // 只保留区域摘要，去掉所有选择器细节
    console.warn('[SW] API_EMPTY_RESPONSE, retrying with minimal prompt...');
    const regionSummary = domResult.regions.map(r => r.summary).join('\n');
    instruction = await inferMinimal(regionSummary, transcript, STATE.apiKey, STATE.model);
  }

  let execResult;
  if (instruction.tasks && instruction.tasks.length > 0) {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXEC_TASK_QUEUE',
      payload: { tasks: instruction.tasks }
    });
  } else if (instruction.action === 'highlight') {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXEC_HIGHLIGHT',
      payload: { selector: instruction.target, fallbackText: instruction.fallbackText }
    });
    // 高亮后验证：如果 LLM 提供了 verifyText，检查高亮元素文字是否匹配
    if (instruction.verifyText && execResult?.success) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'EXEC_VERIFY_HIGHLIGHT',
        payload: { verifyText: instruction.verifyText }
      }).catch(() => {});
    }
  } else if (instruction.action === 'click') {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXEC_HIGHLIGHT',
      payload: { selector: instruction.target, fallbackText: instruction.fallbackText }
    });
    if (instruction.verifyText && execResult?.success) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'EXEC_VERIFY_HIGHLIGHT',
        payload: { verifyText: instruction.verifyText }
      }).catch(() => {});
    }
  } else if (instruction.action === 'input') {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXEC_INPUT',
      payload: {
        selector: instruction.target,
        fallbackText: instruction.fallbackText,
        value: instruction.value
      }
    });
  } else if (instruction.action === 'scroll') {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXEC_SCROLL',
      payload: { selector: instruction.target, fallbackText: instruction.fallbackText }
    });
  } else if (instruction.action === 'describe') {
    // 用户询问网页功能 → 纯语音回答，不高亮任何元素
    execResult = { success: true };
  } else {
    // LLM 返回了未知 action 类型（navigate/open 等）或无 action
    // 有 target 时仍尝试高亮，避免"有语音无标注"
    if (instruction.target) {
      execResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXEC_HIGHLIGHT',
        payload: { selector: instruction.target, fallbackText: instruction.fallbackText }
      }).catch(() => ({ success: false }));
    } else {
      execResult = { success: true };
    }
  }

  setAnim('speaking');
  await speakText(instruction.speech);

  if (execResult && !execResult.success && execResult.level === 'verbal' && execResult.guidance) {
    await speakText(execResult.guidance);
  }

  setAnim('idle');
  return { success: true, instruction, execResult };
}

// --- TTS 播报 ---
// 使用 chrome.tts（Chrome 内置引擎）直接从 SW 发声
// 比 sidepanel speechSynthesis 可靠：不依赖侧边栏是否聚焦，且可 await 等待播完
async function speakText(text) {
  if (!text) return;
  return new Promise(resolve => {
    chrome.tts.speak(text, {
      lang: 'zh-CN',
      rate: 0.91,
      pitch: 1.1,
      volume: 0.9,
      onEvent: (event) => {
        if (['end', 'error', 'cancelled', 'interrupted'].includes(event.type)) {
          resolve();
        }
      }
    });
  });
}

function setAnim(state) {
  STATE.animState = state;
  // 推送到侧边栏
  chrome.runtime.sendMessage({ type: 'ANIM_SET_STATE', payload: { state } }).catch(() => {});
  // 推送到页面内皮卡丘 Widget（chrome.runtime.sendMessage 不到 content script，需 tabs.sendMessage）
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'ANIM_SET_STATE', payload: { state } }).catch(() => {});
  }).catch(() => {});
}

// --- API Key 管理 ---
async function setApiKey(key) {
  STATE.apiKey = key;
  await chrome.storage.local.set({ apiKey: key });

  const valid = await validateApiKey(key);
  return { success: valid, message: valid ? 'API Key 验证成功' : 'API Key 无效，请检查' };
}

// BUG FIX: 原逻辑将 API_EMPTY_RESPONSE 视为验证失败，实际上 key 有效但测试 prompt 无输出应视为通过
async function validateApiKey(key) {
  try {
    await infer('返回空JSON: {}', 'test', key, 'chat');
    return true;
  } catch (e) {
    return e.message !== 'API_AUTH_ERROR';
  }
}
