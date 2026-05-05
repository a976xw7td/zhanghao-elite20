/**
 * Task Queue — 多步任务状态机
 *
 * 状态: IDLE → RUNNING → WAITING → COMPLETED | FAILED
 * 触发器: click | visible | input
 * 依赖: SelectorEngine (L1-L5降级)
 *
 * @module task-queue
 */

const TaskQueue = (() => {
  'use strict';

  // --- 状态枚举 ---
  const STATE = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    WAITING: 'waiting',
    COMPLETED: 'completed',
    FAILED: 'failed'
  });

  const STEP_TIMEOUT_MS = 30000;
  const VISIBLE_POLL_MS = 200;

  // --- 内部状态 ---
  let state = STATE.IDLE;
  let tasks = [];
  let currentIndex = 0;
  let results = [];
  let observer = null;
  let stepTimer = null;

  // --- 重置 ---
  function reset() {
    state = STATE.IDLE;
    tasks = [];
    currentIndex = 0;
    results = [];
    cleanup();
  }

  function cleanup() {
    if (observer) { observer.disconnect(); observer = null; }
    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
  }

  // --- 启动队列 ---
  /**
   * @param {Array<{step: number, speech: string, target: string, trigger: string, value?: string}>} taskList
   * @returns {Promise<{completed: number, total: number, results: Array}>}
   */
  async function run(taskList) {
    reset();
    tasks = taskList;
    state = STATE.RUNNING;

    for (currentIndex = 0; currentIndex < tasks.length; currentIndex++) {
      const task = tasks[currentIndex];

      showSpeech(task.speech, task.target);

      const result = await executeStep(task);
      results.push({ step: task.step, ...result });

      if (!result.success) {
        state = STATE.FAILED;
        break;
      }
    }

    if (state !== STATE.FAILED) {
      state = STATE.COMPLETED;
    }

    cleanup();
    return {
      completed: results.filter(r => r.success).length,
      total: tasks.length,
      state,
      results
    };
  }

  // --- 执行单个步骤 ---
  function executeStep(task) {
    return new Promise(resolve => {
      const resolved = SelectorEngine.resolve(task.target, task.speech, 'click');

      if (!resolved.element) {
        if (task.trigger === 'visible') {
          waitForVisible(task.target).then(el => {
            if (el) {
              if (task.trigger === 'input') {
                fillInput(el, task.value);
                resolve({ success: true, trigger: 'visible-input' });
              } else {
                clickElement(el);
                resolve({ success: true, trigger: 'visible' });
              }
            } else {
              resolve({ success: false, reason: 'timeout', level: 'visible_wait' });
            }
          });
          return;
        }

        if (resolved.level === 'verbal') {
          showSpeech(resolved.guidance, null);
          resolve({ success: true, level: 'verbal', guidance: resolved.guidance });
          return;
        }

        resolve({ success: false, reason: 'selector_not_found', level: resolved.level });
        return;
      }

      const el = resolved.element;

      if (task.trigger === 'input') {
        fillInput(el, task.value);
        resolve({ success: true, trigger: 'input', level: resolved.level });
        return;
      }

      if (task.trigger === 'visible') {
        clickElement(el);
        resolve({ success: true, trigger: 'visible', level: resolved.level });
        return;
      }

      // 默认: click
      clickElement(el);
      resolve({ success: true, trigger: 'click', level: resolved.level });
    });
  }

  // --- 填充输入框 (React/Vue/Angular 兼容) ---
  function fillInput(el, value) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();
    if (value !== undefined && value !== null) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.select();
    }
  }

  // --- 等待元素出现 ---
  function waitForVisible(selector) {
    return new Promise(resolve => {
      const startTime = Date.now();

      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }
        if (Date.now() - startTime > STEP_TIMEOUT_MS) {
          resolve(null);
          return;
        }
        // BUG FIX: 备用轮询间隔应为 VISIBLE_POLL_MS(200ms)，不是 STEP_TIMEOUT_MS(30s)
        stepTimer = setTimeout(check, VISIBLE_POLL_MS);
      };

      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }

      // MutationObserver 优先检测 DOM 变化（最快路径）
      observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          observer = null;
          if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
      });

      // 启动备用轮询（MutationObserver 漏检 visibility/opacity 变化时的兜底）
      stepTimer = setTimeout(check, VISIBLE_POLL_MS);
    });
  }

  // --- 点击元素 ---
  function clickElement(el) {
    // behavior:'instant' 确保立即完成滚动，getBoundingClientRect 得到准确视口坐标
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = el.getBoundingClientRect();
    const flash = document.createElement('div');
    flash.className = 'dhn-highlight-overlay';
    // position:fixed 不加 scroll 偏移
    flash.style.left = (rect.left - 2) + 'px';
    flash.style.top = (rect.top - 2) + 'px';
    flash.style.width = (rect.width + 4) + 'px';
    flash.style.height = (rect.height + 4) + 'px';
    flash.style.borderColor = '#10b981';
    flash.style.background = 'rgba(16, 185, 129, 0.15)';
    document.body.appendChild(flash);
    setTimeout(() => {
      flash.remove();
      el.click();
    }, 400);
  }

  // --- 气泡提示 ---
  function showSpeech(text, selector) {
    if (!text) return;
    const bubble = document.createElement('div');
    bubble.className = 'dhn-speech-bubble';
    bubble.textContent = text;

    if (selector) {
      const target = document.querySelector(selector);
      if (target) {
        const rect = target.getBoundingClientRect();
        // position:fixed 直接用视口坐标
        bubble.style.left = rect.left + 'px';
        bubble.style.top = (rect.top - 48) + 'px';
      } else {
        bubble.style.left = '50%';
        bubble.style.top = '20%';
        bubble.style.transform = 'translate(-50%, -50%)';
      }
    } else {
      bubble.style.left = '50%';
      bubble.style.top = '20%';
      bubble.style.transform = 'translate(-50%, -50%)';
    }

    document.body.appendChild(bubble);
    setTimeout(() => bubble.remove(), 5000);
  }

  // --- 公共 API ---
  return {
    STATE,
    run,
    reset,
    getState: () => state,
    getProgress: () => ({ current: currentIndex, total: tasks.length, results })
  };
})();
