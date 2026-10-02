# Default agents: task strengths, routing, and model selection

Research checked **2026-10-02**. These are workflow presets, not a claim that a role prompt makes every model equally capable. Model recommendations are starting points to evaluate, not permanent winners or shipped vendor pins.

## Major task families

The useful unit is a **work product and its success criterion**, rather than a single intelligence score.

| Family                            | What success means                                                                   | Relevant evidence and limitations                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository exploration            | Locate the right symbols, behavior, and conventions with traceable coverage          | [LongBench v2](https://longbench2.github.io/) includes repository/context comprehension. Large context capacity alone does not establish reliable navigation or sustained execution.                                                                                                                                                                                           |
| Bounded execution / tool use      | Complete a specified operation correctly, within policy, with few unnecessary steps  | [Terminal-Bench](https://www.tbench.ai/) tests environment tasks; [τ-bench](https://arxiv.org/abs/2406.12045) tests policy-constrained tool/user interaction and repeated-run reliability. Scores depend on the tools, scaffold, task version, and budget.                                                                                                                     |
| Sustained software implementation | Resolve a repository issue through iterative edits, debugging, and verified behavior | [SWE-bench](https://www.swebench.com/SWE-bench/) uses real issues and repository tests. Passing tests does not establish maintainability, security, or review skill.                                                                                                                                                                                                           |
| Review / critical verification    | Find actionable defects while avoiding plausible false positives                     | [Code Review Bench](https://github.com/withmartian/code-review-benchmark) assesses review precision/recall. Its small offline set, LLM judging, and developer-fix proxy limit generalization. Implementation skill is not the same as reviewer calibration.                                                                                                                    |
| Evidence research                 | Acquire relevant sources, reconcile evidence, and produce a supported synthesis      | [BrowseComp](https://arxiv.org/abs/2504.12516) tests difficult factual discovery; [DeepResearch Bench](https://deepresearch-bench.github.io/) evaluates reports and citation effectiveness/accuracy. Finding a fact and writing a good sourced report are different competencies.                                                                                              |
| Creative / editorial writing      | Produce coherent, original prose matching an audience, voice, and brief              | [Creative Writing Bench](https://github.com/EQ-bench/creative-writing-bench) uses rubrics and pairwise judgments. Its English prompts and judge preferences are not universal taste, factual reliability, or long-form editorial quality.                                                                                                                                      |
| Visual/interface design           | Deliver convincing visual hierarchy and usable interactions across states and sizes  | [WebDev Arena](https://arena.ai/blog/webdev-arena) measures human preferences between generated apps; [Design Arena](https://designarena.ai/) covers creative artifacts. Preference is not an accessibility, security, or production-readiness audit. Design Arena's methodology was not reliably retrievable in this research, so we do not use it to declare a model winner. |
| Architecture / planning           | Choose defensible tradeoffs and a dependency-valid, verifiable sequence of work      | [PlanBench](https://arxiv.org/abs/2206.10498) tests formal action/state planning. It is not a direct measure of software architecture or multi-agent management; long-context understanding is not an execution guarantee either.                                                                                                                                              |
| Quantitative / analytical work    | Compute correctly with explicit assumptions, units, reproducibility, and uncertainty | Mathematical reasoning, data analysis, and scientific interpretation deserve a distinct evaluation contract. We document an analyst specialization below rather than pretending coding benchmarks cover it.                                                                                                                                                                    |

Other important workloads include translation, tutoring, structured extraction, and GUI/computer operation. [OSWorld](https://os-world.github.io/) illustrates why computer use needs both perception and an actual action interface; a shell-only agent cannot inherit that capability from a model score.

Vision, language, context utilization, latency, cost, risk, task horizon, and available tools are **cross-cutting dimensions**. Assess them alongside the role. Do not turn every benchmark into another default agent, or infer a universal ranking from one leaderboard.

## Shipped roles and boundaries

| Agent        | Default thinking | Route here for                                                                 | Do not use it for                                                      |
| ------------ | ---------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `explorer`   | `low`            | Targeted code lookup, file/symbol maps, tracing existing behavior              | Broad audits, architecture decisions, or external research             |
| `tasker`     | `low`            | A bounded job with clear scope and acceptance criteria                         | An ambiguous, interconnected feature or sustained debugging            |
| `coder`      | `high`           | Iterative implementation, refactoring, and difficult debugging                 | Independent review of its own work as a substitute for a reviewer      |
| `reviewer`   | `high`           | Evidence-led assessment of a change; calibrated defect reports                 | Quietly fixing the patch or generating a quota of speculative findings |
| `researcher` | `high`           | Source acquisition when tooling permits, reconciliation, and synthesis         | Unsourced answers presented as live research; quick code lookup        |
| `writer`     | `medium`         | Creative long-form drafts and voice-preserving editorial work                  | Fabricating facts, citations, endorsements, or purported experiences   |
| `designer`   | `medium`         | Frontend visual/interaction work with responsive and accessible states         | Backend redesign or claims of visual QA without rendered inspection    |
| `architect`  | `high`           | Requirements, alternatives, interfaces, decomposition, authorized coordination | Treating a planning request as permission to execute                   |

Use uncertainty and dependencies, not a fixed number of minutes, to distinguish tasker from coder. Researcher's high setting favors careful synthesis and conflicting evidence; medium can be sufficient for straightforward source summaries. Writer/designer's medium setting is a balance, not a statement that creativity improves monotonically with more reasoning. Increase effort only when it improves the actual work product. The SDK maps requested thinking to the selected model's supported levels; the requested label is not a universal token budget.

Every default has an explicit allowlist. Only architect has delegation tools, and it plans only unless delegation/execution is authorized. Explorer cannot write or execute shell commands. Reviewer/researcher/architect have shell access for inspection or retrieval, so their non-mutation rules are **prompt contracts, not enforced read-only sandboxes**. Bash and delegated children can change files. Writer can edit drafts but has no shell access; implementation roles can edit and run checks. Agents share the working directory and must preserve unrelated changes.

## Research and browser capability gates

The child runtime does **not** load the parent's extensions, MCP tools, skills, web search, or browser tools. These definitions do not change that runtime.

Researcher can use supplied/local sources and an available, authorized shell retrieval/search workflow. If live acquisition is unavailable, it must pause for sources or a supported retrieval route rather than improvise citations. A provider's hosted-search feature does not mean that feature is exposed as a child tool. Likewise, designer may use available CLI browser tooling, but code checks do not prove that a page was rendered, accessible, or visually inspected. A delegated child does not magically gain the parent's unavailable capabilities.

## Model recommendations, not vendor locks

**All bundled definitions omit `models` and inherit the effective parent/default model.** This preserves usability across providers and accounts. Different models can be assigned per role through `/agents types` or same-name user/project definitions.

An explicit `models` list is ordered, exact `provider/model-id` matching against `/scoped-models`. If no preference matches, including an empty scope, spawning fails. It is **not** a fallback to the parent, account registry, or a cheaper model after an API failure. The chosen entry must be a usable physical model, not a virtual selector. Confirm credentials, account entitlement, installed Pi adapter support, and the live scoped identities before adding pins.

Candidate starting points from the sources below:

| Roles               | Optional model candidates                                                                   | Evidence strength / tradeoff                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explorer, tasker    | `openai/gpt-6-luna`; `anthropic/claude-sonnet-5-5` for harder bounded work                  | Luna targets inexpensive focused work. Sonnet's vendor positioning emphasizes well-scoped tasks. Evaluate completion checks and retries, not token price alone.      |
| Coder               | `anthropic/claude-opus-5-5`; Sonnet 5.5 for cost-sensitive implementation                   | Anthropic positions Opus for sustained open-ended judgment. Independent terminal results also make Sonnet a credible coding candidate, not merely a weaker fallback. |
| Reviewer, architect | `anthropic/claude-opus-5-5`; `openai/gpt-6.1-sol` as an alternative to evaluate             | Reasoning and calibration matter. Current role-specific independent evidence for Sol is insufficient here to call it a winner.                                       |
| Researcher          | `google/gemini-3.8-flash` for efficient source synthesis; Opus for difficult reconciliation | Flash offers broad multimodal inputs and low/medium/high thinking. Neither choice supplies missing retrieval tools.                                                  |
| Writer, designer    | `anthropic/claude-sonnet-5-5`; Opus for demanding editorial/design work                     | Clearer prose and visual polish are vendor claims and early-tester observations. Validate against your own voice samples and rendered UI, not a coding score.        |

Sources: [Sonnet 5.5 announcement](https://www.anthropic.com/claude-sonnet-5-5), [Opus 5.5 announcement](https://www.anthropic.com/claude-opus-5-5), [independent Sonnet analysis](https://artificialanalysis.ai/articles/claude-sonnet-5-5), [Luna API reference](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol API reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Flash reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), and [independent Luna/Flash comparison](https://artificialanalysis.ai/models/releases/comparisons/gpt-6-luna-vs-gemini-3-8-flash). Model availability and recommendations will age; use the [Pi catalog](https://pi.dev/models) and your actual runtime to verify identities. Catalog presence alone does not prove installed adapter support or account access.

Independent terminal results and vendor results use different scaffolds/effort, and the independent Sonnet analysis notes a pre-release deployment issue. Do not combine their scores into one ranking. Creative-writing and WebDev leaderboard extraction was incomplete during this research; we deliberately make no current leaderboard-winner claim.

For an opt-in coder override, preserve the bundled prompt/tool policy in `/agents types` and set, for example:

```yaml
models:
  - anthropic/claude-opus-5-5
  - anthropic/claude-sonnet-5-5
thinkingLevel: high
```

This is a **frontmatter fragment**, not a complete definition. Both IDs are examples requiring live scope and runtime validation. Do not use `off` as a universal cheap mode: some newer reasoning models cannot disable thinking; support for minimal/max also varies by model and adapter.

## Optional analyst specialization

Keep the default set small: mathematical/data work can use tasker for a specified computation and coder for an iterative analysis pipeline. Create a separate `analyst` when this becomes a recurring workload with a distinct acceptance contract:

- State inputs, provenance, units, missingness, and assumptions before calculating.
- Use reproducible code for calculations; distinguish measured values from estimates.
- Check dimensional consistency, totals, baselines, and sensitivity to assumptions.
- Separate correlation, causation, and forecast uncertainty.
- Return the method, results, reproducibility instructions, and limitations; never invent data.

Choose thinking and write permissions based on the analysis, not the role name alone. Other specializations—translator, tutor, extraction worker, or GUI operator—should similarly add a concrete contract and required capabilities, not merely a different title.

## Migration and evaluation

The generic bundled `worker` is removed: use tasker for bounded jobs and coder for sustained implementation. Repository lookup formerly sent to researcher should go to explorer. Architect and researcher keep their names but have new prompts, explicit tools, and thinking defaults. Same-name custom definitions still override bundled ones; retained threads keep their saved definitions. There are no runtime aliases or automatic renames.

Evaluate model + preset + actual tools + budget on representative jobs: task completion and retries for execution, passing behavior and regressions for coding, precision/recall for review, citation support/coverage for research, voice/coherence for writing, rendered states/accessibility for design, and dependency validity and acceptance criteria for plans. Track total tokens, latency, and failure cost as well as quality. Independent review and real execution checks are stronger evidence than another model saying a result looks correct.
