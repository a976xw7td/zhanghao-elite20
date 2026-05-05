/**
 * Background Service Worker — 编排中枢
 *
 * 唯一状态持有者 + 消息路由 + API 编排
 * ES Module，通过 import 加载 llm-client
 */

import { infer, inferMinimal, MODELS } from '../lib/llm-client.js';
import { transcribe } from '../lib/asr-client.js';
import { synthesize } from '../lib/tts-client.js';
import { detectLanguage, statusMsg } from '../lib/lang.js';

// --- 应用状态 (单一数据源) ---
const STATE = {
  apiKey: '',
  model: 'v4flash',
  asrApiKey: '',
  asrEndpoint: '',
  language: 'zh',  // 当前语种：'zh' | 'en'
  currentPage: null,
  currentPageUrl: null,
  animState: 'idle',
  isProcessing: false,
  isRecording: false,
  activeTabId: null,
  domDistillPromise: null,
  recordingTimer: null
};

const _distillCache = new Map();  // url → { result, time }
const DISTILL_CACHE_TTL = 5 * 60 * 1000; // 5分钟

// 设置是否已从 storage 加载（避免每次语音查询都读 storage，节省 ~20ms）
// 声明在 onMessage 之前，避免 let TDZ 问题
let _settingsLoaded = false;

// --- 带重试的异步调用（TIMEOUT / RATE_LIMIT 时自动重试最多 2 次，指数退避）---
async function withRetry(fn, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // 以下错误不重试：空响应 / JSON 解析失败 / 认证失败
      if (['API_EMPTY_RESPONSE', 'API_JSON_ERROR', 'API_AUTH_ERROR'].includes(e.message)) throw e;
      // TIMEOUT / RATE_LIMIT / NETWORK 才重试（ASR 和 LLM 错误码前缀不同）
      if (['API_TIMEOUT', 'API_RATE_LIMIT', 'ASR_TIMEOUT', 'ASR_NETWORK'].includes(e.message)) {
        if (attempt < maxRetries) {
          const delay = (attempt + 1) * 1000; // 第1次等1s，第2次等2s
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError;
}

// --- 懒加载用户设置 ---
// MV3 Service Worker 随时可能被 Chrome 回收；onInstalled/onStartup 不覆盖任意重启
// 每次进入关键流程前从 storage 同步，确保用户保存的 key 生效
async function ensureSettings() {
  const stored = await chrome.storage.local.get(['apiKey', 'model', 'asrApiKey', 'asrEndpoint', 'language']);
  if (stored.apiKey) STATE.apiKey = stored.apiKey;
  if (stored.model) STATE.model = stored.model;
  if (stored.asrApiKey !== undefined) STATE.asrApiKey = stored.asrApiKey;
  if (stored.asrEndpoint !== undefined) STATE.asrEndpoint = stored.asrEndpoint;
  if (stored.language !== undefined) STATE.language = stored.language;
}

// --- 推送状态文本到侧边栏 ---
function pushStatus(state, text) {
  chrome.runtime.sendMessage({ type: 'STATUS_TEXT', payload: { state, text } }).catch(() => {});
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'STATUS_TEXT', payload: { state, text } }).catch(() => {});
  }).catch(() => {});
}

// Offscreen Document 管理（用于受限页面录音降级）
async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '需要麦克风权限进行语音识别'
    });
  } catch (e) {
    // 如果已存在，Chrome 会报错，忽略
    if (!e.message?.includes('already exists')) {
      console.warn('[SW] Offscreen creation failed:', e.message);
    }
  }
}

