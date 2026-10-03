# Default agents

Five bundled roles. `modelSuggestions` are advisory display aliases for evaluation, not runtime pins and not a ranking. Research cutoff for the notes below is **2026-10-03**. Guidance dated **2026-10-02** is historical and is not restated here as a current result. Current shortlist and benchmark, Arena, and serving-speed evidence: [default-agent model research](research-default-agent-models.md). Earlier source packets: [coding roles](research-model-roles-coding.md) and [writing and evidence research](research-model-roles-writing.md). The current shortlist supersedes their initial model suggestions.

Public names do not guarantee access in a particular account, region, Pi adapter, or harness. Confirm a live identity before adding `models`. These aliases do not select a model and do not bypass scoped runtime preferences.

## Five roles

| Agent       | Thinking | Route here for                                                              | Do not use it for                                            |
| ----------- | -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `architect` | `high`   | Requirements, tradeoffs, plans, and evidence research when retrieval exists | Implementing the plan, or treating memory as a source        |
| `coder`     | `high`   | Iterative implementation, debugging, refactoring, and frontend UI           | Review of its own patch, or visual QA it did not render      |
| `reviewer`  | `high`   | Independent, non-mutating, evidence-based defects and a minimal local fix   | Applying the fix, style quotas, or speculative redesign      |
| `tasker`    | `low`    | A bounded job, or a targeted repository lookup with path-and-line coverage  | Ambiguous features, audits, or complex code understanding    |
| `writer`    | `medium` | Creative drafts and voice-preserving editorial work                         | Live research, or invented facts, citations, or testimonials |

Use uncertainty and dependencies, not a fixed duration, to separate tasker from coder. A narrow lookup stays with tasker. Complex code understanding goes to architect or coder. Writer stays separate from evidence gathering so prose preference does not choose sources.

Thinking labels are workload defaults. The SDK maps each label onto the selected model's supported levels. That mapping is not a universal token budget. As recorded in the coding research, GPT-6.1 Sol's reference supports low through max, not none or minimal. Do not treat `off` as available on every model.

## Six capabilities, five defaults

The request named six capabilities and five roles. They ship as five defaults, not one role per capability:

| Capability                               | Shipped role                           |
| ---------------------------------------- | -------------------------------------- |
| Architecture and planning                | `architect`                            |
| Evidence research                        | `architect`, not a separate researcher |
| Independent review                       | `reviewer`                             |
| Implementation                           | `coder`                                |
| Frontend and UI implementation           | `coder`, not a separate designer       |
| Cheap bounded work and repository lookup | `tasker`                               |

`writer` is the fifth role. It covers creative and editorial prose and does not absorb research. Keeping writing separate avoids optimizing evidence collection for a compelling narrative.

Removed bundled files, with no runtime alias and no automatic migration:

| Removed file    | Send that work to                                                    |
| --------------- | -------------------------------------------------------------------- |
| `researcher.md` | `architect`, subject to the retrieval gate below                     |
| `designer.md`   | `coder`, subject to the rendered and accessibility gate below        |
| `explorer.md`   | `tasker` when the question is targeted; otherwise architect or coder |

A custom user or project definition may still use the names `researcher`, `designer`, or `explorer`. Same-name definitions override bundled ones. Retained threads keep the definition saved on the thread. Nothing is renamed.

The older bundled `worker` stays removed: tasker for bounded jobs, coder for sustained implementation. Quantitative or other specializations remain custom definitions, not extra bundled roles.

## Tool and capability boundaries

Every default has an explicit allowlist. Only architect has delegation tools. A planning or research request does not authorize implementation. Architect has no edit or write tools. Reviewer has no edit or write tools. Writer has no shell. Coder and tasker can edit and run checks. Tasker's lookup path is still non-mutating: a read-only question does not authorize an edit.

These boundaries are prompt contracts plus tool filtering, **not an OS sandbox**. Bash and delegated children can change the shared working tree. Agents must preserve unrelated work.

Children do not inherit the parent's extensions, MCP servers, skills, browser, or web tools.

Exa provider discovery and full-page fetch can be available in a session that has those provider tools. The 2026-10-03 research used that route. Named Exa MCP tools are not callable by a bundled child, and they are not in architect's allowlist. Do not document or instruct the child to call `mcp__exa__web_search_exa` or `mcp__exa__web_fetch_exa`. Architect uses supplied or local evidence, including a parent research packet, or a genuinely available authorized shell retrieval workflow. An Exa CLI or API counts only when it is actually configured and the task authorizes network access. Otherwise architect pauses. Model memory is not live evidence. Delegation does not give children tools the parent happened to have.

