# CLAUDE.md — RefereeOS Project Blueprint

**Purpose:** Master constraint file for the RefereeOS C5-AG2 hackathon build. Every agent launched from this session must obey this file. No drift, no scope-creep.

---

## 0. Design Philosophy: Harness Engineering

OpenAI's **Harness Engineering** paradigm shifts AI application development from *prompt-centric* to *system-centric* thinking. The model is a component, not the product. The engineering around the model — the evaluation infrastructure, deterministic guardrails, multi-agent checks, observability, and feedback loops — is what makes the system reliable, auditable, and safe.

### How RefereeOS Embodies Harness Engineering

| Harness Engineering Principle | RefereeOS Implementation |
|---|---|
| **Eval harness over prompt tweaking** | Structured JSON evidence board that every agent reads/writes; no raw model output touches the reviewer packet without passing through the board |
| **Deterministic scaffolding around probabilistic models** | Injection scanner (regex), paper parser, triage rules — all deterministic code that constrains and validates before/after model calls |
| **Multi-agent adversarial review** | 3-round cross-model synthesis: DeepSeek drafts, Kimi critiques, Zhipu scores — models checking models |
| **Observability as first-class infrastructure** | SSE streaming agent trace, reproducibility receipt with stdout/stderr, every agent step timestamped and surfaced to UI |
| **Sandboxed execution for safety** | Daytona sandbox runs untrusted reproducibility code; dangerous imports blocked; local fallback only for trusted fixtures |
| **Human-in-the-loop by design** | System outputs triage recommendations (Ready for human review / Needs clarification / Possible integrity issue), NEVER accept/reject |
| **Graceful degradation** | Live Semantic Scholar → fixture fallback; Daytona → local fallback; Zhipu unavailable → DeepSeek self-scores; Kimi unavailable → DeepSeek self-critiques |

### The Harness Engineering Narrative (for judges & README)

> Most AI review tools obsess over prompt engineering — crafting the perfect instruction to get better model output. RefereeOS takes the **harness engineering** approach instead: we build deterministic infrastructure *around* the models. The evidence board is the evaluation harness. The injection scanner is the safety harness. The 3-round cross-model review is the adversarial harness. The SSE trace is the observability harness. The Daytona sandbox is the reproducibility harness. Each harness layer catches what the model alone would miss.

---

## 1. Project Identity

- **Name:** RefereeOS
- **Hackathon:** C5-AG2 (AG2 Beta + Daytona sponsors)
- **One-line pitch:** Multi-agent preprint triage system that produces auditable reviewer packets with sandboxed reproducibility receipts — built on Harness Engineering principles.
- **Ethical boundary:** DOES NOT make accept/reject decisions. Prepares human review. This is non-negotiable in every piece of text and output.

## 2. Non-Negotiable Constraints

- **Never claim** the system replaces peer review, makes autonomous publication decisions, or replaces human editors.
- **Never invent** libraries, URLs, API endpoints, or paper titles. Use real data or clearly labeled fixtures.
- **Never add** feature flags, backwards-compatibility shims, or dead code paths.
- **Never expose** API keys in code, output, or commits.
- **Never introduce** new dependencies without explicit justification — keep the `requirements.txt` tight.
- **Default:** no comments. Only comment non-obvious constraints, workarounds, or invariants.

## 3. Technology Stack (Current)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Backend | Python 3.13, FastAPI, Uvicorn | `backend/app.py` entry point |
| Agent framework | AG2 Beta (`autogen.beta.Agent`) | OpenAI-compatible config via `OpenAIConfig` |
| Models | DeepSeek v4-flash (Lead), Kimi kimi-k2.6 (Critic), Zhipu glm-4-flash (Scorer) | All via `base_url` + `api_key` pattern |
| Sandbox | Daytona SDK with local fallback | Fallback explicitly labeled in output |
| Storage | In-memory run store + JSON evidence board | `backend/storage/evidence_board.py` |
| Frontend | Vite + React + TypeScript + Lucide icons | `frontend/src/` |
| Parsing | PyMuPDF for PDF, regex for injection scan | `backend/parsing/` |
| Metadata | Semantic Scholar live API → fixture fallback | `backend/metadata/` |

## 4. Model Architecture (Critical)

Three models, distinct roles, 3-round adversarial harness:

```
Round 1: DeepSeek (Lead) drafts → Kimi (Critic) reviews
Round 2: DeepSeek (Lead) revises → Kimi (Critic) re-reviews
Round 3: DeepSeek (Lead) finalizes → Zhipu (Scorer) gives 0-10 verdict
```

API calls per review: DeepSeek 3, Kimi 2, Zhipu 1. Zhipu has the naturally lowest call volume.

All model config in `.env.local`:
- `DEEPSEEK_MODEL=deepseek-v4-flash`, `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1`
- `KIMI_MODEL=kimi-k2.6`, `KIMI_BASE_URL=https://api.moonshot.cn/v1`
- `ZHIPU_MODEL=glm-4-flash`, `ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4`

