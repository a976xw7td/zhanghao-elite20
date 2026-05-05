# RefereeOS Demo Script

## 90 Seconds

Scientific review is bottlenecked, and AI-written manuscripts can make weak work look polished.

RefereeOS does not replace peer review. It prepares peer review — using **Harness Engineering**: building deterministic infrastructure around models instead of obsessing over prompts.

Start with the clean fixture. The AG2 workflow extracts claims, surfaces evidence, checks methods, runs an integrity scan, and sends the reproducibility probe into Daytona.

The Daytona sandbox runs the artifact. The evidence board captures reported result, observed result, status, and human follow-up.

Switch to the suspicious fixture. The evidence board now flags an embedded prompt-injection instruction and a metric mismatch.

Show the 3-round cross-model review: DeepSeek v4-flash (Lead) drafts the synthesis, Kimi kimi-k2.6 (Critic) provides adversarial review in rounds 1–2, and Zhipu glm-4-flash (Scorer) issues the final 0–10 verdict in round 3.

Alternate path: upload the manuscript, CSV artifact, metric script, and reported value directly.

Close: "Most AI review tools obsess over prompt engineering. RefereeOS builds the harness around the models. This routes scarce human expertise to the papers and claims that need attention most."

## Five Minutes

- 45s: Problem and ethical boundary. Harness Engineering vs prompt engineering.
- 45s: Architecture: AG2 agents, JSON evidence board, Daytona sandbox, three-model cross-model review (DeepSeek + Kimi + Zhipu).
- 2m: Live clean fixture and suspicious fixture. Show SSE streaming agent trace.
- 45s: Why AG2 (multi-agent orchestration) and Daytona (sandboxed reproducibility).
- 45s: Limitations and next steps. Human-in-the-loop by design.
