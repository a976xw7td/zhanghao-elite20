from __future__ import annotations

import logging
import os
import re
from typing import Annotated

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("refereeos.api")

try:
    from dotenv import load_dotenv

    load_dotenv(".env")
    load_dotenv(".env.local", override=True)
    load_dotenv(".local.env", override=True)
except Exception as exc:
    logger.warning("dotenv load skipped: %s", exc)

import asyncio
import json as json_module
import queue

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.agents.orchestrator import analyze_fixture, analyze_text
from backend.parsing.paper_parser import extract_pdf_text, list_fixtures, load_fixture_text
from backend.storage.evidence_board import run_store

app = FastAPI(
    title="RefereeOS API",
    description="AG2 + Daytona multi-agent preprint triage and reproducibility assistant.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_API_KEY = os.getenv("REFEREEOS_API_KEY", "")


def _require_auth(request: Request) -> None:
    if not _API_KEY:
        return
    auth = request.headers.get("Authorization", "")
    expected = f"Bearer {_API_KEY}"
    if auth != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


_DANGEROUS_IMPORTS = re.compile(
    r"\b(?:import|from)\s+(?:os|subprocess|shutil|socket|ctypes|eval|exec|__import__|compile|pty|posix|commands|pickle|base64)\b"
)


def _validate_script(script_text: str) -> None:
    if _DANGEROUS_IMPORTS.search(script_text):
        raise HTTPException(
            status_code=400,
            detail="Script contains potentially dangerous imports. Remove os, subprocess, sys, socket, etc.",
        )


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "RefereeOS"}


@app.get("/api/fixtures")
def fixtures(_auth: None = Depends(_require_auth)) -> dict:
    return {"fixtures": list_fixtures()}


