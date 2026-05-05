from __future__ import annotations

import json
import logging
import os
import queue
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("refereeos.orchestrator")

from backend.metadata.related_work import get_related_work
from backend.parsing.injection_scan import scan_for_prompt_injection
from backend.parsing.paper_parser import FIXTURES, load_fixture_text, parse_manuscript_text
from backend.repro.daytona_runner import DaytonaOpenAIReproRunner, DEFAULT_OPENAI_MODEL
from backend.storage.evidence_board import build_empty_board


@dataclass
class AG2Runtime:
    available: bool
    version: str
    label: str
    agents: list[str]
    llm_enabled: bool = False
    llm_model: str | None = None
    status: str = "deterministic"
    error: str | None = None


def detect_ag2_runtime() -> AG2Runtime:
    agents = [
        "intake_agent",
        "methods_statistics_agent",
        "integrity_agent",
        "novelty_literature_agent",
        "reproducibility_agent",
        "area_chair_lead",
        "area_chair_critic",
    ]

    try:
        import autogen  # type: ignore

        version = getattr(autogen, "__version__", "installed")
    except Exception as exc:
        return AG2Runtime(
            False,
            "not installed",
            "AG2-compatible deterministic workflow (autogen unavailable)",
            agents,
            status="unavailable",
            error=str(exc),
        )

    model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    enable_llm = os.getenv("REFEREEOS_ENABLE_AG2_LLM", "false").lower() == "true"
    if not enable_llm:
        return AG2Runtime(
            True,
            version,
            f"AG2 {version} installed; deterministic synthesis",
            agents,
            llm_model=model,
            status="disabled",
        )
    if not _deepseek_api_key():
        return AG2Runtime(
            True,
            version,
            f"AG2 {version} installed; DeepSeek synthesis unavailable (missing key)",
            agents,
            llm_model=model,
            status="missing_key",
        )

    zhipu_model = os.getenv("ZHIPU_MODEL", "glm-4-flash")
    kimi_model = os.getenv("KIMI_MODEL", "kimi-k2.6")
    zhipu_available = bool(_zhipu_api_key())
    kimi_available = bool(_kimi_api_key())
    models = ["DeepSeek", model]
    if kimi_available:
        models.append(f"Kimi {kimi_model}")
    if zhipu_available:
        models.append(f"Zhipu {zhipu_model}")
    label = f"AG2 Beta {version} + {' + '.join(models)}"

    return AG2Runtime(True, version, label, agents, True, model, "ready")


def analyze_fixture(
    fixture_id: str = "clean",
    field_domain: str | None = None,
    event_queue: queue.Queue | None = None,
) -> dict[str, Any]:
    text, fixture_meta = load_fixture_text(fixture_id)
    return analyze_text(
        text,
        source=f"sample_fixture:{fixture_meta['fixture_id']}",
        fixture_meta=fixture_meta,
        field_domain=field_domain,
        event_queue=event_queue,
    )


