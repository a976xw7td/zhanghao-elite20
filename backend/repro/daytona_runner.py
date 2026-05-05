from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

logger = logging.getLogger("refereeos.repro")


try:
    from dotenv import load_dotenv

    load_dotenv(".env")
    load_dotenv(".env.local", override=True)
    load_dotenv(".local.env", override=True)
except Exception:
    pass


def _resolve_default_model() -> str:
    if os.getenv("REFEREEOS_ENABLE_AG2_LLM", "false").lower() == "true":
        return os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    return os.getenv("OPENAI_MODEL", "gpt-4o")


DEFAULT_OPENAI_MODEL = _resolve_default_model()
_repro_probe_label = "Reproducibility agent: select and run metric recalculation probe"

_DANGEROUS_SCRIPT_PATTERN = re.compile(
    r"\b(?:import|from)\s+(?:os|subprocess|shutil|socket|ctypes|eval|exec|__import__|compile|pty|posix|commands|pickle|base64)\b"
)


class DaytonaOpenAIReproRunner:
    """Run the reproducibility probe in Daytona with OpenAI as the sandbox agent."""

    def __init__(self) -> None:
        self.openai_model = DEFAULT_OPENAI_MODEL
        self.allow_local_fallback = os.getenv("REFEREEOS_ALLOW_LOCAL_REPRO_FALLBACK", "true").lower() == "true"

    def run(self, fixture_meta: dict[str, Any], paper: dict[str, Any]) -> dict[str, Any]:
        payload = self._build_payload(fixture_meta, paper)

        try:
            return self._run_in_daytona(payload)
        except Exception as exc:
            if payload.get("custom_artifact") or not self.allow_local_fallback:
                return self._inconclusive_receipt(payload, f"Daytona run failed and fallback is disabled: {exc}", provider="Daytona (unavailable)")
            return self._run_local_fallback(payload, str(exc))

    def _build_payload(self, fixture_meta: dict[str, Any], paper: dict[str, Any]) -> dict[str, Any]:
        results_text = fixture_meta.get("results_csv_text")
        script_text = fixture_meta.get("metric_script_text")
        if results_text is None:
            results_path = Path(fixture_meta["results_path"])
            results_text = results_path.read_text(encoding="utf-8") if results_path.exists() else ""
        if script_text is None:
            script_path = Path(__file__).resolve().parents[1] / "fixtures" / "reproduce_metric.py"
            script_text = script_path.read_text(encoding="utf-8")

        return {
            "fixture_id": fixture_meta.get("fixture_id", "uploaded"),
            "paper_title": paper.get("title"),
            "paper_summary": paper.get("abstract"),
            "reported_result": fixture_meta.get("reported_result"),
            "results_csv": results_text,
            "metric_script": script_text,
            "custom_artifact": bool(fixture_meta.get("custom_artifact")),
            "llm_provider": "OpenAI",
            "llm_model": self.openai_model,
            "openai_api_key": _openai_key_for_daytona(),
        }

    def _run_in_daytona(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not os.getenv("DAYTONA_API_KEY"):
            raise RuntimeError("DAYTONA_API_KEY is not set")

        try:
            from daytona import Daytona
        except Exception as exc:  # pragma: no cover - depends on sponsor SDK runtime
            raise RuntimeError("Daytona SDK is not installed") from exc

        daytona = Daytona()
        sandbox = daytona.create()
        try:
            code = _sandbox_code(payload)
            response = sandbox.process.code_run(code)
            exit_code = getattr(response, "exit_code", 0)
            result_text = getattr(response, "result", str(response))
            receipt = _parse_receipt(result_text)
            if not receipt:
                receipt = self._inconclusive_receipt(payload, "Daytona sandbox did not return receipt JSON.")
                receipt["stdout_stderr_summary"] = result_text[-1400:]
            receipt["exit_code"] = exit_code
            receipt["sandbox_provider"] = "Daytona"
            receipt["model"] = payload["llm_model"]
            return receipt
        finally:
            try:
                daytona.delete(sandbox)
            except Exception:
                pass

    def _run_local_fallback(self, payload: dict[str, Any], reason: str) -> dict[str, Any]:
        logger.warning("Using local fallback for reproducibility: %s", reason)

        script_text = payload["metric_script"]
        if _DANGEROUS_SCRIPT_PATTERN.search(script_text):
            return self._inconclusive_receipt(payload, "Script contains dangerous imports; blocked by security policy.")

        temp_dir = Path("outputs") / "local_repro"
        temp_dir.mkdir(parents=True, exist_ok=True)
        results_path = temp_dir / f"{payload['fixture_id']}_results.csv"
        script_path = temp_dir / "reproduce_metric.py"
        results_path.write_text(payload["results_csv"], encoding="utf-8")
        script_path.write_text(script_text, encoding="utf-8")

        completed = subprocess.run(
            [sys.executable, str(script_path), str(results_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        observed = _extract_metric(completed.stdout)
        reported = float(payload.get("reported_result") or 0)
        status = _status(reported, observed)
        followup = (
            "Ask authors to explain the metric mismatch before review."
            if status == "failed"
            else "Human reviewer should still inspect artifact scope and dataset representativeness."
        )

        return {
            "probe": _repro_probe_label,
            "sandbox_provider": "local fallback (Daytona unavailable)",
            "model": payload["llm_model"],
            "status": status,
            "commands_run": [f"{sys.executable} reproduce_metric.py {results_path.name}"],
            "reported_result": f"{reported:.2f}",
            "observed_result": f"{observed:.2f}" if observed is not None else "unavailable",
            "artifact_paths": [str(results_path), str(script_path)],
            "stdout_stderr_summary": (completed.stdout + completed.stderr).strip(),
            "human_followup": followup,
            "llm_interpretation": (
                "Development fallback used because Daytona/OpenAI was not reachable locally. "
                f"Fallback reason: {reason}"
            ),
            "exit_code": completed.returncode,
        }

    def _inconclusive_receipt(self, payload: dict[str, Any], reason: str, *, provider: str = "Daytona") -> dict[str, Any]:
        return {
            "probe": _repro_probe_label,
            "sandbox_provider": provider,
            "model": payload["llm_model"],
            "status": "inconclusive",
            "commands_run": [],
            "reported_result": str(payload.get("reported_result")),
            "observed_result": "unavailable",
            "artifact_paths": [],
            "stdout_stderr_summary": reason,
            "human_followup": "Retry the Daytona sandbox run and ask authors for executable artifacts if it fails again.",
            "llm_interpretation": reason,
            "exit_code": 1,
        }


def _sandbox_code(payload: dict[str, Any]) -> str:
    encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return textwrap.dedent(
        f"""
        import base64
        import json
        import os
        import re
        import subprocess
        import sys
        import urllib.error
        import urllib.request
        from pathlib import Path

        payload = json.loads(base64.b64decode("{encoded}").decode("utf-8"))
        Path("results.csv").write_text(payload["results_csv"], encoding="utf-8")
        Path("reproduce_metric.py").write_text(payload["metric_script"], encoding="utf-8")

        completed = subprocess.run(
            [sys.executable, "reproduce_metric.py", "results.csv"],
            capture_output=True,
            text=True,
            check=False,
        )

        metric_match = re.search(r"(?:macro_f1|metric|observed_result)\\s*=\\s*([0-9.]+)", completed.stdout, flags=re.I)
        observed = float(metric_match.group(1)) if metric_match else None
        reported = float(payload.get("reported_result") or 0)
        if observed is None:
            status = "inconclusive"
        elif abs(observed - reported) <= 0.01:
            status = "passed"
        else:
            status = "failed"

        prompt = f'''
        You are OpenAI GPT-5.5 running inside a Daytona sandbox as the full reproducibility agent for RefereeOS.
        Paper: {{payload["paper_title"]}}
        Reported macro F1: {{reported:.2f}}
        Observed macro F1 from artifact rerun: {{observed if observed is not None else "unavailable"}}
        Process exit code: {{completed.returncode}}
        Stdout: {{completed.stdout}}
        Stderr: {{completed.stderr}}

        Return a terse JSON object with keys interpretation and human_followup.
        Do not recommend accept or reject publication.
        '''

        def ask_openai() -> dict:
            api_key = os.getenv("OPENAI_API_KEY") or payload.get("openai_api_key")
            model = os.getenv("OPENAI_MODEL", payload.get("llm_model", "gpt-4o"))
            if not api_key:
                return {{
                    "interpretation": "OpenAI credentials were not visible in the sandbox, so the sandbox used deterministic interpretation after running the artifact.",
                    "human_followup": "Confirm OPENAI_API_KEY is configured for the Daytona reproducibility agent."
                }}

            def parse_text(text: str) -> dict:
                try:
                    return json.loads(text)
                except Exception:
                    start = text.find("{{")
                    end = text.rfind("}}")
                    if start >= 0 and end > start:
                        return json.loads(text[start : end + 1])
                    return {{
                        "interpretation": text[:700],
                        "human_followup": "Human reviewer should inspect the artifact receipt."
                    }}

            def call(body: dict) -> dict:
                request = urllib.request.Request(
                    "https://api.openai.com/v1/responses",
                    data=json.dumps(body).encode("utf-8"),
                    headers={{"Content-Type": "application/json", "Authorization": f"Bearer {{api_key}}"}},
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(request, timeout=35) as response:
                        response_json = json.loads(response.read().decode("utf-8"))
                except urllib.error.HTTPError as exc:
                    detail = exc.read().decode("utf-8", errors="replace")[:900]
                    raise RuntimeError(f"HTTP {{exc.code}}: {{detail}}") from exc

                text = response_json.get("output_text")
                if not text:
                    chunks = []
                    for item in response_json.get("output", []):
                        for content in item.get("content", []):
                            if "text" in content:
                                chunks.append(content["text"])
                    text = "\\n".join(chunks)
                return parse_text(text)

            response_schema = {{
                "type": "object",
                "properties": {{
                    "interpretation": {{
                        "type": "string",
                        "description": "Terse interpretation of the reproducibility receipt.",
                    }},
                    "human_followup": {{
                        "type": "string",
                        "description": "One concrete reviewer follow-up, without accept/reject language.",
                    }},
                }},
                "required": ["interpretation", "human_followup"],
                "additionalProperties": False,
            }}

            bodies = [
                {{
                    "model": model,
                    "input": prompt,
                    "text": {{
                        "format": {{
                            "type": "json_schema",
                            "name": "repro_interpretation",
                            "strict": True,
                            "schema": response_schema,
                        }}
                    }},
                }},
                {{
                    "model": model,
                    "input": prompt,
                    "text": {{"format": {{"type": "json_object"}}}}
                }},
                {{
                    "model": model,
                    "input": prompt
                }},
            ]
            last_error = None
            for body in bodies:
                try:
                    return call(body)
                except Exception as exc:
                    last_error = str(exc)

            return {{
                "interpretation": f"OpenAI API call failed inside Daytona after artifact execution: {{last_error}}",
                "human_followup": "Inspect OpenAI API key, model name, and Responses API access, then rerun the Daytona reproducibility agent."
            }}

        llm = ask_openai()
        if status == "failed":
            default_followup = "Ask authors to explain the metric mismatch before review."
        elif status == "passed":
            default_followup = "Human reviewer should inspect artifact scope, but the metric receipt matches."
        else:
            default_followup = "Ask authors for a runnable artifact or clearer metric definition."

        receipt = {{
            "probe": "{_repro_probe_label}",
            "sandbox_provider": "Daytona",
            "model": payload.get("llm_model", "{DEFAULT_OPENAI_MODEL}"),
            "status": status,
            "commands_run": [f"{{sys.executable}} reproduce_metric.py results.csv"],
            "reported_result": f"{{reported:.2f}}",
            "observed_result": f"{{observed:.2f}}" if observed is not None else "unavailable",
            "artifact_paths": ["results.csv", "reproduce_metric.py"],
            "stdout_stderr_summary": (completed.stdout + completed.stderr).strip(),
            "human_followup": llm.get("human_followup") or default_followup,
            "llm_interpretation": llm.get("interpretation") or "OpenAI completed the reproducibility interpretation.",
            "exit_code": completed.returncode,
        }}
        print(json.dumps(receipt))
        """
    )


def _openai_key_for_daytona() -> str:
    pass_key = os.getenv("REFEREEOS_PASS_OPENAI_KEY_TO_DAYTONA", "false").lower() == "true"
    if not pass_key:
        return ""
    return os.getenv("OPENAI_API_KEY") or ""


def _parse_receipt(result_text: str) -> dict[str, Any] | None:
    for line in reversed(result_text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def _extract_metric(stdout: str) -> float | None:
    match = re.search(r"macro_f1=([0-9.]+)", stdout)
    return float(match.group(1)) if match else None


def _status(reported: float, observed: float | None) -> str:
    if observed is None:
        return "inconclusive"
    return "passed" if abs(observed - reported) <= 0.01 else "failed"
