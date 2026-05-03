# Architecture

## System Overview

Feed Me Maybe is a single-process, self-hosted RSS reader built on SvelteKit 2. The entire application runs as one Node.js process with an embedded SQLite database — no external services, message queues, or separate workers are required.

```
┌─────────────────────────────────────────────────────┐
│                  SvelteKit Server                    │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Routes   │  │   API    │  │   Server Hooks    │  │
│  │  (SSR)    │  │ Endpoints│  │  (auth, init)     │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │              │                 │             │
│       └──────────────┼─────────────────┘             │
│                      │                               │
│  ┌───────────────────┴───────────────────────────┐   │
│  │              Server Library                    │   │
│  │                                                │   │
│  │  ┌────────┐ ┌────────┐ ┌──────┐ ┌───────────┐ │   │
│  │  │  Auth  │ │   DB   │ │ Feed │ │    AI     │ │   │
│  │  │Module  │ │ Module │ │Module│ │  Module   │ │   │
│  │  └────────┘ └────────┘ └──────┘ └───────────┘ │   │
│  │                                                │   │
│  │  ┌────────────┐  ┌──────────────────────────┐  │   │
│  │  │Interactions│  │       Poller             │  │   │
│  │  │  & Scoring │  │  (15-min background)     │  │   │
│  │  └────────────┘  └──────────────────────────┘  │   │
│  └────────────────────────────────────────────────┘   │
│                      │                                │
└──────────────────────┼────────────────────────────────┘
                       │
              ┌────────┴────────┐
              │   SQLite (WAL)  │
              │  feed-me-maybe  │
              │     .db         │
              └─────────────────┘
```

## Directory Structure

```
src/
├── lib/
│   ├── server/
│   │   ├── ai/              # AI provider integration
│   │   │   ├── client.ts    # OpenAI-compatible chat client + null client
│   │   │   ├── prompts.ts   # Classification and scoring prompts
│   │   │   └── types.ts     # AI provider, model, and article score types
│   │   ├── auth/            # Authentication
│   │   │   ├── password.ts  # Timing-safe password verification
│   │   │   └── session.ts   # Session CRUD, cookie management
│   │   ├── db/              # Database layer
│   │   │   ├── index.ts     # SQLite connection (singleton, WAL mode)
│   │   │   ├── migrate.ts   # CREATE TABLE IF NOT EXISTS migrations
│   │   │   └── schema.ts    # Drizzle ORM schema definitions
│   │   ├── feed/            # Feed ingestion
│   │   │   ├── fetcher.ts   # RSS/Atom parsing via rss-parser
│   │   │   └── ingester.ts  # Fetch → deduplicate → store pipeline
│   │   ├── interactions.ts  # User interaction recording + heuristic scoring
│   │   └── poller.ts        # Background feed polling (setInterval, 15 min)
│   └── index.ts             # Shared utilities (exports placeholder)
├── routes/
│   ├── +layout.svelte       # App shell: top bar + sidebar navigation
│   ├── +page.svelte         # Landing/welcome page
│   ├── login/               # Password login page
│   ├── onboarding/          # 4-step first-run wizard
│   ├── today/               # Main feed view (ranked articles, paginated)
│   ├── saved/               # Saved/bookmarked articles
│   ├── feeds/               # Feed management (list + [id] detail)
│   ├── articles/[id]/       # Individual article reader
│   ├── settings/            # App settings
│   └── api/                 # REST API endpoints
│       ├── login/           # POST — authenticate and set session cookie
│       ├── logout/          # POST — destroy session and clear cookie
│       ├── feeds/           # GET/POST — list and create feeds
│       ├── feeds/[id]/      # GET/PATCH/DELETE — feed CRUD
│       ├── feeds/[id]/refresh/  # POST — trigger manual feed refresh
│       ├── interactions/    # POST — record user interaction
│       ├── settings/        # POST — upsert app setting
│       └── ai/providers/    # GET — list supported AI providers
├── app.css                  # Tailwind v4 + Skeleton v4 imports
├── app.html                 # HTML document shell
├── app.d.ts                 # App.Locals type augmentation
└── hooks.server.ts          # Server hooks: DB init, poller start, auth guard
```

## Data Flow

### Feed Ingestion Pipeline

```
User adds feed URL
       │
       ▼
POST /api/feeds → INSERT INTO feeds (id, url, ...)
       │
       ▼
Background Poller (every 15 min) or Manual Refresh
       │
       ▼
fetchFeed(url) — rss-parser downloads and parses XML
       │
       ▼
ingestFeed() — transactional article processing:
  1. Generate article ID (SHA-256 of URL + title, truncated to 32 chars)
  2. Check for duplicates (unique index on feed_id + url)
  3. Insert new articles
  4. Update feed metadata (title, description, icon)
  5. Record fetch log entry
       │
       ▼
Articles stored in SQLite, ready for display
```

### Article Ranking

```
Article stored with heuristic_score = 0, combined_score = 0
       │
       ▼
User interacts: read / save / hide / thumbs_up / thumbs_down
       │
       ▼
recordInteraction() → UPDATE articles SET {flag} = 1
       │
       ▼
recalculateScore():
  base 50
  + reads × 2
  + saves × 8
  - hides × 10
  + thumbs_up × 5
  - thumbs_down × 8
  clamped to [0, 100]
       │
       ▼
Today view: ORDER BY COALESCE(combined_score, heuristic_score, 0) DESC
```

