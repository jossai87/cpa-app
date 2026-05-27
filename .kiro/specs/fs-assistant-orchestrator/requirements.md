# Requirements Document

## Introduction

The FS Assistant Orchestrator replaces the two existing page-scoped chatbots — SalesChat (POST /pos/chat) on the Sales & Revenue page, and GmailChat (POST /gmail/chat) on the Gmail Analysis page — with a single unified assistant called "FS Assistant" that is available on every authenticated page of the application.

The new assistant runs as a multi-agent system on Amazon Bedrock AgentCore Runtime using the Strands Agents framework. A top-level Orchestrator Agent receives every user message, classifies the intent, and delegates the work to the appropriate specialist sub-agent — either the Sales Agent (POS / Heartland data) or the Inbox Agent (Gmail data). The orchestrator returns a unified response to the user without exposing the routing decision unless asked.

The goal is to remove the seam between the two assistants so that the user can ask one question that spans both domains (e.g. "did Brooks email us about the order I placed yesterday?") and get a single coherent answer, while preserving separation of duty between the sub-agents so each one only has access to the data it owns.

## Glossary

- **FS Assistant**: The user-facing brand name for the unified assistant. Surfaces in the UI as a single floating chat bubble on every page.
- **Orchestrator_Agent**: The top-level Strands agent on AgentCore Runtime. Receives all user messages, classifies intent, delegates to sub-agents via tool calls, and synthesizes the final response. Owns no business data tools directly.
- **Sales_Agent**: Specialist sub-agent that owns Heartland POS data (sales, returns, inventory, staff, purchasing, brands, vendor directory). Mirrors the current capabilities of the `/pos/chat` Lambda.
- **Inbox_Agent**: Specialist sub-agent that owns Gmail data (cached message search, vendor activity, attachments, thread reads). Mirrors the current capabilities of the `/gmail/chat` Lambda.
- **Sub_Agent**: Either Sales_Agent or Inbox_Agent. Generic term used when a requirement applies to both.
- **AgentCore_Runtime**: Amazon Bedrock AgentCore Runtime, the GA managed service that hosts the orchestrator and sub-agents.
- **Strands_Framework**: The open-source Strands Agents Python framework used to define agent loops and tool use.
- **Routing_Decision**: The orchestrator's choice of which sub-agent to invoke (Sales_Agent, Inbox_Agent, both, or neither) for a given user turn.
- **Conversation_Session**: A single chat session, identified by a UUID, scoped to one authenticated user. Messages and routing decisions within a session share context.
- **Admin_User**: A user whose email matches `ADMIN_EMAIL` in `src/lib/admin.ts` (currently `jandoossai@gmail.com`). Sees admin-only data.
- **Standard_User**: Any authenticated user who is not the Admin_User.
- **Caller_User_Id**: The `sub` claim from the Cognito JWT of the authenticated user making the request.
- **Owner_User_Id**: The single Heartland/Gmail account owner ID (currently `OWNER_USER_ID` env var). Both sub-agents read business data scoped to this ID, regardless of which user is asking.
- **Chat_History_Store**: The DynamoDB table partition that persists chat sessions per user with a 30-day TTL, currently keyed by `userId` + `CHAT_HISTORY#<type>#<sessionId>`.

## Requirements

### Requirement 1: Unified FS Assistant UI on every page

**User Story:** As an authenticated user, I want one FS Assistant available on every page of the app, so that I do not have to navigate to a specific page to ask a sales or inbox question.

#### Acceptance Criteria

1. WHEN an authenticated user views any protected route (`/`, `/sales`, `/gmail`, `/credentials`, `/tax`), THE FS_Assistant SHALL render a floating chat bubble in the bottom-right corner of the viewport.
2. WHEN the user is on the `/login` or `/callback` route, THE FS_Assistant SHALL NOT render.
3. WHEN the user clicks the FS Assistant bubble, THE FS_Assistant SHALL open a chat panel anchored to the bottom-right that does not block primary page content above 80% of viewport height.
4. THE FS_Assistant SHALL display the label "FS Assistant" in the chat panel header.
5. WHEN the user navigates between protected routes with the chat panel open, THE FS_Assistant SHALL preserve the open state and the in-progress conversation.
6. THE FS_Assistant SHALL render the same UI for Admin_User and Standard_User; visibility of any data inside responses is controlled by the sub-agents, not the bubble.
7. WHERE the existing SalesChat or GmailChat components are mounted in `SalesRevenue.tsx` or `GmailAnalysis.tsx`, THE FS_Assistant SHALL replace them so that no two chat bubbles render simultaneously.

