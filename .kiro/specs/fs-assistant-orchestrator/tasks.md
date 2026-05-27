# Implementation Plan: FS Assistant Orchestrator

## Overview

This plan ships the unified FS Assistant in five phases, matching the design's Migration Plan: Phase 0 pre-work (pure refactors, nothing wired), Phase 1 builds and deploys the AgentCore container, Phase 2 adds the edge Lambda and the chat-history extension, Phase 3 builds the frontend, Phase 4 is the cutover (flag flip + page-scoped chat removal), and Phase 5 is soak monitoring + post-soak cleanup follow-ups.

The implementation language is **TypeScript** throughout, both for the agent container (Strands TS SDK + Express, per Design §3) and for the edge Lambda (Design §2). Existing TypeScript tool implementations from `lambda/chat/index.ts` and `lambda/gmail-analysis/index.ts` are lifted into Strands tool callbacks rather than rewritten. The legacy `/pos/chat` and `/gmail/chat` endpoints and their Lambdas stay deployed for one release cycle (Req 10.2) — none of the Phase 4 tasks delete them; that's a follow-up after the 14-day soak (Phase 5).

The seven correctness properties from the design (§Correctness Properties) each get a dedicated property-based test sub-task using `fast-check`, tagged `// Feature: fs-assistant-orchestrator, Property <N>: ...` with at least 100 iterations (`numRuns: 100`).

Ship behind two feature flags, default off: `ASSISTANT_ENABLED` (Lambda env var, gates the `/assistant/chat` route) and a Vite env flag (gates the `<FsAssistant />` mount). Task 14.1 is the dedicated cutover task that flips them.

## Tasks

### Phase 0: Pre-work refactors (no production change)

- [x] 1. Refactor shared modules out of `lambda/chat/index.ts` so the agent container can import them
  - [x] 1.1 Extract `VENDOR_CONTACTS` directory to `lambda/shared/vendorContacts.ts`
    - Create `lambda/shared/vendorContacts.ts` exporting the `VENDOR_CONTACTS` constant (and any related types) verbatim
    - Replace the inline definition in `lambda/chat/index.ts` with an import from `lambda/shared/vendorContacts`
    - No behavior change; pure move
    - _Requirements: 4.1; Design Open Question 7, Migration Phase 0_

  - [x] 1.2 Split `executeTool` switch into per-tool exported functions in `lambda/chat/tools/`
    - For each `case '<name>':` block in the existing `executeTool`, extract into its own file under `lambda/chat/tools/` (e.g. `getSalesSummary.ts`, `getReturnsData.ts`, `getOrthoticsCommission.ts`, etc.) — one file per tool, 17 files total per Design §3 Sales_Agent tool list
    - Each function takes the same DynamoDB client + input args the original case received and returns the same shape
    - Update `executeTool` to dispatch to the new functions so existing `/pos/chat` keeps working unchanged
    - _Requirements: 4.1, 4.2; Design §3 Sales_Agent, Migration Phase 0_

  - [ ]* 1.3 Write unit tests for extracted Sales tool functions
    - One happy-path test per extracted function, asserting it returns the same shape `executeTool` returned before
    - _Requirements: 4.1_

- [x] 2. Refactor shared modules out of `lambda/gmail-analysis/index.ts` so the agent container can import them
  - [x] 2.1 Split Gmail tool callbacks into per-tool exported functions in `lambda/gmail-analysis/tools/`
    - Extract one file per tool: `cacheQuery.ts`, `cacheRead.ts`, `cacheVendorActivity.ts`, `cacheStats.ts`, `kbSemanticSearch.ts`, `liveSearchInbox.ts`, `liveReadEmail.ts` — covering the existing tool surface per Design §3 Inbox_Agent
    - Each function reuses `lambda/gmail-analysis/cache.ts` and `lambda/gmail/client.ts` unchanged
    - Update `lambda/gmail-analysis/index.ts` to dispatch to the new functions so existing `/gmail/chat` keeps working unchanged
    - _Requirements: 5.1, 5.2, 5.3; Design §3 Inbox_Agent, Migration Phase 0_

  - [ ]* 2.2 Write unit tests for extracted Gmail tool functions
    - One happy-path test per extracted function plus one test asserting `cacheRead` returns attachment metadata in the existing `AttachmentChip`-compatible shape
    - _Requirements: 5.2_

