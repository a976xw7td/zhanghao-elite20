/**
 * Side Panel — 智引 AI 导航导师 SVG 数字人 + 语音交互
 *
 * 语音: Offscreen Document 录音 → Whisper ASR API (国内可用)
 * 文字: 输入框回车 (备用)
 * 形象: CSS 动画驱动的 2D 卡通头像
 * TTS: SpeechSynthesis (本地，免费)
 */
import { detectLanguage, statusMsg } from '../lib/lang.js';

// --- DOM 引用 ---
const avatarContainer = document.getElementById('avatar-container');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const micBtn = document.getElementById('mic-btn');
const textInput = document.getElementById('text-input');
const apiKeyInput = document.getElementById('api-key-input');
const modelSelect = document.getElementById('model-select');
const saveKeyBtn = document.getElementById('save-key-btn');
const asrKeyInput = document.getElementById('asr-key-input');
const asrEndpointInput = document.getElementById('asr-endpoint-input');
const saveAsrBtn = document.getElementById('save-asr-btn');

// --- 状态 ---
let animState = 'idle';
let synth = window.speechSynthesis;
let currentUtterance = null;
let currentLang = 'zh';

// 录音状态（实际录音在 offscreen document 中）
let isRecording = false;
let cachedVoices = [];

// --- 录音控制 (实际录音在 offscreen document，侧边栏只发控制消息) ---
function startRecording() {
  if (isRecording) return;
  isRecording = true;
  micBtn.textContent = currentLang === 'en' ? '🔴 Release to send' : '🔴 松开发送';
  micBtn.classList.add('recording');
  setUIState('listening', currentLang === 'en' ? '🎤 Listening...' : '🎤 正在聆听...');

  chrome.runtime.sendMessage({ type: 'CTRL_START_REC' }).then(res => {
    if (res && res.error === 'BUSY') {
      isRecording = false;
      micBtn.textContent = currentLang === 'en' ? '🎤 Hold to speak' : '🎤 按住说话';
      micBtn.classList.remove('recording');
      setUIState('idle', statusMsg('processing', currentLang));
    }
  }).catch(() => {
    isRecording = false;
    micBtn.textContent = currentLang === 'en' ? '🎤 Hold to speak' : '🎤 按住说话';
    micBtn.classList.remove('recording');
    setUIState('idle', currentLang === 'en' ? '⚠️ Communication failed' : '⚠️ 通信失败，请重试');
  });
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  micBtn.textContent = '🎤 按住说话';
  micBtn.classList.remove('recording');
  setUIState('thinking', currentLang === 'en' ? '🤔 Recognizing...' : '🤔 正在识别语音...');
  chrome.runtime.sendMessage({ type: 'CTRL_STOP_REC' }).catch(() => {});
}

// --- 文字输入 (备用) ---
function handleTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  setUIState('thinking', currentLang === 'en' ? '🤔 Analyzing...' : '🤔 正在分析...');

  chrome.runtime.sendMessage({
    type: 'ASR_RESULT',
    payload: { transcript: text }
  }).then(response => {
    if (response?.error) {
      const msgs = {
        'NO_API_KEY': currentLang === 'en' ? 'Please enter DeepSeek API Key' : '请填入 DeepSeek API Key',
        'BUSY': currentLang === 'en' ? 'Processing' : '正在处理中',
        'NO_TAB': currentLang === 'en' ? 'Cannot access current page' : '无法获取当前页面',
        'DOM_DISTILL_FAILED': currentLang === 'en' ? 'Page analysis failed' : '页面分析失败'
      };
      setUIState('idle', '⚠️ ' + (msgs[response.error] || response.speech || response.error));
    }
  }).catch(() => {
    setUIState('idle', '⚠️ 通信失败，请刷新扩展');
  });
}

