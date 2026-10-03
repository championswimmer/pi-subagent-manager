# Default agents

Five bundled roles. `modelSuggestions` are advisory display aliases for evaluation, not runtime pins and not a ranking. Research cutoff for the notes below is **2026-10-03**. Guidance dated **2026-10-02** is historical and is not restated here as a current result. Full sourced notes: [coding roles](research-model-roles-coding.md) and [writing and evidence research](research-model-roles-writing.md).

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

The lists below are the initial advisory aliases. They are provisional display names for humans and editors. They are not verified winners, not availability guarantees, and not pins.

| Role        | Advisory display aliases                      |
| ----------- | --------------------------------------------- |
| `architect` | `opus-5.5`, `gpt-6-astra`, `gpt-6.1-sol`      |
| `coder`     | `sonnet-5.5`, `gpt-6.1-sol`, `muse-spark-1.3` |
| `reviewer`  | `gpt-6.1-sol`, `gpt-6-astra`                  |
| `tasker`    | `gpt-6-luna`, `deepseek-4.1-flash`            |
| `writer`    | `opus-5.5`, `gemini-4-argon`, `gpt-6-astra`   |

How to read them, without treating them as configuration:

- `opus-5.5` and `sonnet-5.5` are display aliases for Claude Opus 5.5 and Claude Sonnet 5.5. Official docs, as recorded on 2026-10-03, use `claude-opus-5-5` and `claude-sonnet-5-5`.
- `gpt-6.1-sol`, `gpt-6-astra`, and `gpt-6-luna` match the official model-reference IDs recorded in that research. Sol's launch page was not directly readable then (HTTP 403); identity also rests on the model reference.
- `muse-spark-1.3` is the requested Muse Spark 1.3 candidate for coder. It is not a writing suggestion. The wording `must-spark` is not a verified product name. Standard and Contributor tiers differ in data-use terms and available reasoning effort: max is Standard-only. Do not silently pick Contributor for confidential work.
- `deepseek-4.1-flash` is a display alias only. The documented direct-provider ID is `deepseek-flash` (DeepSeek-V4.1-Flash). A guessed `deepseek-v4.1-flash` is not that ID. Legacy `deepseek-v4-flash` is an alias that routes to the current Flash model, not a second product.
- `gemini-4-argon` is an advisory display name for Gemini 4 Argon. The announcement describes phased, restricted access. Use it only if it is actually available. No API ID was verified for this alias. Guessed `gemini-3.8-pro` is not suggested.
- Fable names appear in writing benchmarks. A provider route was not verified, so Fable is not suggested.

Reviewer's list is GPT-only because that was the requested second-family preference, together with a minimal-solution review contract. It is not a claim that GPT models have the best review precision, and not a claim that GPT models always write less code. Conciseness is not a family invariant; control it in the review task.

Coder's Muse entry is a pilot candidate for implementation, not the writing research winner. Writer's list prefers Opus 5.5 as a generally documented model, Argon only when accessible, and Astra as another documented candidate. None of these lists is a universal winner.

## Evidence checked 2026-10-03

This is a short index of the two research reports, not a new benchmark run. Live pages can change. Release dates below are dates those reports recorded from sources, not independently redeployed timestamps. Do not merge vendor scores, secondary leaderboards, and human-preference Elo into one ranking.

**Official identity pages.** Claude Opus 5.5 and Sonnet 5.5: [Opus docs](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet docs](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Sonnet launch](https://www.anthropic.com/claude-sonnet-5-5). OpenAI references: [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna). Muse Spark 1.3: [Meta models](https://dev.meta.ai/docs/models), [product page](https://developer.meta.com/ai/models/muse-spark/). DeepSeek-V4.1-Flash: [Sep 10, 2026 release](https://api-docs.deepseek.com/news/news260910). Gemini 4 Argon: [announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/). Argon access is phased and restricted; the name is not an API pin.

**Terminal-Bench and DeepSWE do not transfer across harnesses.** Anthropic's Sep 28, 2026 Sonnet launch reports Terminal-Bench 4.0 results under that table's settings, including Sonnet 5.5 at 70.6% and Opus 5.5 at 66.4% subject to the launch footnote. DeepSeek's model card reports different Terminal-Bench versions on its own harness: 90.6 on 2.1, 30.0 on 3.0, and 31.2 on 4.0. Those figures are not one test and must not be compared as if they were. The same card reports DeepSWE v1.1 at 74.2 with mini-SWE at maximum reasoning effort, versus 66.2 in Pi, 65.6 in Codex, and 69.8 in Claude Code. Harness and effort dominate narrow gaps. Strong max-effort scores do not establish cheap low-effort tasker behavior. Secondary DeepSWE rows are not a verified common-harness ranking. No version-matched SWE-bench set for this shortlist was established. Boards: [Terminal-Bench](https://www.tbench.ai/leaderboard), [DeepSWE](https://deepswe.datacurve.ai/), [DeepSeek card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash). Detail and dropped sources: [coding research](research-model-roles-coding.md).

**Human preference is not citation fidelity.** Arena's creative-writing index, freshest dated snapshot found **2026-10-02**, measures blind human preference. Indexed figures placed `gemini-4-argon-high` and `claude-opus-5.5-high` close together, with overlapping intervals. The original child obtained those numbers from a source-linked index; the parent subsequently confirmed the primary creative-writing table through Exa MCP fetch on 2026-10-03, and `high` is a tested configuration rather than proof of an API name. EQ-Bench's fetched JS snapshot is a different instrument: LLM-judged short-form Elo, another scale, and no verified evaluation date on the asset. It ranked GPT-6 Astra and Claude Fable 5.1 above Claude Opus 5.5. That does not make Fable an available route, and it does not measure source support. DeepResearch Bench separates report quality from citation accuracy; its historical agent-system results are not an October 2026 ranking of these aliases. BrowseComp is difficult web answering, not faithful report writing. No source established a universal writing-plus-citation winner. [Arena creative writing](https://arena.ai/leaderboard/text/creative-writing), [EQ-Bench](https://eqbench.com/creative_writing.html), [DeepResearch Bench](https://deepresearch-bench.github.io/). Detail: [writing and evidence research](research-model-roles-writing.md).

**Review.** No matched review-precision result supports a Sol or Astra win over other families. The GPT-only suggestion list is a user preference for a second perspective, plus the smallest-local-repair contract above. It is not a SOTA precision or conciseness claim.

**API and pricing compatibility.** Sol tools require Responses API; Luna's Chat Completions function calling requires `reasoning_effort=none`. Check the actual harness before selecting either. OpenAI prices in the coding report are Standard short-context rates, with higher long-context rates; Luna applies its higher tier above 272K input tokens. Meta Contributor cannot use max reasoning. These constraints do not affect advisory metadata or automatically select a runtime. [Sol reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Luna reference](https://developers.openai.com/api/docs/models/gpt-6-luna), [pricing](https://developers.openai.com/api/docs/pricing), [Meta reasoning](https://ai.developer.meta.com/docs/reasoning/).

Evaluate a candidate on representative jobs before any runtime pin: accepted behavior and regressions for coder, actionable precision and false positives for reviewer, requirement coverage for architect, exact acceptance checks for tasker, and voice plus claim support for writer. Track effort, retries, tokens, and latency. A model saying a result looks correct is weaker evidence than an independent check.
