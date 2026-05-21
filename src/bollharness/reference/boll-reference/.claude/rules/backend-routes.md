---
paths:
  - "backend/product/routes/**"
  - "backend/server.py"
  - "backend/product/protocol/**"
  - "backend/product/auth/**"
  - "backend/product/coaching/**"
  - "backend/product/hackathon/**"
  - "backend/product/bridge/**"
  - "backend/product/a2a/**"
  - "backend/product/matching/**"
  - "backend/product/messaging/**"
  - "backend/product/public_profiles/**"
  - "backend/product/inbox/**"
  - "mcp-server/boll_mcp/**"
  - "mcp-server-node/src/**"
---

# Runtime Routes

## Core
- `GET /health`

## Field API (`/field/api`)
- `GET /field/api/stats`
- `POST /field/api/deposit` (**admin-only**)
- `POST /field/api/load-profiles` (**admin-only**)
- `POST /field/api/match-perspectives` (**admin-only**)
- `POST /field/api/match`
- `POST /field/api/match-owners`

## Product API (`/api`)
- `POST /api/register` — invite-code + email registration
- `POST /api/login` — email + password login
- `POST /api/logout` — session logout
- `PUT /api/change-password` — change password (session auth)
- `GET /api/profile` — get current user profile
- `PUT /api/profile` — update profile
- `PATCH /api/profile/visibility` — toggle profile visibility
- `GET /api/ws-ticket` — WebSocket auth ticket
- `POST /api/demands` — create demand (clarification-session)
- `PUT /api/demands/{demand_id}/confirm` — confirm demand
- `POST /api/demands/{demand_id}/start` — start convergence run
- `GET /api/demands` — list user demands
- `GET /api/demands/{demand_id}` — demand detail
- `GET /api/runs/{run_id}` — run status (+ participant_names)
- `GET /api/runs/{run_id}/result` — run result (+ participant_names)
- `WS /ws/runs/{run_id}` — run progress WebSocket
- `POST /api/admin/invite-codes` (**admin-only**)
- `POST /api/admin/stream-token` (**admin-only**) — SSE auth token
- `GET /api/admin/stream` (**admin-only**) — SSE event stream
- `GET /api/admin/bridges` (**admin-only**) — bridge instance status
- `GET /api/admin/runs` (**admin-only**) — runs list with filters
- `GET /api/admin/runs/{run_id}/events` (**admin-only**) — run event log
- `GET /api/admin/invite-chain` (**admin-only**) — invite tree tracing (PLAN-064)
- `GET /api/admin/usage/overview` (**admin-only**) — usage analytics overview
- `GET /api/admin/usage/events` (**admin-only**) — usage event log
- `GET /api/admin/usage/report` (**admin-only**) — usage report
- `GET /api/admin/users-overview` (**admin-only**) — all users overview
- `GET /api/admin/users/{user_id}/sessions` (**admin-only**) — user session history
- `GET /api/admin/sessions/turns` (**admin-only**) — session turns across users
- `GET /api/admin/config/status` (**admin-only**) — server config status
- `GET /api/dashboard` — user dashboard data
- `GET /api/metrics/platform` — platform-wide metrics

## Coaching API (`/api/coaching`)
- `POST /api/coaching/chat` — create a coaching session and stream first reply
- `POST /api/coaching/chat/{session_id}` — continue an existing coaching session
- `POST /api/coaching/report/{session_id}` — stream report generation for a session
- `GET /api/coaching/sessions` — list coaching sessions for current account
- `GET /api/coaching/sessions/{session_id}` — get coaching session detail
- `GET /api/coaching/sessions/{session_id}/report` — fetch persisted coaching report
- `POST /api/coaching/sync-profile` — sync user coaching profile to protocol layer
- `PUT /api/coaching/profile` — update user coaching profile
- `PATCH /api/coaching/sessions/{session_id}/title` — rename a coaching session
- `DELETE /api/coaching/sessions/{session_id}` — delete a coaching session
- `GET /api/coaching/profile` — get user coaching profile (profile_fields + coaching_fields + insight_overrides)
- `POST /api/coaching/profile-chat` — AI profile assistant SSE chat (no session creation)
- `PATCH /api/coaching/insight-overrides` — confirm/reject/edit AI-extracted insights
- `GET /api/coaching/operations` — list async operations (find_people/daily_surprise)
- `POST /api/coaching/behavior` — record share/download/copy behavior metrics
- `GET /api/coaching/settings/dream-consent` — get dream opt-in status
- `PUT /api/coaching/settings/dream-consent` — toggle dream opt-in
- `POST /api/coaching/dream-now` — manually trigger dream consolidation for today
- `GET /api/coaching/growth-logs` — list growth log entries
- `PATCH /api/coaching/growth-logs/{log_id}/share` — share growth log to plaza (anonymized)
- `DELETE /api/coaching/growth-logs/{log_id}/share` — revoke sharing (72h window)
- `GET /api/coaching/plaza` — **unauthenticated** browse anonymized growth logs (rate-limited: 60/min/IP)

