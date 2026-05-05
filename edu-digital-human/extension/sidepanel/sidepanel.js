/**
 * Side Panel — 智引灵 AI 导航导师 SVG 数字人 + 语音交互
 *
 * 语音: Offscreen Document 录音 → Whisper ASR API (国内可用)
 * 文字: 输入框回车 (备用)
 * 形象: CSS 动画驱动的 2D 卡通头像
 * TTS: SpeechSynthesis (本地，免费)
 */

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

// 录音状态（实际录音在 offscreen document 中）
let isRecording = false;

// --- 录音控制 (实际录音在 offscreen document，侧边栏只发控制消息) ---
function startRecording() {
  if (isRecording) return;
  isRecording = true;
  micBtn.textContent = '🔴 松开发送';
  micBtn.classList.add('recording');
  setUIState('listening', '🎤 正在聆听...');

  chrome.runtime.sendMessage({ type: 'CTRL_START_REC' }).then(res => {
    if (res && res.error === 'BUSY') {
      isRecording = false;
      micBtn.textContent = '🎤 按住说话';
      micBtn.classList.remove('recording');
      setUIState('idle', '正在处理中，请稍等');
    }
  }).catch(() => {
    isRecording = false;
    micBtn.textContent = '🎤 按住说话';
    micBtn.classList.remove('recording');
    setUIState('idle', '⚠️ 通信失败，请重试');
  });
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  micBtn.textContent = '🎤 按住说话';
  micBtn.classList.remove('recording');
  setUIState('thinking', '🤔 正在识别语音...');
  chrome.runtime.sendMessage({ type: 'CTRL_STOP_REC' }).catch(() => {});
}

// --- 文字输入 (备用) ---
function handleTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  setUIState('thinking', '🤔 正在分析...');

  chrome.runtime.sendMessage({
    type: 'ASR_RESULT',
    payload: { transcript: text }
  }).then(response => {
    if (response?.error) {
      const msgs = {
        'NO_API_KEY': '请填入 DeepSeek API Key',
        'BUSY': '正在处理中',
        'NO_TAB': '无法获取当前页面',
        'DOM_DISTILL_FAILED': '页面分析失败'
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
  u.lang = 'zh-CN';
  u.rate = 0.91;
  u.pitch = 1.1;
  u.volume = 0.9;
  const voices = synth.getVoices();
  const zh = voices.find(v => v.lang.startsWith('zh-CN')) || voices.find(v => v.lang.startsWith('zh'));
  if (zh) u.voice = zh;
  u.onstart = () => setUIState('speaking', '🔊 ' + text.slice(0, 30));
  u.onend = () => { setUIState('idle', '准备就绪 — 按住麦克风说话'); currentUtterance = null; };
  u.onerror = () => { setUIState('idle', '准备就绪'); currentUtterance = null; };
  currentUtterance = u;
  synth.speak(u);
}

if (synth) {
  synth.getVoices();
  synth.onvoiceschanged = () => synth.getVoices();
}

// --- UI 状态 ---
function setUIState(state, text) {
  animState = state;
  statusDot.className = state;
  if (text) statusText.textContent = text;
  avatarContainer.className = state;
}


// --- 消息监听 ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TTS_SPEAK') { speakLocal(msg.payload.text); return; }
  if (msg.type === 'TTS_PLAY') {
    // 播放 Service Worker 传来的 TTS 音频（CosyVoice2）
    const audio = new Audio(`data:${msg.payload.mimeType || 'audio/mp3'};base64,${msg.payload.audioBase64}`);
    audio.volume = 0.9;
    audio.play().then(() => {
      audio.onended = () => { audio.remove(); sendResponse({ ok: true }); };
      audio.onerror = () => { audio.remove(); sendResponse({ ok: false }); };
    }).catch(() => {
      audio.remove();
      sendResponse({ ok: false });
    });
    return true; // async sendResponse
  }
  if (msg.type === 'ANIM_SET_STATE') {
    const text = msg.payload.state === 'idle' ? '准备就绪 — 按住麦克风说话' : null;
    setUIState(msg.payload.state, text);
    return;
  }
  if (msg.type === 'STATUS_TEXT') {
    isRecording = false;
    micBtn.textContent = '🎤 按住说话';
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
    setUIState('idle', res.message || '已保存');
    apiKeyInput.value = '';
  } catch (_) {
    setUIState('idle', '保存失败');
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
    setUIState('idle', res.message || 'ASR 配置已保存');
    asrKeyInput.value = '';
    asrEndpointInput.value = '';
  } catch (_) {
    setUIState('idle', '保存失败');
  }
});

// --- 初始加载 ---
chrome.runtime.sendMessage({ type: 'GET_STATE', payload: {} }).then(res => {
  if (res?.apiKeySet && res?.asrApiKeySet) {
    setUIState('idle', '准备就绪 — 按住麦克风说话');
  } else if (!res?.apiKeySet) {
    setUIState('idle', '请填入 DeepSeek API Key');
  } else if (!res?.asrApiKeySet) {
    setUIState('idle', '请填入 ASR API Key（语音识别需要）');
  } else {
    setUIState('idle', '准备就绪 — 按住麦克风说话');
  }
  if (res?.model) modelSelect.value = res.model;
  if (res?.asrEndpoint) asrEndpointInput.value = res.asrEndpoint;
});

