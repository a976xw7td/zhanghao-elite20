/**
 * TTS Client — SiliconFlow 文本转语音
 *
 * 端点: https://api.siliconflow.cn/v1/audio/speech
 * 模型: FunAudioLLM/CosyVoice2-0.5B
 * 音色: claire (温柔女声)
 *
 * @module tts-client
 */

const TTS_ENDPOINT = 'https://api.siliconflow.cn/v1/audio/speech';
const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const TTS_VOICE = 'FunAudioLLM/CosyVoice2-0.5B:claire';

// 根据文本语种选择音色：含中文用 claire，纯英文用 cosy-2-instruct
function pickVoice(text) {
  return /[一-鿿]/.test(text)
    ? TTS_VOICE
    : 'FunAudioLLM/CosyVoice2-0.5B:cosy-2-instruct';
}

/**
 * 将文本转为语音，返回 base64 编码的 MP3
 * @param {string} text - 要合成的文本
 * @param {string} apiKey - SiliconFlow API Key
 * @returns {Promise<string>} base64-encoded MP3 data (不含 data URI 前缀)
 */
export async function synthesize(text, apiKey) {
  if (!apiKey) throw new Error('TTS_KEY_MISSING');
  if (!text) throw new Error('TTS_NO_TEXT');

  const payload = {
    model: TTS_MODEL,
    input: text,
    voice: pickVoice(text),
    response_format: 'mp3'
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (res.status === 401) throw new Error('TTS_AUTH_ERROR');
    if (res.status === 429) throw new Error('TTS_RATE_LIMIT');
    if (!res.ok) throw new Error(`TTS_HTTP_${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // 转为 base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('TTS_TIMEOUT');
    if (e.message?.startsWith('TTS_')) throw e;
    console.error('[TTS] Network error:', e.message);
    throw new Error('TTS_NETWORK');
  }
}