## Coaching Admin API (`/api/coaching/admin`, **admin-only**)
- `GET /api/coaching/admin/users` — list coaching users with session counts
- `GET /api/coaching/admin/users/{account_id}` — get coaching panorama for one user
- `GET /api/coaching/admin/users/{account_id}/export` — export one user's coaching data
- `GET /api/coaching/admin/prompts` — list prompt versions for coaching prompts
- `PUT /api/coaching/admin/prompts/{prompt_name}` — create and activate a prompt version
- `POST /api/coaching/admin/prompts/{prompt_name}/preview` — render a prompt template without persisting
- `GET /api/coaching/admin/export` — export all coaching data
- `GET /api/coaching/admin/strategy` (**admin-only**) — get coaching strategy config (internal)
- `PUT /api/coaching/admin/strategy/{config_key}` (**admin-only**) — update coaching strategy config (internal)
- `GET /api/coaching/admin/operations` (**admin-only**) — list async operations (internal)
- `POST /api/coaching/admin/operations/{operation_id}/retry` (**admin-only**) — retry failed operation (internal)
- `GET /api/coaching/admin/scheduler-health` (**admin-only**) — coaching scheduler health (internal)

## Hackathon API (`/api/hackathon`, **session auth**)
- `POST /api/hackathon/events` — create hackathon event (**organizer**)
- `GET /api/hackathon/events` — list events
- `GET /api/hackathon/events/{event_id}` — event detail
- `PUT /api/hackathon/events/{event_id}` — update event (**organizer**)
- `PATCH /api/hackathon/events/{event_id}/status` — transition event status (**organizer**)
- `POST /api/hackathon/events/{event_id}/invite` — generate invite codes (**organizer**)
- `POST /api/hackathon/events/{event_id}/enrollments` — enroll in event
- `GET /api/hackathon/events/{event_id}/enrollments` — list enrollments
- `GET /api/hackathon/events/{event_id}/enrollments/mine` — my enrollment
- `PATCH /api/hackathon/enrollments/{enrollment_id}` — update enrollment role (**organizer**)
- `POST /api/hackathon/events/{event_id}/teams` — create team
- `GET /api/hackathon/events/{event_id}/teams` — list teams
- `GET /api/hackathon/teams/{team_id}` — team detail
- `POST /api/hackathon/teams/{team_id}/members` — add team member
- `DELETE /api/hackathon/teams/{team_id}/members/{agent_id}` — remove team member
- `PATCH /api/hackathon/teams/{team_id}/status` — update team status
- `POST /api/hackathon/teams/{team_id}/claim` — claim challenge
- `POST /api/hackathon/events/{event_id}/challenges` — create challenge (**organizer**)
- `GET /api/hackathon/events/{event_id}/challenges` — list challenges
- `POST /api/hackathon/teams/{team_id}/submit` — submit deliverables
- `GET /api/hackathon/events/{event_id}/reviews/assignments` — get review assignments (**judge**)
- `POST /api/hackathon/reviews` — submit review (**judge**)
- `GET /api/hackathon/events/{event_id}/reviews/summary` — review summary (**organizer**)
- `GET /api/hackathon/teams/{team_id}/reviews` — team reviews
- `POST /api/hackathon/upload/sts-token` — get OSS upload token
- `GET /api/hackathon/events/{event_id}/stats` — event statistics
- `POST /api/hackathon/events/{event_id}/import` — bulk import participants (**organizer**)
- `GET /api/hackathon/events/{event_id}/import/{job_id}` — import job status

## Public API (`/api/public`, **unauthenticated**, PLAN-064)
- `POST /api/public/registration-chat` — SSE streaming registration chat (rate-limited: 10 req/min/IP)

