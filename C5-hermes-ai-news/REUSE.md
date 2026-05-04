# C5 拿来说明

## 我复用了什么

| 来源 | 版本 | 取用了什么 | License | 改了什么 |
|------|------|-----------|---------|----------|
| Hermes Agent (Nous Research) | latest | cron scheduler, agent orchestration, weixin platform | Apache-2.0 | 配置为仅 weixin + cron，移除不需要的 platform |
| clawbot | latest | WeChat 消息桥接 | MIT | 通过 Hermes weixin platform 调用，未直接修改 |
| feedparser | 6.0.12 | RSS/Atom feed 解析 | BSD-2-Clause | 无 |
| httpx | latest | HTTP 客户端 | BSD-3-Clause | 添加浏览器 UA + SSL 绕过配置 |
| Tavily Search API | v1 | 实时新闻搜索 | 商业 API | 封装为 `search_tavily()` 函数，集成到并行抓取流程 |
| 各 AI 公司官方博客 | - | OpenAI, Google, Meta, Microsoft, Anthropic, NVIDIA, xAI, Mistral, Cohere RSS | 各公司所有 | 仅读取公开 RSS，无修改 |
| DeepSeek API | V4 Pro | 新闻编辑排版 LLM | 商业 API | 通过 Hermes custom_providers 调用 |

## 我没拿来的

- 没有照抄现有 Telegram 新闻 bot 的 prompt 和 persona
- 没有使用未公开/未授权的新闻源
- 没有使用他人的 AI 早报模板

## License 合规声明

本仓库采用 MIT 协议。所引入的第三方代码/服务均为 MIT / Apache-2.0 / BSD 协议或商业 API。
