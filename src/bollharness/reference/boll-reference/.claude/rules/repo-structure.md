---
paths:
  - "backend/**"
  - "scenes/**"
  - "website/**"
  - "mcp-server/**"
  - "mcp-server-node/**"
  - "bridge_agent/**"
  - "bridge_contract/**"
  - "tests/**"
  - "experiments/**"
---

# Repository Structure & Development Commands

## Repository Structure

```
boll/
├── CHANGELOG.md                     # Platform-level changelog (v0.1.0 ~ v0.4.1)
├── backend/
│   ├── server.py                    # V2-only FastAPI entry (port 8080)
│   ├── boll/
│   │   ├── __init__.py              # V2 field-only exports
│   │   ├── field/                   # Intent Field module (12 files)
│   │   └── matching/               # Discovery engine core (operators, recommendation, encoding, evaluation, logging)
│   ├── product/                     # V2 productization layer
│   │   ├── config.py                # Pydantic env-backed config
│   │   ├── field_sync.py            # DB → MemoryField reload
│   │   ├── llm.py                   # LLM client factory
│   │   ├── quota.py                 # Commercial quota management
│   │   ├── scheduler.py             # Run recovery scheduler
│   │   ├── scene_chat_runtime.py    # SSE scene chat runtime
│   │   ├── a2a/                     # A2A protocol adapter
│   │   ├── auth/                    # Auth service + middleware + passwords + SecondMe OAuth
│   │   ├── bridge/                  # Bridge protocol (local Mac ↔ cloud); event_translator.py: bridge→protocol 事件翻译层
│   │   ├── catalyst/                # Cloud-side catalyst (coordinator, deadline scheduler, prompt loader); convergence.py: 收敛标记解析单一真相源
│   │   ├── db/                      # SQLAlchemy engine + CRUD (users/demands/runs/events/artifacts)
│   │   ├── demands/                 # Demand clarification-session + matching service
│   │   ├── matching/               # Discovery pipeline (scanner, nominator, store)
│   │   ├── inbox/                   # Inbox service
│   │   ├── lanes/                   # Auth lanes (SecondMe AI etc.)
│   │   ├── messaging/               # Inter-agent messaging
│   │   ├── metrics/                 # Platform metrics calculator
│   │   ├── notifications/           # SSE notification stream
│   │   ├── coaching/                # Coaching service (kunzhi-coach prompts, export, constants)
│   │   ├── hackathon/               # Hackathon service (state_machine, service layer)
│   │   ├── openagents/              # OpenAgents runtime carrier + session manager
│   │   ├── protocol/               # Canonical protocol API (bootstrap, deps, encoding, federation, service)
│   │   ├── public_profiles/         # Public profile service
│   │   ├── routes/                  # API routes (auth/profile/admin/demands/bridge/runs/dashboard/scene_auth/scene_chat/coaching/coaching_admin/hackathon/protocol/matching/a2a/plaza/public/public_profiles/did/messaging)
│   │   ├── security/                # Security utilities (URL fetcher, sanitization)
│   │   └── ws/                      # WebSocket hub + ticket auth
│   ├── models/                      # ML model artifacts (bge-m3 embeddings)
│   ├── tests/
│   │   ├── field/                   # V2 field unit tests (89)
│   │   ├── product/                 # Product unit tests (545, needs Docker)
│   │   ├── unit/                    # Pure in-memory unit tests (60, no Docker)
│   │   ├── matching/               # Discovery engine tests (21)
│   │   └── test_phase0_surface.py   # Phase-0 surface gate tests (8)
│   └── venv/
├── bridge_contract/                 # Pure-Python bridge contract helpers (artifacts, events, finalization, runtime_profile)
├── bridge_agent/                    # Local bridge agent (polls cloud → runs convergence)
│   ├── agent.py                     # Bridge agent entry
│   ├── bridge_listen.py             # HTTP helper (await-task, monitor, complete)
│   ├── test_progress.py             # Progress detection tests (31)
│   ├── config.yaml                  # Bridge config
│   └── run_e2e.py                   # E2E test runner
├── mcp-server/                      # MCP server — Python (boll-mcp, version see pyproject.toml)
│   ├── boll_mcp/                   # 74 active tools (version see pyproject.toml)
│   ├── CHANGELOG.md                 # MCP-specific changelog (0.3.0 ~ 0.4.0)
│   └── pyproject.toml
├── mcp-server-node/                 # MCP server — TypeScript/Node (boll-mcp, version see package.json)
│   ├── src/                         # 74 active tools (mirror of Python version)
│   └── package.json
├── tests/
│   ├── convergence_poc/         # Crystallization protocol experiments + tests (9)
│   │   ├── prompts/                 # Prompt version chain
│   │   └── simulations/real/        # RUN-001 ~ RUN-006
│   └── field_poc/                   # Field experiment archive (EXP-005~008)
├── website/
│   ├── app/
│   │   ├── page.tsx                 # Home
│   │   ├── (auth)/                  # Login + Register pages
│   │   ├── dashboard/               # User dashboard
│   │   ├── demand/                  # New demand + match result
│   │   ├── field/                   # Field experience page
│   │   ├── profile/                 # User profile
│   │   ├── run/                     # Run progress + result
│   │   └── workspace/               # Startup Hub workspace
│   └── package.json
├── docs/
│   ├── ARCHITECTURE_DESIGN.md       # V1 architecture (archived reference)
│   ├── archive/ENGINEERING_REFERENCE.md  # Engineering standards (archived)
│   ├── INDEX.md                     # Documentation navigation index
│   ├── ROADMAP.md                   # Milestones + current direction + planned
│   ├── architecture/                # Modular arch docs (principles, modules, vision)
│   ├── community/                   # Profile contribution guide
│   ├── decisions/                   # ADR + TECH + TEST + PLAN + REVIEW + EVAL
│   │   ├── ADR-001~034              # Architecture Decision Records
│   │   ├── TECH-015/TECH-018/TECH-SPEC-008  # Engineering designs
│   │   ├── TEST-015/TEST-019        # Test designs
│   │   ├── PLAN-001~080             # Implementation plans
│   │   ├── REVIEW-015~057           # Audits
│   │   └── tasks/                   # Task documents (use `find docs/decisions/tasks -name '*.md' | wc -l` to count)
│   ├── issues/                      # Guardian/red-team issue documents (guard-YYYYMMDD-HHMM-*.md)
│   ├── design-logs/                 # Design evolution logs (001~008)
│   ├── research/                    # Research reports (000~015)
│   ├── reviews/                     # Review artifacts (review-015, review-015-2)
│   ├── guides/                      # Developer guides
│   ├── archive/                     # Legacy V1 docs
│   └── prompts/                     # V1 skill prompts (archived)
├── scenes/                          # Scene demo apps
│   ├── admin-dashboard/            # 管理后台 demo (Vite + React)
│   ├── ai-gig-market/              # AI Agent 零工平台 demo (Vite + React)
│   ├── craw-opc/                   # Craw OPC (placeholder)
│   ├── epic-hackathon/             # Epic Hackathon demo (Vite + React)
│   ├── hackathon-observer/         # Hackathon 观察者 (archive)
│   ├── kunzhi-coach/               # example-coach scene app + prompts
│   ├── kunzhi-coach-admin/         # example-coach后台管理 (Vite + React)
│   ├── lobster-office/             # 龙虾办公 demo (Vite + React)
│   ├── shrimp-hackathon/           # Shrimp Hackathon (placeholder)
│   ├── smart-home-butler/          # 智能家居管家 (placeholder)
│   └── startup-hub/                # Startup Hub workspace
├── experiments/
│   └── real_data/                   # Discovery GT Recall experiments (WP-015)
├── scripts/                         # Utility scripts
├── data/
│   └── profiles/                    # Community profiles
└── .claude/skills/                  # Repo-local Codex skills（见 docs/skills/REGISTRY.md）
```