// --- 初始化 ---
chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  console.log('[智引] AI 导航导师已就绪');
  await ensureOffscreen();
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
          pushStatus('idle', statusMsg('recTimeout', STATE.language));
          setAnim('idle');
        }
      }, 30000);

      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) {
            STATE.isRecording = false;
            sendResponse({ ok: false, error: 'NO_TAB' });
            pushStatus('idle', statusMsg('noTab', STATE.language));
            return;
          }
          if (/^(chrome|about|data|javascript):/i.test(tab.url || '')) {
            STATE.isRecording = false;
            sendResponse({ ok: false, error: 'INVALID_TAB' });
            pushStatus('idle', statusMsg('invalidTab', STATE.language));
            return;
          }
          STATE.activeTabId = tab.id;

          // 确保 content script 已注入（处理扩展安装前已打开的标签）
          await ensureContentScript(tab.id);

          // 按下麦克风时触发 DOM 预收集（与录音并行，不等结果）
          // ASR 完成后 distill 会直接用这份缓存，省去重复 DOM 扫描（~80-150ms）
          chrome.tabs.sendMessage(tab.id, { type: 'DOM_PRECOLLECT' }).catch(() => {});

          let recResult;
          try {
            recResult = await chrome.tabs.sendMessage(tab.id, { type: 'START_REC' });
          } catch (_) {
            STATE.isRecording = false;
            STATE.activeTabId = null;
            if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
            pushStatus('idle', statusMsg('connectFailed', STATE.language));
            setAnim('idle');
            sendResponse({ ok: false, error: 'CONNECTION_FAILED' });
            return;
          }
          if (!recResult || !recResult.ok) {
            // NotAllowedError -> try offscreen document as fallback
            if (recResult?.error === 'NotAllowedError') {
              try {
                await ensureOffscreen();
                chrome.runtime.sendMessage({ type: 'START_REC', target: 'offscreen' }).catch(() => {});
                sendResponse({ ok: true });
                return;
              } catch (_) { /* fall through to error */ }
            }
            STATE.isRecording = false;
            STATE.activeTabId = null;
            if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
            const errMsg = recResult?.error === 'NotAllowedError'
              ? statusMsg('micPermission', STATE.language)
              : statusMsg('connectFailed', STATE.language);
            pushStatus('idle', errMsg);
            setAnim('idle');
            sendResponse({ ok: false, error: recResult?.error || 'START_REC_FAILED' });
            return;
          }
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
        chrome.runtime.sendMessage({ type: 'STOP_REC', target: 'offscreen' }).catch(() => {});
      } else {
        pushStatus('idle', statusMsg('ready', STATE.language));
      }
      sendResponse({ ok: true });
      break;
    }

    case 'RECORDING_DONE':
      STATE.isRecording = false;
      STATE.activeTabId = null;
      if (STATE.recordingTimer) { clearTimeout(STATE.recordingTimer); STATE.recordingTimer = null; }
      if (payload.error === 'NO_AUDIO') {
        pushStatus('idle', statusMsg('noAudio', STATE.language));
        setAnim('idle');
      } else if (payload.error) {
        pushStatus('idle', statusMsg('recFailed', STATE.language));
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
        ? statusMsg('micPermission', STATE.language)
        : payload.error === 'NotFoundError'
          ? statusMsg('noMic', STATE.language)
          : statusMsg('recError', STATE.language) + ': ' + payload.message;
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
      if (sender.tab?.url) _distillCache.delete(sender.tab.url);
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
      sendResponse({ success: true, message: statusMsg('asrSaved', STATE.language) });
      break;

    case 'SET_LANGUAGE':
      STATE.language = payload.lang;
      chrome.storage.local.set({ language: payload.lang });
      sendResponse({ success: true });
      break;

    case 'GET_STATE':
      sendResponse({
        apiKeySet: !!STATE.apiKey,
        model: STATE.model,
        asrApiKeySet: !!STATE.asrApiKey,
        asrEndpoint: STATE.asrEndpoint,
        language: STATE.language
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
    pushStatus('idle', statusMsg('noAsrKey', STATE.language));
    await speakText(statusMsg('configAsrKey', STATE.language));
    return { error: 'NO_ASR_KEY' };
  }
  if (!STATE.apiKey) {
    setAnim('idle');
    pushStatus('idle', statusMsg('noApiKey', STATE.language));
    await speakText(statusMsg('configApiKey', STATE.language));
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
    const asrResult = await withRetry(() => transcribe(audioBase64, mimeType, STATE.asrApiKey, STATE.asrEndpoint));
    const transcript = asrResult.text?.trim();
    if (!transcript) throw new Error('ASR_EMPTY');
    console.log('[SW] ASR done:', transcript);
    STATE.language = detectLanguage(transcript);

    // ── 第二步：用实际意图做针对性 DOM 蒸馏 ──
    // 知道"用户要找登录按钮"后，只重点扫描顶部导航，不再收集整页所有元素
    const cached = _distillCache.get(tab.url);
    if (cached && Date.now() - cached.time < DISTILL_CACHE_TTL) {
      console.log('[SW] Using cached DOM distill for:', tab.url);
      return await processIntent(transcript, cached.result, tab);
    }
    const domResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'DOM_DISTILL',
      payload: { intent: transcript }
    });
    if (!domResult || domResult.error) throw new Error('DOM_DISTILL_FAILED');
    _distillCache.set(tab.url, { result: domResult, time: Date.now() });
    console.log('[SW] DOM distilled with intent, focused on:', domResult.focusedRegions?.join(', ') || 'all regions');

    return await processIntent(transcript, domResult, tab);

  } catch (e) {
    console.error('[智引] Voice error:', e.message);
    setAnim('idle');

    const msgs = {
      'ASR_KEY_MISSING': statusMsg('asrKeyMissing', STATE.language),
      'ASR_AUTH_ERROR': statusMsg('asrAuthError', STATE.language),
      'ASR_TIMEOUT': statusMsg('asrTimeout', STATE.language),
      'ASR_NETWORK': statusMsg('asrNetwork', STATE.language),
      'ASR_EMPTY': statusMsg('asrEmpty', STATE.language),
      'ASR_NO_AUDIO': statusMsg('asrNoAudio', STATE.language),
      'NO_TAB': statusMsg('noTab', STATE.language),
      'DOM_DISTILL_FAILED': statusMsg('domFailed', STATE.language),
      'API_EMPTY_RESPONSE': statusMsg('apiEmpty', STATE.language),
      'API_JSON_ERROR': statusMsg('apiJsonError', STATE.language),
      'API_TIMEOUT': statusMsg('apiTimeout', STATE.language),
      'API_RATE_LIMIT': statusMsg('apiRateLimit', STATE.language),
      'API_AUTH_ERROR': statusMsg('apiAuthError', STATE.language)
    };
    const msg = msgs[e.message] || statusMsg('genericError', STATE.language);
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
    pushStatus('idle', statusMsg('noApiKey', STATE.language));
    await speakText(statusMsg('configApiKey', STATE.language));
    return { error: 'NO_API_KEY' };
  }

  STATE.isProcessing = true;
  setAnim('thinking');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('NO_TAB');
    STATE.language = detectLanguage(transcript);

    const cached = _distillCache.get(tab.url);
    if (cached && Date.now() - cached.time < DISTILL_CACHE_TTL) {
      STATE.currentPage = cached.result;
      return await processIntent(transcript, cached.result, tab);
    }
    const domResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'DOM_DISTILL',
      payload: { intent: transcript }
    });

    if (!domResult || domResult.error) throw new Error('DOM_DISTILL_FAILED');
    _distillCache.set(tab.url, { result: domResult, time: Date.now() });
    STATE.currentPage = domResult;
    return await processIntent(transcript, domResult, tab);

  } catch (e) {
    console.error('[智引] Error:', e.message);
    setAnim('idle');

    const msgs = {
      'API_KEY_MISSING': statusMsg('apiKeyMissing', STATE.language),
      'API_AUTH_ERROR': statusMsg('apiAuthError', STATE.language),
      'API_TIMEOUT': statusMsg('apiTimeout', STATE.language),
      'API_RATE_LIMIT': statusMsg('apiRateLimit', STATE.language),
      'API_EMPTY_RESPONSE': statusMsg('apiEmpty', STATE.language),
      'API_JSON_ERROR': statusMsg('apiJsonError', STATE.language),
      'NO_TAB': statusMsg('noTab', STATE.language),
      'DOM_DISTILL_FAILED': statusMsg('domFailed', STATE.language)
    };
    const msg = msgs[e.message] || statusMsg('genericError', STATE.language);
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
    instruction = await withRetry(() => infer(prompt, transcript, STATE.apiKey, STATE.model));
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
      type: 'EXEC_CLICK',
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
  // Bug 1 (P0): fallback TTS when LLM returned empty speech
  if (!instruction.speech) {
    await speakText(STATE.language === 'zh' ? '好的，已经帮你标注了' : 'Done, highlighted for you');
  }

  // 处理 TaskQueue 结果的 verbal 降级引导
  if (execResult && 'results' in execResult && Array.isArray(execResult.results)) {
    const verbalStep = execResult.results.find(r => r.level === 'verbal' && r.guidance);
    if (verbalStep) {
      await speakText(verbalStep.guidance);
    }
  }

  if (execResult && !execResult.success && execResult.level === 'verbal' && execResult.guidance) {
    await speakText(execResult.guidance);
  }

  setAnim('idle');
  return { success: true, instruction, execResult };
}