- [x] 3. Centralize `ADMIN_EMAIL` propagation
  - [x] 3.1 Wire `ADMIN_EMAIL` through CDK env vars instead of hard-coding in two places
    - Add `ADMIN_EMAIL` as a stack-level constant in `infrastructure/lib/foot-solutions-stack.ts`
    - Inject it into the existing `chatFn`, `heartlandFn`, and `gmailAnalysisFn` Lambda environments (it's currently hard-coded in `lambda/heartland/index.ts`)
    - Source `src/lib/admin.ts` from the same constant via Vite env (so the SPA stays consistent)
    - _Requirements: 6.1; Design Open Question 6, Migration Phase 0_

- [x] 4. Add CDK skeleton for the FS Assistant stack (not yet wired into `bin/`)
  - [x] 4.1 Create `infrastructure/lib/fs-assistant-stack.ts` with the construct shell
    - Define an empty `FsAssistantStack` extending `Stack`, exposing `runtimeArn` and `edgeFnArn` as outputs (left as TODOs for later phases)
    - Do NOT add it to `infrastructure/bin/*.ts` yet — keeps prod synth unchanged
    - _Requirements: 12.1; Design §IAM Matrix, Migration Phase 0_

### Phase 1: AgentCore container build + deployment

- [x] 5. Scaffold the `agents/fs-assistant/` TypeScript Strands container
  - [x] 5.1 Create the package layout and Dockerfile
    - Create `agents/fs-assistant/{package.json,tsconfig.json,Dockerfile,src/}`
    - Add `@strands-agents/sdk`, `express`, `zod`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-secrets-manager` to `package.json`
    - Dockerfile: `FROM --platform=linux/arm64 node:20`, copy `lambda/shared/`, `lambda/chat/tools/`, `lambda/gmail-analysis/tools/`, install, build, expose 8080
    - _Requirements: 12.1; Design §3 file layout_

  - [x] 5.2 Implement `src/server.ts` with `/ping` and `/invocations` endpoints
    - Express server on port 8080
    - `GET /ping` returns `{ status: 'Healthy' }`
    - `POST /invocations` parses the JSON payload `{ messages, callerUserId, isAdmin }`, reads `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header, calls `orchestrator.invoke(...)` with `invocationState`, returns `{ reply, route, attachments }`
    - On thrown error, return HTTP 200 with `{ reply: "Sorry, I ran into a problem...", route: 'general' }` so the edge Lambda can pass through gracefully
    - _Requirements: 2.4, 9.3; Design §3 server.ts skeleton_

- [x] 6. Implement Sales_Agent inside the container
  - [x] 6.1 Wrap each extracted Sales tool function as a Strands `tool({...})` callback in `agents/fs-assistant/src/tools/sales/`
    - One Strands tool per function from Task 1.2 (17 total), each with a Zod input schema
    - Tool callbacks call into `lambda/chat/tools/*` (imported, not duplicated)
    - Mark tools whose output is admin-gated (per `VISIBILITY_KEYS` in `src/lib/admin.ts`) with `context: true` and the admin gate logic inside the callback itself — NOT in the orchestrator. Specifically: `getOrthoticsCommission` and any other tool returning data bound to a `defaultVisible: false` key. Each gated callback checks `ctx.invocationState.isAdmin` and returns `{ error: "That information isn't available to your account." }` when false, **before** issuing any DynamoDB query
    - _Requirements: 4.1, 4.2, 4.4, 6.3; Design §3 Sales_Agent, getOrthoticsCommission sketch_

  - [x] 6.2 Define `Sales_Agent` in `agents/fs-assistant/src/agents/salesAgent.ts`
    - Strands `Agent` with model `global.anthropic.claude-sonnet-4-6`, system prompt lifted from existing `buildSystemPrompt()` in `lambda/chat/index.ts`, tool list = the 17 sales tool callbacks from 6.1
    - No Gmail tools — enforces Req 4.4
    - _Requirements: 4.1, 4.2, 4.3, 4.4; Design §3 Sales_Agent_

  - [ ]* 6.3 Write property test for admin-gated Sales tools
    - **Property 4: Admin-gated tools refuse for non-admin**
    - **Validates: Requirements 6.3**
    - Use `fast-check` to generate `(toolName, args, isAdmin)` tuples where `toolName` is drawn from the gated tool list and `args` are arbitrary valid inputs
    - Assert: when `isAdmin === false`, the callback returns the refusal message and the underlying DynamoDB client mock receives zero calls
    - Tag: `// Feature: fs-assistant-orchestrator, Property 4: Admin-gated tools refuse for non-admin`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 6.3_

- [x] 7. Implement Inbox_Agent inside the container
  - [x] 7.1 Wrap each extracted Gmail tool function as a Strands `tool({...})` callback in `agents/fs-assistant/src/tools/inbox/`
    - One Strands tool per function from Task 2.1 plus a new `resolve_thread_ids` tool (Design §3 Inbox_Agent)
    - Tool callbacks call into `lambda/gmail-analysis/tools/*` (imported, not duplicated)
    - `cacheRead` and `liveReadEmail` callbacks SHALL append attachment metadata to the agent's `result.metadata.attachments` so the orchestrator can merge it (Design §3 Inbox_Agent reply contract)
    - _Requirements: 5.1, 5.2, 5.3; Design §3 Inbox_Agent_

  - [x] 7.2 Define `Inbox_Agent` in `agents/fs-assistant/src/agents/inboxAgent.ts`
    - Strands `Agent` with model `global.anthropic.claude-sonnet-4-6`, system prompt lifted from existing `lambda/gmail-analysis/index.ts`, tool list = the 8 inbox tool callbacks from 7.1
    - No POS tools — enforces Req 5.4
    - _Requirements: 5.1, 5.3, 5.4; Design §3 Inbox_Agent_

- [x] 8. Implement Orchestrator_Agent + routing/timeout/merge logic
  - [x] 8.1 Define the Orchestrator_Agent in `agents/fs-assistant/src/orchestrator.ts`
    - Strands `Agent` with model `global.anthropic.claude-haiku-4-5-20251001-v1:0`, the system prompt from Design §3 Orchestrator (verbatim, with `{callerUserId}` / `{isAdmin}` slots), and tools `[salesAgent.asTool({ name: 'call_sales_agent', ... }), inboxAgent.asTool({ name: 'call_inbox_agent', ... })]`
    - Orchestrator has no DynamoDB or Gmail tools — enforces Req 3.6
    - _Requirements: 3.1, 3.5, 3.6, 3.7, 3.8, 6.1, 6.2, 11.3; Design §3 orchestrator.ts skeleton_

  - [x] 8.2 Implement per-sub-agent 60s timeout wrapper
    - Wrap each `asTool` callback in a `Promise.race` against a 60s timer (Req 9.4)
    - On timeout or exception, return `{ error: "<Sales|Inbox> data is temporarily unavailable", available: false }` so the orchestrator's system prompt can continue answering the cross-domain portion
    - _Requirements: 9.1, 9.2, 9.4; Design §3 Per-sub-agent timeout, §Failure mode table_

  - [x] 8.3 Implement routing-decision derivation from `tooluseHistory`
    - Pure function `deriveRoute(tooluseHistory): 'sales' | 'inbox' | 'both' | 'general'` per the table in Design §Routing decision in metadata
    - Wire into the orchestrator's post-invoke step so `result.metadata.route` is set before returning to `server.ts`
    - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.5; Design §Routing decision in metadata_

  - [x] 8.4 Implement attachment merge from sub-agent metadata into orchestrator response
    - Pure function `mergeAttachments(salesMeta?, inboxMeta?): Attachment[]` that concatenates `metadata.attachments` arrays from each sub-agent reply preserving order and element identity
    - Wire into `server.ts` so the response payload's `attachments` field is populated unchanged from the Inbox_Agent's array
    - _Requirements: 5.2, 8.2; Design §Sub-agent input/output contract, §Routing decision in metadata_

  - [ ]* 8.5 Write property test for routing-decision derivation
    - **Property 1: Routing decision matches sub-agent call set**
    - **Validates: Requirements 2.4, 3.1, 3.2, 3.3, 3.4, 3.5**
    - Generate arbitrary `tooluseHistory[]` arrays containing zero or more `call_sales_agent` and `call_inbox_agent` entries plus arbitrary other tool-use entries
    - Assert `deriveRoute()` returns `sales` when only `call_sales_agent` is present, `inbox` when only `call_inbox_agent`, `both` when both, and `general` when neither
    - Tag: `// Feature: fs-assistant-orchestrator, Property 1: Routing decision matches sub-agent call set`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 8.6 Write property test for single-domain failure isolation
    - **Property 2: Single-domain failure isolation**
    - **Validates: Requirements 9.1, 9.2, 9.3**
    - Generate arbitrary `(salesResult, inboxResult)` tuples where each is either a successful reply, a thrown error, or a timeout sentinel; mock the orchestrator turn at the `Promise.race` layer
    - Assert: when only one sub-agent failed, the orchestrator reply contains the corresponding "...temporarily unavailable" phrase, the response status is 200, and the other sub-agent's reply text is preserved verbatim
    - Tag: `// Feature: fs-assistant-orchestrator, Property 2: Single-domain failure isolation`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ]* 8.7 Write property test for attachment merge round-trip
    - **Property 7: Attachment metadata round-trip**
    - **Validates: Requirements 5.2, 8.2**
    - Generate arbitrary `attachments[]` arrays from the Inbox_Agent shape (messageId, subject, attachments[].{filename,mimeType,size,attachmentId})
    - Assert `mergeAttachments()` and the `server.ts` response path emit element-for-element identical arrays (deep equal, same order)
    - Tag: `// Feature: fs-assistant-orchestrator, Property 7: Attachment metadata round-trip`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 5.2, 8.2_