### Requirement 2: Single backend entrypoint for all chat traffic

**User Story:** As a frontend developer, I want one HTTP endpoint behind the FS Assistant, so that the client does not have to know which sub-agent will handle a question.

#### Acceptance Criteria

1. WHEN the FS_Assistant sends a user message, THE FS_Assistant SHALL POST it to a single endpoint `POST /assistant/chat`.
2. THE `/assistant/chat` request body SHALL contain the message list `Array<{ role: 'user' | 'assistant'; content: string }>` and an optional `sessionId` UUID.
3. WHEN `/assistant/chat` is called without a `sessionId`, THE Orchestrator_Agent SHALL generate a new UUID and return it in the response so the client can associate follow-up turns.
4. THE `/assistant/chat` response SHALL contain `{ reply: string, sessionId: string, route: 'sales' | 'inbox' | 'both' | 'general' }` where `route` reports which Sub_Agent(s) handled the turn.
5. IF the caller is unauthenticated, THEN THE `/assistant/chat` endpoint SHALL return HTTP 401 without invoking any agent.

### Requirement 3: Orchestrator routing and delegation

**User Story:** As a user, I want the assistant to figure out on its own whether my question is about sales or email, so that I never have to specify which assistant to use.

#### Acceptance Criteria

1. WHEN `/assistant/chat` receives a user message, THE Orchestrator_Agent SHALL classify the message intent into one of: sales-only, inbox-only, both, or general.
2. WHEN the intent is sales-only, THE Orchestrator_Agent SHALL invoke the Sales_Agent via a Strands tool call and SHALL NOT invoke the Inbox_Agent for that turn.
3. WHEN the intent is inbox-only, THE Orchestrator_Agent SHALL invoke the Inbox_Agent via a Strands tool call and SHALL NOT invoke the Sales_Agent for that turn.
4. WHEN the intent is both, THE Orchestrator_Agent SHALL invoke both sub-agents, in either order, and SHALL synthesize a single combined response.
5. WHEN the intent is general (greeting, capability question, off-topic), THE Orchestrator_Agent SHALL respond directly without invoking any Sub_Agent.
6. THE Orchestrator_Agent SHALL NOT have direct access to DynamoDB business data, Heartland data, or Gmail data; data access SHALL flow exclusively through Sub_Agent tool calls.
7. WHEN the Orchestrator_Agent is about to invoke a Sub_Agent, THE Orchestrator_Agent SHALL emit a brief progress note to the user (e.g. "Checking sales data…", "Checking the inbox…") consistent with the announcement pattern already used in the existing SalesChat and GmailChat system prompts.
8. WHEN the user message is genuinely ambiguous about which Sub_Agent should answer, THE Orchestrator_Agent SHALL ask one clarifying question before delegating, instead of guessing.

### Requirement 4: Sales Agent capability parity

**User Story:** As a user, I want the FS Assistant to answer every question that the old SalesChat could answer, so that nothing regresses during the migration.

#### Acceptance Criteria

1. THE Sales_Agent SHALL expose tool calls for, at minimum: vendor contact lookup, sales summary by date range, returns by brand and year, inventory queries, staff performance queries, purchasing queries, and brand performance queries — covering the existing tool surface of `lambda/chat/index.ts`.
2. WHEN the Sales_Agent receives a delegated question, THE Sales_Agent SHALL execute its tool loop against the same DynamoDB table currently used by `/pos/chat`, scoped to the Owner_User_Id.
3. THE Sales_Agent SHALL return a single text reply to the Orchestrator_Agent, formatted for direct inclusion in a user-facing response.
4. THE Sales_Agent SHALL NOT have direct access to Gmail data tools.

### Requirement 5: Inbox Agent capability parity

**User Story:** As a user, I want the FS Assistant to answer every question that the old GmailChat could answer, so that nothing regresses during the migration.

#### Acceptance Criteria

