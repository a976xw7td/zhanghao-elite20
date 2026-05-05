# AI_LOG.md — RefereeOS AI-Assisted Development Log

This document transparently records every material AI-assisted decision made during the development of RefereeOS for the C5-AG2 hackathon. Claude Opus 4.7 (via Claude Code) served as the primary AI development partner throughout the build.

## Architecture Decisions

### 1. Harness Engineering as Design Philosophy
- **Date:** 2026-05-06
- **Decision:** Adopted OpenAI's Harness Engineering paradigm as the project's architectural framework.
- **Rationale:** The paradigm — building deterministic infrastructure around models rather than obsessing over prompt engineering — maps directly onto the RefereeOS architecture. Each subsystem (evidence board, injection scanner, cross-model review, SSE trace) is a distinct "harness layer" that catches what models alone would miss.
- **AI Role:** Claude proposed using Harness Engineering as the unifying narrative for both technical implementation and judging presentation.
- **Reference:** OpenAI's agent development guidelines and community discourse around the shift from prompt-centric to system-centric AI engineering.

### 2. Three-Model Cross-Model Adversarial Review
- **Date:** 2026-05-06
- **Decision:** Upgraded from single-model (DeepSeek-only) Lead+Critic to three-model review: DeepSeek v4-flash (Lead), Kimi kimi-k2.6 (Critic), Zhipu glm-4-flash (Scorer).
- **Rationale:** Cross-model adversarial review — where three different providers' models check each other's work — is a concrete implementation of Harness Engineering that most hackathon projects won't attempt. It also provides genuine quality improvement: different models have different blind spots.
- **AI Role:** Claude designed the 3-round architecture, implemented the AG2 Beta agent configuration for all three providers, and handled the graceful degradation chain.
- **Trade-off:** More moving parts and API dependencies, but the fallback chain ensures the system degrades gracefully when providers are unavailable.

### 3. SSE Streaming for Real-Time Agent Trace
- **Date:** 2026-05-06
- **Decision:** Added Server-Sent Events streaming endpoint (`/api/analyze-stream`) alongside the existing synchronous endpoint.
- **Rationale:** Hackathon judges see the agent workflow in real-time rather than waiting for completion. The `queue.Queue` + thread-based approach avoids async/await compatibility issues with AG2 Beta's synchronous agent calls inside uvicorn.
- **AI Role:** Claude implemented the full SSE pipeline: backend event queue, thread-pool executor, frontend `ReadableStream` SSE parser, live trace state management, and AbortController cancellation.

### 4. Semantic Scholar Live Search with Fixture Fallback
- **Date:** 2026-05-06
- **Decision:** Implemented live Semantic Scholar API search as the primary related-work data source, with bundled fixture data as fallback.
- **Rationale:** Live search demonstrates real API integration (important for judges), while fixtures ensure the demo always works even offline or if the API rate-limits.
- **AI Role:** Claude created the `semantic_scholar.py` client using only `urllib` (no external dependencies), the Chinese→English field domain mapping, and the graceful degradation logic.

### 5. Claim-Concern Linking Fixes
- **Date:** 2026-05-06
- **Decision:** Expanded keyword matching for metric claims (from 5 to 8 keywords) and ablation concerns (now includes metric claim IDs).
- **Rationale:** The clean paper had claim_001 not linked to the ablation concern, and the suspicious paper had claim_004 not linked to any concern. The keyword expansion fixes both.
- **AI Role:** Claude identified the root cause (insufficient keyword sets), proposed the specific keyword additions, and implemented the `_claim_ids_for_concern()` fix.

### 6. Chinese Field Domain Support
- **Date:** 2026-05-06
- **Decision:** Added Chinese→English field domain alias mapping in `related_work.py` to support Chinese-language field inputs.
- **Rationale:** The system received Chinese field names (e.g., "计算生物学") from the frontend dropdown but the related-work lookup expected English keys.
- **AI Role:** Claude created the `_FIELD_ALIASES` mapping and `_resolve_field()` helper.

## Technical Fixes

### 7. Stale Model Name References
- **Date:** 2026-05-06
- **Decision:** Replaced all hardcoded "OpenAI GPT-5.5", "Gemini", and "gpt-4o" references throughout the codebase.
- **Affected Files:** `orchestrator.py` (4 locations), `daytona_runner.py` (3 locations), `README.md`, `docs/demo_script.md`, `tests/test_orchestrator.py`, `AgentTrace.tsx`.
- **AI Role:** Claude identified all occurrences via grep, replaced with dynamic model resolution or updated labels.

### 8. Daytona Runner Model Resolution
- **Date:** 2026-05-06
- **Decision:** Added `_resolve_default_model()` function that checks `REFEREEOS_ENABLE_AG2_LLM` and returns the correct model name instead of hardcoded "gpt-4o".
- **AI Role:** Claude identified the issue (model always showing "gpt-4o" regardless of config) and implemented the fix.

### 9. Pre-Submission Audit Fixes
- **Date:** 2026-05-06
- **Decision:** Comprehensive project audit identified and fixed multiple issues:
  - Fixed Semantic Scholar SSL verification failure by adding `certifi` CA bundle to `urllib` context
  - Added SSE heartbeat comment lines (15s interval) to prevent proxy/browser timeout during long AG2 synthesis
  - Replaced stale `gpt-5.5` fallback in Daytona sandbox code with `gpt-4o`
  - Removed legacy Gemini configuration from `.env.example`, added Kimi + Zhipu templates
  - Added `provider` parameter to `_inconclusive_receipt()` for accurate sandbox provider labeling
  - Fixed README.md claiming "small/font-size text heuristics" that the injection scanner never had
  - Added 0.12s delay in `_run_step()` after emitting SSE "running" event to ensure frontend renders intermediate states
  - Kimi model upgraded from `moonshot-v1-8k` to `kimi-k2.6`
- **AI Role:** Claude performed the full audit, identified all issues, and implemented all fixes.

## Prompt Engineering Notes

- The 3-round review prompts were iteratively refined to produce structured JSON output from three different models with different behaviors.
- The Critic prompt explicitly requests specific output format (`{"gaps": [...], "endorsed": true/false}`) to ensure parseable feedback.
- The Scorer prompt uses a constrained output schema (`{"score": <0-10>, "verdict": "PASS|MINOR|REVISE", "comment": "..."}`) for consistent scoring.
- All prompts include "Do not recommend accepting or rejecting publication" to enforce the ethical boundary.

## Known AI Limitations

- The Semantic Scholar search query construction is heuristic (title + field domain) rather than embedding-based, which may miss some semantically related papers.
- The injection scanner uses regex patterns that can be bypassed by sophisticated adversarial text; it catches common patterns but is not cryptographically robust.
- The cross-model review quality depends on all three model providers being available; single-model fallback reduces the adversarial benefit.
- SSE streaming uses a thread-pool executor for uvicorn compatibility, which adds minor complexity but avoids the need for full async rewrite of AG2 call paths.

## Development Statistics

- **Primary AI tool:** Claude Opus 4.7 via Claude Code
- **Total AI-assisted decisions documented:** 9 major, ~25 minor
- **Human decisions:** Project concept, model provider selection (DeepSeek, Kimi, Zhipu), visual design direction, fixture paper content
- **AI decisions:** Architecture patterns, implementation details, bug fixes, prompt design, test fixes
