# Mahilo Registry Dockerfile
# Single-stage build - Bun runs TypeScript directly, no bundling needed

FROM oven/bun:1.1.38-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --frozen-lockfile -p

# Copy source code (Bun runs TypeScript directly)
COPY src ./src
COPY public ./public
COPY tsconfig.json drizzle.config.ts ./

# Create data directory for SQLite
RUN mkdir -p /app/data

# Environment variables (override as needed)
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATABASE_URL=/app/data/mahilo.db
ENV NODE_ENV=production

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run the application directly from TypeScript
CMD ["bun", "run", "src/index.ts"]
