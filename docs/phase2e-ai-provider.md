# Phase 2E: secure AI provider and action review

Phase 2E removes the Gemini runtime and routes every text-generation feature
through a backend-only provider contract. Groq is the only enabled provider.
Speech and transcription remain on AssemblyAI and were not migrated.

Meeting text, document text, questions, and autocomplete input are sent to the
configured external AI provider. Model output can be incorrect or influenced
by instructions in user content. Strict schemas reduce the consequences but do
not make prompt injection impossible, so extracted actions are proposals and
require explicit review before they can cause reminders.

## Architecture and routes

`backend/ai/contracts.py` defines provider-neutral messages and text/structured
results. `groq_provider.py` is the only SDK adapter. `service.py` owns prompts,
validation, long-input handling, cost accounting, idempotency orchestration,
local HTML construction, and server-owned persistence. `store.py` is the
service-role adapter for narrow database RPCs. Routers receive the service via
an overrideable dependency, which lets tests use deterministic fakes without a
network call.

Authenticated routes are:

- `POST /generate-result/`: typed generation plus atomic persistence; requires
  a UUID `Idempotency-Key` header;
- `POST /ai/autocomplete`: contextual writing continuation with its own tighter
  distributed limiter;
- `POST /ai/question`: separate bounded question and context fields;
- `POST /ai/topics`: validated topics with zero-based UTF-16 source indexes resolved
  locally from provider-selected, server-numbered source blocks;
- `POST /action-items/{id}/review`: owner-scoped confirm or reject, with the
  complete reviewed action fields.

The generic `POST /ai-helper` route is retired with `410`. The browser cannot
choose a provider, model, system prompt, tools, temperature, or output format,
and it cannot write AI provenance or AI-generated actions directly.

### Editor completion and topic labels

