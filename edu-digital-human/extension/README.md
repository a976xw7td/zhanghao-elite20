# 智引 AI 导航导师

> 面向高校教育场景的 AI 导航助手，帮助师生在教学平台上快速找到方向。

## 项目简介

智引是一款 Chrome 浏览器扩展，通过语音或文字输入，理解用户意图后在网页上高亮目标元素、执行多步操作，并提供温暖的语音引导。项目定位为"虚拟助教"，服务大学师生在在线教学场景中的导航需求。

## 核心功能

- **语音交互**：按住麦克风说话，AI 理解后自动导航（支持中英文）
- **智能高亮**：精确标注页面目标元素，带脉冲动画和波纹特效
- **多步任务**：复杂操作（如选课、提交作业）自动分解为步骤逐步完成
- **教育场景感知**：识别课程页面、作业系统、考试平台等常见教育场景
- **概念解释**：遇到教育术语（学分、绩点、先修课等）可即时解释

## 技术架构

```
┌─────────────────────────────────────────┐
│              Chrome Extension MV3         │
├───────────┬─────────┬───────────────────┤
│ Side Panel│ Content │ Background SW     │
│ (配置+2D  │ Script  │ (编排中枢)         │
│  数字人)   │ (DOM操  │ • LLM推理协调      │
│           │  作+高亮)│ • ASR/TTS调度     │
│           │         │ • 状态管理         │
├───────────┴─────────┴───────────────────┤
│           lib/ (共享模块)                 │
│  • dom-distiller  - 意图感知DOM蒸馏      │
│  • selector-engine - 5级选择器降级        │
│  • task-queue     - 多步任务状态机        │
│  • llm-client     - DeepSeek API 客户端  │
│  • lang           - 双语检测+文本         │
├─────────────────────────────────────────┤
│       外部服务 (API)                      │
│  • DeepSeek (LLM推理)                    │
│  • SiliconFlow (ASR语音识别 + TTS合成)    │
└─────────────────────────────────────────┘
```

## 安装步骤

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目 `extension/` 目录
5. 扩展图标出现在工具栏，点击可打开侧边栏

## 配置指南

### 必填配置
- **DeepSeek API Key**：在侧边栏「API Key」输入框填入，用于 LLM 推理
- **ASR API Key + Endpoint**：在侧边栏「ASR 配置」填入，用于语音识别（SiliconFlow SenseVoice）
- **模型选择**：deepseek-chat（精准）/ deepseek-v4-flash（快速）

### 获取 API Key
- DeepSeek: https://platform.deepseek.com/api_keys
- SiliconFlow: https://siliconflow.cn（提供 SenseVoice ASR + CosyVoice TTS）

## 使用说明

1. 打开任意教学平台网页（如超星、智慧树、Canvas 等）
2. 点击页面右下角皮卡丘角色展开菜单
3. 按住麦克风按钮说话（如「帮我找提交作业的按钮」）
4. 松开后 AI 自动识别、分析页面、高亮目标
5. 也可点击文字按钮，输入文字指令后回车

## 适用场景

- 在线课程平台导航（超星/学习通、智慧树/知到、学堂在线、中国大学MOOC）
- 国际教学平台（Canvas、Moodle、Blackboard）
- 选课系统、成绩查询、作业提交
- 学术资源检索、图书馆系统

## 隐私说明

页面内容和语音会上传至 AI 服务（DeepSeek / SiliconFlow）进行处理，不会在服务器端存储。你的 API Key 仅保存在浏览器本地。

## 项目结构

```
extension/
├── manifest.json              # Chrome 扩展配置
├── background/
│   └── service-worker.js      # 后台编排中枢
├── content/
│   ├── content.js             # 页面交互 + 皮卡丘 Widget
│   └── content.css            # 注入样式
├── sidepanel/
│   ├── sidepanel.html         # 侧边栏 UI
│   └── sidepanel.js           # 侧边栏逻辑
├── offscreen/
│   ├── offscreen.html         # 离屏文档
│   └── offscreen.js           # 录音降级
├── lib/
│   ├── dom-distiller.js       # DOM 蒸馏
│   ├── selector-engine.js     # 选择器引擎
│   ├── task-queue.js          # 任务队列
│   ├── llm-client.js          # LLM 客户端
│   ├── lang.js                # 语言工具
│   ├── asr-client.js          # ASR 客户端
│   └── tts-client.js          # TTS 客户端
├── assets/                    # 图标等静态资源
└── README.md
```