def analyze_text(
    text: str,
    source: str,
    fixture_meta: dict[str, Any] | None = None,
    field_domain: str | None = None,
    event_queue: queue.Queue | None = None,
) -> dict[str, Any]:
    runtime = detect_ag2_runtime()
    fixture_meta = fixture_meta or {"fixture_id": "uploaded", **FIXTURES["clean"]}
    paper = parse_manuscript_text(text, source=source)
    if field_domain:
        paper["field_guess"] = field_domain

    kimi_model = os.getenv("KIMI_MODEL", "kimi-k2.6")
    kimi_available = bool(_kimi_api_key())
    zhipu_model = os.getenv("ZHIPU_MODEL", "glm-4-flash")
    zhipu_available = bool(_zhipu_api_key())
    models_parts = ["DeepSeek"]
    if kimi_available:
        models_parts.append(f"Kimi {kimi_model}")
    if zhipu_available:
        models_parts.append(f"Zhipu {zhipu_model}")
    provider_label = " + ".join(models_parts)

    board = build_empty_board(
        paper,
        {
            "workflow_engine": runtime.label,
            "sandbox_provider": "Daytona",
            "llm_provider": provider_label if runtime.llm_enabled else "none",
            "llm_model": runtime.llm_model if runtime.llm_enabled else DEFAULT_OPENAI_MODEL,
            "fixture_id": fixture_meta.get("fixture_id"),
            "ag2_status": runtime.status,
            "ag2_model": runtime.llm_model,
            "kimi_model": kimi_model if kimi_available else None,
            "zhipu_model": zhipu_model if zhipu_available else None,
        },
    )

    _run_step(board, "intake_agent", "Extract paper profile and atomic claims", lambda: _intake(board, paper), event_queue=event_queue)
    _run_step(board, "methods_statistics_agent", "Assess methodology and statistics risk", lambda: _methods_stats(board, paper), event_queue=event_queue)
    _run_step(board, "integrity_agent", "Scan manuscript for prompt-injection and suspicious instructions", lambda: _integrity(board, paper), event_queue=event_queue)
    _run_step(board, "novelty_literature_agent", "Attach lightweight related-work risks", lambda: _novelty(board, paper), event_queue=event_queue)
    _run_step(
        board,
        "reproducibility_agent",
        "Run Daytona sandbox reproducibility probe",
        lambda: _reproducibility(board, paper, fixture_meta),
        event_queue=event_queue,
    )
    _run_step(board, "area_chair_agent", _area_chair_label(runtime), lambda: _area_chair(board, runtime), event_queue=event_queue)

    return board


def _run_step(
    board: dict[str, Any],
    agent: str,
    label: str,
    fn,
    event_queue: queue.Queue | None = None,
) -> None:
    started = datetime.now(timezone.utc).isoformat()
    trace = {"agent": agent, "label": label, "status": "running", "started_at": started}
    board["agent_trace"].append(trace)

    if event_queue is not None:
        event_queue.put_nowait(_make_sse_event("step", trace))
        # Small delay so the SSE stream delivers the "running" state
        # before fn() completes. Otherwise fast steps batch running+complete
        # together and React 18 never renders the intermediate state.
        import time as _time
        _time.sleep(0.12)

    try:
        fn()
        trace["status"] = "complete"
    except Exception as exc:
        trace["status"] = "error"
        trace["error"] = str(exc)
        board["concerns"].append(
            {
                "id": _next_id(board, "concern"),
                "agent": agent,
                "severity": "high",
                "category": "workflow",
                "text": f"{label} failed: {exc}",
                "human_followup": "Rerun this agent after checking environment configuration.",
            }
        )
    finally:
        trace["completed_at"] = datetime.now(timezone.utc).isoformat()

    if event_queue is not None:
        event_queue.put_nowait(_make_sse_event("step", trace))


def _make_sse_event(event_type: str, data: dict[str, Any]) -> str:
    """Format a dict as an SSE event data line."""
    return json.dumps({"type": event_type, **data}, default=str)


def _intake(board: dict[str, Any], paper: dict[str, Any]) -> None:
    for idx, claim in enumerate(paper["claims"], start=1):
        claim_id = f"claim_{idx:03d}"
        evidence_id = f"ev_{idx:03d}"
        claim_type = _claim_type(claim)
        board["claims"].append(
            {
                "id": claim_id,
                "text": claim,
                "type": claim_type,
                "supporting_evidence_ids": [evidence_id],
                "concern_ids": [],
            }
        )
        board["evidence"].append(
            {
                "id": evidence_id,
                "claim_id": claim_id,
                "source_location": "abstract/results",
                "text": _evidence_for_claim(claim, paper),
            }
        )


