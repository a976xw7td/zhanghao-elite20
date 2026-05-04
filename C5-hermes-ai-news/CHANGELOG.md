# Changelog

## [0.2.0] - 2026-05-04

### feat: Tavily 实时新闻搜索

- 集成 Tavily Search API 作为 RSS 补充
- 4 个搜索 query 覆盖中英文 AI 新闻
- 并行执行，不增加整体延迟

### fix: 24h 时效窗口

- 从 48h 改为 24h 严格过滤
- 解决 4 月/3 月旧闻混入问题

### refactor: 数据采集与编辑分离

- 脚本负责全部数据采集（RSS + Tavily + GitHub）
- Agent 仅负责格式化排版，不再做搜索
- 避免 Agent 搜索循环问题

## [0.2.1] - 2026-05-04

### fix: 成本估算修正

- 实际单次成本 ~¥0.01（仅 LLM 编辑排版），非之前估算的 ~¥1.5
- Tavily 搜索为可选配置，未配置时无成本
- RSS + GitHub Trending 全免费，无需 API Key

## [0.1.0] - 2026-05-04

### feat: 初始版本

- 9 个 RSS 源并行抓取（中英文 AI 媒体）
- GitHub Trending AI 项目筛选（70+ 关键词）
- Hermes cron 集成（8:03 AM 每日）
- WeChat 推送（via clawbot）
- DeepSeek V4 Pro 编辑排版
- 6 种新闻分类（大厂动态/论文/开源项目/技术突破/国内动态/行业动态）