// --- TTS 播报 ---
// 使用 SiliconFlow CosyVoice2 TTS（claire 温柔女声），比 Chrome 内置引擎更自然
// Service Worker 无法直接播放音频 → 调 API 获取 base64 → 发给 content script 播放
let _enVoiceName = null;

async function speakText(text) {
  if (!text) return;
  const isEn = !/[一-鿿]/.test(text);
  if (isEn) {
    console.log('[智引] TTS EN:', text);
    // 选取高质量英文语音（macOS: Samantha/Karen/Alex; 其他OS: 第一个 en-US）
    if (!_enVoiceName) {
      try {
        const voices = await chrome.tts.getVoices();
        const good = voices.find(v =>
          /Samantha|Karen|Alex|Ava|Allison|Susan/i.test(v.voiceName) && v.lang?.startsWith('en')
        ) || voices.find(v => v.lang?.startsWith('en-US'));
        if (good) _enVoiceName = good.voiceName;
      } catch (_) { /* getVoices not available */ }
    }
    return new Promise(resolve => {
      chrome.tts.speak(text, {
        lang: 'en-US',
        rate: 0.85,
        pitch: 1.0,
        volume: 1.0,
        voiceName: _enVoiceName,
        onEvent: (event) => {
          if (['end', 'error', 'cancelled', 'interrupted'].includes(event.type)) resolve();
        }
      });
    });
  }
  try {
    const audioBase64 = await synthesize(text, STATE.asrApiKey);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id) {
      const ttsResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'TTS_PLAY',
        payload: { audioBase64, mimeType: 'audio/mp3' }
      });
      // content script 的 audio.play() 可能被页面自动播放策略拦截（如 GitHub）
      if (!ttsResult?.ok) throw new Error('TTS_PLAY_BLOCKED');
    }
  } catch (e) {
    console.warn('[智引] TTS CosyVoice failed, fallback to chrome.tts:', e.message);
    return new Promise(resolve => {
      chrome.tts.speak(text, {
        lang: 'zh-CN',
        rate: 0.91,
        pitch: 1.1,
        volume: 0.9,
        onEvent: (event) => {
          if (['end', 'error', 'cancelled', 'interrupted'].includes(event.type)) resolve();
        }
      });
    });
  }
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
  return { success: true, message: statusMsg('keySaved', STATE.language) };
}
