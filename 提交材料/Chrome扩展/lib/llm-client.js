/**
 * LLM Client — DeepSeek API 客户端
 *
 * 支持模型: deepseek-chat (V3), deepseek-v4-flash
 * 用于 Background Service Worker (ES Module)
 *
 * @module llm-client
 */

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

export const MODELS = {
  chat: 'deepseek-chat',
  v4flash: 'deepseek-v4-flash'
};

const SYSTEM_PROMPT = `你是"智引灵"，一位面向高校教育场景的AI导航导师。你的身份是一所智慧大学的虚拟助教，职责是帮助师生在学习、教学、管理相关的在线平台上快速找到方向。

## 角色设定
- 身份：虚拟助教，服务于大学师生
- 性格：温暖、耐心、专业，像一位细心的学长/学姐
- 使命：不让任何一个人因为不会用网站而错过学习机会
- 原则：技术退后一步，教育向前一步——你是导航伙伴，不是替代教师

## 核心能力
1. 页面导航：理解用户需求，高亮目标元素或执行多步操作
2. 概念解释：当用户询问页面上的教育概念（如"学分绩点""先修课""培养方案"等），结合页面可见内容给出40字以内的专业解释
3. 学习引导：当用户表现出困惑时，主动提供操作建议和学习路径指引

## 输出格式
{
  "target": "CSS选择器",
  "fallbackText": "元素的可见文本(用于XPath降级匹配)",
  "verifyText": "目标元素上应出现的精确可见文字(用于验证高亮准确性，必填)",
  "action": "highlight|click|input|scroll|describe",
  "value": "填入的文字(仅 action 为 input 时必填，其他情况省略)",
  "speech": "对用户说的引导语(中文，教育场景不超过30字，其他场景不超过20字)",
  "tasks": [
    {"step": 1, "speech": "...", "target": "...", "trigger": "click|visible|input", "value": "填入内容(trigger为input时必填)"}
  ]
}

## 规则
1. target 必须基于页面结构中实际存在的选择器，优先使用 strongSelector
2. 不确定的选择器不要编造，用 fallbackText 标注元素的可见文本
3. verifyText 必须是目标元素上实际可见的文字（如"用量统计"），用于后端验证高亮是否选对
4. speech 要简短自然，像朋友在耳边提示；教育场景不超过30字，其他场景不超过20字
5. 如果用户请求模糊，优先选择最可能的元素
6. 多步任务必须按操作顺序排列 steps，每个 step 有独立的 trigger
7. action 为 input 时，必须在 value 字段填写用户要输入的内容
8. 导航指引默认使用 highlight，高亮展示目标位置，让用户自己决定是否点击；click 仅在用户明确说"帮我点""直接点"时才使用
9. 如果用户意图与页面无关，speech 中礼貌说明
10. 当用户询问"这个网页/网站/页面是什么""有什么功能""能做什么"等页面描述类问题时，使用 action:"describe"，不需要 target/verifyText，speech 用50字以内综合页面标题、结构和内容进行简洁总结
11. 当用户询问页面上的教育概念或专业术语时，优先用 action:"describe" 做简短解释，再视需要给出导航指引`;

/**
 * @param {string} pageSummary - 蒸馏后的页面结构(Prompt格式)
 * @param {string} userIntent - 用户语音转文字
 * @param {string} apiKey - DeepSeek API Key
 * @param {'chat'|'v4flash'} modelType
 * @returns {Promise<Object>}
 */
export async function infer(pageSummary, userIntent, apiKey, modelType = 'chat') {
  if (!apiKey) {
    throw new Error('API_KEY_MISSING');
  }

  const model = MODELS[modelType] || MODELS.chat;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: pageSummary }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 1500
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (res.status === 401) throw new Error('API_AUTH_ERROR');
    if (res.status === 429) throw new Error('API_RATE_LIMIT');
    if (!res.ok) throw new Error(`API_HTTP_${res.status}`);

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) throw new Error('API_EMPTY_RESPONSE');

    // 提取 JSON：兼容 markdown 代码块包裹 和 纯 JSON 两种格式
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                      content.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

    try {
      return JSON.parse(jsonStr);
    } catch (_) {
      // max_tokens 截断时 JSON 不完整，尝试从中抢救出已完成的字段
      const recovered = recoverPartialJson(content);
      if (recovered?.target || recovered?.speech) {
        console.warn('[LLM] Partial JSON recovered from truncated response');
        return recovered;
      }
      console.error('[LLM] JSON parse failed, raw:', content.slice(0, 200));
      throw new Error('API_JSON_ERROR');
    }
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('API_TIMEOUT');
    throw e;
  }
}

/**
 * 极简推理 — 专门用于 API_EMPTY_RESPONSE 重试
 * 去掉所有选择器细节，只保留区域摘要 + 意图，绕过内容安全过滤
 */
export async function inferMinimal(regionSummary, userIntent, apiKey, modelType = 'chat') {
  if (!apiKey) throw new Error('API_KEY_MISSING');
  const model = MODELS[modelType] || MODELS.chat;
  const messages = [
    {
      role: 'system',
      content: `你是智引灵AI导航导师。根据页面区域描述和用户意图，给出口头指引。
只返回 JSON：{"speech":"指引语(20字内)","verifyText":"目标文字"}`
    },
    {
      role: 'user',
      content: `页面区域：\n${regionSummary}\n\n用户意图：${userIntent}`
    }
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 200 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`API_HTTP_${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('API_EMPTY_RESPONSE');
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { speech: userIntent ? '请查看页面相关区域' : '请描述你的操作' };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('API_TIMEOUT');
    throw e;
  }
}

/**
 * 从被 max_tokens 截断的 JSON 中抢救可用字段
 * 截断场景：{"target":"...","action":"highlig  ← 末尾不完整
 */
function recoverPartialJson(raw) {
  const result = {};
  const pairs = [
    ['target',       /"target"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['fallbackText', /"fallbackText"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['action',       /"action"\s*:\s*"(highlight|click|input|scroll)/],
    ['speech',       /"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['value',        /"value"\s*:\s*"((?:[^"\\]|\\.)*)"/],
  ];
  for (const [key, re] of pairs) {
    const m = raw.match(re);
    if (m) result[key] = m[1];
  }
  return Object.keys(result).length ? result : null;
}

/**
 * 流式推理 — 逐步返回内容片段
 * @returns {AsyncGenerator<string>}
 */
export async function* inferStream(pageSummary, userIntent, apiKey, modelType = 'chat') {
  if (!apiKey) { yield '{"error":"API_KEY_MISSING"}'; return; }

  const model = MODELS[modelType] || MODELS.chat;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: pageSummary }
  ];

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 512, stream: true })
  });

  if (!res.ok) { yield `{"error":"API_HTTP_${res.status}"}`; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (_) { /* skip malformed chunks */ }
      }
    }
  }
}
