# C5 AI 开发日志

## 总览

- **挑战**: C5 Hermes AI News
- **开发区间**: 2026-05-04
- **主要使用**: Claude Code、DeepSeek V4 Pro
- **Token 消耗**: ~¥5 (含多次调试)

## 关键决策节点

### 2026-05-04 · 架构选型：Hermes Cron vs 独立脚本 + crontab

- **困惑**: 用系统 crontab 直接运行脚本更简单，为什么要用 Hermes？
- **与 Claude 讨论要点**:
  - Hermes 提供 script → agent → delivery 完整链路，脚本输出 JSON 直接注入 Agent prompt
  - 支持多平台（weixin/telegram/slack），未来扩展不需要改代码
  - 内置 cron 调度器，管理界面友好
- **决策**: 使用 Hermes Cron，虽然多一层依赖但长期维护成本更低

### 2026-05-04 · 新闻源策略：RSS only vs RSS + 实时搜索

- **困惑**: RSS 已覆盖 9 个主流源，是否需要额外搜索？
- **问题发现**: 第一次测试输出只有 13 条（周末），且混入了 4 月旧闻
- **改进方案**: 集成 Tavily Search API，用 "AI news May 4 2026" 等带日期的 query 搜当天新闻
- **决策**: RSS + Tavily 双通道，24h 时间窗口严格过滤
- **效果**: 新闻量从 13 条提升到 49 条，时效性显著改善

### 2026-05-04 · Prompt 设计：Agent 搜索 vs 脚本搜索

- **困惑**: 让 Agent 自己搜索（灵活但不可控）还是脚本搜好再给 Agent（可控但死板）？
- **实验**: 
  - 方案 A：Agent 自主搜索 → 陷入搜索循环（72+ 消息未输出）
  - 方案 B：脚本收集数据 → Agent 仅格式化 → 30 秒完成
- **决策**: 方案 B。Agent 搜不准日期、停不下来；脚本做数据收集，Agent 做编辑排版
- **核心教训**: 时效性过滤必须在前置脚本做（确定性），不能依赖 Agent 判断（模糊性）

## AI 做了什么 / 我做了什么

| 模块 | AI 主导 | 人主导 | 共同打磨 |
|------|--------|--------|----------|
| Python 脚本架构 | | ✅ | |
| RSS 抓取 + Tavily 集成 | | ✅ | |
| Hermes cron 配置 | | ✅ | |
| Prompt 设计迭代 | | | ✅ |
| Agent 搜索策略调整 | | | ✅ |
| 目录结构 + 文档 | | ✅ | |

## 反思

- **AI 最帮我的**: 帮我快速理解 Hermes Agent 的 cron/script/agent 架构，省去大量读文档时间
- **我不该让 AI 做的**: 第一次让 Agent 自己做实时搜索——它不停搜、停不下来。应该让脚本做数据采集，Agent 只做格式化
- **最意外的发现**: feedparser + 浏览器 UA 头能绕过大部分反爬；Tavily 的 `days` 参数对时效性控制非常有效
- **如果重来**: 一开始就直接在脚本里集成 Tavily 搜索，不走 Agent 搜索的弯路
