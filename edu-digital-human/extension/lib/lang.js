/**
 * Language Utility — 语种检测 + 双语文本
 *
 * @module lang
 */

/**
 * 检测文本语种：含有中文字符 → 'zh'，否则 → 'en'
 */
export function detectLanguage(text) {
  if (!text) return 'zh';
  return /[一-鿿㐀-䶿]/.test(text) ? 'zh' : 'en';
}

// --- 多语言状态提示文本 ---
const STATUS_MSGS = {
  ready: {
    zh: '准备就绪 — 按住麦克风说话',
    en: 'Ready — hold the mic to speak'
  },
  listening: {
    zh: '🎤 正在聆听...',
    en: '🎤 Listening...'
  },
  thinking: {
    zh: '🤔 正在分析...',
    en: '🤔 Analyzing...'
  },
  recTimeout: {
    zh: '⚠️ 录音超时，请重试',
    en: '⚠️ Recording timed out, please try again'
  },
  noTab: {
    zh: '⚠️ 无法获取当前页面',
    en: '⚠️ Cannot access current page'
  },
  invalidTab: {
    zh: '⚠️ 请先打开一个普通网页再使用语音功能',
    en: '⚠️ Please open a regular webpage first'
  },
  connectFailed: {
    zh: '⚠️ 无法连接页面，请刷新后重试',
    en: '⚠️ Cannot connect to page, please refresh'
  },
  micPermission: {
    zh: '⚠️ 请点击地址栏麦克风图标，允许此网站使用麦克风',
    en: '⚠️ Click the mic icon in the address bar to allow access'
  },
  noAudio: {
    zh: '⚠️ 未录到声音，请重试',
    en: '⚠️ No audio detected, please try again'
  },
  recFailed: {
    zh: '⚠️ 录音失败，请重试',
    en: '⚠️ Recording failed, please try again'
  },
  noMic: {
    zh: '⚠️ 未检测到麦克风设备',
    en: '⚠️ No microphone found'
  },
  recError: {
    zh: '⚠️ 录音失败',
    en: '⚠️ Recording error'
  },
  noAsrKey: {
    zh: '⚠️ 请在设置面板填入 ASR API Key',
    en: '⚠️ Please enter your ASR API Key in settings'
  },
  configAsrKey: {
    zh: '请先配置语音识别的 API Key',
    en: 'Please configure the ASR API Key first'
  },
  noApiKey: {
    zh: '⚠️ 请在设置面板填入 DeepSeek API Key',
    en: '⚠️ Please enter your DeepSeek API Key in settings'
  },
  configApiKey: {
    zh: '请先配置 DeepSeek API Key',
    en: 'Please configure the DeepSeek API Key first'
  },
  asrKeyMissing: {
    zh: '请配置 ASR API Key',
    en: 'Please configure the ASR API Key'
  },
  asrAuthError: {
    zh: 'ASR Key 无效',
    en: 'Invalid ASR Key'
  },
  asrTimeout: {
    zh: '语音识别超时，请重试',
    en: 'Speech recognition timed out, please try again'
  },
  asrNetwork: {
    zh: '网络连接失败',
    en: 'Network connection failed'
  },
  asrEmpty: {
    zh: '没听到说话，请按住按钮说完再松开',
    en: 'No speech detected, hold the button while speaking'
  },
  asrNoAudio: {
    zh: '未收到音频数据',
    en: 'No audio data received'
  },
  domFailed: {
    zh: '页面分析失败',
    en: 'Page analysis failed'
  },
  apiEmpty: {
    zh: '页面元素太多，请重试',
    en: 'Too many page elements, please try again'
  },
  apiJsonError: {
    zh: '响应格式异常，请重试',
    en: 'Invalid response format, please try again'
  },
  apiKeyMissing: {
    zh: '请先配置 API Key',
    en: 'Please configure the API Key'
  },
  apiAuthError: {
    zh: 'API Key 无效，请检查',
    en: 'Invalid API Key, please check'
  },
  apiTimeout: {
    zh: '请求超时，请重试',
    en: 'Request timed out, please try again'
  },
  apiRateLimit: {
    zh: '请求太频繁，请稍等',
    en: 'Too many requests, please wait'
  },
  genericError: {
    zh: '出错了，请再试一次',
    en: 'Something went wrong, please try again'
  },
  keySaved: {
    zh: '已保存',
    en: 'Saved'
  },
  saveFailed: {
    zh: '保存失败',
    en: 'Save failed'
  },
  keyValid: {
    zh: 'API Key 验证成功',
    en: 'API Key validated successfully'
  },
  keyInvalid: {
    zh: 'API Key 无效，请检查',
    en: 'Invalid API Key, please check'
  },
  asrSaved: {
    zh: 'ASR 配置已保存',
    en: 'ASR configuration saved'
  },
  needKey: {
    zh: '请填入 DeepSeek API Key',
    en: 'Please enter DeepSeek API Key'
  },
  needAsrKey: {
    zh: '请填入 ASR API Key（语音识别需要）',
    en: 'Please enter ASR API Key (required for speech)'
  },
  processing: {
    zh: '正在处理中，请稍等',
    en: 'Processing, please wait'
  }
};

/**
 * 获取指定语种的状态文本
 */
export function statusMsg(key, lang) {
  const entry = STATUS_MSGS[key];
  if (!entry) return '';
  return entry[lang] || entry.zh;
}
