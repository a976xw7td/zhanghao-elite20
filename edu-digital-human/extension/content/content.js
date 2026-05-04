/**
 * Content Script — 页面交互执行器
 *
 * 职责: DOM提取、高亮动画、操作执行、任务队列、皮卡丘悬浮 Widget
 * 禁止: 网络请求、API调用 (全部委托给Background SW)
 * 依赖: DomDistiller, SelectorEngine, TaskQueue (lib层)
 */
(() => {
  'use strict';

  // --- DOM 元素缓存 ---
  let highlightEl = null;
  let highlightTargetEl = null;   // 当前被高亮的目标元素（用于 verifyText 验证）
  let highlightClickDismiss = null;
  let speechBubble = null;

  // --- Widget 内部引用 ---
  let widgetHost = null;
  let pikaBall = null;
  let fanLayer = null;
  let micFanBtn = null;
  let textWrap = null;
  let textInput = null;

  // --- 初始化 ---
  function init() {
    injectPikachuWidget();
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  // ─────────────────────────────────────────────
  // 皮卡丘 Widget（Shadow DOM 完全隔离）
  // ─────────────────────────────────────────────

  const WIDGET_CSS = `
:host {
  position: fixed !important;
  bottom: 24px !important;
  right: 24px !important;
  z-index: 2147483647 !important;
  display: block;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.widget-root {
  position: relative;
  width: 90px;
  height: 110px;
}

/* ── 智引灵 SVG ── */
.xb-svg {
  display: block;
  overflow: visible;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  filter: drop-shadow(0 0 14px rgba(255,160,190,0.45));
  animation: xb-float 3.5s ease-in-out infinite;
}
.xb-svg.dragging { cursor: grabbing; animation: none; }
.xb-svg:active   { transform: scale(0.94); }

@keyframes xb-float {
  0%, 100% { transform: translateY(0px); }
  50%       { transform: translateY(-6px); }
}

/* 轨道环慢转 */
#xb-halo {
  transform-box: fill-box;
  transform-origin: center;
  animation: halo-spin 10s linear infinite;
}
@keyframes halo-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* 眼部扫描 */
#xb-eye-l, #xb-eye-r {
  transform-box: fill-box;
  transform-origin: center;
  animation: xb-blink 4s ease-in-out infinite;
}
#xb-eye-r { animation-delay: 0.15s; }
@keyframes xb-blink {
  0%, 82%, 100% { transform: scaleY(1); }
  90%            { transform: scaleY(0.06); }
}

/* ── listening ── */
.xb-svg.listening {
  animation: xb-listen 0.5s ease-in-out infinite;
  filter: drop-shadow(0 0 18px rgba(245,158,11,0.70));
}
.xb-svg.listening #xb-halo { animation: halo-spin 1.5s linear infinite; }
@keyframes xb-listen {
  0%, 100% { transform: translateY(-3px) scale(1.02); }
  50%       { transform: translateY(-9px) scale(1.05); }
}
.xb-svg.listening #xb-eye-l,
.xb-svg.listening #xb-eye-r { animation: none; transform: scaleY(1.3); }
.xb-svg.listening #xb-cheek-l,
.xb-svg.listening #xb-cheek-r { animation: xb-cheek 0.5s ease-in-out infinite alternate; }

/* ── thinking ── */
.xb-svg.thinking {
  animation: xb-think 1.4s ease-in-out infinite;
  filter: drop-shadow(0 0 18px rgba(139,92,246,0.70));
}
.xb-svg.thinking #xb-halo { animation: halo-pulse-ring 1.4s ease-in-out infinite; }
@keyframes halo-pulse-ring {
  0%, 100% { transform: scale(1) rotate(0deg); }
  50%       { transform: scale(1.1) rotate(180deg); }
}
@keyframes xb-think {
  0%, 100% { transform: translateY(0) rotate(-3deg); }
  50%       { transform: translateY(-5px) rotate(3deg); }
}
.xb-svg.thinking #xb-eye-l,
.xb-svg.thinking #xb-eye-r {
  animation: xb-eye-scan 1.4s ease-in-out infinite;
  transform-box: fill-box; transform-origin: center;
}
@keyframes xb-eye-scan {
  0%, 100% { transform: translateX(-3px) scaleY(0.6); }
  50%       { transform: translateX(3px)  scaleY(0.6); }
}

/* ── speaking ── */
.xb-svg.speaking {
  animation: xb-speak-hop 0.45s ease-in-out infinite;
  filter: drop-shadow(0 0 18px rgba(16,185,129,0.70));
}
.xb-svg.speaking #xb-halo { animation: halo-spin 0.8s linear infinite; }
@keyframes xb-speak-hop {
  0%, 100% { transform: translateY(0); }
  45%       { transform: translateY(-7px); }
}
.xb-svg.speaking #xb-mouth-normal { opacity: 0; }
.xb-svg.speaking #xb-mouth-open {
  opacity: 1;
  animation: xb-mouth 0.38s ease-in-out infinite;
}
@keyframes xb-mouth {
  0%, 100% { transform: scaleY(0.7); transform-box: fill-box; transform-origin: center top; }
  50%       { transform: scaleY(1.3); transform-box: fill-box; transform-origin: center top; }
}
.xb-svg.speaking #xb-cheek-l,
.xb-svg.speaking #xb-cheek-r { animation: xb-cheek 0.45s ease-in-out infinite alternate; }

@keyframes xb-cheek {
  from { filter: drop-shadow(0 0 3px #ffb3c1); }
  to   { filter: drop-shadow(0 0 8px #ff7090); }
}

/* ── 扇形菜单 ── */
.fan-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.fbtn {
  position: absolute;
  width: 44px; height: 44px;
  /* 从角色腹部出发：SVG 88px宽，身体中心 ≈ x:44,y:78 → (44-22=22, 78-22=56) */
  top: 56px; left: 22px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  pointer-events: auto;
  transform: scale(0);
  opacity: 0;
  transition: transform 0.28s cubic-bezier(0.34,1.56,0.64,1), opacity 0.22s ease;
  will-change: transform, opacity;
  box-shadow: 0 3px 10px rgba(0,0,0,0.4);
}
.fbtn:hover  { background: linear-gradient(135deg,#ffd0dc,#f0a0b8) !important; color: #8b3a50 !important; filter: none; }
.fbtn:active { filter: brightness(0.90); }

/* 展开时三个按钮飞出位置（从角色腹部向上扇形展开） */
.fan-layer.open .fbtn.mic {
  transform: translate(-4px, -96px) scale(1);
  opacity: 1;
}
.fan-layer.open .fbtn.txt {
  transform: translate(-60px, -70px) scale(1);
  opacity: 1;
  transition-delay: 0.05s;
}
.fan-layer.open .fbtn.cfg {
  transform: translate(-86px, -22px) scale(1);
  opacity: 1;
  transition-delay: 0.10s;
}

.fbtn.mic { background: linear-gradient(135deg,#fffef8,#f0e4d4); color: #7a5040; }
.fbtn.mic.recording {
  background: linear-gradient(135deg,#ef4444,#dc2626);
  color: white;
  animation: btn-recording 0.8s ease-in-out infinite;
}
.fbtn.txt { background: linear-gradient(135deg,#fffef8,#f0e4d4); color: #7a5040; }
.fbtn.cfg { background: linear-gradient(135deg,#fffef8,#f0e4d4); color: #7a5040; }

/* ── 文字输入框 ── */
.tinput-wrap {
  position: absolute;
  bottom: 112px;
  right: 0;
  width: 210px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px);
  transition: opacity 0.22s, transform 0.22s;
}
.tinput-wrap.visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
.tinput {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 14px;
  border-radius: 20px;
  border: 2px solid #3b82f6;
  background: #0f172a;
  color: #f8fafc;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  outline: none;
  box-shadow: 0 4px 16px rgba(0,0,0,0.45);
}
.tinput::placeholder { color: #475569; }
.tinput:focus { border-color: #60a5fa; }

@media (prefers-color-scheme: light) {
  .tinput {
    background: #ffffff;
    color: #1e293b;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  }
  .tinput::placeholder { color: #94a3b8; }
}
`;

  const WIDGET_HTML = `
<div class="widget-root">

  <!-- 扇形菜单 -->
  <div class="fan-layer" id="fan-layer">
    <button class="fbtn mic" id="fbtn-mic" title="长按录音">🎤</button>
    <button class="fbtn txt" id="fbtn-txt" title="文字输入">✏️</button>
    <button class="fbtn cfg" id="fbtn-cfg" title="打开设置面板">⚙️</button>
  </div>

  <!-- 智引灵 SVG v5 -->
  <svg class="xb-svg idle" id="pika" viewBox="0 0 100 120" width="86"
       overflow="visible" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <!-- 头：奶白为主 -->
      <radialGradient id="xb-head-g" cx="38%" cy="32%" r="65%">
        <stop offset="0%"   stop-color="#fffef8"/>
        <stop offset="55%"  stop-color="#f8ece0"/>
        <stop offset="100%" stop-color="#e8d0bc"/>
      </radialGradient>
      <!-- 身体：奶白带粉 -->
      <radialGradient id="xb-body-g" cx="40%" cy="30%" r="65%">
        <stop offset="0%"   stop-color="#fff4f0"/>
        <stop offset="55%"  stop-color="#f5dcd8"/>
        <stop offset="100%" stop-color="#e0b8b4"/>
      </radialGradient>
      <!-- 眼：天蓝（与奶白形成对比） -->
      <radialGradient id="xb-eye-g" cx="30%" cy="28%" r="66%">
        <stop offset="0%"   stop-color="#c8f0ff"/>
        <stop offset="50%"  stop-color="#3098d8"/>
        <stop offset="100%" stop-color="#0860a8"/>
      </radialGradient>
      <!-- 脚：粉色 -->
      <radialGradient id="xb-foot-g" cx="40%" cy="35%" r="65%">
        <stop offset="0%"   stop-color="#ffd0dc"/>
        <stop offset="100%" stop-color="#f0a0b8"/>
      </radialGradient>
    </defs>

    <!-- 光晕（粉色调） -->
    <ellipse cx="50" cy="32" rx="40" ry="40" fill="rgba(255,180,200,0.07)"/>

    <!-- 轨道环（粉色） -->
    <g id="xb-halo">
      <circle cx="50" cy="32" r="36" fill="none"
              stroke="#ffb0c8" stroke-width="1.8"
              stroke-dasharray="11 5" stroke-linecap="round" opacity="0.80"/>
    </g>

    <!-- ① 头部（大圆，奶白） -->
    <circle cx="50" cy="32" r="30" fill="url(#xb-head-g)"/>
    <!-- 头顶高光 -->
    <ellipse cx="41" cy="18" rx="10" ry="6"
             fill="rgba(255,255,255,0.50)" transform="rotate(-12,41,18)"/>

    <!-- 脸部（比头略暖） -->
    <ellipse cx="50" cy="34" rx="21" ry="19" fill="#fff8f0"/>

    <!-- 左眼 -->
    <g id="xb-eye-l">
      <ellipse cx="42" cy="31" rx="6.5" ry="7" fill="url(#xb-eye-g)"/>
      <circle  cx="39"   cy="28"   r="3.8" fill="rgba(255,255,255,0.92)"/>
      <circle  cx="45.5" cy="34.5" r="1.6" fill="rgba(255,255,255,0.38)"/>
    </g>

    <!-- 右眼 -->
    <g id="xb-eye-r">
      <ellipse cx="58" cy="31" rx="6.5" ry="7" fill="url(#xb-eye-g)"/>
      <circle  cx="55"   cy="28"   r="3.8" fill="rgba(255,255,255,0.92)"/>
      <circle  cx="61.5" cy="34.5" r="1.6" fill="rgba(255,255,255,0.38)"/>
    </g>

    <!-- 腮红 -->
    <ellipse id="xb-cheek-l" cx="32" cy="37" rx="7" ry="4.5" fill="#ffb8c8" opacity="0.75"/>
    <ellipse id="xb-cheek-r" cx="68" cy="37" rx="7" ry="4.5" fill="#ffb8c8" opacity="0.75"/>

    <!-- 嘴·闭合 -->
    <path id="xb-mouth-normal" d="M 44,44 Q 50,49 56,44"
          fill="none" stroke="#d08878" stroke-width="1.7" stroke-linecap="round"/>

    <!-- 嘴·张开 -->
    <g id="xb-mouth-open" opacity="0">
      <path d="M 44,44 Q 50,50 56,44" fill="#d08070"/>
      <ellipse cx="50" cy="47" rx="5" ry="2.8" fill="#b85050"/>
    </g>

    <!-- ② 身体（奶白带粉，比头窄，紧凑） -->
    <path d="M 39,62 C 28,64 14,70 14,82
             C 14,95 26,104 50,104
             C 74,104 86,95 86,82
             C 86,70 72,64 61,62 Z"
          fill="url(#xb-body-g)"/>

    <!-- 身体高光 -->
    <ellipse cx="44" cy="80" rx="11" ry="13" fill="rgba(255,255,255,0.30)"/>

    <!-- 手臂（奶白带粉） -->
    <ellipse cx="9"  cy="76" rx="13" ry="8" fill="url(#xb-body-g)" transform="rotate(-22,9,76)"/>
    <ellipse cx="91" cy="76" rx="13" ry="8" fill="url(#xb-body-g)" transform="rotate(22,91,76)"/>

    <!-- ③ 脚（粉色，两只小圆脚） -->
    <ellipse cx="37" cy="110" rx="13" ry="8" fill="url(#xb-foot-g)"/>
    <ellipse cx="63" cy="110" rx="13" ry="8" fill="url(#xb-foot-g)"/>
    <!-- 脚高光 -->
    <ellipse cx="34" cy="107" rx="5" ry="3" fill="rgba(255,255,255,0.40)"/>
    <ellipse cx="60" cy="107" rx="5" ry="3" fill="rgba(255,255,255,0.40)"/>
  </svg>

  <!-- 文字输入 -->
  <div class="tinput-wrap" id="tinput-wrap">
    <input class="tinput" id="tinput" type="text" placeholder="输入指令，回车发送">
  </div>
</div>`;

  function injectPikachuWidget() {
    widgetHost = document.createElement('div');
    widgetHost.id = 'dhn-widget-host';
    document.body.appendChild(widgetHost);

    const shadow = widgetHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${WIDGET_CSS}</style>${WIDGET_HTML}`;

    pikaBall   = shadow.getElementById('pika');
    fanLayer   = shadow.getElementById('fan-layer');
    micFanBtn  = shadow.getElementById('fbtn-mic');
    textWrap   = shadow.getElementById('tinput-wrap');
    textInput  = shadow.getElementById('tinput');

    // ── 拖拽逻辑 ──
    // 区分拖动 vs 点击：移动距离 > 5px 才算拖拽，否则触发 toggleFan
    let _ptrDownX = 0, _ptrDownY = 0;
    let _dragging = false, _moved = false;
    let _hostStartL = 0, _hostStartT = 0;

    pikaBall.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fbtn')) return;
      _ptrDownX = e.clientX; _ptrDownY = e.clientY;
      _dragging = false; _moved = false;
      const r = widgetHost.getBoundingClientRect();
      _hostStartL = r.left;
      _hostStartT = r.top;
      pikaBall.setPointerCapture(e.pointerId);
    });

    pikaBall.addEventListener('pointermove', (e) => {
      if (!(e.buttons & 1)) return;
      const dx = e.clientX - _ptrDownX;
      const dy = e.clientY - _ptrDownY;
      if (!_moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        _moved = true; _dragging = true;
        pikaBall.setAttribute('class', pikaBall.getAttribute('class') + ' dragging');
        closeFan();
      }
      if (_dragging) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const nl = Math.max(0, Math.min(_hostStartL + dx, vw - 88));
        const nt = Math.max(0, Math.min(_hostStartT + dy, vh - 88));
        widgetHost.style.left  = nl + 'px';
        widgetHost.style.top   = nt + 'px';
        widgetHost.style.bottom = 'auto';
      }
    });

    pikaBall.addEventListener('pointerup', () => {
      if (_dragging) {
        _dragging = false;
        const base = pikaBall.getAttribute('class').replace(' dragging', '');
        pikaBall.setAttribute('class', base);
        chrome.storage.local.set({
          widgetPos: { left: widgetHost.style.left, top: widgetHost.style.top }
        });
      } else if (!_moved) {
        toggleFan();
      }
      _moved = false;
    });

    // 恢复上次拖拽位置
    chrome.storage.local.get(['widgetPos'], (data) => {
      if (data.widgetPos?.left) {
        widgetHost.style.left   = data.widgetPos.left;
        widgetHost.style.top    = data.widgetPos.top || '24px';
        widgetHost.style.bottom = 'auto';
      }
    });

    // 长按麦克风 → 立即反馈，不等 SW 回包
    micFanBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      // setPointerCapture 确保手指/鼠标移出按钮后 pointerup 仍送达此元素
      micFanBtn.setPointerCapture(e.pointerId);
      setWidgetState('listening');
      micFanBtn.classList.add('recording');
      chrome.runtime.sendMessage({ type: 'CTRL_START_REC' }).catch(() => {});
    });
    const stopRec = (e) => {
      e?.stopPropagation();
      micFanBtn.classList.remove('recording');
      setWidgetState('thinking');
      chrome.runtime.sendMessage({ type: 'CTRL_STOP_REC' }).catch(() => {});
    };
    micFanBtn.addEventListener('pointerup',     stopRec);
    micFanBtn.addEventListener('pointercancel', stopRec);

    // 文字按钮 → 显示/隐藏输入框
    shadow.getElementById('fbtn-txt').addEventListener('click', (e) => {
      e.stopPropagation();
      textWrap.classList.toggle('visible');
      if (textWrap.classList.contains('visible')) textInput.focus();
    });

    // 设置按钮 → 打开侧边栏
    shadow.getElementById('fbtn-cfg').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', payload: {} });
    });

    // 回车发送文字指令
    textInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = textInput.value.trim();
      if (!text) return;
      textInput.value = '';
      textWrap.classList.remove('visible');
      closeFan();
      setWidgetState('thinking');
      chrome.runtime.sendMessage({ type: 'ASR_RESULT', payload: { transcript: text } }).catch(() => {});
    });

    // 点击 widget 外部 → 收起扇形
    document.addEventListener('click', (e) => {
      if (!e.composedPath().includes(widgetHost)) closeFan();
    });
  }

  function toggleFan() {
    fanLayer.classList.contains('open') ? closeFan() : fanLayer.classList.add('open');
  }

  function closeFan() {
    fanLayer?.classList.remove('open');
    textWrap?.classList.remove('visible');
  }

  function setWidgetState(state) {
    if (!pikaBall) return;
    pikaBall.setAttribute('class', 'xb-svg ' + (state || 'idle'));
  }

  // ─────────────────────────────────────────────
  // 麦克风录音 (getUserMedia 在真实页面上下文)
  // ─────────────────────────────────────────────

  let contentRecorder = null;
  let contentChunks   = [];
  let contentStream   = null;
  let contentMimeType = '';
  let pendingStop     = false;

  async function startContentRecording() {
    contentChunks = [];
    contentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    contentMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';

    contentRecorder = new MediaRecorder(contentStream, { mimeType: contentMimeType });
    contentRecorder.ondataavailable = (e) => { if (e.data.size > 0) contentChunks.push(e.data); };
    contentRecorder.onstop = async () => {
      contentStream.getTracks().forEach(t => t.stop());
      contentStream = null;
      if (contentChunks.length === 0) {
        chrome.runtime.sendMessage({ type: 'RECORDING_DONE', payload: { error: 'NO_AUDIO' } }).catch(() => {});
        return;
      }
      const blob = new Blob(contentChunks, { type: contentMimeType });
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          type: 'RECORDING_DONE',
          payload: { audio: reader.result.split(',')[1], mimeType: contentMimeType }
        }).catch(() => {});
      };
      reader.readAsDataURL(blob);
    };
    contentRecorder.start(100);
    if (pendingStop) { pendingStop = false; contentRecorder.stop(); }
  }

  function stopContentRecording() {
    if (contentRecorder && contentRecorder.state !== 'inactive') {
      contentRecorder.stop();
    } else {
      pendingStop = true;
    }
  }

  // ─────────────────────────────────────────────
  // 消息路由
  // ─────────────────────────────────────────────

  function handleMessage(msg, _sender, sendResponse) {
    const { type, payload } = msg;

    switch (type) {
      case 'PING':
        sendResponse({ pong: true });
        break;

      case 'ANIM_SET_STATE':
        setWidgetState(payload.state);
        sendResponse({ ok: true });
        break;

      case 'STATUS_TEXT':
        setWidgetState(payload.state || 'idle');
        sendResponse({ ok: true });
        break;

      case 'START_REC': {
        pendingStop = false;
        startContentRecording()
          .then(() => sendResponse({ ok: true }))
          .catch(e => {
            pendingStop = false;
            console.error('[Content] getUserMedia error:', e.name, e.message);
            chrome.runtime.sendMessage({
              type: 'RECORDING_ERROR',
              payload: { error: e.name, message: e.message }
            }).catch(() => {});
            sendResponse({ ok: false, error: e.name });
          });
        return true;
      }

      case 'STOP_REC':
        stopContentRecording();
        sendResponse({ ok: true });
        break;

      case 'DOM_PRECOLLECT':
        // 按下麦克风时触发，与录音并行运行，结果缓存在 DomDistiller 内部
        // 后续 DOM_DISTILL 会复用这份缓存，省去重复 DOM 扫描
        try { DomDistiller.precollect(document); } catch (_) {}
        sendResponse({ ok: true });
        break;

      case 'DOM_DISTILL':
        try {
          sendResponse(DomDistiller.distill(document, payload?.intent || ''));
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'EXEC_HIGHLIGHT':
        sendResponse(execHighlight(payload.selector, payload.fallbackText));
        break;

      case 'EXEC_CLICK':
        // 用户偏好：service-worker 的 click action 已统一改发 EXEC_HIGHLIGHT
        // 保留此 handler 供未来"强制点击"模式使用，目前不会被调用
        sendResponse(execAction(payload.selector, payload.fallbackText));
        break;

      case 'EXEC_INPUT':
        sendResponse(execInput(payload.selector, payload.fallbackText, payload.value));
        break;

      case 'EXEC_SCROLL':
        sendResponse(execScroll(payload.selector, payload.fallbackText));
        break;

      case 'EXEC_TASK_QUEUE':
        TaskQueue.run(payload.tasks).then(res => sendResponse(res));
        return true;

      case 'EXEC_VERIFY_HIGHLIGHT': {
        const res = verifyAndReHighlight(payload.verifyText);
        sendResponse(res);
        break;
      }

      case 'CLEAR_HIGHLIGHT':
        clearAll();
        sendResponse({ success: true });
        break;

      case 'SHOW_SPEECH':
        showSpeechBubble(payload.text, payload.selector);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: 'UNKNOWN_MESSAGE_TYPE' });
    }
  }

  // ─────────────────────────────────────────────
  // 高亮动画
  // ─────────────────────────────────────────────

  function execHighlight(selector, fallbackText) {
    const resolved = SelectorEngine.resolve(selector, fallbackText, 'highlight');
    if (!resolved.element) return { success: false, level: resolved.level, guidance: resolved.guidance };

    clearHighlight();
    const el = resolved.element;
    const rect = el.getBoundingClientRect();
    const inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight
                    && rect.left >= 0 && rect.right <= window.innerWidth;

    if (inViewport) {
      placeHighlightOverlay(el);
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => placeHighlightOverlay(el), 600);
    }
    return { success: true, level: resolved.level };
  }

  function placeHighlightOverlay(el) {
    clearHighlight();
    highlightTargetEl = el;   // 记录目标元素供 verifyText 校验使用
    const rect = el.getBoundingClientRect();
    highlightEl = document.createElement('div');
    highlightEl.className = 'dhn-highlight-overlay';
    highlightEl.style.left   = (rect.left - 4) + 'px';
    highlightEl.style.top    = (rect.top  - 4) + 'px';
    highlightEl.style.width  = (rect.width  + 8) + 'px';
    highlightEl.style.height = (rect.height + 8) + 'px';
    document.body.appendChild(highlightEl);
    spawnRipple(rect);
    setTimeout(() => spawnRipple(rect), 300);

    highlightClickDismiss = () => clearHighlight();
    document.addEventListener('click', highlightClickDismiss, { once: true, capture: true });
  }

  function spawnRipple(rect) {
    const ripple = document.createElement('div');
    ripple.className = 'dhn-ripple-ring';
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const size = Math.max(rect.width, rect.height) * 1.5;
    ripple.style.left   = (cx - size / 2) + 'px';
    ripple.style.top    = (cy - size / 2) + 'px';
    ripple.style.width  = size + 'px';
    ripple.style.height = size + 'px';
    document.body.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }

  function clearHighlight() {
    if (highlightEl) { highlightEl.remove(); highlightEl = null; }
    highlightTargetEl = null;
    if (highlightClickDismiss) {
      document.removeEventListener('click', highlightClickDismiss, { capture: true });
      highlightClickDismiss = null;
    }
    document.querySelectorAll('.dhn-ripple-ring').forEach(r => r.remove());
  }

  // --- 高亮验证：校验 verifyText 是否和被高亮元素的文字匹配 ---
  // 解决"LLM 说用量统计但高亮了模型广场"的问题
  function verifyAndReHighlight(verifyText) {
    if (!verifyText) return { success: true, verified: true };

    const vt = verifyText.toLowerCase().replace(/\s+/g, '').trim();

    // 1. 检查当前高亮元素是否已经正确
    if (highlightTargetEl) {
      const elText = (highlightTargetEl.textContent || '').toLowerCase().replace(/\s+/g, '').trim();
      if (elText.includes(vt) || vt.includes(elText.slice(0, 10))) {
        return { success: true, verified: true };
      }
    }

    // 2. 高亮元素文字不匹配 → 在全页可交互元素里找正确的
    const candidates = document.querySelectorAll(
      'a, button, [role="menuitem"], [role="tab"], [role="link"], li, span, div, td'
    );
    for (const el of candidates) {
      const text = (el.textContent || '').toLowerCase().replace(/\s+/g, '').trim();
      if (!text || text.length > 30) continue;
      if (text.includes(vt) || vt.includes(text.slice(0, Math.min(vt.length, 10)))) {
        // 找到了更正确的元素，重新高亮
        placeHighlightOverlay(el);
        return { success: true, verified: false, reHighlighted: true };
      }
    }

    return { success: true, verified: false };
  }

  // ─────────────────────────────────────────────
  // 点击 / 输入 / 滚动
  // ─────────────────────────────────────────────

  function execAction(selector, fallbackText) {
    const resolved = SelectorEngine.resolve(selector, fallbackText, 'click');
    if (!resolved.element) return { success: false, level: resolved.level, guidance: resolved.guidance };
    highlightAndClick(resolved.element);
    return { success: true, level: resolved.level };
  }

  function highlightAndClick(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = el.getBoundingClientRect();
    const flash = document.createElement('div');
    flash.className = 'dhn-highlight-overlay';
    flash.style.left   = (rect.left - 2) + 'px';
    flash.style.top    = (rect.top  - 2) + 'px';
    flash.style.width  = (rect.width  + 4) + 'px';
    flash.style.height = (rect.height + 4) + 'px';
    flash.style.borderColor = '#10b981';
    flash.style.background  = 'rgba(16,185,129,0.15)';
    document.body.appendChild(flash);
    setTimeout(() => { flash.remove(); el.click(); }, 400);
  }

  function execInput(selector, fallbackText, value) {
    const resolved = SelectorEngine.resolve(selector, fallbackText, 'input');
    if (!resolved.element) return { success: false, level: resolved.level, guidance: resolved.guidance };

    const el = resolved.element;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();

    if (value !== undefined && value !== null) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.select();
    }
    return { success: true, level: resolved.level };
  }

  function execScroll(selector, fallbackText) {
    const resolved = SelectorEngine.resolve(selector, fallbackText, 'scroll');
    if (!resolved.element) return { success: false, level: resolved.level, guidance: resolved.guidance };
    resolved.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { success: true, level: resolved.level };
  }

  // ─────────────────────────────────────────────
  // 语音气泡
  // ─────────────────────────────────────────────

  function showSpeechBubble(text, selector) {
    if (speechBubble) { speechBubble.remove(); speechBubble = null; }

    speechBubble = document.createElement('div');
    speechBubble.className = 'dhn-speech-bubble';
    speechBubble.textContent = text;

    if (selector) {
      const target = document.querySelector(selector);
      if (target) {
        const rect = target.getBoundingClientRect();
        speechBubble.style.left = rect.left + 'px';
        speechBubble.style.top  = (rect.top - 48) + 'px';
      } else {
        positionCenter(speechBubble);
      }
    } else {
      positionCenter(speechBubble);
    }

    document.body.appendChild(speechBubble);
    setTimeout(() => { if (speechBubble) { speechBubble.remove(); speechBubble = null; } }, 5000);
  }

  function positionCenter(el) {
    el.style.left      = '50%';
    el.style.top       = '20%';
    el.style.transform = 'translate(-50%, -50%)';
  }

  function clearAll() {
    clearHighlight();
    if (speechBubble) { speechBubble.remove(); speechBubble = null; }
  }

  // ─────────────────────────────────────────────
  // SPA 路由变化检测
  // ─────────────────────────────────────────────

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', payload: { url: lastUrl } });
    }
  }).observe(document, { subtree: true, childList: true });

  init();
})();
