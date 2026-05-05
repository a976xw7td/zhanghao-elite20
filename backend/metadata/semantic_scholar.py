"""Live Semantic Scholar search for related-work discovery.

Uses the free, public Semantic Scholar /graph/v1/paper/search endpoint.
No API key is required.  Rate limit is ~100 requests / 5 min without a key.
"""

from __future__ import annotations

import json
import logging
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import certifi

logger = logging.getLogger(__name__)

SEMANTIC_SCHOLAR_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
REQUEST_TIMEOUT_SEC = 10
_USER_AGENT = "RefereeOS/1.0 (mailto:refereeos@example.com)"

# ---------------------------------------------------------------------------
# Query construction
# ---------------------------------------------------------------------------

_STOP_WORDS: frozenset[str] = frozenset(
    {
        "a", "an", "the", "of", "in", "on", "at", "to", "for", "with",
        "and", "or", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would",
        "shall", "should", "may", "might", "must", "can", "could",
        "this", "that", "these", "those", "it", "its", "by", "from",
    }
)


def _build_query(title: str, field_domain: str) -> str:
    """Extract key terms from *title* and append the *field_domain*.

    Returns a short query string suitable for the Semantic Scholar search API.
    """
    terms = [w for w in title.lower().split() if w not in _STOP_WORDS]
    # Keep enough terms for an informative query, but do not overload the API.
    key_terms = terms[:6]
    parts = key_terms.copy()
    if field_domain:
        parts.append(field_domain.lower())
    return " ".join(parts)

# ---------------------------------------------------------------------------
# Relevance mapping
# ---------------------------------------------------------------------------


def _relevance_label(index: int) -> tuple[str, str]:
    """Map a 0-based result index to a *novelty_risk* label and a human-readable reason."""
    if index == 0:
        return (
            "high",
            "Highly relevant — top Semantic Scholar match for this title.",
        )
    if index == 1:
        return (
            "high",
            "Highly relevant — strong Semantic Scholar match.",
        )
    if index in (2, 3):
        return (
            "medium",
            "Somewhat relevant — mid-ranked Semantic Scholar result.",
        )
    return (
        "low",
        "Tangentially relevant — lower-ranked Semantic Scholar result.",
    )

# ---------------------------------------------------------------------------
# API call & result parsing
# ---------------------------------------------------------------------------


def _call_api(query: str, limit: int) -> list[dict[str, Any]]:
    """Execute a single Semantic Scholar paper search.

    Returns the raw list of paper dicts from the ``data`` key, or an empty
    list when the API is unreachable or returns no results.
    """
    params: dict[str, str | int] = {
        "query": query,
        "limit": limit,
        "fields": "title",
    }
    url = f"{SEMANTIC_SCHOLAR_SEARCH_URL}?{urllib.parse.urlencode(params)}"

    logger.info("Semantic Scholar query=%r limit=%d", query, limit)

    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})

    try:
        ctx = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SEC, context=ctx) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        logger.warning(
            "Semantic Scholar HTTP %d — %s (query=%r)", exc.code, exc.reason, query
        )
        return []
    except urllib.error.URLError as exc:
        logger.warning("Semantic Scholar network error: %s (query=%r)", exc.reason, query)
        return []
    except OSError as exc:
        logger.warning("Semantic Scholar OS error: %s (query=%r)", exc, query)
        return []

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        logger.warning("Semantic Scholar JSON decode error: %s", exc)
        return []

    papers: list[dict[str, Any]] = payload.get("data", [])
    if not papers:
        logger.info("Semantic Scholar returned 0 results for query=%r", query)
    else:
        logger.info("Semantic Scholar returned %d results for query=%r", len(papers), query)

    return papers


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def search_related_work(
    title: str,
    field_domain: str,
    limit: int = 5,
) -> list[dict[str, str]]:
    """Search Semantic Scholar for papers related to *title*.

    Parameters
    ----------
    title:
        The paper title to find related work for.
    field_domain:
        A field or domain label used to refine the search (e.g. "computational biology").
    limit:
        Maximum number of results to return (default 5; clamped to 1–100).

    Returns
    -------
    list[dict]
        Each dict has the keys ``title``, ``source``, ``novelty_risk``, and ``reason``.
        Returns an empty list when the API is unreachable or returns no results.
    """
    if not title.strip():
        logger.warning("search_related_work called with empty title")
        return []

    limit = max(1, min(limit, 100))
    query = _build_query(title, field_domain)

    papers = _call_api(query, limit)

    results: list[dict[str, str]] = []
    for i, paper in enumerate(papers):
        paper_title = paper.get("title") or "Untitled"
        novelty_risk, reason = _relevance_label(i)
        results.append(
            {
                "title": paper_title,
                "source": "Semantic Scholar",
                "novelty_risk": novelty_risk,
                "reason": reason,
            }
        )

    return results
