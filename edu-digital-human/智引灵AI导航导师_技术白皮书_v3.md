# 智引灵 AI 导航导师

## 技术实现方案及架构白皮书 v3.0

### 第三届"教育数字人大赛——我和数字人的故事"参赛作品

---

## 一、项目概述

### 1.1 项目愿景

"智引灵"是一个以 Chrome 浏览器扩展形态运行的 AI 数字人导航导师，专为高校师生设计。用户在面对教务系统、在线课程平台、学术资源站点等教育类网站时，通过**语音对话**即可获得即时的页面导航指引——数字人会高亮目标元素、语音播报操作提示，帮助学生和教师快速找到所需功能。

### 1.2 核心目标

| 目标 | 指标 |
|------|------|
| 低延迟响应 | 端到端 < 3秒（ASR + DOM蒸馏 + LLM推理 + 执行 + TTS） |
| 高精度定位 | 目标元素匹配率 > 90%（精确 + 弱化 + XPath三级） |
| 沉浸式陪伴 | 双形态数字人（侧边栏主形象 + 页面浮窗 Widget） |
| 可靠降级 | 5级选择器策略，确保在最坏情况下仍有语音指引 |

### 1.3 v3.0 更新要点

- **教育身份注入**：LLM System Prompt 从通用导航助手升级为"智引灵"虚拟助教角色
- **意图感知蒸馏**：DOM蒸馏支持根据用户意图智能聚焦页面区域（如"登录"→优先扫描导航栏）
- **双录音路径**：Offscreen Document + Content Script 双通道，兼容侧边栏关闭场景
- **高亮验证机制**：LLM 输出 verifyText，前端校验高亮元素是否匹配，防止选错目标
- **双模推理**：全量 Prompt → 极简 Prompt 自动降级，应对 API 安全过滤或 token 超限
- **SPA 路由感知**：MutationObserver 检测 SPA 页面切换，自动失效 DOM 缓存

---

## 二、系统架构

### 2.1 六层架构总览

```
┌─────────────────────────────────────────────────────┐
│ 展现层     │ Side Panel (SVG 数字人 + 动画)          │
│            │ Content Widget (皮卡丘浮窗 + 扇出菜单)   │
├─────────────────────────────────────────────────────┤
│ 对话层     │ Offscreen Document (getUserMedia 录音) │
│            │ Content Script (备选录音路径)           │
│            │ Chrome TTS (语音合成播报)               │
├─────────────────────────────────────────────────────┤
│ 编排层     │ Service Worker (状态机 + 消息路由)      │
│            │ TaskQueue (多步操作 + MutationObserver) │
│            │ SelectorEngine (5级选择器降级)          │
├─────────────────────────────────────────────────────┤
│ 大脑层     │ DeepSeek Chat / DeepSeek V4 Flash      │
│            │ infer() 全量推理 + inferMinimal() 极简  │
│            │ recoverPartialJson() 截断抢救           │
├─────────────────────────────────────────────────────┤
│ 预处理层   │ DomDistiller (意图驱动蒸馏管线)        │
│            │ 过滤→去重→意图聚类→摘要→选择器→Prompt  │
├─────────────────────────────────────────────────────┤
│ 感知层     │ Content Script DOM Parser              │
│            │ 可交互元素提取 + SPA路由变化检测        │
└─────────────────────────────────────────────────────┘
```

### 2.2 进程与通信

Chrome Extension MV3 架构下，系统由四个独立进程组成，通过 Chrome Runtime Messages 通信：

| 进程 | 文件 | 职责 |
|------|------|------|
| **Side Panel** | `sidepanel/sidepanel.html` + `sidepanel.js` | SVG数字人渲染、设置面板、文字输入备用通道 |
| **Background SW** | `background/service-worker.js` | 状态持有者、消息路由、API编排、TTS播报 |
| **Content Script** | `content/content.js` | DOM操作、Widget渲染、高亮动画、任务执行、备选录音 |
| **Offscreen Doc** | `offscreen/offscreen.html` + `offscreen.js` | getUserMedia 麦克风录音 |

**关键消息类型：**

| 消息 | 方向 | 用途 |
|------|------|------|
| `CTRL_START_REC` / `CTRL_STOP_REC` | SidePanel → SW → Content | 录音启停控制 |
| `RECORDING_DONE` | Content/Offscreen → SW | 录音完成，携带 base64 音频 |
| `RECORDING_ERROR` | Content/Offscreen → SW | 录音失败（权限/设备） |
| `DOM_PRECOLLECT` | SW → Content | 触发DOM预收集（与录音并行） |
| `DOM_DISTILL` | SW → Content | 蒸馏DOM，携带用户意图 |
| `EXEC_HIGHLIGHT` / `EXEC_CLICK` / `EXEC_INPUT` / `EXEC_SCROLL` | SW → Content | 执行导航指令 |
| `EXEC_TASK_QUEUE` | SW → Content | 执行多步任务队列 |
| `EXEC_VERIFY_HIGHLIGHT` | SW → Content | 高亮后验证文字匹配 |
| `ANIM_SET_STATE` | SW → SidePanel + Content | 同步动画状态 |
| `TTS_SPEAK` | SW → SidePanel | TTS播报（备用路径，已改用chrome.tts） |
| `STATUS_TEXT` | SW → SidePanel + Content | 推送状态文本 |
| `PAGE_CHANGED` | Content → SW | SPA路由变化通知 |

