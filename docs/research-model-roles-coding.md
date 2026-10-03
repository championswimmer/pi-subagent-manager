# Technical Research: Coding-agent model roles

## Summary

Research cutoff: **2026-10-03**. Recommend advisory defaults of **Opus 5.5 for architect**, **GPT-6.1 Sol for independent reviewer**, **Sonnet 5.5 for coder**, and **GPT-6 Luna for tasker**. The dedicated [writing research](research-model-roles-writing.md) supersedes this coding-focused report's economical documentation candidate: the final writer shortlist is Opus 5.5, access-conditional Gemini 4 Argon, and GPT-6 Astra. These are role-fit starting points, not a claim of a universal SOTA winner or runtime model pins; validate with repository-specific trials before changing execution configuration.

## Access and evidence provenance

Read the requested web-research skill. The parent reports `mcp__exa__web_search_exa` and `mcp__exa__web_fetch_exa` available through codemode. Neither codemode nor these MCP functions is exposed in this sub-agent's callable tool set. Discovery nevertheless **used `functions.web_search(provider="exa")`**, with responses explicitly reporting Exa; full-page reading used `functions.fetch_content`, not Exa MCP fetch. Do not describe this as direct use of the named MCP tools or as Exa search being unavailable. Context7/code-search tools are also not exposed; this is model selection, not library API research.

Sources below were consulted for this cutoff. Live pages may change and are not archived historical snapshots. Release dates are reported source dates, not independently established deployment times. OpenAI's Sol launch page returned HTTP 403 on direct fetch; its model reference was readable. Some fetches used page-local answer extraction; treat extracted benchmark tables as vendor evidence rather than independent reproduction.

## Recommendation matrix: advisory modelSuggestions

| Role                               | Suggested default              | Alternatives / escalation                                                                | Rationale and limits                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| architect (also evidence research) | Claude Opus 5.5                | GPT-6 Astra for expensive, high-stakes second opinions; GPT-6.1 Sol for cheaper planning | Anthropic positions Opus for complex, open-ended sustained judgment. Benchmark execution success is not an architecture-quality evaluation. Research needs browsing and citation verification regardless of model. |
| reviewer                           | **GPT-6.1 Sol**                | **GPT-6 Astra** for security-sensitive or unusually difficult reviews                    | GPT-only by explicit user preference; a different family from the default Claude coder provides a second perspective, not proven statistical independence. No verified review-precision win for these candidates.  |
| coder                              | Claude Sonnet 5.5              | GPT-6.1 Sol; pilot Muse Spark 1.3 and DeepSeek-V4.1-Flash; Opus for complex failures     | Strong recent Terminal-Bench 4.0 vendor result, lower token prices than Opus, and faster positioning. DeepSWE alone does not establish Sonnet as the best implementer.                                             |
| tasker                             | GPT-6 Luna                     | DeepSeek-V4.1-Flash; Sonnet for failed/ambiguous tasks                                   | Low published token cost suits bounded extraction, formatting, test invocation, and mechanical changes. Constrain scope and require machine-checkable acceptance.                                                  |
| writer                             | See dedicated writing research | Final shortlist: Opus 5.5; Gemini 4 Argon only if accessible; GPT-6 Astra                | Creative/editorial writing is a different workload from economical documentation. This coding report does not establish writing quality. See [final bundled suggestions](default-agents.md).                       |

These suggestions should remain descriptive/advisory metadata. Do not silently change provider IDs, harnesses, reasoning effort, or runtime routing. A GPT coder should still receive a separate reviewer session with independent context and explicit review criteria.

## Verified names versus user aliases

