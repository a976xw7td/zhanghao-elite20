from __future__ import annotations

import logging

from .semantic_scholar import search_related_work

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Fixture data — used as fallback when the live API is unreachable.
# ---------------------------------------------------------------------------

RELATED_WORK_FIXTURES: dict[str, list[dict[str, str]]] = {
    "computational biology": [
        {
            "title": "Compact gene panels for cell-state annotation",
            "source": "demo Semantic Scholar fixture",
            "novelty_risk": "medium",
            "reason": "Overlaps with the same feature-pruning benchmark theme.",
        },
        {
            "title": "Reproducible evaluation in computational biology",
            "source": "demo Semantic Scholar fixture",
            "novelty_risk": "low",
            "reason": "Relevant evaluation guidance, not a direct method overlap.",
        },
        {
            "title": "Sparse classifiers for single-cell RNA-seq cohorts",
            "source": "demo Semantic Scholar fixture",
            "novelty_risk": "medium",
            "reason": "Potential prior art for the sparse classifier claim.",
        },
    ],
    "clinical/public health": [
        {
            "title": "Evaluation leakage in medical machine learning",
            "source": "demo OpenAlex fixture",
            "novelty_risk": "high",
            "reason": "Directly relevant to unclear train/test split concerns.",
        },
        {
            "title": "Clinical prediction under dataset shift",
            "source": "demo OpenAlex fixture",
            "novelty_risk": "medium",
            "reason": "Challenges broad deployability across hospitals.",
        },
        {
            "title": "Limits of small observational health datasets",
            "source": "demo OpenAlex fixture",
            "novelty_risk": "high",
            "reason": "Contradicts broad causal claims from a pilot sample.",
        },
    ],
}

# ---------------------------------------------------------------------------
# Chinese → English field alias lookup (preserved from original).
# ---------------------------------------------------------------------------

_FIELD_ALIASES: dict[str, str] = {
    "计算生物学": "computational biology",
    "生物信息学": "computational biology",
    "临床医学": "clinical/public health",
    "公共卫生": "clinical/public health",
    "临床": "clinical/public health",
    "机器学习": "machine learning systems",
    "机器学习系统": "machine learning systems",
}


def _resolve_field(field_guess: str) -> str:
    """Resolve a possibly-Chinese field name to its canonical English form."""
    return _FIELD_ALIASES.get(field_guess, field_guess)


def _match_fixture(lowered_field: str) -> list[dict[str, str]] | None:
    """Return fixture papers for *lowered_field* if it matches a known key.

    Returns ``None`` when no fixture key is a substring of *lowered_field*.
    """
    for field_key, papers in RELATED_WORK_FIXTURES.items():
        if field_key in lowered_field:
            return papers
    return None


# ---------------------------------------------------------------------------
# Main entry-point
# ---------------------------------------------------------------------------


def get_related_work(field_guess: str, title: str) -> list[dict[str, str]]:
    """Return related-work entries for a manuscript.

    1. Try a live Semantic Scholar search using the resolved field name
       and paper title.
    2. If the live search returns results, use them.
    3. Otherwise, fall back to the bundled fixture data.
    4. If no fixture matches, return a generic placeholder entry.

    Chinese field names (e.g. "计算生物学") are translated via
    ``_FIELD_ALIASES`` before the search.
    """
    resolved = _resolve_field(field_guess)
    lowered = resolved.lower()

    # --- attempt live Semantic Scholar search --------------------------------
    try:
        live_results = search_related_work(title=title, field_domain=resolved)
        if live_results:
            logger.info(
                "Using live Semantic Scholar results for field=%r title=%r",
                resolved,
                title,
            )
            return live_results
    except Exception:
        logger.exception(
            "Live Semantic Scholar search raised an unexpected exception; "
            "falling back to fixtures."
        )

    # --- fallback: fixture data ---------------------------------------------
    fixtures = _match_fixture(lowered)
    if fixtures:
        logger.info("Using fixture data for field=%r", resolved)
        return fixtures

    # --- last resort: generic placeholder -----------------------------------
    logger.info("No fixture match for field=%r; returning generic placeholder.", resolved)
    return [
        {
            "title": f"Prior work potentially related to {title[:70]}",
            "source": "demo metadata fixture",
            "novelty_risk": "medium",
            "reason": "Use live Semantic Scholar/OpenAlex lookup as a stretch path.",
        }
    ]