---

## 三、核心技术详解

### 3.1 DOM蒸馏管线（DomDistiller）

这是整个系统最关键的优化——将 3000-5000 token 的原始 DOM 压缩至 300-500 token 的语义摘要，同时保证 LLM 指令遵循率 > 90%。

**六阶段管线：**

```
原始DOM (2000+标签)
  │
  ▼
① 过滤 — querySelectorAll 捕获所有可交互元素
          (button, a[href], input, select, textarea,
           [role="button"], [role="link"], [onclick], [tabindex])
          上限 500 个，防止超大页面卡死
  │
  ▼
② 去重 — 按"标签名 + 可见文本"去重，id 唯一元素保留
  │
  ▼
③ 意图感知聚类 — 根据用户意图智能分配各区域的采集配额：
          · 命中意图区域：24 个元素（2倍宽限）
          · 非相关区域（有意图时）：4 个元素（严格限制）
          · 无意图时：12 个元素（均匀分布）
          
          区域划分策略：
          · ARIA landmark (role="banner"/"navigation"/"main"…)
          · 语义标签 (header/nav/main/aside/footer)
          · 视口位置推断 (topRatio<0.15→header-bar, >0.85→footer)
  │
  ▼
④ 语义摘要 — 每个区域生成自然语言描述
          "★ 顶部区域：[登录] [注册] [我的账户]"
          "导航栏：[首页] [课程中心] [成绩查询] [个人设置]"
  │
  ▼
⑤ 选择器增强 — 每个元素生成三层选择器：
          · weakSelector: button.btn-primary
          · strongSelector: button.btn-primary[data-testid="submit-btn"]
          · textFallback: //button[contains(text(),"提交")]
  │
  ▼
⑥ Prompt 拼装 — 页面标题 + meta描述 + h1-h3 + 区域摘要 + 元素列表 + 用户意图
          有意图时 60 个元素，无意图时 35 个元素
```

**意图模式匹配（10个预设 + 泛化兜底）：**

| 用户说 | 优先采集区域 |
|--------|------------|
| "登录/注册/账号" | header-bar, navigation, banner |
| "搜索/查找" | search, header-bar, navigation |
| "设置/配置/个人资料" | sidebar, navigation, complementary |
| "提交/确认/保存/下一步" | form, main-content |
| "导航/菜单/侧边栏" | navigation, sidebar, header-bar |
| "购买/支付/下单" | main-content, sidebar |
| "上传/导入/文件" | main-content, form |
| "关闭/退出/返回" | header-bar, main-content |
| "介绍/说明/这是什么页面" | 无优先（均匀采集，LLM综合） |

**预收集缓存机制：**
用户按下麦克风的瞬间，content script 同步执行 `DOM_PRECOLLECT`，与录音并行完成元素采集。ASR 完成后，`DOM_DISTILL` 直接使用缓存（TTL 30秒，URL 校验），省去重复扫描 ~80-150ms。

### 3.2 LLM 推理引擎（llm-client.js）

**双模型支持：**

| 模型 | API ID | 延迟 | 适用场景 |
|------|--------|------|---------|
| DeepSeek Chat (V3) | `deepseek-chat` | 1-2s | 主力推理，JSON指令能力强 |
| DeepSeek V4 Flash | `deepseek-v4-flash` | 0.5-1s | 更快推理，低延迟场景 |

**双模推理策略：**

```
infer(fullPrompt, intent, apiKey, model)
  │
  ├─ 正常返回 → 解析 JSON → 返回指令
  │
  └─ API_EMPTY_RESPONSE（安全过滤/token超限）
       │
       └─ 自动触发 inferMinimal()
            · 去掉所有选择器细节
            · 仅保留区域摘要 + 用户意图
            · max_tokens = 200
            · 只要求 speech + verifyText
```

**JSON 截断抢救（recoverPartialJson）：**
LLM 响应被 `max_tokens` 截断时（`{"target":"...","action":"highlig...`），通过正则逐字段抢救已完成的 JSON 字段（target / fallbackText / action / speech / value），避免因截断导致整个推理结果作废。

### 3.3 语音交互流水线

**双录音路径：**

