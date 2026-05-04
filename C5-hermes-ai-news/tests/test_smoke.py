#!/usr/bin/env python3
"""Smoke test for Hermes AI News fetcher."""
import json
import subprocess
import sys


def test_script_runs():
    """Verify the script runs and produces valid JSON."""
    result = subprocess.run(
        ["python3", "src/fetch_ai_news.py"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"Script failed: {result.stderr[:500]}"

    data = json.loads(result.stdout)
    assert "date" in data, "Missing 'date' field"
    assert "total" in data, "Missing 'total' field"
    assert "items" in data, "Missing 'items' field"
    assert isinstance(data["items"], list), "'items' must be a list"

    for item in data["items"]:
        assert "title" in item, f"Item missing title: {item}"
        assert "url" in item, f"Item missing url: {item}"
        assert "source" in item, f"Item missing source: {item}"

    print(f"OK · {data['date']} · {data['total']} items · {len(data.get('categories', {}))} categories")
    return 0


if __name__ == "__main__":
    sys.exit(test_script_runs())
