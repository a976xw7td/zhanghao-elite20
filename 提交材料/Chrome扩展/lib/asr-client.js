/**
 * ASR Client — Whisper-compatible speech-to-text
 *
 * Supports any OpenAI-format /v1/audio/transcriptions endpoint.
 * Tested providers: SiliconFlow (api.siliconflow.cn)
 *
 * @module asr-client
 */

const DEFAULT_ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions';

/**
 * @param {string} audioBase64 - base64-encoded audio (without data URI prefix)
 * @param {string} mimeType - e.g. 'audio/webm;codecs=opus' or 'audio/webm'
 * @param {string} apiKey - ASR API key
 * @param {string} [endpoint] - Whisper-compatible endpoint URL
 * @returns {Promise<{text: string}>}
 */
export async function transcribe(audioBase64, mimeType, apiKey, endpoint) {
  if (!apiKey) throw new Error('ASR_KEY_MISSING');
  if (!audioBase64) throw new Error('ASR_NO_AUDIO');

  const url = endpoint || DEFAULT_ENDPOINT;

  // 将 base64 解码为二进制
  const binaryStr = atob(audioBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
  const blob = new Blob([bytes], { type: mimeType });

  const form = new FormData();
  form.append('file', blob, `recording.${ext}`);
  form.append('model', 'FunAudioLLM/SenseVoiceSmall');
  form.append('language', 'zh');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    console.log('[ASR] Sending to:', url, 'size:', bytes.length);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });

    clearTimeout(timeout);
    console.log('[ASR] Response status:', res.status);

    if (res.status === 401) throw new Error('ASR_AUTH_ERROR');
    if (res.status === 429) throw new Error('ASR_RATE_LIMIT');
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('[ASR] HTTP', res.status, errBody.slice(0, 200));
      throw new Error(`ASR_HTTP_${res.status}`);
    }

    const data = await res.json();
    console.log('[ASR] Result:', JSON.stringify(data).slice(0, 200));

    const text = data.text?.trim();
    if (!text) throw new Error('ASR_EMPTY');

    return { text };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('ASR_TIMEOUT');
    if (e.message?.startsWith('ASR_')) throw e;
    console.error('[ASR] Network error:', e.message);
    throw new Error('ASR_NETWORK');
  }
}