def _methods_stats(board: dict[str, Any], paper: dict[str, Any]) -> None:
    text = paper["raw_text"].lower()
    checks = []
    has_clear_split = "train/validation/test" in text or ("train" in text and "validation" in text and "test" in text)

    if "does not clearly separate train and test" in text or not has_clear_split:
        checks.append(("high", "methods", "Train/test split is unclear or absent.", "Ask authors for exact split construction."))
    if "does not describe a baseline" in text or "baseline" not in text:
        checks.append(("high", "methods", "Baseline comparison appears underspecified.", "Ask authors for baseline code and hyperparameters."))
    if "small pilot" in text or "48 patient" in text:
        checks.append(("high", "stats", "Sample size is too small for broad deployment claims.", "Ask authors for external validation or narrower claims."))
    if "proves causal" in text or ("causal" in text and "observational" in text):
        checks.append(("high", "stats", "Causal language is unsupported by observational evidence.", "Ask authors to revise causal claims or add identification assumptions."))
    if "ablation" not in text:
        checks.append(("medium", "methods", "Ablation evidence is missing or thin.", "Ask authors which components drive the gain."))

    if not checks:
        checks.append(
            (
                "low",
                "methods",
                "Core split and baseline details are present for a first-pass review.",
                "Human reviewer should still inspect fixture representativeness.",
            )
        )

    for severity, category, concern, followup in checks[:5]:
        _append_concern(
            board,
            "methods_statistics_agent",
            severity,
            category,
            concern,
            followup,
            claim_ids=_claim_ids_for_concern(board, category, concern),
        )


def _integrity(board: dict[str, Any], paper: dict[str, Any]) -> None:
    findings = scan_for_prompt_injection(paper["raw_text"])
    for finding in findings:
        _append_concern(
            board,
            "integrity_agent",
            finding["severity"],
            "integrity",
            f"{finding['finding']} Matched text: {finding['matched_text']!r}.",
            finding["recommendation"],
        )

    if not findings:
        board["concerns"].append(
            {
                "id": _next_id(board, "concern"),
                "agent": "integrity_agent",
                "severity": "low",
                "category": "integrity",
                "text": "No prompt-injection phrases were found by the regex scanner.",
                "human_followup": "Continue to treat raw manuscript text as untrusted input.",
            }
        )


def _novelty(board: dict[str, Any], paper: dict[str, Any]) -> None:
    related = get_related_work(paper["field_guess"], paper["title"])
    board["related_work"] = related
    for paper_ref in related:
        if paper_ref["novelty_risk"] == "high":
            _append_concern(
                board,
                "novelty_literature_agent",
                "medium",
                "novelty",
                f"Potential novelty overlap: {paper_ref['title']}.",
                paper_ref["reason"],
                claim_ids=_claim_ids_matching(board, ["prior", "baseline", "method", "outperform", "obsolete"]),
            )


def _reproducibility(board: dict[str, Any], paper: dict[str, Any], fixture_meta: dict[str, Any]) -> None:
    receipt = DaytonaOpenAIReproRunner().run(fixture_meta, paper)
    board["repro_checks"].append(receipt)

    status = receipt.get("status")
    if status in {"failed", "inconclusive"}:
        severity = "high" if status == "failed" else "medium"
        _append_concern(
            board,
            "reproducibility_agent",
            severity,
            "reproducibility",
            f"Reproducibility probe was {status}: reported {receipt.get('reported_result')} vs observed {receipt.get('observed_result')}.",
            receipt.get("human_followup", "Ask authors for executable artifacts."),
            claim_ids=_metric_claim_ids(board),
        )