1. THE Inbox_Agent SHALL expose tool calls for, at minimum: cached query, cached read, cached vendor activity, cache stats, thread id resolution, and (where currently available) Tavily web search and KB semantic search — covering the existing tool surface of `lambda/gmail-analysis/index.ts`.
2. WHEN the Inbox_Agent reads an email that has attachments, THE Inbox_Agent SHALL include attachment metadata in its reply in the same shape currently consumed by `AttachmentChip.tsx`.
3. WHEN the Inbox_Agent receives a delegated question, THE Inbox_Agent SHALL execute its tool loop against the same Gmail cache currently used by `/gmail/chat`, scoped to the Owner_User_Id.
4. THE Inbox_Agent SHALL NOT have direct access to Heartland POS tools.

### Requirement 6: User identity propagation and admin scoping

**User Story:** As the system owner, I want the assistant to know who is asking so that admin-only data is only revealed to the admin, while still letting non-admin users see the operational data they need.

#### Acceptance Criteria

1. WHEN `/assistant/chat` is invoked, THE Orchestrator_Agent SHALL receive the Caller_User_Id and an `isAdmin` boolean derived from the JWT email claim matching `ADMIN_EMAIL`.
2. THE Orchestrator_Agent SHALL pass the Caller_User_Id and `isAdmin` flag to every Sub_Agent invocation as part of the delegation payload.
3. WHEN `isAdmin` is false AND the user requests data behind an admin-gated visibility key (matching the existing `VISIBILITY_KEYS` map in `src/lib/admin.ts`, e.g. `sales.staff.beckyCommission`), THE Sales_Agent SHALL refuse to return that data and SHALL respond with a non-revealing message such as "That information isn't available to your account."
4. THE Sub_Agents SHALL continue to read business data scoped to Owner_User_Id regardless of who is asking, because the store's Heartland and Gmail data is shared.

### Requirement 7: Conversation history per user

**User Story:** As a user, I want my chat history with the FS Assistant to persist across sessions so that I can revisit past conversations.

#### Acceptance Criteria

1. WHEN a Conversation_Session reaches at least two user-assistant exchanges, THE FS_Assistant SHALL persist the session to the Chat_History_Store keyed by `userId` and a sort key of the form `CHAT_HISTORY#assistant#<sessionId>`.
2. THE persisted session SHALL include, for each turn, the user message, the assistant reply, and the Routing_Decision (`sales`, `inbox`, `both`, or `general`).
3. THE persisted session SHALL expire 30 days after last update via DynamoDB TTL, matching the current chat history retention.
4. WHEN the user opens a past session via the chat history panel, THE FS_Assistant SHALL load the message list and continue the conversation in the same session UUID.
5. THE chat history list endpoint SHALL return only sessions belonging to the Caller_User_Id.

### Requirement 8: Cross-domain question handling

**User Story:** As a user, I want to ask a question that spans both POS and inbox data and get one synthesized answer, so that I don't have to mentally stitch together two replies.

#### Acceptance Criteria

1. WHEN a user asks a question that requires both POS and Gmail data (e.g. "did the brand with the highest return rate email us this week?"), THE Orchestrator_Agent SHALL invoke both Sub_Agents and combine their replies into a single coherent response.
2. WHEN combining replies, THE Orchestrator_Agent SHALL preserve attachment metadata returned by the Inbox_Agent so that AttachmentChip rendering still works in the UI.
3. WHEN one Sub_Agent's reply contradicts or makes assumptions that the other Sub_Agent's data can resolve, THE Orchestrator_Agent SHALL prefer the Sub_Agent that owns the contradicting data domain in its synthesized answer.

### Requirement 9: Failure modes and graceful degradation

**User Story:** As a user, I want the FS Assistant to keep working when one part of the system is down, so that a single failure doesn't block all my questions.

#### Acceptance Criteria

1. IF the Sales_Agent is unavailable or its invocation returns an error, THEN THE Orchestrator_Agent SHALL respond to the user with a message that names the unavailable capability ("Sales data is temporarily unavailable") and SHALL still answer any inbox-only portion of the question if applicable.
2. IF the Inbox_Agent is unavailable or its invocation returns an error, THEN THE Orchestrator_Agent SHALL respond to the user with a message that names the unavailable capability ("Inbox data is temporarily unavailable") and SHALL still answer any sales-only portion of the question if applicable.
3. IF both Sub_Agents are unavailable, THEN THE Orchestrator_Agent SHALL return HTTP 200 with a reply explaining that data lookups are temporarily down and SHALL NOT return HTTP 5xx.
4. IF a Sub_Agent invocation exceeds 60 seconds, THEN THE Orchestrator_Agent SHALL abort that invocation, treat it as unavailable, and inform the user.
5. IF Bedrock returns a throttling error to the Orchestrator_Agent, THEN THE Orchestrator_Agent SHALL retry with exponential backoff up to 3 attempts before returning a user-facing error.

