---
paths:
  - "backend/product/config.py"
  - "backend/server.py"
  - "scripts/deploy*.sh"
  - "scripts/deploy*.py"
  - ".env*"
---

# Important Environment Variables

## Required
- `DATABASE_URL` — PostgreSQL connection string
- `BRIDGE_API_KEY` — bridge agent authentication
- `boll_ADMIN_KEY` — admin route authentication

## Optional
- `ALLOWED_ORIGINS` — CORS origins (default includes localhost + <NETWORK_REDACTED> + <NETWORK_REDACTED> + auth.<NETWORK_REDACTED> + hackathon domains; see `backend/product/config.py`)
- `boll_ANTHROPIC_API_KEY` — single API key (enables MPG)
- `boll_ANTHROPIC_API_KEYS` — comma-separated API keys (rotation)
- `boll_ANTHROPIC_BASE_URL` — custom API base URL
- `SESSION_TTL_DAYS` — session expiry (default: 30)
- `BCRYPT_ROUNDS` — password hash rounds (default: 12)
- `LOGIN_MAX_ATTEMPTS_PER_MINUTE` — rate limit (default: 5)
- `LOGIN_FREEZE_AFTER_FAILURES` — lockout threshold (default: 10)
- `LOGIN_FREEZE_MINUTES` — lockout duration (default: 15)

## Secrets (production-only)
- `boll_KEY_ENCRYPTION_SECRET` — BYOK key encryption
- `boll_PROTOCOL_ENCODING_PACKAGE_SECRET` — encoding package signing
- `boll_PROTOCOL_FEDERATION_SECRET` — federation auth
- `boll_OSS_ACCESS_KEY_ID` / `boll_OSS_ACCESS_KEY_SECRET` / `boll_OSS_ROLE_ARN` — Alibaba Cloud OSS
- `boll_SMTP_HOST` / `boll_SMTP_PORT` / `boll_SMTP_USERNAME` / `boll_SMTP_PASSWORD` / `boll_SMTP_SENDER` / `boll_SMTP_USE_TLS` — email delivery
- `SECONDME_CLIENT_ID` / `SECONDME_CLIENT_SECRET` / `SECONDME_REDIRECT_URI` — SecondMe OAuth

## LLM Configuration
- `boll_DEFAULT_MODEL` — default LLM model
- `boll_COACHING_ANTHROPIC_API_KEY` / `boll_COACHING_ANTHROPIC_BASE_URL` / `boll_COACHING_ANTHROPIC_MODEL` — coaching-specific LLM
- `boll_OPENROUTER_API_KEY` / `boll_OPENROUTER_BASE_URL` / `boll_OPENROUTER_MODEL` — OpenRouter fallback

## Operational
- `boll_SECURE_COOKIES` — cookie security flag (default: true in prod)
- `boll_PROTOCOL_BYOK_SESSION_TTL_MINUTES` — BYOK session TTL
- `boll_PROTOCOL_PUBLIC_ORIGIN` / `boll_PUBLIC_BASE_URL` / `boll_APP_PUBLIC_BASE_URL` — public URLs (note: `_build_public_run_url` only reads `app_public_base_url || public_base_url`; `protocol_public_origin` is reserved/unused as of 2026-04-07)
- `RATE_LIMIT_OVERRIDES` — per-email rate limit overrides (`email:endpoint:max:window,...`); only effective for endpoints that pass `account_email` (not register/login)
- `RATE_LIMIT_BYPASS_IPS` — comma-separated IP allowlist that skips ALL rate limiting; for internal E2E scripts and health checks running from localhost / known internal subnets so they don't burn the public per-IP register quota. Prod default: `127.0.0.1`
- `boll_QUALITY_GATE_C_THRESHOLD` / `boll_QUALITY_GATE_A_THRESHOLD` — quality gate thresholds
- `FIELD_SNAPSHOT_PATH` — field cache path
- `RUN_TTL_ASSIGNED_MINUTES` / `RUN_TTL_RUNNING_MINUTES` / `RUN_TTL_DELIVERING_MINUTES` — run lifecycle TTLs
- `RUN_MAX_RETRY_ATTEMPTS` / `RUN_RECOVERY_INTERVAL_SECONDS` — run recovery