- [x] 9. CDK: deploy AgentCore Runtime + ECR repo + execution role
  - [x] 9.1 Wire `FsAssistantStack` to provision the runtime
    - Add an `aws_ecr.Repository` named `foot-solutions-fs-assistant`
    - Add an `AWS::BedrockAgentCore::Runtime` L1 construct referencing the image; configure `runtimeUserId` and observability per Req 12.5
    - Define the AgentCore execution role with the IAM Matrix entries (Bedrock Invoke for Haiku 4.5 + Sonnet 4.6, DynamoDB scoped to `FootSolutionsApp`, `secretsmanager:GetSecretValue` on `foot-solutions/gmail/*` and `foot-solutions/tavily/*`, S3 Vectors query, CloudWatch Logs)
    - Wire `FsAssistantStack` into `infrastructure/bin/*.ts` so it deploys
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5; Design §IAM Matrix, Migration Phase 1_

  - [x] 9.2 Build, push the ARM64 image, and deploy to a non-prod runtime alias
    - Provide a build script `agents/fs-assistant/scripts/build-and-push.sh` that builds linux/arm64 and pushes to the ECR repo
    - Deploy to AgentCore qualifier `dev`; capture runtime ARN as a CDK output
    - _Requirements: 12.1, 12.5; Design Migration Phase 1_

  - [ ]* 9.3 CDK snapshot test for the new constructs
    - In `infrastructure/test/foot-solutions-stack.test.ts`, snapshot the synthesized template's `AWS::BedrockAgentCore::Runtime`, ECR repo, and AgentCore execution role
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [ ] 10. Phase 1 Checkpoint
  - Smoke-test the dev runtime: `agentcore invoke` with payload `{ messages: [{role:'user',content:'hi'}], callerUserId:'test', isAdmin:false }` returns `{ reply, route: 'general' }`, HTTP 200
  - Ensure all tests pass, ask the user if questions arise.