def _area_chair(board: dict[str, Any], runtime: AG2Runtime) -> None:
    recommendation = _triage_recommendation(board)
    expertise = _recommended_expertise(board)
    synthesis = None

    if runtime.llm_enabled:
        try:
            synthesis = _ag2_beta_area_chair_synthesis(board, recommendation, expertise, runtime)
            board["metadata"]["ag2_status"] = "used"
        except Exception as exc:
            board["metadata"]["ag2_status"] = "error"
            board["metadata"]["ag2_error"] = str(exc)[:500]
            _append_concern(
                board,
                "area_chair_lead",
                "high",
                "workflow",
                f"AG2 Beta area-chair synthesis failed: {exc}",
                "Check DeepSeek configuration before the live demo or use deterministic fallback.",
                claim_ids=[],
            )
            recommendation = _triage_recommendation(board)
    else:
        board["metadata"]["ag2_status"] = runtime.status
        if runtime.error:
            board["metadata"]["ag2_error"] = runtime.error[:500]

    markdown = _packet_markdown(board, recommendation, expertise, synthesis)
    board["final_packet"] = {
        "triage_recommendation": recommendation,
        "recommended_human_reviewer_expertise": expertise,
        "markdown": markdown,
        "area_chair_synthesis": synthesis,
        "ethical_boundary": "RefereeOS prepares human peer review and does not make publication decisions.",
    }


def _triage_recommendation(board: dict[str, Any]) -> str:
    high_categories = {concern["category"] for concern in board["concerns"] if concern["severity"] == "high"}
    repro_statuses = {check.get("status") for check in board["repro_checks"]}

    if "integrity" in high_categories:
        return "Possible integrity issue"
    if "failed" in repro_statuses or "inconclusive" in repro_statuses:
        return "Reproducibility check failed or inconclusive"
    if "workflow" in high_categories:
        return "Needs author clarification before review"
    if high_categories.intersection({"methods", "stats", "novelty"}):
        return "Needs author clarification before review"
    return "Ready for human review"


def _recommended_expertise(board: dict[str, Any]) -> list[str]:
    field = board["paper"]["field_guess"]
    expertise = [field.title(), "Reproducible computational methods"]
    if any(concern["category"] == "stats" for concern in board["concerns"]):
        expertise.append("Statistical validation")
    if any(concern["category"] == "integrity" and concern["severity"] == "high" for concern in board["concerns"]):
        expertise.append("Research integrity / adversarial ML review")
    return expertise


def _packet_markdown(
    board: dict[str, Any],
    recommendation: str,
    expertise: list[str],
    synthesis: dict[str, str] | None = None,
) -> str:
    paper = board["paper"]
    claims = "\n".join(f"{idx}. {claim['text']}" for idx, claim in enumerate(board["claims"], start=1))
    evidence_rows = "\n".join(
        f"| {claim['id']} | {claim['text']} | {', '.join(claim['concern_ids']) or 'No direct concern'} |"
        for claim in board["claims"]
    )
    concern_lines = "\n".join(
        f"- **{concern['severity'].title()} {concern['category']}**: {concern['text']} Follow-up: {concern['human_followup']}"
        for concern in board["concerns"]
    )
    related_lines = "\n".join(
        f"- {item['title']} ({item['novelty_risk']} risk): {item['reason']}" for item in board["related_work"]
    )
    repro = board["repro_checks"][0] if board["repro_checks"] else {}
    expertise_lines = "\n".join(f"- {item}" for item in expertise)
    synthesis_section = ""
    if synthesis:
        summary = synthesis.get("summary", "").strip()
        risk_summary = synthesis.get("risk_summary", "").strip()
        human_focus = synthesis.get("human_focus", "").strip()
        synthesis_lines = "\n".join(line for line in [summary, risk_summary, human_focus] if line)
        synthesis_section = f"""
## AG2 Area Chair Synthesis
{synthesis_lines}
"""

    return f"""# RefereeOS Reviewer Packet

## Triage Recommendation
{recommendation}

## Paper Summary
**Title:** {paper['title']}

**Field guess:** {paper['field_guess']}

{paper['abstract']}

## Top Claims
{claims}

## Evidence Map
| Claim ID | Claim | Concern Links |
|---|---|---|
{evidence_rows}

## Methodological, Integrity, And Novelty Risks
{concern_lines}

## Related Work / Novelty Risks
{related_lines}
{synthesis_section}

## Reproducibility Receipt
- Sandbox: {repro.get('sandbox_provider', 'Daytona')}
- Model: {repro.get('model', DEFAULT_OPENAI_MODEL)}
- Probe: {repro.get('probe', 'Not run')}
- Status: {repro.get('status', 'not_run')}
- Commands run: {', '.join(repro.get('commands_run', [])) or 'None'}
- Reported result: {repro.get('reported_result', 'unknown')}
- Observed result: {repro.get('observed_result', 'unknown')}
- LLM interpretation: {repro.get('llm_interpretation', 'No interpretation available')}
- Human follow-up: {repro.get('human_followup', 'Human review required')}

## Recommended Human Reviewer Expertise
{expertise_lines}

## Human Judgment Still Required
RefereeOS prepares peer review. It does not make final publication accept/reject decisions.
"""


