#!/usr/bin/env python3
"""
AI News Fetcher for Hermes Cron
Fetches today's AI news from multiple sources and outputs structured JSON.

Sources:
  - English media: The Verge AI, TechCrunch AI, VentureBeat AI
  - HackerNews (AI-filtered via hnrs)
  - arXiv: cs.AI, cs.CL, cs.LG (new listings each weekday)
  - GitHub Trending (AI/ML repos)
  - Chinese media: 机器之心, 量子位 (best-effort)

Output: JSON to stdout — Hermes injects this into the agent prompt.
"""

import json
import os
import re
import sys
import ssl
import hashlib
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

import feedparser
import httpx

# ── HTTP client with browser-like headers ────────────────────────────────────

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE  # for broken SSL on some Chinese sites

# ── Sources ──────────────────────────────────────────────────────────────────

RSS_FEEDS = {
    # ── English AI news ──
    "The Verge - AI": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    "TechCrunch - AI": "https://techcrunch.com/category/artificial-intelligence/feed/",
    "VentureBeat - AI": "https://feeds.feedburner.com/venturebeat/SZYF",

    # ── HackerNews (AI-filtered, scored ≥ 10) ──
    "HN - AI": (
        "https://hnrss.org/frontpage?"
        "q=AI+OR+LLM+OR+GPT+OR+Claude+OR+OpenAI+OR+Gemini+OR+model+OR+GPU"
        "&points=10"
    ),

    # ── arXiv (new papers, weekdays) ──
    "arXiv - cs.AI": "https://rss.arxiv.org/rss/cs.AI",
    "arXiv - cs.CL": "https://rss.arxiv.org/rss/cs.CL",
    "arXiv - cs.LG": "https://rss.arxiv.org/rss/cs.LG",

    # ── Chinese AI media (may need SSL bypass / UA) ──
    "机器之心": "https://www.jiqizhixin.com/rss",
    "量子位": "https://www.qbitai.com/feed",
}

# Some feeds need the browser-like UA but standard SSL
_STANDARD_FEEDS = {"The Verge - AI", "TechCrunch - AI", "VentureBeat - AI",
                    "HN - AI", "arXiv - cs.AI", "arXiv - cs.CL", "arXiv - cs.LG"}

# Chinese feeds need SSL bypass
_LOOSE_FEEDS = {"机器之心", "量子位"}

# ── GitHub Trending ──

GITHUB_TRENDING_URL = "https://github.com/trending?since=daily"

AI_KEYWORDS = [
    "llm", "gpt", "transformer", "agent", "rag", "vector", "embedding",
    "diffusion", "stable-diffusion", "llama", "mistral", "deepseek",
    "chatgpt", "openai", "claude", "gemini", "anthropic", "langchain",
    "fine-tun", "inference", "neural", "rlhf", "dpo", "lora", "qlora",
    "whisper", "tts", "vision", "multimodal", "moe", "mixture-of-experts",
    "mcp", "tool-use", "function-call", "copilot", "vllm", "tgi",
    "machine-learning", "deep-learning", "pytorch", "jax", "onnx",
    "tokenizer", "sentence", "rerank", "embedding", "ocr",
    "sd-webui", "comfyui", "text-generation", "langgraph", "crewai",
    "autogen", "semantic-kernel", "dspy", "guardrail", "jailbreak",
    "prompt-engineering", "chain-of-thought", "cot",
    "qwen", "glm", "yi-model", "kimi", "moonshot", "minimax",
    "cuda", "triton", "flash-attention", "speculative-decoding",
    "knowledge-graph", "graphrag", "colpali", "colqwen",
]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_client(loose_ssl: bool = False) -> httpx.Client:
    kwargs = {"headers": _HEADERS, "timeout": 15, "follow_redirects": True}
    if loose_ssl:
        kwargs["verify"] = _SSL_CONTEXT
    return httpx.Client(**kwargs)


def _normalize_url(url: str) -> str:
    return url.split("?")[0].split("#")[0].rstrip("/")


def _clean_html(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text or "")


def _shorten(text: str, max_len: int = 300) -> str:
    text = _clean_html(text).strip()
    text = re.sub(r"\s+", " ", text)
    return text[:max_len] + ("…" if len(text) > max_len else "")