@app.post("/api/analyze")
def analyze(
    fixture_id: Annotated[str, Form()] = "clean",
    field_domain: Annotated[str | None, Form()] = None,
    reported_result: Annotated[float | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
    artifact_file: Annotated[UploadFile | None, File()] = None,
    script_file: Annotated[UploadFile | None, File()] = None,
    _auth: None = Depends(_require_auth),
) -> dict:
    logger.info("analyze: fixture=%s domain=%s file=%s", fixture_id, field_domain, file.filename if file else "none")
    custom_artifact = _read_custom_artifact(artifact_file, script_file, reported_result)

    if file and file.filename:
        if file.content_type == "application/pdf" or file.filename.lower().endswith(".pdf"):
            text = extract_pdf_text(file.file)
        else:
            text = file.file.read().decode("utf-8", errors="ignore")
        _, fixture_meta = load_fixture_text("clean")
        fixture_meta["fixture_id"] = "uploaded"
        if custom_artifact:
            fixture_meta.update(custom_artifact)
        board = analyze_text(text, source=f"uploaded_file:{file.filename}", fixture_meta=fixture_meta, field_domain=field_domain)
    else:
        if custom_artifact:
            text, fixture_meta = load_fixture_text(fixture_id)
            fixture_meta.update(custom_artifact)
            board = analyze_text(
                text,
                source=f"sample_fixture:{fixture_meta['fixture_id']}:custom_repro_artifact",
                fixture_meta=fixture_meta,
                field_domain=field_domain,
            )
        else:
            board = analyze_fixture(fixture_id=fixture_id, field_domain=field_domain)

    run = run_store.create(board)
    logger.info("analyze complete: run_id=%s triage=%s", run["run_id"], board["final_packet"].get("triage_recommendation", "unknown"))
    return run


@app.post("/api/analyze-stream")
async def analyze_stream(
    fixture_id: Annotated[str, Form()] = "clean",
    field_domain: Annotated[str | None, Form()] = None,
    reported_result: Annotated[float | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
    artifact_file: Annotated[UploadFile | None, File()] = None,
    script_file: Annotated[UploadFile | None, File()] = None,
    _auth: None = Depends(_require_auth),
):
    """Stream analysis progress as SSE events."""
    logger.info(
        "analyze-stream: fixture=%s domain=%s file=%s",
        fixture_id, field_domain, file.filename if file else "none",
    )

    loop = asyncio.get_running_loop()
    event_queue: queue.Queue = queue.Queue()

    async def event_generator():
        # Use a sentinel to signal the analysis is done
        _SENTINEL = object()

        def _signal_done():
            event_queue.put_nowait(_SENTINEL)

        try:
            # --- Resolve input in the executor thread ---
            custom_artifact = _read_custom_artifact(artifact_file, script_file, reported_result)

            def _run_analysis() -> dict[str, Any]:
                try:
                    if file and file.filename:
                        if file.content_type == "application/pdf" or file.filename.lower().endswith(".pdf"):
                            text = extract_pdf_text(file.file)
                        else:
                            text = file.file.read().decode("utf-8", errors="ignore")
                        _, fixture_meta = load_fixture_text("clean")
                        fixture_meta["fixture_id"] = "uploaded"
                        if custom_artifact:
                            fixture_meta.update(custom_artifact)
                        board = analyze_text(
                            text,
                            source=f"uploaded_file:{file.filename}",
                            fixture_meta=fixture_meta,
                            field_domain=field_domain,
                            event_queue=event_queue,
                        )
                    else:
                        if custom_artifact:
                            text, fixture_meta = load_fixture_text(fixture_id)
                            fixture_meta.update(custom_artifact)
                            board = analyze_text(
                                text,
                                source=f"sample_fixture:{fixture_meta['fixture_id']}:custom_repro_artifact",
                                fixture_meta=fixture_meta,
                                field_domain=field_domain,
                                event_queue=event_queue,
                            )
                        else:
                            board = analyze_fixture(
                                fixture_id=fixture_id,
                                field_domain=field_domain,
                                event_queue=event_queue,
                            )
                    return board
                finally:
                    _signal_done()

            # Run analysis in thread pool; stream events as they arrive
            import concurrent.futures
            import time as _time

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = loop.run_in_executor(pool, _run_analysis)
                _last_heartbeat = _time.monotonic()
                _HEARTBEAT_INTERVAL = 15.0  # keep proxies/browsers from timing out

                while True:
                    try:
                        item = await loop.run_in_executor(None, event_queue.get, True, 0.5)
                    except queue.Empty:
                        # No event yet, check if analysis is done
                        if future.done():
                            # Drain any remaining events
                            while True:
                                try:
                                    item = event_queue.get_nowait()
                                except queue.Empty:
                                    break
                                if item is _SENTINEL:
                                    break
                                yield f"data: {item}\n\n"
                            break
                        # Send SSE comment as heartbeat to keep connection alive
                        if _time.monotonic() - _last_heartbeat >= _HEARTBEAT_INTERVAL:
                            yield ": heartbeat\n\n"
                            _last_heartbeat = _time.monotonic()
                        continue

                    if item is _SENTINEL:
                        break
                    yield f"data: {item}\n\n"
                    _last_heartbeat = _time.monotonic()

                board = future.result()

            run = run_store.create(board)
            logger.info(
                "analyze-stream complete: run_id=%s triage=%s",
                run["run_id"],
                board["final_packet"].get("triage_recommendation", "unknown"),
            )

            final_event = json_module.dumps({"type": "result", "run": run}, default=str)
            yield f"data: {final_event}\n\n"

        except Exception as exc:
            logger.exception("analyze-stream failed")
            error_event = json_module.dumps({"type": "error", "message": str(exc)})
            yield f"data: {error_event}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _read_custom_artifact(
    artifact_file: UploadFile | None,
    script_file: UploadFile | None,
    reported_result: float | None,
) -> dict | None:
    provided = [bool(artifact_file and artifact_file.filename), bool(script_file and script_file.filename), reported_result is not None]
    if not any(provided):
        return None
    if not all(provided):
        raise HTTPException(
            status_code=400,
            detail="Custom reproducibility needs a CSV artifact, Python script, and reported result.",
        )

    assert artifact_file is not None
    assert script_file is not None
    artifact_text = artifact_file.file.read().decode("utf-8", errors="ignore")
    script_text = script_file.file.read().decode("utf-8", errors="ignore")

    _validate_script(script_text)

    if "macro_f1" not in script_text and "metric" not in script_text and "observed_result" not in script_text:
        raise HTTPException(
            status_code=400,
            detail="Metric script should print macro_f1=<number>, metric=<number>, or observed_result=<number>.",
        )

    return {
        "fixture_id": "uploaded_custom",
        "reported_result": reported_result,
        "results_csv_text": artifact_text,
        "metric_script_text": script_text,
        "custom_artifact": True,
    }


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, _auth: None = Depends(_require_auth)) -> dict:
    run = run_store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/api/runs/{run_id}/evidence-board")
def get_evidence_board(run_id: str, _auth: None = Depends(_require_auth)) -> dict:
    run = run_store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run["board"]


@app.get("/api/runs/{run_id}/packet", response_class=PlainTextResponse)
def get_packet(run_id: str, _auth: None = Depends(_require_auth)) -> str:
    run = run_store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run["packet"]


@app.on_event("shutdown")
def _shutdown() -> None:
    logger.info("RefereeOS shutting down")