Coder may implement frontend UI in the project's existing system, including focus, state coverage, and narrow-width hierarchy. A screenshot, browser check, or accessibility pass counts only if tooling in that session rendered the UI and the agent inspected the result. A CSS reading is not visual verification. If no browser tooling is available, the layout stays visually unverified.

Reviewer reports demonstrable defects and asks for the smallest local repair or removal. It does not propose a speculative abstraction when a local change or deletion would fix the defect, and it does not apply the fix.

## Advisory aliases and runtime models

Bundled definitions omit `models` and `model`. They inherit the effective parent or default model. An explicit `models` list is ordered exact `provider/model-id` matching. With scoped filtering on, a miss fails spawn. It does not fall back to a suggestion, the parent, or a cheaper model. `modelSuggestions` never participate in that match and never bypass scoped runtime preferences.

Same-name user definitions override bundled ones. Trusted project definitions override user ones. An override keeps the suggestions it declares; it still does not select a model unless it also sets `models` or `model`.

The lists below are the researched advisory shortlist from the 13 requested candidates. They are provisional display names for humans and editors, not verified role-specific winners, availability guarantees, or runtime pins.

| Role        | Advisory display aliases                                              |
| ----------- | --------------------------------------------------------------------- |
| `architect` | `opus-5.5`, `gpt-6-astra`, `fable-5.1`, `kimi-k3`                     |
| `coder`     | `sonnet-5.5`, `gpt-6.1-sol`, `muse-spark-1.3`, `mimo-v2.6-pro`        |
| `reviewer`  | `gpt-6.1-sol`, `gpt-6-astra`, `opus-5.5`, `glm-5.3`                   |
| `tasker`    | `gemini-3.8-flash`, `sonnet-5.5`, `deepseek-v4.1-flash`, `gpt-6-luna` |
| `writer`    | `opus-5.5`, `gemini-3.8-flash`, `fable-5.1`                           |

Why these candidates, without treating them as configuration:

- Architect favors sustained reasoning and planning quality over streaming speed. Opus/Astra are quality-first choices; Fable and Kimi are deliberate alternatives with integration caveats.
- Coder balances repository/terminal evidence, frontend preferences, and iteration speed. Sonnet/Sol are strong starting points; Muse offers high throughput, and MiMo is a quality-first alternate with slower first-party serving.
- Reviewer now includes Claude and GLM alongside GPT, expanding the earlier GPT-only preference for this cross-family request. No matched reviewer-precision or false-positive benchmark establishes a winner. The smallest-local-repair and non-mutating contracts remain unchanged.
- Tasker favors full few-call latency, not just decoder tok/sec. Sonnet has direct low-effort quality and first-answer measurements; Gemini has low-effort support and fast high-mode serving. DeepSeek's provider route matters, and Luna belongs on mechanical jobs with acceptance checks. Exact low-mode speeds remain unverified for Gemini/DeepSeek.
- Writer favors creative-writing preferences among the requested candidates. Opus, Gemini Flash, and Fable have stronger collected writing evidence than Muse or Astra, but tested Arena efforts differ from the shipped medium setting. Preference does not prove voice preservation or citation fidelity.

Alias and compatibility notes:

- Claude display aliases resolve to official IDs `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-fable-5-1`. The new research verifies Fable 5.1's exact route; earlier uncertainty about Fable availability is superseded.
- The three GPT aliases match their official references; GPT-6.1 Sol is distinct from GPT-6 Sol. Keep the API compatibility checks below.
- `gemini-3.8-flash` is a verified stable API ID, with low/medium/high thinking support. It replaces Argon here because Argon is outside this request's candidate list.
- `deepseek-v4.1-flash` is the requested advisory alias, replacing the earlier `deepseek-4.1-flash` spelling. DeepSeek's direct API calls this version `deepseek-flash`; the advisory string is not a guessed runtime ID.
- Standard `muse-spark-1.3` differs from `muse-spark-1.3-contributor` in data-use terms. Do not silently substitute Contributor for confidential code.
- GLM/Kimi document low/high/max; MiMo's low/medium/high enum was not verified. Validate adapter mappings before pinning. Kimi also requires correct historical-thinking replay and cautions about excessive proactiveness.
- Grok 4.7 was researched, not silently omitted. Its benchmark/preference/latency balance did not displace a finalist; it remains a credible alternate rather than a demonstrated failure.

The [full research note](research-default-agent-models.md) records all 13 models, measured effort, provider-specific tok/sec, Arena scores and dates, contradictory samples, benchmark harnesses, and unmeasured role outcomes.