### Phase 2: Edge Lambda + endpoint + chat history extension

- [x] 11. Implement `assistantEdgeFn` Lambda
  - [x] 11.1 Create `lambda/assistant/index.ts` with JWT extraction and request validation
    - Extract `callerUserId` from `jwt.claims.sub`; derive `isAdmin = email.toLowerCase() === ADMIN_EMAIL.toLowerCase()` using the same logic as `lambda/heartland/index.ts` `isAdminCaller`
    - Reject with HTTP 400 when the latest user message exceeds 8000 characters (Req 13.2) before any AgentCore call
    - Reject with HTTP 200 + turn-cap reply when `messages.length > 50` (Req 13.3) before any AgentCore call
    - Generate a new `sessionId` UUID when one is not provided (Req 2.3)
    - Gate everything behind `process.env.ASSISTANT_ENABLED === 'true'`; return 404 when disabled
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 6.1, 13.2, 13.3_

  - [x] 11.2 Implement DynamoDB-backed rate limiter
    - Use a `RATE#<userId>#<minute-bucket>` item with `ADD count :one`, conditional `if_not_exists(count, :zero) <= 60`, TTL 120s, per Design §2 step 2
    - On limit exceeded, return HTTP 429 with `Retry-After` header **before** any AgentCore call and **before** any history write (Req 13.1)
    - _Requirements: 13.1; Design §Failure mode table_

  - [x] 11.3 Implement AgentCore invocation
    - Use `@aws-sdk/client-bedrock-agentcore` `InvokeAgentRuntimeCommand` with `agentRuntimeArn=process.env.FS_ASSISTANT_RUNTIME_ARN`, `runtimeSessionId=sessionId`, `runtimeUserId=callerUserId`, JSON payload `{ messages, callerUserId, isAdmin }`
    - Map errors per Design §Failure mode table: `ThrottlingException` → 503 + `Retry-After: 5`; `ResourceNotFoundException` → 500; AgentCore graceful error JSON → 200 passthrough
    - _Requirements: 2.4, 6.2, 9.3, 9.5, 12.2_

  - [x] 11.4 Implement history persistence after each turn
    - When `messages.length >= 4` (≥ 2 user-assistant exchanges per Req 7.1), `UpdateItem` on `userId + CHAT_HISTORY#assistant#<sessionId>` appending the new user turn and assistant turn with the per-turn `route` and `attachments` fields per Design §Per-turn history shape
    - Compute `ttl = lastMessageAt + 30 days` (Req 7.3) and refresh on every update
    - _Requirements: 7.1, 7.2, 7.3; Design §Per-turn history shape_

  - [x] 11.5 Emit custom CloudWatch metrics
    - `cloudwatch:PutMetricData` for `AssistantRouteCount` (dim `route`) and `OrchestratorTurnLatencyMs` per Design §Observability
    - _Requirements: 12.5; Design §Observability_

  - [ ]* 11.6 Write property test for the rate limiter
    - **Property 5: Rate limit denies before agent invocation**
    - **Validates: Requirements 13.1**
    - Generate arbitrary sequences of N requests for a single `callerUserId` within a 60s window with N ranging 0..120
    - Assert: requests 1..60 succeed (call AgentCore mock + history-write mock); request 61+ within the window return HTTP 429 with `Retry-After`, do NOT call the AgentCore mock, and do NOT call the history-write mock
    - Tag: `// Feature: fs-assistant-orchestrator, Property 5: Rate limit denies before agent invocation`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 13.1_

  - [ ]* 11.7 Write property test for length validator
    - **Property 6: Message-length validation rejects before agent invocation**
    - **Validates: Requirements 13.2**
    - Generate arbitrary user-message strings; assert that any message > 8000 chars produces HTTP 400 with no AgentCore call and no history write, and any message ≤ 8000 chars proceeds normally
    - Tag: `// Feature: fs-assistant-orchestrator, Property 6: Message-length validation rejects before agent invocation`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 13.2_

  - [ ]* 11.8 Write property test for history append round-trip
    - **Property 3: History append preserves prior turns**
    - **Validates: Requirements 7.1, 7.2, 7.4**
    - Generate arbitrary sequences of N turns each tagged with a `route` from `{sales, inbox, both, general}`; persist via the history-write helper in the edge Lambda against an in-memory DynamoDB stub
    - Assert: querying the resulting session returns all N turns in chronological order with no loss/duplication, and each persisted turn's `route` matches the response's `route` for that turn
    - Tag: `// Feature: fs-assistant-orchestrator, Property 3: History append preserves prior turns`
    - `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 7.1, 7.2, 7.4_

- [x] 12. CDK: wire the edge Lambda into API Gateway behind the feature flag
  - [x] 12.1 Add `assistantEdgeFn` Lambda + `/assistant/chat` route to `FsAssistantStack`
    - Node 20, 256 MB, 90s timeout (per Design §2)
    - Env vars: `FS_ASSISTANT_RUNTIME_ARN`, `ADMIN_EMAIL`, `ASSISTANT_ENABLED` (default `'false'`), `TABLE_NAME`
    - IAM role with the Lambda-side IAM Matrix entries (`bedrock-agentcore:InvokeAgentRuntime`, `bedrock-agentcore:InvokeAgentRuntimeForUser`, scoped DynamoDB on `FootSolutionsApp` with `LeadingKeys=userId`, `cloudwatch:PutMetricData`)
    - Wire as `POST /assistant/chat` on the existing API Gateway HTTP API behind the JWT authorizer
    - _Requirements: 2.1, 2.5, 12.2; Design §IAM Matrix_

- [x] 13. Extend the chat-history endpoint to support `?type=assistant` and `?type=all`
  - [x] 13.1 Add `?type=assistant` to the existing `chatFn` Lambda
    - `GET /chat/history?type=assistant` lists `CHAT_HISTORY#assistant#*` for the caller
    - `GET /chat/history/{sessionId}?type=assistant` fetches a single new-format session
    - `POST /chat/history` accepts `type='assistant'` with the per-turn `route` and `attachments` fields per Design §Data Models
    - `DELETE /chat/history/{sessionId}?type=assistant` mirrors existing logic
    - _Requirements: 7.1, 7.2, 7.4, 7.5; Design §Component 5 chat history endpoints_

  - [x] 13.2 Add `?type=all` unified-list mode
    - `GET /chat/history?type=all` queries all three SK prefixes (`CHAT_HISTORY#sales#`, `CHAT_HISTORY#inbox#`, `CHAT_HISTORY#assistant#`), caps each prefix at 50 results, and returns each session with `legacy: boolean` and `displayLabel: string` (`"Sales (legacy)"`, `"Inbox (legacy)"`, `"FS Assistant"`) per Design §Component 5
    - Sessions returned only for the Caller_User_Id (Req 7.5)
    - This task MUST land in Phase 2, before the frontend cutover, so legacy sessions are visible after Phase 4 (Req 10.3, 10.4)
    - _Requirements: 7.5, 10.3, 10.4; Design §Component 5 chat history endpoints, Open Question 5_

  - [ ]* 13.3 Write integration test for `?type=all` mixed legacy + new sessions
    - Seed the test table with one session of each type for a single user; assert the response contains all three with correct `legacy` flags and `displayLabel` values
    - _Requirements: 10.3, 10.4_