| 路径 | 上下文 | 优点 | 缺点 |
|------|--------|------|------|
| **Offscreen Document** | 独立隐藏页面 | 不受侧边栏关闭影响 | 创建offscreen有开销 |
| **Content Script** | 页面内 | 响应快，直接访问页面 | 依赖侧边栏保持打开 |

两路径互为备份：Side Panel 按下麦克风 → Offscreen 启动；Widget 按下麦克风 → Content Script 直接录音。

**ASR 配置：**
- 端点：SiliconFlow Whisper API (`api.siliconflow.cn`)
- 模型：`FunAudioLLM/SenseVoiceSmall`
- 语言：中文
- 格式：WebM (Opus codec)
- 超时：10 秒

**TTS 配置：**
- 引擎：Chrome `chrome.tts` API（内置引擎，无需 API Key）
- 语言：zh-CN
- 语速：0.91，音高：1.1，音量：0.9
- 优势：从 Service Worker 直接发声，不依赖侧边栏聚焦状态

**四种动画状态同步：**

```
idle ──(按下麦克风)──→ listening
                            │
                    (松开发送)
                            │
                            ▼
                        thinking ──(LLM返回)──→ speaking
                            │                       │
                            │              (TTS播完) │
                            │                       │
                            ▼                       ▼
                          idle ←──────────────── idle
```

每种状态对应 Side Panel SVG 动画和 Widget SVG 动画同步切换，光晕颜色不同（listening 橙色 / thinking 紫色 / speaking 绿色 / idle 粉色）。

### 3.4 选择器降级引擎（SelectorEngine）

5级降级策略，确保在任何情况下都能给出反馈：

| 级别 | 方法 | 说明 | 典型命中率 |
|------|------|------|-----------|
| **L1 精确匹配** | `document.querySelector(selector)` | LLM 输出的 strongSelector 直接命中 | ~90% |
| **L2 弱化匹配** | 去掉属性和 id，仅用 tag + class；多匹配时用 fallbackText 文本筛选 | 页面 class 稳定即可命中 | ~7% |
| **L3 XPath文本** | `//tag[contains(text(),"...")]` | 根据元素可见文本定位 | ~2% |
| **L3b 广域文本** | 对所有可交互元素做全量文本比对 | L3 标签名不匹配时兜底 | ~0.5% |
| **L4 LLM 重试** | 带失败上下文重新请求 API | 元素确实不存在时 | — |
| **L5 语音降级** | 口头指引用户自己操作 | 最终兜底 | ~0.5% |

### 3.5 高亮验证机制

解决"LLM 说用量统计但高亮了模型广场"的语义错配问题：

```
EXEC_HIGHLIGHT(target=".nav-item-3", fallbackText="用量统计")
  │
  ├─ ① 正常高亮目标元素，同时记录 highlightTargetEl
  │
  └─ ② EXEC_VERIFY_HIGHLIGHT(verifyText="用量统计")
       │
       ├─ 被高亮元素文字包含"用量统计" → verified: true ✓
       │
       └─ 文字不匹配 → 全页搜索可交互元素
            │
            ├─ 找到文字包含"用量统计"的元素 → 重新高亮 ✦
            └─ 未找到 → verified: false，不操作
```

### 3.6 多步任务队列（TaskQueue）

状态机驱动，支持三种触发器：

| 触发器 | 行为 | 等待机制 |
|--------|------|---------|
| `click` | 直接点击元素 | 无等待 |
| `visible` | 等待元素出现后点击 | MutationObserver 监听 DOM 变化 + 200ms 定时轮询，30s 超时 |
| `input` | 等待元素出现后填入内容 | 同 visible |

**React/Vue/Angular 兼容：** 通过 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')` 劫持 setter，确保框架能感知 value 变化并触发响应式更新。

### 3.7 双形态数字人

**侧边栏主形象（Side Panel）：**
- 纯 SVG 渲染，不依赖 Three.js/WebGL
- 粉白色调、天蓝眼、轨道环光晕
- 4 种动画状态：浮动(idle) / 点头(listening) / 倾斜摇摆(thinking) / 张嘴跳动(speaking)
- 每种状态光晕颜色不同

**页面浮窗 Widget（Content Script）：**
- Shadow DOM 完全隔离，CSS 不污染宿主页面
- 支持拖拽移动，位置持久化到 chrome.storage
- 扇出菜单（语音/文字/设置）从角色腹部展开
- 文字输入框深色半透明风格
- 点击外部自动收起菜单

---

## 四、端到端延迟预算