def _is_recent(published_str: str, hours: int = 24) -> bool:
    """Check if published within N hours."""
    if not published_str:
        return True
    for fmt in [
        "%a, %d %b %Y %H:%M:%S %z",
        "%a, %d %b %Y %H:%M:%S %Z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
    ]:
        try:
            dt = datetime.strptime(published_str, fmt)
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            return dt.replace(tzinfo=timezone.utc) >= cutoff
        except ValueError:
            continue
    return True  # unparseable → keep


# ── Fetchers ─────────────────────────────────────────────────────────────────

def fetch_rss(name: str, url: str) -> list[dict]:
    """Fetch a single RSS feed and return normalized items."""
    items = []
    loose_ssl = name in _LOOSE_FEEDS
    try:
        with _get_client(loose_ssl=loose_ssl) as client:
            resp = client.get(url)
            resp.raise_for_status()
        feed = feedparser.parse(resp.text)

        for entry in feed.entries[:20]:
            title = (entry.get("title") or "").strip()
            link = (entry.get("link") or "").strip()
            if not title or not link:
                continue

            published = entry.get("published") or entry.get("updated") or ""
            if not _is_recent(published):
                continue

            items.append({
                "title": title[:300],
                "url": link[:2048],
                "source": name,
                "category": _classify(name, title),
                "summary": _shorten(
                    entry.get("summary") or entry.get("description") or "",
                    250,
                ),
                "published": published,
            })

    except Exception as e:
        print(f"[WARN] {name}: {e}", file=sys.stderr)

    return items


def fetch_github_trending() -> list[dict]:
    """Scrape GitHub trending page for AI-related repos."""
    items = []
    try:
        with _get_client() as client:
            resp = client.get(GITHUB_TRENDING_URL)
            resp.raise_for_status()
        html = resp.text

        # Repo entries
        repos = re.findall(
            r'<h2[^>]*class="[^"]*h3[^"]*lh-condensed[^"]*"[^>]*>'
            r'\s*<a\s+href="/([^"]+)"[^>]*>'
            r'\s*(?:<span[^>]*>.*?</span>\s*)*'
            r'([^<]+)\s*</a>',
            html, re.DOTALL,
        )

        # Descriptions
        descs = re.findall(
            r'<p class="col-9 color-fg-muted my-1 pr-4">\s*(.*?)\s*</p>',
            html, re.DOTALL,
        )

        # Language tags
        langs = re.findall(
            r'<span itemprop="programmingLanguage">([^<]+)</span>', html,
        )

        for i, (full_name, _) in enumerate(repos[:25]):
            name = full_name.strip()
            desc = _shorten(descs[i] if i < len(descs) else "", 200)
            lang = langs[i] if i < len(langs) else ""

            combined = f"{name} {desc} {lang}".lower()
            if not any(kw in combined for kw in AI_KEYWORDS):
                continue

            items.append({
                "title": f"{name}",
                "url": f"https://github.com/{name}",
                "source": "GitHub Trending",
                "category": "开源项目",
                "summary": f"[{lang}] {desc}" if lang else desc,
                "published": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            })

    except Exception as e:
        print(f"[WARN] GitHub Trending: {e}", file=sys.stderr)

    return items


def _classify(source: str, title: str) -> str:
    """Classify a news item based on source and content."""
    src = source.lower()
    t = title.lower()

    if any(k in src for k in ("arxiv",)):
        return "论文"
    if any(k in src for k in ("github",)):
        return "开源项目"
    if any(k in src for k in ("机器之心", "量子位")):
        return "国内动态"

    # English sources: classify by keyword
    big_tech_kw = [
        "openai", "google", "deepmind", "microsoft", "meta", "anthropic",
        "gemini", "gpt-", "chatgpt", "claude", "llama", "copilot",
        "sora", "veo", "midjourney", "suno",
    ]
    china_kw = [
        "baidu", "alibaba", "bytedance", "huawei", "tencent",
        "deepseek", "qwen", "kimi", "moonshot", "minimax", "zhipu",
        "stepfun", "01.ai", "baichuan",
    ]
    breakthrough_kw = [
        "breakthrough", "state-of-the-art", "novel", "first",
        "record", "outperforms", "achieve", "new approach",
        "new method", "surpasses",
    ]

    if any(k in t for k in china_kw):
        return "国内动态"
    if any(k in t for k in big_tech_kw):
        return "大厂动态"
    if any(k in t for k in breakthrough_kw):
        return "技术突破"
    return "行业动态"


