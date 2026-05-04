# Hermes AI News · C5 Submission by ZhangHao

**一句话定位**：基于 Hermes Agent 的 AI 早报系统——自动抓取全球 AI 新闻，经 AI 编辑排版，每日 8:00 推送到微信。服务 AI+X 实验班同学的每日信息需求。

## 🎬 Demo

- 效果展示：每天早 8:00 微信收到 AI 早报
- 早报示例：[examples/sample_output.md](examples/sample_output.md)

## 🚀 Quick Start

```bash
# 1. 克隆仓库
git clone https://github.com/a976xw7td/hermes-ai-news
cd hermes-ai-news

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 Hermes 配置

# 4. 运行新闻抓取（测试）
bash scripts/reproduce.sh

# 5. 注册到 Hermes cron
hermes cron create --name "AI早报" --schedule "3 8 * * *" --script fetch-ai-news.py --deliver weixin
```

## 📊 Results

| Level | 指标 | 状态 |
|-------|------|------|
| L1 | 多源新闻抓取 + 结构化输出 | ✅ |
| L2 | Tavily 实时搜索补充 + 24h 时效过滤 | ✅ |
| L3 | Hermes cron 集成 + 微信自动推送 | ✅ |
| L4 | 服务全班 20+ 同学每日 AI 信息需求 | 🔜 |

## 🧾 Evidence Ledger

- **AI 开发日志**：[AI_LOG.md](AI_LOG.md)
- **拿来说明**：[REUSE.md](REUSE.md)
- **方案设计**：[PROPOSAL.md](PROPOSAL.md)

## 🙏 Acknowledgements

- [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) — Nous Research 开源多智能体框架
- [clawbot](https://github.com/openclaw/clawbot) — WeChat 桥接
- [feedparser](https://github.com/kurtmckee/feedparser) — RSS 解析
- [Tavily](https://tavily.com) — 实时新闻搜索 API
- [hnrss](https://hnrss.org) — HackerNews RSS 过滤
- 复用：DeepSeek API、各 AI 公司官方博客 RSS