- [ ] 14. Phase 2 Checkpoint
  - Run `lambda/assistant/__tests__/*.pbt.ts` and confirm Properties 3, 5, 6 pass with `numRuns: 100`
  - Hit `POST /assistant/chat` against the deployed dev runtime end-to-end (admin and non-admin) with `ASSISTANT_ENABLED=true` set on a dev stage
  - Ensure all tests pass, ask the user if questions arise.

### Phase 3: Frontend `<FsAssistant />` and `<ProtectedShell />`

- [x] 15. Build the FS Assistant frontend
  - [x] 15.1 Create the Zustand store at `src/lib/fsAssistantStore.ts`
    - Holds `{ open: boolean, sessionId: string | null, messages: Message[], history: HistorySession[] }` per Design §Component 1
    - Actions: `open()`, `close()`, `appendUserMessage`, `appendAssistantReply`, `loadSession`, `clearSession`
    - _Requirements: 1.5; Design §Component 1 state persistence_

  - [x] 15.2 Implement `<FsAssistant />` component at `src/components/FsAssistant.tsx`
    - Mirror the visual language of existing `SalesChat.tsx` but with header label exactly `"FS Assistant"` (Req 1.4)
    - Floating bubble bottom-right; panel capped at `min(80vh, 720px)` height (Req 1.3)
    - `useMutation` against `POST /assistant/chat` reading the Cognito ID token; on success, append the assistant reply with `route` and `attachments` to the store
    - Render attachment chips via the existing `AttachmentChip.tsx` consuming the `attachments[]` field unchanged (Req 5.2, 8.2)
    - Suggested-questions deck with three categories (sales, inbox, mixed) per Design §Component 1
    - Read the Vite env flag (`VITE_ASSISTANT_ENABLED`); render nothing when off
    - _Requirements: 1.1, 1.3, 1.4, 1.6, 5.2, 8.2; Design §Component 1_

  - [x] 15.3 Wire chat history list to `?type=all`
    - Fetch via `GET /chat/history?type=all`, render with `displayLabel` per session, badge legacy sessions visually so users can tell `"Sales (legacy)"` / `"Inbox (legacy)"` apart from `"FS Assistant"` (Req 10.4)
    - On click, load the session via `GET /chat/history/{sessionId}?type=<type>` and continue the same `sessionId` (Req 7.4) — for legacy sessions, viewing only (no continuation into the new orchestrator)
    - _Requirements: 7.4, 10.3, 10.4_

  - [ ]* 15.4 Write unit tests for `<FsAssistant />`
    - Header label is `"FS Assistant"`; bubble does not exceed 80vh; mutation posts to `/assistant/chat`; attachment chips render when `attachments` is non-empty
    - _Requirements: 1.3, 1.4, 5.2_

