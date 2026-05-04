# Deployment Guide

## Docker

### Building the Image

The project uses a multi-stage Dockerfile to minimize the final image size:

```dockerfile
Stage 1 (builder): node:20-slim + build tools → npm ci + npm run build
Stage 2 (runner):  node:20-slim + runtime deps → npm ci --omit=dev + copy build
```

Build the image:

```bash
docker build -t feed-me-maybe .
```

### Running with Docker

```bash
docker run -d \
  --name feed-me-maybe \
  -p 3000:3000 \
  -e APP_PASSWORD=your-strong-password \
  -v feed-me-maybe-data:/app/data \
  --restart unless-stopped \
  feed-me-maybe
```

### Docker Compose

Create a `.env` file in the project root:

```env
APP_PASSWORD=your-strong-password
PORT=3000
```

Then start the service:

```bash
docker compose up -d
```

The `docker-compose.yml` defines:

- A named volume `feed-me-maybe-data` mounted at `/app/data` inside the container
- Port mapping from `${PORT:-3000}` on the host to `3000` in the container
- `restart: unless-stopped` for automatic recovery

## Environment Variables Reference

| Variable       | Required | Default                                                               | Description                                                      |
| -------------- | -------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `APP_PASSWORD` | **Yes**  | —                                                                     | Password for application access. Must be set or login will fail. |
| `ORIGIN`       | Recommended | —                                                                  | Public URL of the app (e.g. `https://feed.example.com`). Required for CSRF protection when behind a reverse proxy. |
| `DATABASE_URL` | No       | `./data/feed-me-maybe.db` (local) / `/app/data/feed-me-maybe.db` (Docker) | Path to the SQLite database file. Already set in the Docker image; only override if you need a different location. |
| `HOST`         | No       | `0.0.0.0`                                                             | Network interface to bind the server to.                         |
| `PORT`         | No       | `3000`                                                                | HTTP port to listen on.                                          |
| `APP_SECRET`   | No       | —                                                                     | Encryption key for AI provider API keys. Generate with `openssl rand -hex 32`. Keep stable across deploys. |
| `PROVIDER`     | No       | —                                                                     | AI provider ID: `openai`, `anthropic`, `openrouter`, or `groq`.  |
| `MODEL`        | No       | —                                                                     | Model name (e.g., `gpt-4o`, `claude-3-5-sonnet-20241022`).       |
| `API_KEY`      | No       | —                                                                     | API key for the configured AI provider.                          |

### Generating a Secure APP_SECRET

```bash
openssl rand -hex 32
```

## Reverse Proxy Configuration

### Caddy

```caddy
rss.example.com {
    reverse_proxy localhost:3000
}
```

Caddy automatically provisions TLS certificates via Let's Encrypt.

### Nginx

```nginx
server {
    listen 80;
    server_name rss.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

For HTTPS with Let's Encrypt, add Certbot or use a managed certificate.

### Nginx with HTTPS

```nginx
server {
    listen 443 ssl http2;
    server_name rss.example.com;

    ssl_certificate /etc/letsencrypt/live/rss.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rss.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Data Volume Management

### Docker Named Volume

The SQLite database is stored in a Docker named volume:

```bash
# List volumes
docker volume ls | grep feed-me-maybe

# Inspect volume details
docker volume inspect feed-me-maybe-data

# Find the actual path on the host
docker volume inspect -f '{{ .Mountpoint }}' feed-me-maybe-data
```

### Bind Mount (Alternative)

Instead of a named volume, you can bind-mount a host directory:

```bash
docker run -d \
  --name feed-me-maybe \
  -p 3000:3000 \
  -e APP_PASSWORD=your-strong-password \
  -v /path/on/host/data:/app/data \
  feed-me-maybe
```

This makes the database file directly accessible on the host filesystem for easier backup and inspection.

### Database File Location

| Deployment            | Database Path                                 |
| --------------------- | --------------------------------------------- |
| Local dev             | `./data/feed-me-maybe.db`                     |
| Docker (named volume) | `/app/data/feed-me-maybe.db` inside container |
| Docker (bind mount)   | `/path/on/host/data/feed-me-maybe.db`         |

## Health Check

The application does not expose a dedicated `/health` endpoint. You can verify health by checking:

```bash
# HTTP check
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login
# Expected: 200

# Docker health check (add to docker-compose.yml)
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/login"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

### Updated docker-compose.yml with Health Check

```yaml
version: '3.8'

services:
  rss-reader:
    build: .
    container_name: feed-me-maybe
    ports:
      - '${PORT:-3000}:3000'
    environment:
      - NODE_ENV=production
      - APP_PASSWORD=${APP_PASSWORD}
    volumes:
      - feed-me-maybe-data:/app/data
    restart: unless-stopped
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "require('http').get('http://localhost:3000/login', (r) => process.exit(r.statusCode === 200 ? 0 : 1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  feed-me-maybe-data:
```

## Production Checklist

- [ ] Set a strong `APP_PASSWORD` (not the default)
- [ ] Generate and set `APP_SECRET` with `openssl rand -hex 32`
- [ ] Configure a reverse proxy with TLS
- [ ] Set up regular database backups (see [Backup & Restore](backup-restore.md))
- [ ] Monitor disk space for the SQLite database and WAL files
- [ ] Consider setting up log rotation for container logs