def _append_concern(
    board: dict[str, Any],
    agent: str,
    severity: str,
    category: str,
    text: str,
    human_followup: str,
    claim_ids: list[str] | None = None,
) -> None:
    concern_id = _next_id(board, "concern")
    board["concerns"].append(
        {
            "id": concern_id,
            "agent": agent,
            "severity": severity,
            "category": category,
            "text": text,
            "human_followup": human_followup,
        }
    )
    linked_claim_ids = set(claim_ids or [])
    for claim in board["claims"]:
        if claim["id"] in linked_claim_ids and concern_id not in claim["concern_ids"]:
            claim["concern_ids"].append(concern_id)


def _area_chair_label(runtime: AG2Runtime) -> str:
    if runtime.llm_enabled:
        return f"Synthesize reviewer-prep packet with {runtime.label}"
    return "Synthesize reviewer-prep packet with deterministic fallback"


def _deepseek_config():
    from autogen.beta.config import OpenAIConfig

    return OpenAIConfig(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        api_key=_deepseek_api_key(),
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        temperature=0,
    )


def _deepseek_api_key() -> str:
    return os.getenv("DEEPSEEK_API_KEY") or ""


def _kimi_config():
    from autogen.beta.config import OpenAIConfig

    return OpenAIConfig(
        model=os.getenv("KIMI_MODEL", "kimi-k2.6"),
        api_key=_kimi_api_key(),
        base_url=os.getenv("KIMI_BASE_URL", "https://api.moonshot.cn/v1"),
        temperature=0.3,
    )


def _kimi_api_key() -> str:
    return os.getenv("KIMI_API_KEY") or ""


def _zhipu_config():
    from autogen.beta.config import OpenAIConfig

    return OpenAIConfig(
        model=os.getenv("ZHIPU_MODEL", "glm-4-flash"),
        api_key=_zhipu_api_key(),
        base_url=os.getenv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
        temperature=0.3,
    )


def _zhipu_api_key() -> str:
    return os.getenv("ZHIPU_API_KEY") or ""


def _area_chair_prompt(board: dict[str, Any], recommendation: str, expertise: list[str]) -> str:
    digest = {
        "paper": board["paper"],
        "claims": board["claims"],
        "concerns": board["concerns"],
        "repro_checks": board["repro_checks"],
        "deterministic_triage_recommendation": recommendation,
        "recommended_human_reviewer_expertise": expertise,
    }
    return (
        "Return JSON only with keys summary, risk_summary, and human_focus. "
        "Preserve the deterministic triage recommendation and do not include accept/reject language.\n\n"
        + json.dumps(digest, indent=2)
    )


def _reply_to_text(reply: Any) -> str:
    if isinstance(reply, str):
        return reply.strip()
    if isinstance(reply, dict):
        return str(reply.get("content") or reply.get("text") or reply).strip()
    return str(reply).strip()


