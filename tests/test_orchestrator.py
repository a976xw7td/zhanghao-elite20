from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from backend.agents import orchestrator


PASSED_RECEIPT = {
    "probe": "Reproducibility agent: select and run metric recalculation probe",
    "sandbox_provider": "Daytona",
    "model": "deepseek-v4-flash",
    "status": "passed",
    "commands_run": ["python reproduce_metric.py results.csv"],
    "reported_result": "0.87",
    "observed_result": "0.87",
    "artifact_paths": ["results.csv", "reproduce_metric.py"],
    "stdout_stderr_summary": "macro_f1=0.87",
    "human_followup": "No immediate follow-up needed for this metric.",
    "llm_interpretation": "Artifact rerun reproduced the reported macro F1.",
    "exit_code": 0,
}

FAILED_RECEIPT = {
    **PASSED_RECEIPT,
    "status": "failed",
    "reported_result": "0.91",
    "observed_result": "0.77",
    "stdout_stderr_summary": "macro_f1=0.77",
    "human_followup": "Ask authors to explain the metric mismatch before review.",
    "llm_interpretation": "Artifact rerun did not reproduce the reported macro F1.",
}


class OrchestratorTests(unittest.TestCase):
    def analyze_fixture_with_receipt(self, fixture_id: str, receipt: dict) -> dict:
        with patch.dict(os.environ, {"REFEREEOS_ENABLE_AG2_LLM": "false"}, clear=False):
            with patch.object(orchestrator.DaytonaOpenAIReproRunner, "run", return_value=dict(receipt)):
                return orchestrator.analyze_fixture(fixture_id)

    def test_clean_fixture_remains_ready_for_human_review(self) -> None:
        board = self.analyze_fixture_with_receipt("clean", PASSED_RECEIPT)

        self.assertEqual(board["final_packet"]["triage_recommendation"], "Ready for human review")
        self.assertEqual(board["repro_checks"][0]["status"], "passed")

    def test_suspicious_fixture_remains_possible_integrity_issue(self) -> None:
        board = self.analyze_fixture_with_receipt("suspicious", FAILED_RECEIPT)

        self.assertEqual(board["final_packet"]["triage_recommendation"], "Possible integrity issue")
        self.assertTrue(any(c["category"] == "integrity" and c["severity"] == "high" for c in board["concerns"]))

    def test_repro_concern_links_to_metric_claim(self) -> None:
        board = self.analyze_fixture_with_receipt("suspicious", FAILED_RECEIPT)
        repro_concern = next(c for c in board["concerns"] if c["category"] == "reproducibility")

        linked_claim_ids = [claim["id"] for claim in board["claims"] if repro_concern["id"] in claim["concern_ids"]]

        self.assertIn("claim_002", linked_claim_ids)
        # claim_004 also matches metric keywords after keyword expansion
        self.assertIn("claim_004", linked_claim_ids)

    def test_workflow_high_concern_prevents_ready_recommendation(self) -> None:
        board = {
            "concerns": [{"severity": "high", "category": "workflow"}],
            "repro_checks": [{"status": "passed"}],
        }

        self.assertEqual(orchestrator._triage_recommendation(board), "Needs author clarification before review")

    def test_causal_condition_still_flags_observational_causal_language(self) -> None:
        text = """# Causal Test Paper

## Abstract
This observational benchmark claims causal improvement in outcomes.

## Main Claims
- The method makes causal improvement claims from observational data.

## Methods
The study uses a train/validation/test split and a baseline model.

## Results
The paper reports macro F1 of 0.87.
"""
        with patch.dict(os.environ, {"REFEREEOS_ENABLE_AG2_LLM": "false"}, clear=False):
            with patch.object(orchestrator.DaytonaOpenAIReproRunner, "run", return_value=dict(PASSED_RECEIPT)):
                board = orchestrator.analyze_text(text, source="unit", fixture_meta={"fixture_id": "unit"})

        self.assertTrue(any("Causal language is unsupported" in c["text"] for c in board["concerns"]))

    def test_ag2_fallback_still_produces_packet_without_keys(self) -> None:
        env = {
            "REFEREEOS_ENABLE_AG2_LLM": "true",
            "DEEPSEEK_API_KEY": "",
            "KIMI_API_KEY": "",
            "ZHIPU_API_KEY": "",
        }
        with patch.dict(os.environ, env, clear=False):
            with patch.object(orchestrator.DaytonaOpenAIReproRunner, "run", return_value=dict(PASSED_RECEIPT)):
                board = orchestrator.analyze_fixture("clean")

        self.assertIn(board["metadata"]["ag2_status"], {"missing_key", "unavailable"})
        self.assertTrue(board["final_packet"]["markdown"])


if __name__ == "__main__":
    unittest.main()
