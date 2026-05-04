#!/bin/bash
# C5 Hermes AI News · 一键复现脚本
# 用法: bash scripts/reproduce.sh
set -e

echo "=== Hermes AI News · Reproduce Script ==="
echo ""

# 1. 检查 Python 环境
echo "[1/4] Checking Python..."
python3 --version

# 2. 安装依赖
echo "[2/4] Installing dependencies..."
pip install -r requirements.txt -q

# 3. 运行新闻抓取
echo "[3/4] Running news fetcher..."
TAVILY_API_KEY="${TAVILY_API_KEY:-}" python3 src/fetch_ai_news.py

# 4. 验证输出
echo ""
echo "[4/4] Done. Output above should be valid JSON with AI news items."
echo "If you see JSON with 'items' array, the script works correctly."