## Earlier research context (2026-10-03)

This is a short index of the two earlier research reports, not a new benchmark run. Their initial shortlist is superseded by the current research linked above. Live pages can change. Release dates below are dates those reports recorded from sources, not independently redeployed timestamps. Do not merge vendor scores, secondary leaderboards, and human-preference Elo into one ranking.

**Official identity pages.** Claude Opus 5.5 and Sonnet 5.5: [Opus docs](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet docs](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Sonnet launch](https://www.anthropic.com/claude-sonnet-5-5). OpenAI references: [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna). Muse Spark 1.3: [Meta models](https://dev.meta.ai/docs/models), [product page](https://developer.meta.com/ai/models/muse-spark/). DeepSeek-V4.1-Flash: [Sep 10, 2026 release](https://api-docs.deepseek.com/news/news260910). Gemini 4 Argon: [announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/). Argon access is phased and restricted; the name is not an API pin.

**Terminal-Bench and DeepSWE do not transfer across harnesses.** Anthropic's Sep 28, 2026 Sonnet launch reports Terminal-Bench 4.0 results under that table's settings, including Sonnet 5.5 at 70.6% and Opus 5.5 at 66.4% subject to the launch footnote. DeepSeek's model card reports different Terminal-Bench versions on its own harness: 90.6 on 2.1, 30.0 on 3.0, and 31.2 on 4.0. Those figures are not one test and must not be compared as if they were. The same card reports DeepSWE v1.1 at 74.2 with mini-SWE at maximum reasoning effort, versus 66.2 in Pi, 65.6 in Codex, and 69.8 in Claude Code. Harness and effort dominate narrow gaps. Strong max-effort scores do not establish cheap low-effort tasker behavior. Secondary DeepSWE rows are not a verified common-harness ranking. No version-matched SWE-bench set for this shortlist was established. Boards: [Terminal-Bench](https://www.tbench.ai/leaderboard), [DeepSWE](https://deepswe.datacurve.ai/), [DeepSeek card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash). Detail and dropped sources: [coding research](research-model-roles-coding.md).

**Human preference is not citation fidelity.** Arena's creative-writing index, freshest dated snapshot found **2026-10-02**, measures blind human preference. Indexed figures placed `gemini-4-argon-high` and `claude-opus-5.5-high` close together, with overlapping intervals. The original child obtained those numbers from a source-linked index; the parent subsequently confirmed the primary creative-writing table through Exa MCP fetch on 2026-10-03, and `high` is a tested configuration rather than proof of an API name. EQ-Bench's fetched JS snapshot is a different instrument: LLM-judged short-form Elo, another scale, and no verified evaluation date on the asset. It ranked GPT-6 Astra and Claude Fable 5.1 above Claude Opus 5.5. That earlier comparison did not by itself verify an available Fable route; the current shortlist research now verifies Fable 5.1's exact identity. Neither comparison measures source support. DeepResearch Bench separates report quality from citation accuracy; its historical agent-system results are not an October 2026 ranking of these aliases. BrowseComp is difficult web answering, not faithful report writing. No source established a universal writing-plus-citation winner. [Arena creative writing](https://arena.ai/leaderboard/text/creative-writing), [EQ-Bench](https://eqbench.com/creative_writing.html), [DeepResearch Bench](https://deepresearch-bench.github.io/). Detail: [writing and evidence research](research-model-roles-writing.md).

**Review.** No matched review-precision result supports a Sol or Astra win over other families. The earlier GPT-only list reflected a second-family preference, not a SOTA precision or conciseness claim. The current cross-family shortlist preserves the smallest-local-repair contract.

**API and pricing compatibility.** Sol tools require Responses API; Luna's Chat Completions function calling requires `reasoning_effort=none`. Check the actual harness before selecting either. OpenAI prices in the coding report are Standard short-context rates, with higher long-context rates; Luna applies its higher tier above 272K input tokens. Meta Contributor cannot use max reasoning. These constraints do not affect advisory metadata or automatically select a runtime. [Sol reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Luna reference](https://developers.openai.com/api/docs/models/gpt-6-luna), [pricing](https://developers.openai.com/api/docs/pricing), [Meta reasoning](https://ai.developer.meta.com/docs/reasoning/).

Evaluate a candidate on representative jobs before any runtime pin: accepted behavior and regressions for coder, actionable precision and false positives for reviewer, requirement coverage for architect, exact acceptance checks for tasker, and voice plus claim support for writer. Track effort, retries, tokens, and latency. A model saying a result looks correct is weaker evidence than an independent check.
