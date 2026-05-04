# Agent Handoff: Feed Me Maybe

## Project Overview

Self-hosted AI-powered RSS reader. SvelteKit + Svelte 5 + SQLite + Docker.

## Architecture

- Single-process Node.js app (adapter-node)
- SQLite database (better-sqlite3 + Drizzle ORM)
- Password authentication (APP_PASSWORD env var, session cookies)
- Server-side feed polling (15-min interval)
- Heuristic + optional AI article ranking

## Key Files

### Server Code (`src/lib/server/`)

- `db/` - Database singleton, Drizzle schema, migration
- `auth/` - Password verification, session management
- `feed/` - RSS fetcher (rss-parser), article ingester
- `ai/` - AI client abstraction, prompt templates, provider metadata
- `interactions.ts` - User interaction recording + heuristic scoring
- `poller.ts` - Background feed polling

### Routes (`src/routes/`)

- `login/` - Login page
- `today/` - Mixed feed (main reading view)
- `feeds/` - Feed management (list, add, edit, delete)
- `articles/[id]/` - Article detail view
- `saved/` - Bookmarked articles
- `settings/` - General, AI provider, system status pages
- `onboarding/` - First-run setup wizard
- `api/` - REST API endpoints (feeds, interactions, auth, settings, ai/providers)

### Database Tables

- `sessions` - Auth sessions with expiry
- `app_settings` - Key-value settings (setup_complete, ai_enabled)
- `feeds` - RSS/Atom feed sources with per-feed proxy toggle
- `articles` - Normalized feed items with scoring
- `article_ai_metadata` - Cached AI analysis results
- `feed_fetch_logs` - Fetch job tracking
- `app_error_logs` - Persisted application/server errors
- `jobs` - Background job queue
- `user_interactions` - Read/hide/save/thumbs events
- `user_preference_memory` - Learned preferences (type/polarity/strength)

## Key Design Decisions

- **Svelte 5 runes** ($state, $props, $effect) throughout
- **Skeleton UI v4** preset classes (no component imports for simple forms)
- **SQLite** for single-user self-hosted simplicity
- **No ORM in runtime** - raw SQL via better-sqlite3 (simpler than Drizzle for sync API)
- **Drizzle ORM schema** used for type safety and documentation
- **OpenAI-compatible AI abstraction** - null provider fallback when no AI configured
- **Background polling** - simple setInterval (upgradeable to cron/systemd)
- **Heuristic scoring** works independently of AI (recency + interactions)

## State of Completion

### Complete

- Auth, sessions, login page, route guards
- Feed CRUD (API + UI)
- RSS/Atom fetching + parsing
- Article ingestion with deduplication
- Today feed with pagination
- Article detail with read tracking
- Interaction recording (hide/save/thumbs)
- Heuristic ranking
- Background polling (15-min)
- PWA manifest + service worker
- Docker build + compose
- AI client abstraction + provider metadata
- Saved articles view
- Settings pages (General, AI Provider, System Status)
- Documentation (README, architecture, deployment, backup)

### Needs Work

- AI settings integration with provider_configs table
- Onboarding wizard (steps 2-4 need full implementation)
- Memory management UI (view/edit/delete preferences)
- AI batch processing pipeline (queue + rate limiting)
- Keyboard shortcuts
- Mobile swipe gestures
- OPML import/export
- CSRF protection for mutation endpoints
- Rate limiting on login
- Test coverage (interaction API, ingestion integration)

## Commands

```bash
npm run dev      # Development server
npm run build    # Production build
npm run check    # Type check (svelte-check)
npm run test     # Run tests (Vitest)
npm run lint     # ESLint check
npm run format   # Prettier format

# Docker
docker build -t feed-me-maybe .
docker-compose up -d
```

## Environment Variables

- `APP_PASSWORD` (required) - Password to access the app
- `ORIGIN` (recommended for production) - Public URL for CSRF protection behind reverse proxies
- `DATABASE_URL` (optional) - SQLite file path (default: `./data/feed-me-maybe.db`)
- `HOST`, `PORT` (optional) - Server binding
- `APP_SECRET` (optional) - Encryption key for API keys
- `PROXY_BASE_URL` (optional) - Generic Cloudflare Worker proxy URL used for feed fetching and Reddit comments; `REDDIT_BASE_URL` remains a legacy alias

## Known Issues

- svelte-check reports ~19 type warnings (non-blocking, build succeeds)
- Interaction API FK constraint error if passed invalid article IDs
- No rate limiting on login endpoint
- AI settings page saves config metadata but doesn't persist API key to provider_configs table