- [x] 16. Mount `<FsAssistant />` globally via `<ProtectedShell />`
  - [x] 16.1 Add `<ProtectedShell />` wrapper in `src/App.tsx`
    - Defines `function ProtectedShell({ children })` rendering `<ErrorBoundary>{children}<FsAssistant /></ErrorBoundary>` per Design §Component 1 mount point
    - Wrap each protected route's element with `<ProtectedShell>` so the bubble appears on `/`, `/sales`, `/gmail`, `/credentials`, `/tax` (Req 1.1) and NOT on `/login` or `/callback` (Req 1.2)
    - Bubble survives navigation between protected routes via the Zustand store (Req 1.5)
    - This is a high-blast-radius change — verify visually that EVERY protected route still renders correctly (no layout regression, no double-bubble) before proceeding to Phase 4
    - _Requirements: 1.1, 1.2, 1.5; Design §Component 1 mount point_

  - [ ]* 16.2 Write integration test for `<ProtectedShell />` mounting
    - Render the app at each protected route and assert exactly one `<FsAssistant />` is in the DOM; render at `/login` and `/callback` and assert zero `<FsAssistant />` is in the DOM
    - _Requirements: 1.1, 1.2_

- [ ] 17. Phase 3 Checkpoint
  - With `VITE_ASSISTANT_ENABLED=false` in prod and `=true` on a dev preview, confirm the bubble appears only on dev preview and behaves correctly across navigation
  - Existing `<SalesChat />` and `<GmailChat />` are still mounted on their pages — that is intentional for Phase 3 (Migration Phase 3)
  - Ensure all tests pass, ask the user if questions arise.