Fallback chain (graceful degradation): Kimi unavailable → DeepSeek self-critiques; Zhipu unavailable → DeepSeek self-scores.

## 5. Current State — What's Done

- [x] Backend FastAPI with `/api/analyze` and `/api/analyze-stream` (SSE)
- [x] Agent workflow: Intake → Methods/Stats → Integrity → Novelty → Repro → Area Chair
- [x] 3-round cross-model AG2 Beta synthesis (DeepSeek Lead + Kimi Critic + Zhipu Scorer)
- [x] SSE streaming agent trace (`event_queue` pattern)
- [x] Live Semantic Scholar search → fixture fallback for related work
- [x] Chinese → English field domain mapping (计算生物学, 临床医学, etc.)
- [x] Claim-concern linking with expanded keyword matching
- [x] Daytona reproducibility runner with local fallback
- [x] Frontend dashboard with Upload, AgentTrace (live), EvidenceBoard, ReviewerPacket
- [x] Prompt-injection scanner (`backend/parsing/injection_scan.py`)
- [x] Clean and suspicious fixture papers
- [x] `.env.local` with all API keys configured

## 6. What Must Be Done Tonight

### Phase 1: Fix Stale References (HIGH) — DONE
- [x] **README.md** — still references Gemini, GPT-5.5, OpenAI. Rewrite to reflect DeepSeek+Kimi+Zhipu three-model architecture. Include Harness Engineering narrative.
- [x] **docs/demo_script.md** — still mentions "OpenAI GPT-5.5". Update to current models + harness engineering framing.
- [x] **tests/test_orchestrator.py** — references gpt-5.5 in test fixtures. Update to generic labels.
- [x] **docs/architecture.md** — check and update if needed.

### Phase 2: End-to-End Verification (HIGH) — DONE
- [x] **Run clean fixture** — verify 3-round synthesis completes with all 3 models, no errors.
- [x] **Run suspicious fixture** — verify prompt-injection detected, repro failed, claim-concern linking correct.
- [x] **Verify SSE streaming** — open `http://127.0.0.1:5173`, click "Run Review", confirm live trace animation.
- [x] **Verify Semantic Scholar** — check logs that live API is returning results, not just fixtures.
- [x] **Verify frontend fallback** — test that `/api/analyze` works when streaming fails.

### Phase 3: Submission Artifacts (CRITICAL) — DONE
- [x] **AI_LOG.md** — document every AI-assisted decision: model choices, Harness Engineering adoption, architecture changes, prompt engineering, bug fixes. Must be honest and detailed.
- [x] **ATTRIBUTION.md** — credit all open-source components: AG2, Daytona, FastAPI, PyMuPDF, React, Vite, Lucide, Semantic Scholar API, and the Harness Engineering paradigm from OpenAI.
- [x] **LICENSE** — MIT license file.
- [x] **Update README.md** — architecture diagram (show harness layers), setup instructions, demo flow, ethical boundary, sponsor usage, Harness Engineering positioning.
- [x] **Update docs/demo_script.md** — 90-second and 5-minute versions with correct model names.

### Phase 4: Polish (MEDIUM) — DONE
- [x] **Frontend sponsor strip** — update to show DeepSeek + Kimi + Zhipu.
- [ ] **Record demo video** — 90s version showing clean + suspicious paper runs. (OPTIONAL)
- [x] **Sample output** — save and commit example review packets for both fixtures.
- [x] **Preflight check** — run `scripts/preflight_demo.py` and fix any failures.
- [x] **CSS polish** — ensure the live pulse animation, trace list, and evidence board look good.

## 7. File Map (Where Everything Lives)

```
RefereeOS/
├── CLAUDE.md                          ← THIS FILE
├── README.md                          ← DONE (Harness Engineering narrative, model names, two-mode setup)
├── design.md                          ← Visual design direction
├── .env.local                         ← All API keys (DO NOT COMMIT)
├── .env.example                       ← Template without real keys
├── requirements.txt                   ← Python deps
├── main.py                            ← Root launcher (uvicorn)
├── refereeos_hackathon_build_plan.md  ← Reference only, not a deliverable
├── refereeos_deliverables_brief.md    ← What to submit
├── AI_LOG.md                          ← DONE (9 major decisions documented)
├── ATTRIBUTION.md                     ← DONE (all OSS + models + paradigm credited)
├── LICENSE                            ← DONE (MIT)
├── backend/
│   ├── app.py                         ← FastAPI: /api/analyze, /api/analyze-stream, health, runs
│   ├── agents/
│   │   └── orchestrator.py            ← Core: agent pipeline + AG2 synthesis (HEAVILY MODIFIED)
│   ├── fixtures/
│   │   ├── clean_paper.md             ← Clean computational biology fixture
│   │   ├── suspicious_paper.md        ← Suspicious/adversarial fixture
│   │   └── reproduce_metric.py        ← Metric recalculation script
│   ├── metadata/
│   │   ├── related_work.py            ← Live Semantic Scholar → fixture fallback
│   │   └── semantic_scholar.py        ← Live API client (urllib only, no deps)
│   ├── parsing/
│   │   ├── paper_parser.py            ← Text/PDF extraction + fixture loading
│   │   └── injection_scan.py          ← Prompt-injection regex scanner
│   ├── repro/
│   │   └── daytona_runner.py          ← Daytona sandbox + local fallback
│   └── storage/
│       └── evidence_board.py          ← In-memory run store + board builder
├── frontend/
│   ├── src/
│   │   ├── App.tsx                    ← Main app: streaming SSE + fallback
│   │   ├── types.ts                   ← TypeScript types
│   │   ├── styles.css                 ← CSS with live-pulse animation
│   │   └── components/
│   │       ├── AgentTrace.tsx          ← Live trace with pulsing indicator
│   │       ├── EvidenceBoard.tsx       ← Claims, concerns, evidence table
│   │       ├── ReviewerPacket.tsx      ← Markdown packet display
│   │       └── UploadPanel.tsx         ← Upload/fixture selector
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── docs/
│   ├── architecture.md
│   └── demo_script.md                 ← DONE (model names updated, harness framing)
├── tests/
│   └── test_orchestrator.py           ← DONE (model references updated)
├── scripts/
│   ├── preflight_demo.py              ← Pre-demo connectivity check
│   └── daytona_smoke.py               ← Daytona sandbox smoke test
└── outputs/
    └── runs/                          ← Run output storage
```

