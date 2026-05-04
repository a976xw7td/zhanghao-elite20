# C5 Portfolio 条目

| 字段 | 值 |
|------|-----|
| **挑战编号** | C5 |
| **项目名称** | Hermes AI News |
| **达到 Level** | L3（系统级整合） |
| **Token 消耗** | ~¥5（开发调试）+ ~¥0.01/天（运营） |
| **核心产出** | https://github.com/a976xw7td/hermes-ai-news |
| **开发周期** | 2026-05-04 |
| **关键技术** | Hermes Agent, DeepSeek V4 Pro, Tavily Search, feedparser, clawbot WeChat |

## 关键反思

1. **时效性是新闻产品的生命线**。第一版因为 48h 窗口 + Agent 无日期意识，混入了 3-4 月旧闻。修复方案：24h 窗口 + 脚本层做 Tavily 带日期搜索，Agent 不再做搜索。
2. **Agent 搜索不如脚本搜索可控**。让 Agent 自主搜索会陷入搜索循环（72+ 条消息无输出），脚本做数据采集 + Agent 做排版才是正确分工。
3. **Hermes cron 的 script → agent → delivery 链路设计优秀**，把"数据采集"和"AI 编辑"解耦，各司其职。