| User wording         | Verified public identity / documented ID                      | Availability evidence                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sonnet-5.5`         | Claude Sonnet 5.5 / `claude-sonnet-5-5`                       | Official docs list active, released Sep 28, 2026; availability across major Claude platforms. [Docs](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)                                                                                     |
| `opus-5.5`           | Claude Opus 5.5 / `claude-opus-5-5`                           | Official docs list active, released Sep 22, 2026. [Docs](https://platform.claude.com/docs/en/models/opus-5-5/overview)                                                                                                                                   |
| `gpt-6.1-sol`        | GPT-6.1 Sol / `gpt-6.1-sol`                                   | Official model reference readable; Sep 29 launch identified by announcement/search sources. [Reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Announcement](https://openai.com/index/introducing-gpt-6-1-sol)                     |
| `gpt-6-astra`        | GPT-6 Astra / `gpt-6-astra`                                   | Public official model reference. [Reference](https://developers.openai.com/api/docs/models/gpt-6-astra)                                                                                                                                                  |
| `gpt luna`           | Likely GPT-6 Luna / `gpt-6-luna`                              | Generation omitted by user; confirm intended generation, rather than treating the phrase as an exact ID. [Reference](https://developers.openai.com/api/docs/models/gpt-6-luna)                                                                           |
| `must-spark-1.3`     | **Unverified name**; likely Muse Spark 1.3 / `muse-spark-1.3` | Official Meta docs and launch identify Muse, not Must. Confirm typo with user. Standard and Contributor variants differ in data-use terms. [Models](https://dev.meta.ai/docs/models), [Launch](https://research.meta.ai/blog/introducing-muse-spark-1-3) |
| `deepseek 4.1 flash` | DeepSeek-V4.1-Flash / **`deepseek-flash`**                    | Sep 10, 2026 official release. Legacy `deepseek-v4-flash` aliases route to it; a guessed `deepseek-v4.1-flash` is not the documented direct-service ID. [Release](https://api-docs.deepseek.com/news/news260910)                                         |

Public documentation does not guarantee access in a particular account, provider, region, or coding harness.

## Findings

1. **DeepSWE is especially relevant to implementation, but harness differences dominate narrow score gaps.** Datacurve's DeepSWE v1.1 describes long-horizon tasks across 113 tasks, 91 repositories and five languages, graded with functional and regression tests. The official board is the preferred reference. Secondary reporting updated Oct 2 separates provider runs from standardized mini-swe-agent entries: GPT-6.1 Sol 75.2%, Opus 5.5 74.2%, Sonnet 5.5 71.0%; it also reports Muse 75.4% and Astra 74.1%. These secondary numbers are **not independently verified primary-source scores here** and must not be presented as a common-harness ranking. Confidence intervals and task costs for new provider rows are incomplete. [Official board](https://deepswe.datacurve.ai/), [dated secondary report](https://codingfleet.com/blog/deepswe-v11-leaderboard-2026/)

2. **DeepSeek provides particularly concrete harness-sensitivity evidence.** Its September model card reports DeepSWE v1.1 **74.2** using mini-SWE at maximum reasoning effort, versus **66.2 in Pi**, **65.6 in Codex**, and **69.8 in Claude Code** in its scaffold comparison. These are vendor evaluations, not a reproduction in this repository. The comparison uses eight samples/task for DeepSWE, three for Terminal-Bench 2.1, up to 500 steps, and max reasoning. Strong benchmark results at max effort do not establish cheap bounded-task latency at low effort. [Model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)

3. **Terminal-Bench versions cannot be merged.** Anthropic's Sep 28 Sonnet launch reports **70.6% on Terminal-Bench 4.0**, with Opus 5.5 **66.4%** subject to the launch table's footnote/settings. DeepSeek's model card reports **90.6 on 2.1**, **30.0 on 3.0**, and **31.2 on 4.0**, with its own Minimal harness. This does not justify comparing 90.6 directly to 70.6 or declaring an unconditional winner. Use the official leaderboard and match task version, harness, effort, tool/network access, retries and scoring. [Sonnet launch](https://www.anthropic.com/claude-sonnet-5-5), [DeepSeek card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash), [Terminal-Bench](https://www.tbench.ai/leaderboard)

4. **SWE-bench evidence remains a gap for this exact shortlist.** No adequately verified, version-matched SWE-bench Verified/Pro result set for all requested candidates was obtained. Do not substitute DeepSWE for SWE-bench or invent missing scores. Nor should issue-resolution pass rate be treated as review precision.

5. **GPT reviewer recommendation is preference-constrained, not a proven precision ranking.** Sol's official model reference recommends comparing near-Astra capability against cost on one's own tasks. No current, matched review benchmark for Sol/Astra versus Sonnet/Opus was established. Review evaluation needs true actionable defect precision, false-positive comments/PR, recall, severity calibration and human acceptance—not just bug-fixing success. Require file/line, reproducible failure, impact and minimal suggested fix; permit an empty findings list, prohibit unsolicited rewrites, and cap comments. [Sol reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

6. **Conciseness is not a GPT-family invariant.** Meta reports Muse 1.3 uses about 20% fewer tool calls and 25% fewer tokens than Muse 1.2 in its engineers' comparisons; that is a vendor, within-family comparison, not GPT review evidence. OpenAI's Sol system-card text reports longer final answers than GPT-6 Sol/Luna but slightly shorter than Astra on HealthBench—non-coding evidence that cannot establish review concision. There is no support here for “GPT always writes less code.” Control reviewer length through task policy and evaluate it locally. [Meta launch](https://research.meta.ai/blog/introducing-muse-spark-1-3), [OpenAI system-card addendum](https://deploymentsafety.openai.com/gpt-6-1-sol/kernelgen-1p)

7. **Latency depends on effort and total trajectory.** Anthropic describes Sonnet as fast, Opus as moderate, and claims Sonnet 5.5 output generation is 30%+ faster than Sonnet 5, not all competitors. Artificial Analysis's live comparison gives Sonnet-medium versus Opus-low about 92 versus 72 output tokens/s and 1.42 versus 12.76 seconds to first token, yet per-task time about 131 versus 87 seconds: token speed does not equal task speed. These are live, configuration-specific measurements, not archived Oct 3 guarantees. Sol's reference supports low through max, but **not none/minimal**. Measure p50/p95 wall time and accepted-result cost on the actual harness. [Launch](https://www.anthropic.com/claude-sonnet-5-5), [AA comparison](https://artificialanalysis.ai/models/comparisons/claude-sonnet-5-5-medium-vs-claude-opus-5-5-low), [Sol reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

## Cost snapshot

USD per million uncached input / output tokens; exclude tool fees, retry costs and cache discounts. OpenAI figures below are **Standard-processing short-context rates**, not unrestricted tariffs. Official long-context rates are Sol **$4 / $15**, Astra **$20 / $75**, and Luna **$0.20 / $0.75**. Luna's reference applies its higher rates to the full request when input exceeds **272K tokens**; consult each model's live reference for its applicable threshold before cost-sensitive routing. Live pricing is not a frozen historical tariff. [Official OpenAI pricing](https://developers.openai.com/api/docs/pricing).

| Model                   |                             Input / output | Evidence / qualification                                                                                                        |
| ----------------------- | -----------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------- |
| Sonnet 5.5              |                                   $2 / $10 | Official Sep 28 launch and docs                                                                                                 |
| Opus 5.5                |                                   $4 / $20 | Official model docs                                                                                                             |
| GPT-6.1 Sol             |                                   $2 / $10 | Readable official model reference and independently fetched official pricing; Standard short-context                            |
| GPT-6 Astra             |                                  $10 / $50 | Independently fetched official pricing; Standard short-context; verify live billing                                             |
| GPT-6 Luna              |                              $0.10 / $0.50 | Official model reference and pricing; Standard short-context, higher rates above 272K input tokens                              |
| Muse Spark 1.3 Standard |                              $1.25 / $4.25 | Official Meta product page; Contributor $0.10 / $0.20 allows product improvement/training, so is not an equivalent privacy tier |
| DeepSeek-V4.1-Flash     | $0.15 / $0.60 off-peak; $0.30 / $1.20 peak | Official pricing fetched; cache-hit input $0.003 / $0.006 respectively; UTC schedule applies                                    |

[Meta product/pricing](https://developer.meta.com/ai/models/muse-spark/), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), [Official OpenAI pricing](https://developers.openai.com/api/docs/pricing). Low token tariffs do not guarantee lowest cost per successful task.

## Key APIs and usage constraints

No runtime configuration changes are proposed. Names above are verified direct-provider identities for disambiguation, not pins. Sol tool calling requires the Responses API; Chat Completions supports it without tool calling. Luna supports tools/function calling through Responses; Chat Completions function calling requires `reasoning_effort=none`, so check harness compatibility before using a reasoning-enabled tasker. [Luna reference](https://developers.openai.com/api/docs/models/gpt-6-luna). Meta Standard tier supports Muse 1.3 max reasoning; Contributor changes both data-use terms and available reasoning effort: max is Standard-only. Equivalent performance at shared efforts was not established. [Meta reasoning docs](https://ai.developer.meta.com/docs/reasoning/). DeepSeek's direct-service Flash alias is mutable, so record actual model version during evaluations.

Illustrative reviewer policy, not a model-specific API call:

```text
Review independently; do not edit files.
Report only actionable defects introduced by the diff.
For each: severity, file:line, failure scenario, evidence, minimal fix.
No style-only findings or unsolicited rewrites. Maximum five findings.
Return “No actionable findings” when appropriate. Mark unverified claims.
```

## Sources

Kept: official Claude model pages/launch (identity, dates, costs and vendor evaluations); official OpenAI model references (identity and API constraints); Meta models/product/launch (identity, availability, data tiers and efficiency claims); DeepSeek release/pricing/model card (alias, costs and harness-specific results); Datacurve and Terminal-Bench boards (canonical benchmark context); Artificial Analysis (independent but live configuration-specific latency); CodingFleet Oct 2 report (explicitly secondary, distinguishes provider and standardized runs).

Dropped from decisive rankings: LLMBoard/Vector Wire leaderboard mirrors (mixed provenance and apparently precise ranks obscure harness differences); generic price/coding guides (not primary evaluations); older code-review comparisons involving Sonnet 4.6/GPT-5.4 mini (different models cannot settle the requested shortlist). Pricing catalog retained only as corroboration, not authority for identity or access.

## Gaps and next steps

- Named Exa MCP fetch was not callable in the original research child. The parent subsequently fetched Sonnet's launch, Sol's reference, Google's Argon announcement, Arena creative writing, and Meta's model page through Exa MCP. Independent review also fetched official pricing and Luna/Meta reasoning references, leading to the corrections above. These are source checks, not benchmark reproductions.
- Need archived Oct 3 sources and primary Sol/Opus/Muse DeepSWE tables before promoting secondary scores to verified values.
- No matched SWE-bench suite or direct review precision/conciseness evidence for the exact candidates; no direct architecture or writer evaluation.
- Run a small blinded repository trial with identical harness/tool permissions: accepted patches plus regressions for coder; actionable precision/false positives for reviewer; requirement coverage and tradeoff accuracy for architect; exact acceptance checks for tasker; factuality and editing burden for writer. Track effort, retries, tokens, cache use and p50/p95 cost/latency.
- Confirm `must` → `muse` and intended Luna generation. Check account availability separately.

Only this new research Markdown file was written; no source code or runtime model configuration was edited. The target did not exist before writing; other files were not modified.