### Requirement 10: Migration from existing endpoints

**User Story:** As the system owner, I want to cut over to the FS Assistant without breaking active sessions or losing chat history, so that the migration is invisible to end users.

#### Acceptance Criteria

1. WHEN the FS Assistant ships, THE FS_Assistant SHALL replace the SalesChat and GmailChat components in `SalesRevenue.tsx` and `GmailAnalysis.tsx` in the same release that introduces the global bubble.
2. THE existing `/pos/chat` and `/gmail/chat` HTTP endpoints SHALL remain deployed and functional for one release cycle after the FS Assistant ships, to allow rollback.
3. WHEN a user opens chat history, THE FS_Assistant SHALL display sessions persisted under the new `assistant` history type AND SHALL also display legacy sessions persisted under `sales` and `inbox` history types until the rollback window closes.
4. WHERE legacy sessions are displayed, THE FS_Assistant SHALL label them with their original type ("Sales", "Inbox") so the user can tell them apart from new unified sessions.

### Requirement 11: Cost and latency expectations

**User Story:** As the system owner, I want the FS Assistant to not be meaningfully slower or more expensive than the two-bot setup, so that consolidation does not regress the user experience or run up the Bedrock bill.

#### Acceptance Criteria

1. WHEN a user message is classified as sales-only or inbox-only, THE Orchestrator_Agent SHALL complete the turn (first byte of reply) within 8 seconds at the 95th percentile under nominal Bedrock latency.
2. WHEN a user message requires both Sub_Agents, THE Orchestrator_Agent SHALL complete the turn within 15 seconds at the 95th percentile.
3. THE Orchestrator_Agent SHALL use a smaller, faster model (e.g. Claude Haiku 4.5) for the routing classification step where possible, reserving the larger Sonnet 4.6 model for sub-agent reasoning.
4. WHEN the Orchestrator_Agent invokes only one Sub_Agent for a turn, THE total Bedrock invocation count for that turn SHALL be at most one orchestrator-routing call plus one sub-agent tool loop.

### Requirement 12: AgentCore deployment and IAM scoping

**User Story:** As the system owner, I want each agent to have only the AWS permissions it strictly needs, so that the principle of least privilege is preserved across the multi-agent system.

#### Acceptance Criteria

1. THE Orchestrator_Agent SHALL be deployed on Amazon Bedrock AgentCore Runtime as a code-based agent built with the Strands Agents framework.
2. THE Orchestrator_Agent's execution role SHALL grant Bedrock model invocation permissions for the orchestrator's chosen model and SHALL grant invocation permissions for the Sales_Agent and Inbox_Agent endpoints, and SHALL NOT grant direct DynamoDB or Gmail access.
3. THE Sales_Agent's execution role SHALL grant DynamoDB read and write access scoped to the existing application table only, and Bedrock model invocation, and SHALL NOT grant Gmail access.
4. THE Inbox_Agent's execution role SHALL grant Gmail OAuth secret access (the existing `foot-solutions/gmail/*` secrets), DynamoDB read and write access scoped to the existing application table only, Bedrock model invocation, and Tavily and vector-index access where currently used, and SHALL NOT grant Heartland POS data access beyond what `gmail-analysis` already has.
5. WHEN the FS Assistant is deployed, THE deployment SHALL configure AgentCore observability so that orchestrator decisions, sub-agent invocations, latencies, and errors are emitted to CloudWatch in the existing `us-east-1` region.

### Requirement 13: Rate limiting and abuse protection

**User Story:** As the system owner, I want per-user limits on the FS Assistant so that one user cannot run up the Bedrock bill or starve others.

#### Acceptance Criteria

1. WHEN a Caller_User_Id has sent more than 60 messages to `/assistant/chat` in the last 60 seconds, THE FS_Assistant SHALL return HTTP 429 with a retry-after header and SHALL NOT invoke any agent.
2. WHEN a single user message exceeds 8000 characters, THE FS_Assistant SHALL return HTTP 400 and SHALL NOT invoke any agent.
3. WHEN a Conversation_Session exceeds 50 turns, THE Orchestrator_Agent SHALL prompt the user to start a new chat and SHALL NOT continue extending the session indefinitely.
