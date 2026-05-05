import { CheckCircle2, CircleDashed, Radio, XCircle } from "lucide-react";
import type { AgentTraceItem } from "../types";

type Props = {
  trace: AgentTraceItem[];
  live?: boolean;
};

export default function AgentTrace({ trace, live = false }: Props) {
  const items = trace.length && trace.some((t) => t.status !== "pending") ? trace : emptyTrace;
  return (
    <section className="panel trace-panel">
      <div className="panel-heading">
        <h2>Agent Trace</h2>
        {live && (
          <span className="live-indicator">
            <Radio size={12} /> Live
          </span>
        )}
      </div>
      <ol className="trace-list">
        {items.map((item) => (
          <li key={item.agent} className={item.status}>
            {item.status === "complete" && <CheckCircle2 size={17} />}
            {item.status === "error" && <XCircle size={17} />}
            {item.status !== "complete" && item.status !== "error" && <CircleDashed size={17} />}
            <div>
              <strong>{agentLabel(item.agent)}</strong>
              <span>{item.label}</span>
              {item.error && <em>{item.error}</em>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const emptyTrace: AgentTraceItem[] = [
  { agent: "intake_agent", label: "Extract paper profile and atomic claims", status: "pending" },
  { agent: "methods_statistics_agent", label: "Assess methodology and statistics risk", status: "pending" },
  { agent: "integrity_agent", label: "Scan manuscript for prompt-injection and suspicious instructions", status: "pending" },
  { agent: "novelty_literature_agent", label: "Attach lightweight related-work risks", status: "pending" },
  { agent: "reproducibility_agent", label: "Run Daytona sandbox reproducibility probe", status: "pending" },
  { agent: "area_chair_agent", label: "AG2 Beta 3-round review (DeepSeek Lead + Kimi Critic + Zhipu Scorer)", status: "pending" },
];

function agentLabel(agent: string) {
  return agent
    .replace("_agent", "")
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
