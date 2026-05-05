/**
 * Offscreen Document — 麦克风录音
 *
 * 在 offscreen 上下文中调用 getUserMedia，绕过侧边栏 iframe 的麦克风限制。
 * 通过 chrome.runtime.sendMessage 与 Service Worker 通信。
 *
 * SW → offscreen: START_REC / STOP_REC (target: 'offscreen')
 * offscreen → SW: RECORDING_DONE / RECORDING_ERROR
 */

let mediaRecorder = null;
let audioChunks = [];
let stream = null;
let mimeType = '';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'START_REC') {
    startRecording().catch(e => {
      console.error('[Offscreen] getUserMedia error:', e.name, e.message);
      chrome.runtime.sendMessage({
        type: 'RECORDING_ERROR',
        payload: { error: e.name, message: e.message }
      }).catch(() => {});
    });
    return;
  }

  if (msg.type === 'STOP_REC') {
    stopRecording();
  }
});

async function startRecording() {
  audioChunks = [];
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    stream = null;

    if (audioChunks.length === 0) {
      chrome.runtime.sendMessage({
        type: 'RECORDING_DONE',
        payload: { error: 'NO_AUDIO' }
      }).catch(() => {});
      return;
    }

    const audioBlob = new Blob(audioChunks, { type: mimeType });
    const base64 = await blobToBase64(audioBlob);
    chrome.runtime.sendMessage({
      type: 'RECORDING_DONE',
      payload: { audio: base64, mimeType }
    }).catch(() => {});
  };

  mediaRecorder.start(100);
  console.log('[Offscreen] Recording started');
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log('[Offscreen] Recording stopped');
  }
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}