Completion uses up to the last 4,000 characters before the cursor, including
previous paragraphs and exact trailing whitespace. It predicts one short,
context-aware clause or sentence in the author's language, voice, and tense;
questions in the editor are text to continue, not questions to answer. The
prompt explicitly rejects restatement and repetitive token loops, while local
validation rejects oversized, multiline, markup-like, or mechanically repeated
output. The response's `text` is the exact insertion: `market to buy fresh
vegetables.` after `I am going to the `, ` review the proposal again on Friday.`
after `We agreed to`, or `ket to buy fresh vegetables.` after `I am going to the
mar`. Consumers must not trim it or add their own separator.
The browser debounces typing, cancels obsolete requests, and rejects late
responses after a document change, cursor move, selection, blur, or toggle-off.
Tab, Enter, and clicking the suggestion accept it; Escape dismisses it.

Topic requests preserve the original whitespace and line endings. The server
numbers paragraph/sentence blocks and retains their original UTF-16 indexes.
The model selects `block_id` values and concise titles; it no longer has to
copy exact source excerpts. This removes failures caused by paraphrased,
oversized, or differently formatted anchors. The provider schema restricts IDs
to the supplied blocks, and local validation still rejects unknown IDs or
invalid titles. Metadata is bounded to 256 blocks by grouping adjacent sections
without dropping content. Topic count is bounded by the configured topic and
output budgets, with the full configured output ceiling available instead of
the former 2,000-token ceiling. Index conversion counts emoji as UTF-16 units
for the browser, and insertion accounts for Quill embeds omitted from plain text.
Labels are applied as one undoable edit; results for text edited during the
request are discarded. No model, credential, or database migration is needed
for these editor fixes; deploy the frontend and backend together.
The numbered-block correction itself changes only the backend; existing
frontends continue receiving the same `{topics: [{topic, index}]}` response.

## Groq configuration

The selected production configuration is `openai/gpt-oss-20b` for both
`AI_TEXT_MODEL` and `AI_STRUCTURED_MODEL`. Groq lists it as a production text
model and documents strict JSON-schema structured output for the GPT-OSS
models. It is used through the official async `groq` Python SDK with no tools,
browsing, code execution, function calls, Compound model, or custom base URL.
GPT-OSS calls use low reasoning effort and omit reasoning from responses so
short product tasks do not exhaust their completion budget before returning
user-visible content. Autocomplete uses temperature `0.6`, within Groq's
recommended range for avoiding repetitive or incoherent reasoning-model
output, while other deterministic tasks retain their lower temperatures. It
still receives a bounded 512-token ceiling and its displayed result is capped
locally to 24 words and 320 characters.
Review current availability before rollout:

- https://console.groq.com/docs/models
- https://console.groq.com/docs/structured-outputs
- https://github.com/groq/groq-python

Production does not silently select a model. When `AI_ENABLED=true`, startup
requires an approved provider, API key, explicit text and structured model IDs,
and prompt version. Unknown, preview, audio, guard, Compound, and models without
an explicitly registered strict-output capability fail validation. When AI is
disabled, AI routes fail closed with `503`; `/health` remains a local liveness
check and never calls the provider. There is no automatic fallback to Gemini or
any other provider.

Required server-side variables are:

```text
AI_ENABLED
AI_PROVIDER
GROQ_API_KEY
AI_TEXT_MODEL
AI_STRUCTURED_MODEL
AI_CONNECT_TIMEOUT_SECONDS
AI_READ_TIMEOUT_SECONDS
AI_WRITE_TIMEOUT_SECONDS
AI_POOL_TIMEOUT_SECONDS
AI_MAX_RETRIES
AI_MAX_INPUT_CHARS
AI_MAX_ESTIMATED_INPUT_TOKENS
AI_MAX_OUTPUT_TOKENS
AI_CHUNK_CHARS
AI_MAX_CHUNKS
AI_MAX_ACTION_ITEMS
AI_MAX_TOPICS
AI_MAX_CONCURRENT_REQUESTS
AI_GENERATION_LEASE_SECONDS
AI_PROMPT_VERSION
RATE_LIMIT_AI_PER_MINUTE
RATE_LIMIT_AI_PER_DAY
RATE_LIMIT_AUTOCOMPLETE_PER_MINUTE
RATE_LIMIT_AUTOCOMPLETE_PER_DAY
```

Secrets stay in backend configuration and are excluded from settings
representations. Remove the obsolete `GOOGLE_API_KEY` from local and Render
configuration manually after the new deployment is healthy.

## Trust boundary and validation

Server-owned instructions occupy system messages. Source text, role, target
language, question, and context are JSON-serialized into separate user
messages and treated as untrusted data. Prompts contain no credentials or
unrelated user data, and the model receives no tools or system access. The
short `AI_PROMPT_VERSION` is persisted; full prompts are not.

Requests forbid unknown fields and control characters. Languages come from a
server-owned allow-list. Questions and contexts have independent limits.
Provider structured results are parsed and then validated again with strict
local Pydantic schemas that reject extra fields, malformed dates, reversed date
ranges, invalid email addresses, multiline subjects, excessive actions/topics,
topic block IDs absent from the submitted source, and oversized evidence. The
server derives topic indexes from its own source boundaries rather than
trusting model arithmetic. A malformed structured response gets at most one
bounded repair attempt with corrective system guidance instead of repeating
an identical request. No partial data is saved.

Provider-facing JSON Schemas contain only Groq's strict-decoding structural
subset. Pydantic-only annotations such as string length and pattern constraints
are removed before the request and remain enforced by local validation after
the response. This prevents provider schema rejection without weakening the
application's output checks.

The provider returns plain text or data, never trusted HTML. Ally constructs
`formatted_result` locally from escaped summary text. A generated assignee
email is kept only when that exact normalized address occurs in the original
source; otherwise it becomes null for the reviewer to supply.

## Limits, retries, and errors

Character and conservative estimated-token limits are checked before provider
work. Long input is split at paragraph/sentence/word boundaries without silent
content truncation. Chunks are summarized sequentially, then one bounded
synthesis call produces the strict result. Chunk count, provider call count,
output tokens, action count, topic count, and concurrent requests are all
bounded.

One process-wide async SDK client is created at application startup and closed
at shutdown. It has explicit connect/read/write/pool timeouts and the official
SDK's bounded retry setting; Ally does not layer another transport retry loop
on top. Authentication/permission failures, rate limits, timeouts, connection
failures, provider 5xx responses, refusals, malformed output, and truncation are
mapped to sanitized application categories. Public responses never contain raw
provider bodies or request data. A bounded `Retry-After` may be forwarded for a
provider rate limit.

Logs contain operation, provider, model, prompt version, result category,
latency, call count, and token counts. They do not contain source text, prompts,
model responses, API keys, email addresses, access tokens, or raw provider
errors.
Validation retries also log `ai_validation schema=... attempt=... reason=...`
with server-owned categories such as `output_truncated`, `schema_validation`,
`unknown_topic_block`, or `invalid_json`. An HTTP 200 from Groq means the
transport succeeded; these categories identify why response checks still
failed. Public errors remain sanitized.

## Durable generation idempotency and provenance

`private.ai_generation_requests` is RLS-enabled and inaccessible to browser
roles. Its database-unique key is `(user_id, operation, idempotency_key)`, and
it stores a canonical request hash, processing lease, provider-start marker,
bounded provenance/usage, failure category, and completed meeting link. It does
not store keys or full prompts.

A safe abandoned claim can be recovered only before provider work is marked as
started. Loss after provider start becomes `unknown` rather than triggering a
blind duplicate call. A completed replay reconstructs the persisted result
without provider usage; the same key with a different payload conflicts; the
same key remains independent for different users. The frontend retains a key
after uncertain failure and removes it only after success or a definite
client-side rejection. Starting over intentionally creates a new key.

Only the backend service-role RPC atomically creates the meeting, stores actual
provider/model/prompt-version provenance, inserts proposed actions as pending,
and completes the idempotency record. The legacy browser
`save_meeting_with_actions` execution grant is revoked. Historical provenance,
including old Gemini labels, is not rewritten.

## Human review and reminder eligibility

All AI actions start with `review_status=pending` and no review timestamp;
manual actions start confirmed. The migration backfills existing AI actions to
pending because there is no reliable prior approval evidence. The review route
uses the verified JWT owner and a service-role-only RPC. Cross-user and missing
IDs return the same not-found outcome, and browser roles cannot update the
review columns directly.

The UI labels proposals “Needs review,” shows the proposed task, assignee,
recipient, dates, and evidence, and allows edits before Confirm or Reject.
There is no bulk or automatic confirmation. A failed review request leaves the
previous state visible. Any later material edit to a confirmed AI action resets
it to pending.

Manual claim, scheduled candidate creation, retry claiming, delivery
preparation, and the final provider-start database update all require a
currently confirmed AI action. Review revocation cancels clearly unsent work
and revokes unused status tokens. A processing delivery already marked as
provider-attempted becomes `unknown`; existing `sent` and `unknown` history is
preserved.

## Rollout, rollback, and operations

Use this order:

1. Apply `20260921150000_phase2e_ai_review_and_idempotency.sql`.
2. Apply `20260921151000_phase2e_reminder_review_enforcement.sql`.
3. Run Phase 2E contract/security tests and database lint.
4. Create separate Groq projects/keys for development and production, set
   project limits where available, and review Groq retention/data handling.
5. Set all server variables and deploy backend and frontend together.
6. Run an explicitly authorized synthetic staging request; automated tests do
   not call Groq.
7. Remove `GOOGLE_API_KEY`, then monitor errors, latency, usage, rate-limit
   dashboards, idempotency `unknown` states, and review failures.

Rollback by setting `AI_ENABLED=false` or reverting the application deployment.
Do not re-enable Gemini and do not bypass action review. Leave the forward-only
database structures and reminder checks in place so existing data remains safe.
No automatic cleanup is installed: apply the documented 90-day completed and
30-day failed/unknown retention only after an operational retention decision.

To add a future provider, implement the provider-neutral contract, register
explicit text/strict-output capabilities, add fail-closed configuration and
sanitized error mapping, and run the same fake-provider conformance tests. Do
not add an implicit fallback.

Verification from `ally/`:

When a local `.env` contains real deployment settings, run the unit tests with
`PYTHON_DOTENV_DISABLED=1` in the test process. Otherwise the existing reminder
tests inherit signing keys and origins instead of their expected test defaults.
This does not require changing or removing the local `.env`.

```powershell
npm test
python -m compileall -q backend
python -m pip check
npx supabase migration list --linked
npx supabase db lint --linked --schema public --level warning --fail-on error
npx supabase db query --linked --file supabase/tests/database/phase2e_contract_test.sql
npx supabase db query --linked --file supabase/tests/database/phase2e_security_smoke.sql
```
