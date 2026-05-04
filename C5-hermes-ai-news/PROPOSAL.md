# C5 Hermes AI News · 方案设计

**挑战**: C5  
**目标 Level**: L3（系统级整合，服务全班同学）  
**作者**: ZhangHao  

---

## 1. 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| Agent 框架 | Hermes Agent (Nous Research) | 内置 cron、多平台推送、Python 脚本预处理 |
| 消息推送 | WeChat (via clawbot/ilinkai) | AI+X 实验班通讯主渠道 |
| 新闻源 (RSS) | The Verge AI, TechCrunch AI, VentureBeat AI, HN, arXiv, 机器之心, 量子位 | 覆盖中英文主流 AI 媒体 |
| 新闻源 (实时搜索) | Tavily Search API | 补充 RSS 覆盖盲区，搜索当天新闻 |
| 大模型 | DeepSeek V4 Pro | 百万 Token 上下文，高性价比 |
| 编程语言 | Python 3.10+ | |

## 2. 系统架构

```
┌────────────────────────────────────────────┐
│              Hermes Gateway                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Cron     │  │ Agent    │  │ Weixin   │ │
│  │ Scheduler│→ │ (DeepSeek│→ │ Platform │ │
│  │ 8:00 AM  │  │  V4 Pro) │  │ (clawbot)│ │
│  └──────────┘  └──────────┘  └──────────┘ │
└────────────────────────────────────────────┘
         │              ▲
         ▼              │
┌─────────────────┐    │
│ fetch_ai_news.py│    │ (注入 prompt context)
│ ┌─────────────┐ │    │
│ │ RSS Fetcher │ │    │
│ │ Tavily Search│ │    │
│ │ GitHub Trend │ │    │
│ │ Dedup/Filter │ │    │
│ └─────────────┘ │    │
│ Output: JSON    │────┘
└─────────────────┘
```

## 3. 数据流

1. **Cron 触发** → 每天 8:03 AM
2. **脚本运行** → `fetch_ai_news.py` 并行抓取 RSS + Tavily + GitHub Trending
3. **JSON 输出** → stdout 注入 Agent 系统提示
4. **Agent 编辑** → DeepSeek V4 Pro 筛选、排版、生成早报
5. **推送到微信** → 通过 clawbot 发送到用户微信

## 4. 实验矩阵

| 变量 | 当前值 | 备选方案 | 评估标准 |
|------|--------|----------|----------|
| 新闻时间窗口 | 24h | 12h / 48h | 新闻数量 vs 时效性 |
| AI 模型 | DeepSeek V4 Pro | GPT-5 / Claude Opus 4.7 | 质量 / 成本 |
| RSS 源数量 | 9 个 | 加减源 | 覆盖率 / 噪音比 |
| Tavily 搜索深度 | advanced | basic | 质量 / 速度 |
| 推送时间 | 8:03 AM | 7:00 / 9:00 | 同学阅读习惯 |

## 5. 失败怎么办

- **脚本抓取失败** → 使用 Tavily fallback 搜索，至少有基本新闻
- **Agent 生成失败** → 脚本 JSON 直接推送到微信作为降级方案
- **微信推送失败** → 日志记录，下次 cron tick 重试
- **Token 超支** → 切换到 DeepSeek V4 Flash（成本 1/3）
