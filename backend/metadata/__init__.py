"""Metadata and related-work helpers."""

from .related_work import get_related_work
from .semantic_scholar import search_related_work

__all__ = [
    "get_related_work",
    "search_related_work",
]
