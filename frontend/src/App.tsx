import { AlertTriangle, BrainCircuit, FlaskConical, Play, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import AgentTrace from "./components/AgentTrace";
import EvidenceBoard from "./components/EvidenceBoard";
import ReviewerPacket from "./components/ReviewerPacket";
import UploadPanel from "./components/UploadPanel";
import type { AgentTraceItem, Fixture, RunResult } from "./types";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export default function App() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixtureId, setFixtureId] = useState("clean");
  const [fieldDomain, setFieldDomain] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [artifactFile, setArtifactFile] = useState<File | null>(null);
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [reportedResult, setReportedResult] = useState("");
  const [run, setRun] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveTrace, setLiveTrace] = useState<AgentTraceItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/fixtures`)
      .then((response) => response.json())
      .then((payload) => setFixtures(payload.fixtures ?? []))
      .catch(() => {
        setFixtures([
          { id: "clean", label: "Clean computational paper", reported_result: 0.87 },
          { id: "suspicious", label: "Suspicious/adversarial paper", reported_result: 0.91 },
        ]);
      });
  }, []);

  const board = run?.board;
  const repro = board?.repro_checks[0];
  const headline = board?.final_packet.triage_recommendation ?? "No run yet";
  const highRiskCount = useMemo(
    () => board?.concerns.filter((concern) => concern.severity === "high").length ?? 0,
    [board],
  );

  const displayTrace = isStreaming && liveTrace.length > 0 ? liveTrace : (board?.agent_trace ?? []);

  async function analyze() {
    setLoading(true);
    setError(null);
    setIsStreaming(true);
    setLiveTrace([]);

    const form = new FormData();
    form.set("fixture_id", fixtureId);
    if (fieldDomain) form.set("field_domain", fieldDomain);
    if (file) form.set("file", file);
    if (artifactFile) form.set("artifact_file", artifactFile);
    if (scriptFile) form.set("script_file", scriptFile);
    if (reportedResult) form.set("reported_result", reportedResult);

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${API_BASE}/api/analyze-stream`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        // Fall back to non-streaming endpoint
        throw new Error("SSE not available, falling back");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body reader");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          try {
            const event = JSON.parse(raw);
            if (event.type === "step") {
              setLiveTrace((prev) => {
                const existing = prev.findIndex(
                  (item) => item.agent === event.agent,
                );
                const step: AgentTraceItem = {
                  agent: event.agent,
                  label: event.label,
                  status: event.status,
                  error: event.error,
                  started_at: event.started_at,
                  completed_at: event.completed_at,
                };
                if (existing === -1) return [...prev, step];
                const next = [...prev];
                next[existing] = step;
                return next;
              });
            } else if (event.type === "result") {
              setRun(event.run);
            } else if (event.type === "error") {
              setError(event.message);
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } catch (exc: unknown) {
      if (exc instanceof DOMException && exc.name === "AbortError") {
        return;
      }
      // Fallback to non-streaming endpoint
      try {
        const fallback = new AbortController();
        const response = await fetch(`${API_BASE}/api/analyze`, {
          method: "POST",
          body: form,
          signal: fallback.signal,
        });
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json();
        setRun(result);
      } catch (fallbackErr) {
        setError(
          fallbackErr instanceof Error
            ? fallbackErr.message
            : "Analysis failed",
        );
      }
    } finally {
      setLoading(false);
      setIsStreaming(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="masthead">
          <img className="wordmark" src="/wordmark.svg" alt="RefereeOS" />
          <p className="eyebrow">AG2 Beta · Daytona · DeepSeek + Kimi + Zhipu Harness Engineering</p>
        </div>
        <div className="sponsor-strip" aria-label="Sponsor integration status">
          <span title="AG2 synthesizes the area-chair packet when enabled">
            <BrainCircuit size={16} /> AG2
          </span>
          <span title="Daytona runs the reproducibility sandbox">
            <FlaskConical size={16} /> Daytona
          </span>
          <span title="DeepSeek v4-flash: Lead agent for 3-round synthesis">
            <ShieldCheck size={16} /> DeepSeek
          </span>
          <span title="Kimi k2.6: cross-model Critic for adversarial review">
            <ShieldCheck size={16} /> Kimi
          </span>
          <span title="Zhipu glm-4-flash: final Scorer for 0-10 verdict">
            <ShieldCheck size={16} /> Zhipu
          </span>
        </div>
      </header>

      <section className="command-band">
        <UploadPanel
          fixtures={fixtures}
          fixtureId={fixtureId}
          fieldDomain={fieldDomain}
          file={file}
          artifactFile={artifactFile}
          scriptFile={scriptFile}
          reportedResult={reportedResult}
          loading={loading}
          onFixtureChange={setFixtureId}
          onFieldDomainChange={setFieldDomain}
          onFileChange={setFile}
          onArtifactFileChange={setArtifactFile}
          onScriptFileChange={setScriptFile}
          onReportedResultChange={setReportedResult}
          onAnalyze={analyze}
        />
        <div className="run-summary">
          <div>
            <p className="label">Run</p>
            <strong data-mono>{run?.run_id ?? "standby"}</strong>
          </div>
          <div>
            <p className="label">Triage</p>
            <strong>{headline}</strong>
          </div>
          <div>
            <p className="label">High Risks</p>
            <strong>{highRiskCount}</strong>
          </div>
          <div>
            <p className="label">Repro</p>
            <strong className={`status-text ${repro?.status ?? "not_run"}`}>{repro?.status ?? "not run"}</strong>
          </div>
          <button className="primary-action" onClick={analyze} disabled={loading}>
            <Play size={17} />
            {loading ? "Running" : "Run Review"}
          </button>
        </div>
      </section>

      {error && (
        <div className="error-banner">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      <section className="workspace-grid">
        <AgentTrace trace={displayTrace} live={isStreaming} />
        <EvidenceBoard board={board} />
        <ReviewerPacket markdown={run?.packet ?? ""} runId={run?.run_id} />
      </section>
    </main>
  );
}