def _parse_json_object(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except Exception:
        pass
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _ag2_beta_area_chair_synthesis(
    board: dict[str, Any],
    recommendation: str,
    expertise: list[str],
    runtime: AG2Runtime,
) -> dict[str, str]:
    """AG2 Beta multi-agent: 3-round cross-model review.

    DeepSeek (Lead) — drafts and revises all 3 rounds.
    Kimi (Critic) — cross-model adversarial review in rounds 1–2.
    Zhipu (Scorer) — final 0–10 verdict in round 3 (least calls).

    Falls back: missing Kimi → DeepSeek self-critiques; missing Zhipu → DeepSeek self-scores.
    """
    import asyncio

    from autogen.beta import Agent

    deepseek_model = runtime.llm_model or os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    kimi_model = os.getenv("KIMI_MODEL", "kimi-k2.6")
    zhipu_model = os.getenv("ZHIPU_MODEL", "glm-4-flash")
    kimi_available = bool(_kimi_api_key())
    zhipu_available = bool(_zhipu_api_key())

    parts = ["DeepSeek (Lead)"]
    if kimi_available:
        parts.append(f"Kimi (Critic)")
    if zhipu_available:
        parts.append(f"Zhipu (Scorer)")
    source_label = f"AG2 Beta + {' + '.join(parts)} — 3-round review"

    digest = _area_chair_prompt(board, recommendation, expertise)

    async def _run() -> dict[str, str]:
        lead = Agent(
            "area_chair_lead",
            prompt=(
                "You are the RefereeOS area chair synthesis lead. "
                "Given review-prep evidence, draft a concise synthesis with summary, risk_summary, and human_focus. "
                "Return JSON only. Do not recommend accepting or rejecting publication."
            ),
            config=_deepseek_config(),
        )

        # Kimi as cross-model critic for rounds 1–2
        critic_config = _kimi_config() if kimi_available else _deepseek_config()
        critic_model = f"Kimi {kimi_model}" if kimi_available else f"DeepSeek {deepseek_model}"
        critic = Agent(
            "area_chair_critic",
            prompt=(
                f"You are the RefereeOS area chair critic, powered by {critic_model}. "
                "Review the lead's synthesis draft from a different perspective. "
                "Flag any missing risks, unsupported claims, blind spots, or bias. Be specific and terse. "
                "Return your critique as plain text, then end with a JSON block {\"gaps\": [...], \"endorsed\": true/false}."
            ),
            config=critic_config,
        )

        # ── Round 1: Lead drafts + Critic reviews ──
        lead_draft = await lead.ask(digest)
        draft_text = str(lead_draft.body)

        critic_r1 = await critic.ask(
            f"ROUND 1/3\nLead synthesis draft:\n{draft_text}\n\nCritique this. Flag gaps, biases, or missing risks."
        )
        critique_r1 = str(critic_r1.body)

        # ── Round 2: Lead revises + Critic re-reviews ──
        lead_r2 = await lead.ask(
            f"ROUND 2/3\nYour previous draft:\n{draft_text}\n\nCritic feedback:\n{critique_r1}\n\n"
            "Revise your synthesis incorporating the critic's feedback. Return JSON only."
        )
        draft_r2 = str(lead_r2.body)

        critic_r2 = await critic.ask(
            f"ROUND 2/3\nRevised synthesis:\n{draft_r2}\n\n"
            "The lead has revised based on your first critique. Identify any remaining gaps or improvements."
        )
        critique_r2 = str(critic_r2.body)

        # ── Round 3: Lead finalizes ──
        lead_final = await lead.ask(
            f"ROUND 3/3 (FINAL)\nYour previous draft:\n{draft_r2}\n\n"
            f"Critic's second review:\n{critique_r2}\n\n"
            "Produce your final synthesis incorporating all feedback. Return JSON only with keys summary, risk_summary, and human_focus."
        )
        final_text = str(lead_final.body)

        # ── Round 3: Zhipu (or DeepSeek fallback) final scoring ──
        scorer_config = _zhipu_config() if zhipu_available else _deepseek_config()
        scorer_name = f"Zhipu {zhipu_model}" if zhipu_available else f"DeepSeek {deepseek_model}"
        scorer = Agent(
            "area_chair_scorer",
            prompt=(
                f"You are the RefereeOS final synthesis scorer, powered by {scorer_name}. "
                "Rate the final synthesis 0-10 on completeness, accuracy, and actionability. "
                "Return JSON: {\"score\": <0-10>, \"verdict\": \"PASS|MINOR|REVISE\", \"comment\": \"...\"}"
            ),
            config=scorer_config,
        )
        scorer_result = await scorer.ask(
            f"FINAL SCORING\nFinal synthesis:\n{final_text}\n\n"
            "Rate the final synthesis 0-10 on completeness, accuracy, and actionability. "
            "Return JSON: {{\"score\": <0-10>, \"verdict\": \"PASS|MINOR|REVISE\", \"comment\": \"...\"}}"
        )
        scoring_text = str(scorer_result.body)
        score_data = _parse_json_object(scoring_text) or {}

        parsed = _parse_json_object(final_text) or _parse_json_object(draft_text)
        if parsed:
            return {
                "source": source_label,
                "summary": str(parsed.get("summary", "")).strip(),
                "risk_summary": str(parsed.get("risk_summary", "")).strip(),
                "human_focus": str(parsed.get("human_focus", "")).strip(),
                "critic_score": score_data.get("score"),
                "critic_verdict": str(score_data.get("verdict", "")),
            }
        return {
            "source": source_label,
            "summary": final_text[:1200],
            "risk_summary": critique_r1[:600],
            "human_focus": "",
            "critic_score": score_data.get("score"),
            "critic_verdict": str(score_data.get("verdict", "")),
        }

    import threading

    AG2_SYNTHESIS_TIMEOUT = 300  # seconds — 3 rounds need more time

    result: dict[str, str] = {}
    error: Exception | None = None

    def _target() -> None:
        nonlocal result, error
        try:
            result = asyncio.run(_run())
        except Exception as exc:
            error = exc

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()
    thread.join(timeout=AG2_SYNTHESIS_TIMEOUT)
    if thread.is_alive():
        raise TimeoutError(f"AG2 Beta synthesis timed out after {AG2_SYNTHESIS_TIMEOUT}s")
    if error:
        raise error
    return result


def _claim_ids_for_concern(board: dict[str, Any], category: str, concern_text: str) -> list[str]:
    lowered = concern_text.lower()
    if category == "stats":
        if "causal" in lowered:
            return _claim_ids_matching(board, ["causal", "deploy", "hospital", "clinical"])
        if "sample size" in lowered:
            return _claim_ids_matching(board, ["deploy", "hospital", "clinical", "causal"])
    if category == "methods":
        if "baseline" in lowered or "train/test" in lowered:
            return _metric_claim_ids(board)
        if "ablation" in lowered:
            return list(set(_metric_claim_ids(board) + _claim_ids_matching(board, ["feature", "method", "component", "f1", "improves"])))
    return []


def _metric_claim_ids(board: dict[str, Any]) -> list[str]:
    return _claim_ids_matching(board, ["macro f1", "f1", "metric", "benchmark", "reported", "outperform", "baseline", "obsolete"])


def _claim_ids_matching(board: dict[str, Any], keywords: list[str]) -> list[str]:
    matches = []
    for claim in board["claims"]:
        text = claim["text"].lower()
        if any(keyword in text for keyword in keywords):
            matches.append(claim["id"])
    return matches


def _next_id(board: dict[str, Any], prefix: str) -> str:
    existing = len(board["concerns"]) + 1 if prefix == "concern" else 1
    return f"{prefix}_{existing:03d}"


def _claim_type(claim: str) -> str:
    lowered = claim.lower()
    if "causal" in lowered or "proves" in lowered:
        return "causal"
    if "f1" in lowered or "benchmark" in lowered or "outperform" in lowered:
        return "benchmark"
    if "method" in lowered or "feature" in lowered:
        return "methodological"
    return "empirical"


def _evidence_for_claim(claim: str, paper: dict[str, Any]) -> str:
    if "f1" in claim.lower():
        return paper.get("results_summary") or paper.get("abstract")
    return paper.get("abstract")
