# Stage 1: Build
FROM node:26-slim AS builder
WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./
RUN npm ci

# Copy source, build, then remove development-only dependencies.
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-slim AS runner
WORKDIR /app

# Copy production dependencies and build output from the builder stage.
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown node:node /app /app/data

ENV NODE_ENV=production
ENV DATABASE_URL=/app/data/feed-me-maybe.db
ENV PROTOCOL_HEADER=x-forwarded-proto
ENV HOST_HEADER=x-forwarded-host
ENV PORT_HEADER=x-forwarded-port

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/login`).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "build/index.js"]