## Development Commands

```bash
# Backend
cd backend
source venv/bin/activate
uvicorn server:app --reload --port 8080

# Deployment (MUST use this, never manual scp — hook enforced)
bash scripts/deploy.sh --yes        # Full deploy: coherence check → sync → restart → verify
bash scripts/deploy.sh --dry-run    # Preview only, no changes
bash scripts/deploy-edge.sh --yes   # Sync repo-managed nginx edge config + verify public routes
bash scripts/deploy-edge.sh --dry-run
# Note: --yes skips interactive confirmation (required for AI execution)
# Manual scp/rsync to production server is blocked by PreToolUse hook

# Demo frontend deployment (static files, no backend restart)
bash scripts/deploy-demo.sh ai-gig-market --channel prod --yes     # Build + deploy public demo
bash scripts/deploy-demo.sh ai-gig-market --channel preview --yes  # Build + deploy internal preview
bash scripts/deploy-demo.sh ai-gig-market --dry-run     # Preview only
bash scripts/deploy-demo.sh ai-gig-market --skip-build --yes  # Deploy existing dist

# Frontend
cd website
npm run dev

# Tests (1992 collectable as of 2026-04-06)
cd /Users/nature/个人项目/boll
backend/venv/bin/pytest -q backend/tests/test_phase0_surface.py   # Phase-0 gate (8)
backend/venv/bin/pytest -q backend/tests/field                     # Field unit (89)
backend/venv/bin/pytest -q backend/tests/unit                      # Pure in-memory unit (462, no Docker)
backend/venv/bin/pytest -q backend/tests/product                   # Product unit (750, needs Docker)
backend/venv/bin/pytest -q backend/tests/matching                 # Discovery engine (21)
backend/venv/bin/pytest -q tests/convergence_poc/simulations/real  # Crystallization (9)
backend/venv/bin/pytest -q bridge_agent/test_progress.py           # Bridge progress (31)

# MCP Server (Python)
pip install -e ./mcp-server
boll-mcp --help

# MCP Server (Node/TypeScript)
cd mcp-server-node
npm install && npm run build
npx boll-mcp

# Official install entry
/mcp

# Frontend build
cd website
npm run build
```