| 环节 | 耗时 | 优化手段 |
|------|------|---------|
| DOM 预收集 | < 50ms | 纯前端本地执行，与录音并行 |
| 录音 + ASR | 300-500ms | 边录边传，SenseVoiceSmall 小模型 |
| DOM 蒸馏 | < 50ms | 预收集缓存复用，跳过重复扫描 |
| API 请求 + LLM 推理 | 500-1500ms | DeepSeek V4 Flash 优先，15s 超时 |
| JSON 解析 | < 10ms | JSON.parse，截断时正则抢救 |
| 高亮/点击执行 | < 50ms | 原生 DOM 操作，behavior:instant |
| TTS 语音合成 | 200-500ms | chrome.tts 引擎，首段 200ms 可播放 |

**合计：** 约 1.1 - 2.6 秒（最优路径），感知延迟可接受。

---

## 五、代码规模与模块清单

| 模块 | 文件 | 行数 | 职责 |
|------|------|------|------|
| 编排中枢 | `background/service-worker.js` | 512 | 状态管理、消息路由、API编排、TTS |
| 页面执行器 | `content/content.js` | 856 | Widget渲染、录音、高亮、气泡、SPA检测 |
| 侧边栏UI | `sidepanel/sidepanel.js` | 218 | 动画控制、录音按钮、设置面板、文字输入 |
| 后台录音 | `offscreen/offscreen.js` | 87 | 独立document的getUserMedia |
| DOM蒸馏 | `lib/dom-distiller.js` | 405 | 过滤去重聚类摘要选择器Prompt全管线 |
| LLM客户端 | `lib/llm-client.js` | 239 | 推理+极简重试+JSON抢救+流式 |
| ASR客户端 | `lib/asr-client.js` | 79 | Whisper ASR（SiliconFlow） |
| 选择器引擎 | `lib/selector-engine.js` | 208 | 5级降级+广域文本搜索 |
| 任务队列 | `lib/task-queue.js` | 263 | 多步状态机+气泡+React兼容输入 |
| 页面样式 | `content/content.css` | 123 | 高亮/波纹/气泡/箭头动画 |
| 扩展配置 | `manifest.json` | 51 | MV3权限与入口声明 |
| **合计** | **11 个文件** | **~3041** | |

---

## 六、安全与隐私设计

| 维度 | 措施 |
|------|------|
| **DOM 数据** | 仅提取可交互元素文本，不传输原始页面内容；蒸馏在本地完成 |
| **API Key** | 加密存储于 chrome.storage.local，由用户自主填入；demo 默认 key 仅为开发测试用 |
| **语音数据** | 录音仅在本地浏览器内完成 base64 编码，通过 HTTPS 传输至 ASR 服务 |
| **内容安全** | 扩展仅请求必要权限（sidePanel/storage/activeTab/scripting/tts） |
| **用户隐私** | 不收集用户身份信息，不存储浏览历史，不上报使用数据 |
| **开源许可** | 计划赛后开源，便于教育机构审计和二次开发 |

---

## 七、竞品对比

| 特性 | 智引灵 | Microsoft Copilot | 传统网页导航 |
|------|--------|-------------------|-------------|
| 数字人形象陪伴 | ✓ 双形态SVG | ✗ | ✗ |
| 全语音交互 | ✓ | 文本为主 | ✗ |
| 意图感知 DOM 蒸馏 | ✓（10+意图模式） | ✗（上传全DOM） | N/A |
| 多步任务自动化 | ✓ 状态机 | 有限 | ✗ |
| 5级选择器降级 | ✓ | ✗ | N/A |
| 高亮验证机制 | ✓（verifyText） | ✗ | N/A |
| 双模推理降级 | ✓（全量→极简） | ✗ | N/A |
| JSON 截断抢救 | ✓ | ✗ | N/A |
| 离线运行 | 计划中（Ollama 8B） | ✗ | N/A |
| 隐私保护 | 本地蒸馏 | 上传全DOM | ✓（纯本地） |
| 中文教育场景适配 | ✓ 针对优化 | 一般 | ✓ |
| 平台 | Chrome 扩展（全平台） | Edge 集成 | 浏览器原生 |

---

## 八、开发环境与部署

| 项目 | 说明 |
|------|------|
| **开发环境** | macOS + Chrome 120+ |
| **运行环境** | Chrome 浏览器（全平台：Mac/Windows/Linux） |
| **外部依赖** | DeepSeek API（LLM）+ SiliconFlow API（ASR） |
| **扩展类型** | Chrome Extension Manifest V3 |
| **安装方式** | 开发者模式加载已解压的扩展目录 / Chrome Web Store 发布 |

---

## 九、后续规划

| 阶段 | 内容 |
|------|------|
| **Phase 2** | 本地 Ollama 8B 离线降级、移动端适配 |
| **Phase 3** | 操作确认/撤销、历史回溯、多语言（先英后日韩） |
| **远期** | 教育领域知识库 RAG、多平台扩展（Firefox/Safari）、无障碍（WCAG）合规 |

---

*项目：智引灵 AI 导航导师 | 版本：v3.0 | 2026年5月*