// --- TTS (本地 SpeechSynthesis，免费无需API) ---
function speakLocal(text) {
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const isEn = !/[一-鿿]/.test(text);
  u.lang = isEn ? 'en-US' : 'zh-CN';
  u.rate = isEn ? 0.85 : 0.91;
  u.pitch = isEn ? 1.0 : 1.1;
  u.volume = 1.0;
  const voices = cachedVoices.length > 0 ? cachedVoices : synth.getVoices();
  const preferred = isEn
    ? voices.find(v => /Samantha|Karen|Alex|Daniel/i.test(v.name) && v.lang.startsWith('en'))
      || voices.find(v => v.lang.startsWith('en'))
    : voices.find(v => v.lang.startsWith('zh-CN')) || voices.find(v => v.lang.startsWith('zh'));
  if (preferred) u.voice = preferred;
  u.onstart = () => setUIState('speaking', '🔊 ' + Array.from(text).slice(0, 30).join(''));
  u.onend = () => { setUIState('idle', statusMsg('ready', currentLang)); currentUtterance = null; };
  u.onerror = () => { setUIState('idle', currentLang === 'en' ? 'Ready' : '准备就绪'); currentUtterance = null; };
  currentUtterance = u;
  synth.speak(u);
}

if (synth) {
  cachedVoices = synth.getVoices();
  synth.onvoiceschanged = () => { cachedVoices = synth.getVoices(); };
}

// --- UI 状态 ---
function setUIState(state, text) {
  animState = state;
  statusDot.className = state;
  if (text) statusText.textContent = text;
  avatarContainer.className = state;
}


// --- 消息监听 ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TTS_SPEAK') speakLocal(msg.payload.text);
  else if (msg.type === 'ANIM_SET_STATE') {
    // 回到 idle 时同步重置状态文字，防止错误提示永远停留
    const text = msg.payload.state === 'idle' ? statusMsg('ready', currentLang) : null;
    setUIState(msg.payload.state, text);
  }
  else if (msg.type === 'STATUS_TEXT') {
    // 录音失败时 SW 推送状态文本，并重置 isRecording
    isRecording = false;
    micBtn.textContent = currentLang === 'en' ? '🎤 Hold to speak' : '🎤 按住说话';
    micBtn.classList.remove('recording');
    setUIState(msg.payload.state, msg.payload.text);
  }
});

// --- UI 事件 ---
// 麦克风: 按住录音，松开发送
micBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  micBtn.setPointerCapture(e.pointerId);
  startRecording();
});

micBtn.addEventListener('pointerup', (e) => {
  e.preventDefault();
  stopRecording();
});

micBtn.addEventListener('pointerleave', (e) => {
  if (isRecording) stopRecording();
});

// 触摸事件
micBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
}, { passive: false });

micBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording();
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleTextInput();
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SET_API_KEY', payload: { key } });
    setUIState('idle', res.message || statusMsg('keySaved', currentLang));
    apiKeyInput.value = '';
  } catch (_) {
    setUIState('idle', statusMsg('saveFailed', currentLang));
  }
});

modelSelect.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_MODEL', payload: { model: modelSelect.value } });
});

saveAsrBtn.addEventListener('click', async () => {
  const key = asrKeyInput.value.trim();
  const endpoint = asrEndpointInput.value.trim();
  if (!key && !endpoint) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SET_ASR_CONFIG',
      payload: { key, endpoint }
    });
    setUIState('idle', res.message || statusMsg('asrSaved', currentLang));
    asrKeyInput.value = '';
    asrEndpointInput.value = '';
  } catch (_) {
    setUIState('idle', statusMsg('saveFailed', currentLang));
  }
});

// --- 初始加载 ---
chrome.runtime.sendMessage({ type: 'GET_STATE', payload: {} }).then(res => {
  if (res?.language) currentLang = res.language;
  if (res?.apiKeySet && res?.asrApiKeySet) {
    setUIState('idle', statusMsg('ready', currentLang));
  } else if (!res?.apiKeySet) {
    setUIState('idle', statusMsg('needKey', currentLang));
  } else if (!res?.asrApiKeySet) {
    setUIState('idle', statusMsg('needAsrKey', currentLang));
  } else {
    setUIState('idle', statusMsg('ready', currentLang));
  }
  if (res?.model) modelSelect.value = res.model;
  if (res?.asrEndpoint) asrEndpointInput.value = res.asrEndpoint;
});

// 自动检测用户输入的语言
textInput.addEventListener('input', () => {
  const val = textInput.value.trim();
  if (val) {
    const detected = detectLanguage(val);
    if (detected !== currentLang) {
      currentLang = detected;
    }
  }
});