# ── Tavily Web Search ────────────────────────────────────────────────────────

TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")

_TAVILY_SEARCH_QUERIES = [
    "AI artificial intelligence news today {date}",
    "OpenAI Google DeepMind Anthropic Meta news {date}",
    "大模型 人工智能 AI 新闻 {date}",
    "GitHub AI open source trending {date}",
]


def search_tavily(query: str, days: int = 1) -> list[dict]:
    """Search Tavily for recent AI news."""
    items = []
    if not TAVILY_API_KEY:
        return items

    try:
        with _get_client() as client:
            resp = client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": TAVILY_API_KEY,
                    "query": query,
                    "search_depth": "advanced",
                    "max_results": 10,
                    "days": days,
                    "include_answer": False,
                },
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()

        for r in data.get("results", []):
            title = (r.get("title") or "").strip()
            url = (r.get("url") or "").strip()
            if not title or not url:
                continue
            items.append({
                "title": title[:300],
                "url": url[:2048],
                "source": "Web Search",
                "category": _classify("", title),
                "summary": _shorten(r.get("content") or r.get("description") or "", 250),
                "published": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            })
    except Exception as e:
        print(f"[WARN] Tavily search '{query[:50]}...': {e}", file=sys.stderr)

    return items


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    all_items: list[dict] = []
    seen_urls: set[str] = set()
    errors: list[str] = []

    today_str = datetime.now().strftime("%Y-%m-%d")

    # Fetch everything in parallel
    with ThreadPoolExecutor(max_workers=15) as pool:
        rss_futures = {
            pool.submit(fetch_rss, name, url): name
            for name, url in RSS_FEEDS.items()
        }
        gh_future = pool.submit(fetch_github_trending)

        # Tavily web searches for today's news
        tavily_futures = {
            pool.submit(search_tavily, q.format(date=today_str)): q
            for q in _TAVILY_SEARCH_QUERIES
        }

        for future in as_completed(rss_futures):
            source_name = rss_futures[future]
            try:
                items = future.result()
            except Exception as e:
                errors.append(f"{source_name}: {e}")
                continue
            for item in items:
                norm = _normalize_url(item["url"])
                h = hashlib.md5(norm.encode()).hexdigest()
                if h not in seen_urls:
                    seen_urls.add(h)
                    all_items.append(item)

        for future in as_completed(tavily_futures):
            try:
                items = future.result()
            except Exception as e:
                errors.append(f"Tavily: {e}")
                continue
            for item in items:
                norm = _normalize_url(item["url"])
                h = hashlib.md5(norm.encode()).hexdigest()
                if h not in seen_urls:
                    seen_urls.add(h)
                    all_items.append(item)

        try:
            for item in gh_future.result():
                norm = _normalize_url(item["url"])
                h = hashlib.md5(norm.encode()).hexdigest()
                if h not in seen_urls:
                    seen_urls.add(h)
                    all_items.append(item)
        except Exception as e:
            errors.append(f"GitHub Trending: {e}")

    # Sort by date descending
    def _sort_key(item):
        pub = item.get("published", "")
        for fmt in [
            "%a, %d %b %Y %H:%M:%S %z",
            "%a, %d %b %Y %H:%M:%S %Z",
            "%Y-%m-%dT%H:%M:%S%z",
            "%Y-%m-%dT%H:%M:%SZ",
            "%Y-%m-%d",
        ]:
            try:
                return datetime.strptime(pub, fmt).timestamp()
            except ValueError:
                continue
        return 0

    all_items.sort(key=_sort_key, reverse=True)

    # Limit
    all_items = all_items[:80]

    # Category stats
    categories: dict[str, int] = {}
    for item in all_items:
        cat = item.get("category", "其他")
        categories[cat] = categories.get(cat, 0) + 1

    output = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "total": len(all_items),
        "categories": categories,
        "source_errors": errors if errors else None,
        "items": all_items,
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