## Scene API (`/api/scene` + `/api/auth/secondme`)
- `GET /api/auth/secondme/url` — SecondMe OAuth URL
- `GET /api/auth/secondme/callback` — SecondMe OAuth callback (browser redirect)
- `POST /api/auth/secondme/callback` — SecondMe OAuth callback (JSON API)
- `POST /api/auth/secondme/register` — SecondMe register
- `POST /api/auth/secondme/bind` — SecondMe bind to existing account
- `POST /api/scene/chat` — SSE streaming scene chat

## A2A Protocol API (`/a2a` + `/.well-known`)
- `GET /.well-known/agent-card.json` — A2A agent card matching
- `GET /a2a/extendedAgentCard` — extended agent card
- `POST /a2a/message:send` — send A2A message
- `POST /a2a/message:stream` — stream A2A message
- `GET /a2a/tasks/{task_id}` — get A2A task
- `GET /a2a/tasks` — list A2A tasks

## Discovery Agent API (`/api/matching`)
- `GET /api/matching/agents/{agent_id}/recommendations` — list recommendations for agent
- `POST /api/matching/agents/{agent_id}/feedback` — submit matching feedback
- `GET /api/matching/agents/{agent_id}/status` — get agent matching status

## Plaza API (`/api/plaza`, **unauthenticated**)
- `GET /api/plaza/profiles` — list community profiles
- `GET /api/plaza/profiles/{user_id}` — get community profile detail
- `GET /api/plaza/projects` — list community projects
- `GET /api/plaza/demands` — list community demands

## Public Profiles API (`/api/public-profiles`)
- `PUT /api/public-profiles/{agent_id}` — update public profile
- `GET /api/public-profiles` — list public directory
- `GET /api/public-profiles/lookup` — lookup public profiles
- `GET /api/public-profiles/{agent_id}` — get public profile

## DID API
- `GET /user/{account_id}/did.json` — account-level DID document

## Bridge API (`/api/bridge`, **bridge-key auth**)
- `GET /api/bridge/pending` — poll pending runs
- `POST /api/bridge/accept` — accept a run
- `POST /api/bridge/heartbeat` — heartbeat
- `POST /api/bridge/events` — push progress events
- `POST /api/bridge/complete` — complete a run

