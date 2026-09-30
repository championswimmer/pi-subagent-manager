# Design and review checkpoints

The current public behavior is described in ../../README.md; the current contracts are in ../../src/types.ts. Plans describe the decisions at their checkpoint, not separate specifications to maintain forever.

- `implementation.md`: initial decomposition, ownership and lifecycle decisions, including the user’s retained-session refinement.
- `review-lifecycle.md`: initial race/context review. Resolved with synchronous reservations, abortable setup and late-driver cleanup, context preservation, and preservation of completed descendants.
- `review-composability.md`: stable original task labels, a live type catalog, one owner for resolved model defaults and a dedicated durable registry shape.
- `review-test-value.md`: prioritized real SDK recovery coverage over additional microscopic unit tests.
- `review-config-ui.md`: fail-closed duplicate names, source-directory symlink rejection, centralized save destinations and trusted-only scope choices.
- `review-sdk.md`: runtime-only credentials, durable paused mailboxes, non-turning updates and a materialized-session path contract.
- `review-final-architecture.md`: caller-scoped `ThreadService`, explicit `SavedThreadView`, and one context-sanitization owner.
- `review-final-lifecycle.md`: original-prompt-before-steering ordering and stopped-ancestor spawn guards.
- `review-resolution.md`: final bounded verification of those resolutions.

Tests remain bounded and offline. The root integration scenario loads the extension through pi’s loader, pauses a real scripted child, reopens the parent, resumes the same JSONL child, and checks separate-main-session isolation.