## 8. Agent Implementation Rules

### Orchestrator (`backend/agents/orchestrator.py`)
- **This is the single most important file.** ~800 lines. Every agent step and AG2 synthesis lives here.
- `analyze_text()` and `analyze_fixture()` are the main entry points. Both accept `event_queue`.
- `_run_step()` wraps each agent step with SSE event push — this is the observability harness.
- `_ag2_beta_area_chair_synthesis()` is the 3-model 3-round adversarial harness. ~120 lines.
- All model config functions follow the `_<provider>_config()` / `_<provider>_api_key()` pattern.
- `detect_ag2_runtime()` introspects the environment and returns an `AG2Runtime` dataclass.

### Evidence Board (`backend/storage/evidence_board.py`)
- The **evaluation harness** — structured JSON that every agent reads and writes.
- `build_empty_board(paper, metadata)` initializes the board structure.
- `run_store` is a module-level `RunStore` instance (in-memory dict, survives single process lifetime).

### Related Work (`backend/metadata/related_work.py`)
- `get_related_work(field_guess, title)` — live API first, fixture fallback (graceful degradation).
- Chinese field names resolved via `_FIELD_ALIASES`.
- Semantic Scholar returns 3-5 papers with `novelty_risk` and `reason`.

## 9. Frontend Implementation Rules

- SSE streaming is the primary code path. The non-streaming `/api/analyze` is a fallback only.
- `liveTrace` state accumulates `AgentTraceItem[]` as `step` SSE events arrive.
- `isStreaming` controls the `live` prop on `AgentTrace`.
- AbortController cancels in-flight requests on re-run.
- The empty trace placeholder only shows when items have non-pending status.

## 10. Test Rules

- No mocking the evidence board, parser, or injection scanner — they are deterministic.
- Daytona runner and AG2 synthesis are mocked in unit tests.
- Tests must pass before declaring work complete.
- Run with: `.venv/bin/python -m unittest tests.test_orchestrator -v`

## 11. How to Start / Restart

```bash
# Backend
pkill -f "uvicorn backend.app:app"
.venv/bin/python -m uvicorn backend.app:app --reload --reload-exclude "outputs/*" --host 127.0.0.1 --port 8000

# Frontend (separate terminal)
npm --prefix frontend run dev

# Quick test
curl -s http://127.0.0.1:8000/api/health
```

## 12. Deliverables Checklist (Final) — ALL DONE

- [x] README.md (updated with Harness Engineering narrative)
- [x] AI_LOG.md (created)
- [x] ATTRIBUTION.md (created)
- [x] LICENSE (created)
- [x] docs/demo_script.md (updated)
- [x] docs/architecture.md (updated if needed)
- [x] All tests passing
- [x] Clean fixture run produces correct output
- [x] Suspicious fixture run produces correct output
- [x] SSE streaming works in browser
- [x] No references to Gemini, GPT-5.5, or OpenAI in any user-facing text (except Harness Engineering credit)
- [ ] Demo video recorded (optional — skip for submission)
- [x] `outputs/runs/` has example output for both fixtures

## 13. Execution Order for Tonight — ALL DONE

1. [x] Fix README.md (Harness Engineering narrative, model names, architecture, setup)
2. [x] Fix docs/demo_script.md (model names, harness framing)
3. [x] Fix tests/test_orchestrator.py (gpt-5.5 references)
4. [x] Create AI_LOG.md, ATTRIBUTION.md, LICENSE
5. [x] Run clean fixture → verify output → save
6. [x] Run suspicious fixture → verify output → save
7. [x] Verify frontend SSE in browser
8. [x] Update sponsor strip in App.tsx
9. [x] Final README pass
10. [x] Package everything, ensure git repo is clean