### Phase 4: Cutover release

- [ ] 18. Cutover: enable feature flags + remove page-scoped chats
  - [ ] 18.1 Flip the feature flags
    - Set `ASSISTANT_ENABLED=true` on the prod `assistantEdgeFn` Lambda (CDK env var change)
    - Set `VITE_ASSISTANT_ENABLED=true` in the prod build env
    - This is the single cutover moment — Phase 4
    - _Requirements: 10.1; Design Migration Phase 4_

  - [ ] 18.2 Remove `<SalesChat />` from `src/pages/SalesRevenue.tsx` and `<GmailChat />` from `src/pages/GmailAnalysis.tsx`
    - Delete the JSX mounts only (do NOT delete the component files, do NOT touch their `useMutation` plumbing yet — those go in the Phase 5 cleanup, after the 14-day soak)
    - Verify no two chat bubbles render simultaneously on `/sales` or `/gmail` (Req 1.7)
    - Do NOT remove or modify the legacy `/pos/chat` Lambda (`lambda/chat/index.ts`), the legacy `/gmail/chat` Lambda (`lambda/gmail-analysis/index.ts`), or their API Gateway routes — they MUST stay deployed for rollback through the soak period (Req 10.2)
    - _Requirements: 1.7, 10.1, 10.2; Design Migration Phase 4_

