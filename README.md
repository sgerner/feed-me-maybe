# Feed Me Maybe

A self-hosted, AI-powered RSS reader built with SvelteKit, SQLite, and modern web standards.

## Features

- **RSS/Atom Feed Ingestion** — Add and manage RSS/Atom feeds with automatic background polling every 15 minutes
- **Article Ranking** — Heuristic scoring based on user interactions (read, save, hide, thumbs up/down)
- **AI-Powered Analysis** — Optional OpenAI-compatible AI provider integration for article classification, relevance scoring, and summarization
- **Progressive Web App** — Installable on mobile/desktop with offline support via service worker
- **Single-Process Architecture** — SQLite database with WAL mode, no external services required
- **Password-Gated Auth** — Simple single-user authentication with HttpOnly session cookies
- **Responsive UI** — Built with Skeleton UI v4 and Tailwind CSS v4, works on mobile and desktop

## Prerequisites

- **Node.js** 20 or later
- **npm** (or any compatible package manager)
- **Git**

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/feed-me-maybe.git
cd feed-me-maybe

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env and set APP_PASSWORD to a strong password

# Start the development server
npm run dev
```

Open [http://localhost:5373](http://localhost:5373) in your browser. You'll be prompted to log in with the password you set in `.env`.

## Docker Deployment

### Build and Run

```bash
# Build the image
docker build -t feed-me-maybe .

# Run with a named volume for persistent data
docker run -d \
  --name feed-me-maybe \
  -p 3000:3000 \
  -e APP_PASSWORD=your-strong-password \
  -v feed-me-maybe-data:/data \
  feed-me-maybe
```

### Docker Compose

Create a `.env` file with your configuration:

```env
APP_PASSWORD=your-strong-password
PORT=3000
```

Then run:

```bash
docker compose up -d
```

The application will be available at `http://localhost:3000`.

### Persistent Storage

The app stores its SQLite database in `/data/feed-me-maybe.db` inside the container.
Mount `/data` to a persistent Docker volume or host directory so feeds, articles,
sessions, and settings survive container restarts.

If you change `APP_SECRET` after storing AI provider credentials, previously saved
encrypted values may no longer be readable.

### CapRover

For CapRover, set the following as runtime environment variables, not build args:

- `APP_PASSWORD`
- `APP_SECRET`
- `DATABASE_URL=/data/feed-me-maybe.db`

Create a persistent directory mapping for `/data`.

Example:

- App env vars: `APP_PASSWORD`, `APP_SECRET`, `DATABASE_URL`
- Persistent directory: `/data`
- Database path inside container: `/data/feed-me-maybe.db`

CapRover may show a warning if you enter these values as build args. That warning
is harmless only if the values are also set as runtime environment variables.
The Docker image reads them at startup, not at build time.

## Environment Variables

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `APP_PASSWORD` | Yes | - | Password for application access |
| `APP_SECRET` | Recommended | - | Secret used for session-related and encrypted AI settings; generate with `openssl rand -hex 32` |
| `DATABASE_URL` | No | `./data/feed-me-maybe.db` locally, `/data/feed-me-maybe.db` in Docker | Path to the SQLite database file |
| `HOST` | No | `0.0.0.0` | Server bind address |
| `PORT` | No | `3000` | Server port |
| `PROVIDER` | No | - | AI provider ID, for example `openai`, `anthropic`, `openrouter`, or `groq` |
| `MODEL` | No | - | AI model name, for example `gpt-4o` or `claude-3-5-sonnet-20241022` |
| `API_KEY` | No | - | AI provider API key |

### Docker Notes

- Use a persistent mount for `/data`.
- Set `DATABASE_URL=/data/feed-me-maybe.db` when running in Docker or CapRover.
- Keep `APP_PASSWORD` and `APP_SECRET` stable across restarts.
- Set these as runtime environment variables. Do not rely on build args for them.

## Project Structure

```
feed-me-maybe/
├── src/
│   ├── lib/
│   │   ├── server/
│   │   │   ├── ai/          # AI client, prompts, and types
│   │   │   ├── auth/        # Password verification and session management
│   │   │   ├── db/          # SQLite connection, schema, and migrations
│   │   │   ├── feed/        # Feed fetching (rss-parser) and ingestion
│   │   │   ├── interactions.ts  # User interaction recording and scoring
│   │   │   └── poller.ts    # Background feed polling (15-min interval)
│   │   └── index.ts         # Shared utilities
│   ├── routes/
│   │   ├── +layout.svelte   # App layout with sidebar navigation
│   │   ├── +page.svelte     # Landing page
│   │   ├── login/           # Password login page
│   │   ├── onboarding/      # First-run setup wizard
│   │   ├── today/           # Main article feed (ranked, paginated)
│   │   ├── saved/           # Saved/bookmarked articles
│   │   ├── feeds/           # Feed management (list + detail)
│   │   ├── articles/[id]/   # Individual article view
│   │   ├── settings/        # App settings
│   │   └── api/             # REST API endpoints
│   │       ├── login/       # POST /api/login
│   │       ├── logout/      # POST /api/logout
│   │       ├── feeds/       # CRUD for feeds + refresh
│   │       ├── interactions/# POST /api/interactions
│   │       ├── settings/    # POST /api/settings
│   │       └── ai/          # AI provider listing
│   ├── app.css              # Tailwind + Skeleton imports
│   ├── app.html             # HTML shell
│   ├── app.d.ts             # TypeScript type declarations
│   └── hooks.server.ts      # Server hooks (auth guard, DB init, poller)
├── static/                  # Static assets (favicon, PWA icons)
├── data/                    # SQLite database (created on first run)
├── Dockerfile               # Multi-stage Docker build
├── docker-compose.yml       # Docker Compose configuration
├── drizzle.config.ts        # Drizzle ORM configuration
├── svelte.config.js         # SvelteKit configuration
├── vite.config.ts           # Vite + PWA configuration
└── package.json
```

## Development Commands

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `npm run dev`         | Start development server with hot reload      |
| `npm run build`       | Build for production                          |
| `npm run preview`     | Preview the production build locally          |
| `npm run check`       | Run TypeScript type checking                  |
| `npm run check:watch` | TypeScript type checking in watch mode        |
| `npm run lint`        | Run Prettier and ESLint                       |
| `npm run format`      | Auto-format code with Prettier                |
| `npm run test`        | Run test suite with Vitest                    |
| `npm run test:watch`  | Run tests in watch mode                       |
| `npm run db:push`     | Push schema changes to database (development) |
| `npm run db:generate` | Generate Drizzle migration files              |
| `npm run db:migrate`  | Run pending migrations (production)           |

## Tech Stack

| Layer        | Technology                                        |
| ------------ | ------------------------------------------------- |
| Framework    | SvelteKit 2 with Svelte 5 (runes)                 |
| Styling      | Tailwind CSS v4 + Skeleton UI v4 (Cerberus theme) |
| Database     | SQLite via better-sqlite3                         |
| ORM          | Drizzle ORM                                       |
| Feed Parsing | rss-parser                                        |
| Validation   | Zod                                               |
| Testing      | Vitest                                            |
| PWA          | @vite-pwa/sveltekit                               |
| Deployment   | @sveltejs/adapter-node                            |
| Linting      | ESLint 9 + Prettier 3                             |

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