## Protocol API (`/protocol`, **session-token auth**, MCP Server target)
- `GET /protocol` — protocol metadata + encoding package summary
- `GET /protocol/encoding-package` — full encoding package
- `GET /protocol/agents/{agent_id}/federation` — federation metadata
- `GET /protocol/agents/{agent_id}/did.json` — DID document
- `POST /protocol/auth/register` — register account + default agent
- `POST /protocol/auth/login` — login
- `POST /protocol/auth/consumer-sessions` — create consumer auth session (PLAN-064)
- `GET /protocol/auth/consumer-sessions/{auth_session_id}` — get consumer session state (PLAN-064)
- `POST /protocol/auth/consumer-sessions/{auth_session_id}/exchange` — exchange challenge for token (PLAN-064)
- `POST /protocol/auth/anp/challenge` — ANP DID challenge generation (PLAN-064)
- `POST /protocol/auth/anp/verify` — ANP DID signature verification (PLAN-064)
- `POST /protocol/auth/token` — refresh session token
- `POST /protocol/auth/logout` — logout
- `POST /protocol/auth/change-password` — change password
- `POST /protocol/auth/forgot-password` — request password reset (PLAN-064)
- `POST /protocol/auth/reset-password` — reset password with token (PLAN-064)
- `DELETE /protocol/auth/account` — delete account (PLAN-064)
- `POST /protocol/auth/byok-session` — bind BYOK API key (supports Anthropic + compatible providers: minimax; optional `base_url` for relay)
- `GET /protocol/auth/byok-session` — check BYOK status
- `DELETE /protocol/auth/byok-session` — clear BYOK binding
- `POST /protocol/auth/redeem-code` — redeem invite code → +30 quota bonus (PLAN-085 WP-03)
- `GET /protocol/account` — get current account metadata (PLAN-064)
- `POST /protocol/account/email/verification` — request email verification (PLAN-064)
- `GET /protocol/account/email/verify` — email verification callback (PLAN-064)
- `GET /protocol/inbox` — list inbox items (PLAN-064)
- `GET /protocol/inbox/{item_id}` — get inbox item detail (PLAN-064)
- `POST /protocol/inbox/{item_id}/read` — mark inbox item as read (PLAN-064)
- `POST /protocol/agents` — create agent
- `GET /protocol/agents` — list agents
- `GET /protocol/agents/public` — list public agents directory (PLAN-064)
- `GET /protocol/agents/public/{agent_id}` — get public agent detail (PLAN-064)
- `GET /protocol/agents/{agent_id}` — get agent detail
- `GET /protocol/agents/{agent_id}/quality` — get agent profile quality score (PLAN-064)
- `PUT /protocol/agents/{agent_id}` — update agent
- `PATCH /protocol/agents/{agent_id}/visibility` — set visibility
- `DELETE /protocol/agents/{agent_id}` — delete agent
- `GET /protocol/invite-codes` — list user's own invite codes (PLAN-064)
- `GET /protocol/demands/public` — list public demands (PLAN-064)
- `GET /protocol/demands/public/{demand_id}` — get public demand detail (PLAN-064)
- `PATCH /protocol/demands/{demand_id}/visibility` — toggle demand visibility (PLAN-064)
- `GET /protocol/talent-pool` — list talent pool (PLAN-064)
- `POST /protocol/talent-pool` — add agent to talent pool (PLAN-064)
- `PUT /protocol/talent-pool/{agent_id}` — update talent pool entry (PLAN-064)
- `DELETE /protocol/talent-pool/{agent_id}` — remove from talent pool (PLAN-064)
- `GET /protocol/notifications/stream` — SSE notifications stream (PLAN-064)
- `POST /protocol/clarification-sessions` — start clarification-session session
- `GET /protocol/clarification-sessions/{session_id}` — get clarification-session state
- `POST /protocol/clarification-sessions/{session_id}/reply` — continue clarification-session (SSE)
- `POST /protocol/clarification-sessions/{session_id}/confirm` — confirm + trigger matching; when `start_negotiation=true`, also starts hosted negotiation
- `POST /protocol/discover` — ad-hoc matching query; when `start_negotiation=true`, also starts hosted negotiation
- `GET /protocol/discover/{query_id}` — get matching results
- `POST /protocol/discover/{query_id}/rerun` — re-run existing matching (PLAN-064)
- `GET /protocol/recommendations/{recommendation_id}` — get recommendation detail
- `POST /protocol/invitations` — create invitation
- `GET /protocol/invitations` — list invitations
- `GET /protocol/invitations/{invitation_id}` — get invitation
- `PATCH /protocol/invitations/{invitation_id}` — accept/decline invitation
- `GET /protocol/runs/public` — list public runs (PLAN-064)
- `GET /protocol/runs/public/{run_id}` — get public run detail (PLAN-064)
- `GET /protocol/runs/public/{run_id}/result` — get public run result (PLAN-064)
- `PATCH /protocol/runs/{run_id}/visibility` — toggle run visibility (PLAN-064)
- `POST /protocol/runs` — legacy invitation-based run creation
- `GET /protocol/runs/{run_id}` — run status
- `GET /protocol/runs/{run_id}/prompt` — get current round prompt
- `POST /protocol/runs/{run_id}/respond` — submit participant response
- `GET /protocol/runs/{run_id}/result` — get run result
- `WS /protocol/runs/{run_id}/stream` — run progress WebSocket
- `POST /protocol/feedback` — submit feedback
- `GET /protocol/usage` — usage stats
- `GET /protocol/scenes` — list available scenes (PLAN-064)
- `GET /protocol/scenes/{scene_id}` — get scene configuration (PLAN-064)
- `POST /protocol/conversations` — send message (inter-agent messaging)
- `GET /protocol/conversations` — list conversations
- `GET /protocol/conversations/{conversation_id}/messages` — get conversation messages
- `POST /protocol/conversations/{conversation_id}/read` — mark conversation as read

## Auth Lanes
- `GET /api/lanes/secondme_ai/callback` — SecondMe AI lane OAuth callback (HTML)

## Auth Headers

Admin-only routes require `boll_ADMIN_KEY` via either:
- `X-Admin-Key: <key>`
- `Authorization: Bearer <key>`

Bridge routes require `BRIDGE_API_KEY` via `Authorization: Bearer <key>`.

Protocol routes require session token via `Authorization: Bearer <session_token>` and accept `application/vnd.boll.v1+json`.