- [x] 19. CloudWatch dashboard + alarms for the cutover
  - [x] 19.1 Provision the `FsAssistant` CloudWatch dashboard and alarms in CDK
    - Three rows per Design §Observability: routing distribution (stacked area on `AssistantRouteCount`), latency (p50/p95/p99 on `OrchestratorTurnLatencyMs` + per-sub-agent p95 on `SubAgentLatencyMs`), errors (4xx/5xx + AgentCore failures + `SubAgentUnavailable`)
    - Alarms per Design §Alarms (CloudWatch): orchestrator p95 > 8s, edge 5xx > 2%, `SubAgentUnavailable` > 5/min, `BedrockThrottlingException` > 5/min
    - _Requirements: 11.1, 11.2, 12.5; Design §Observability, §Alarms_

- [ ] 20. Phase 4 Checkpoint (cutover validation)
  - Run the 12-question UAT matrix from Design §Testing Strategy against prod, confirming each `route` value matches the expected column and the admin vs non-admin gate behaves correctly
  - Confirm that legacy sessions render under the chat-history list with `(legacy)` labels (Req 10.4)
  - Confirm `/pos/chat` and `/gmail/chat` still respond 200 to direct requests for rollback (Req 10.2)
  - Ensure all tests pass, ask the user if questions arise.

### Phase 5: Soak monitoring (no code tasks; gates Phase 6)

- [x] 21. Soak window watchdog (14 days)
  - [x] 21.1 Configure a 14-day soak watchdog
    - Add a CloudWatch composite alarm `FsAssistantSoakHealth` that breaches if any of the Phase 4 alarms fire during the soak window
    - This task ships the alarm; the actual 14-day wait happens outside the code path
    - Cleanup of legacy `/pos/chat`, `/gmail/chat` Lambdas, routes, and `<SalesChat />` / `<GmailChat />` component files is INTENTIONALLY NOT scheduled in this plan — it is a follow-up spec after the soak completes per Req 10.2 and Design Migration Phase 5
    - _Requirements: 10.2; Design Migration Phase 5_

- [ ] 22. Final checkpoint
  - Confirm all 7 property tests have run with `numRuns: 100` and passed
  - Confirm dashboards are populated and alarms are healthy
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP. Optional sub-tasks here cover unit tests, property-based tests, CDK snapshot tests, and integration tests.
- Each task references specific requirements (e.g. _Requirements: 6.3_) and design sections for traceability.
- Property-based tests use `fast-check` with `numRuns: 100` minimum. Each test is tagged `// Feature: fs-assistant-orchestrator, Property <N>: <text>`. The seven properties are covered by tasks 6.3 (P4), 8.5 (P1), 8.6 (P2), 8.7 (P7), 11.6 (P5), 11.7 (P6), and 11.8 (P3).
- The legacy `/pos/chat` and `/gmail/chat` Lambdas + routes are intentionally **not** deleted by Phase 4 — they stay deployed for the one-release rollback window (Req 10.2). Cleanup is a follow-up spec after the 14-day soak.
- The chat-history `?type=all` mode (Task 13.2) is sequenced into Phase 2 deliberately so that when the cutover happens (Phase 4) legacy sessions are already visible to users (Req 10.3, 10.4).
- The admin gate (Property 4) lives **inside the gated tool callbacks** (Task 6.1), not in the orchestrator — the orchestrator never sees the data domain, only the sub-agent reply.
- Cost-tracker badge (`CostBadge`) and other unrelated dashboard work is explicitly out of scope and not represented here.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "5.1"] },
    { "id": 3, "tasks": ["5.2", "6.1", "7.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "7.2"] },
    { "id": 5, "tasks": ["8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 7, "tasks": ["8.5", "8.6", "8.7", "9.1"] },
    { "id": 8, "tasks": ["9.2", "9.3"] },
    { "id": 9, "tasks": ["11.1"] },
    { "id": 10, "tasks": ["11.2", "11.3", "11.4", "11.5"] },
    { "id": 11, "tasks": ["11.6", "11.7", "11.8", "12.1", "13.1"] },
    { "id": 12, "tasks": ["13.2"] },
    { "id": 13, "tasks": ["13.3", "15.1"] },
    { "id": 14, "tasks": ["15.2", "15.3"] },
    { "id": 15, "tasks": ["15.4", "16.1"] },
    { "id": 16, "tasks": ["16.2", "18.1", "18.2"] },
    { "id": 17, "tasks": ["19.1"] },
    { "id": 18, "tasks": ["21.1"] }
  ]
}
```