### AI Analysis (Optional)

```
AI provider configured in settings
       │
       ▼
createAiClient({ baseUrl, apiKey, model })
       │
       ▼
classifyArticle(title, content) → topics, contentType, entities, summary
scoreArticle(title, summary) → relevanceScore, noveltyScore, qualityScore
summarizeArticle(content) → 2-3 sentence summary
       │
       ▼
Results stored in article_ai_metadata table
Displayed in article view when available
```

## Component Hierarchy

```
+layout.svelte (App Shell)
├── Header (top bar: logo, hamburger, subtitle)
├── Sidebar (navigation: Today, Saved, Feeds, Settings)
│   └── Nav items with active state highlighting
└── Main Content Area
    ├── +page.svelte (Landing)
    ├── login/+page.svelte (Login form)
    ├── onboarding/+page.svelte (4-step wizard)
    ├── today/
    │   ├── +page.server.ts (load: paginated articles by score)
    │   └── +page.svelte (article cards with interaction buttons)
    ├── saved/+page.svelte (Saved articles placeholder)
    ├── feeds/
    │   ├── +page.svelte (Feed list + add form)
    │   └── [id]/+page.svelte (Feed detail: edit, refresh, delete)
    ├── articles/[id]/
    │   ├── +page.server.ts (load: article + AI metadata, mark read)
    │   └── +page.svelte (Article reader with AI summary)
    └── settings/
        └── +page.svelte (Settings placeholder)
```

## Key Design Decisions

### SQLite over PostgreSQL

- **Single-process deployment** — no separate database server to manage
- **WAL mode** — enables concurrent reads with a single writer, sufficient for a single-user app
- **File-based** — trivial backup (copy the `.db` file), easy volume mounting in Docker
- **Drizzle ORM** — provides type-safe queries with SQLite dialect support

### Svelte 5 Runes

The application uses Svelte 5's rune-based reactivity (`$state`, `$derived`, `$effect`, `$props`) instead of the older `let` + reactive declarations pattern. This provides:
- Fine-grained reactivity without compiler magic
- Better TypeScript integration
- Clearer mental model for state management

### Skeleton UI v4 + Tailwind CSS v4

- **Skeleton v4** provides pre-built component classes (`card`, `btn`, `input`, `badge`, `alert`) with theme support
- **Tailwind v4** uses the new CSS-first configuration via `@import 'tailwindcss'`
- **Cerberus theme** — dark-oriented theme configured in `app.css` via `@import '@skeletonlabs/skeleton/themes/cerberus'`
- HTML element sets `data-theme="cerberus"` for theme activation

### rss-parser with Custom Fields

The feed parser extracts additional metadata beyond standard RSS/Atom fields:
- `media:content` and `media:thumbnail` for article images
- `dc:creator` for author attribution
- `enclosure.url` as a fallback image source

### Article Deduplication

Articles are identified by a deterministic SHA-256 hash of `url|title`, truncated to 32 characters. A unique composite index on `(feed_id, url)` provides a secondary deduplication layer.

## Authentication Model

### Password Gate

The application uses a single shared password defined via the `APP_PASSWORD` environment variable. There are no user accounts or registration.

### Session Management

1. **Login** — `POST /api/login` verifies the password using timing-safe comparison (`crypto.timingSafeEqual`)
2. **Session creation** — A random UUID is generated and stored in the `sessions` table with a 24-hour expiry
3. **Cookie** — Set as `HttpOnly; Path=/; SameSite=Lax` with `Max-Age=86400`
4. **Validation** — `hooks.server.ts` reads the cookie on every request, validates the session against the database, and sets `event.locals.sessionId`
5. **Auth guard** — All routes except `/login`, `/api/login`, and `/api/logout` require a valid session. API routes return 401 JSON; page routes redirect to `/login`

### First-Run Detection

On first launch, the `app_settings` table has no `setup_complete` entry. After login, users are redirected to `/onboarding` to complete the 4-step setup wizard. The wizard sets `setup_complete = true` in `app_settings`, after which normal navigation is allowed.

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `sessions` | Auth sessions (id, user_id, created_at, expires_at) |
| `app_settings` | Key-value store for app configuration |
| `feeds` | RSS/Atom feed definitions and fetch status |
| `articles` | Stored articles with interaction flags and scores |
| `article_ai_metadata` | AI-generated analysis per article |
| `feed_fetch_logs` | Historical fetch results per feed |
| `jobs` | Background job queue (feed_fetch, ai_process, memory_summarize) |
| `user_interactions` | Interaction event log for scoring |
| `user_preference_memory` | Learned user preferences for AI ranking |

### Key Indexes

- `idx_articles_feed_id` — articles by feed
- `idx_articles_published_at` — articles by publication date (DESC)
- `idx_articles_feed_url` — unique constraint for deduplication
- `idx_fetch_logs_feed_id` — fetch logs by feed
- `idx_jobs_status` — jobs by status and scheduled time
- `idx_interactions_article` — interactions by article
