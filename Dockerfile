# Mahilo Registry Dockerfile
# Multi-stage build for minimal production image

# Build stage
FROM oven/bun:1.1.38-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src
COPY tsconfig.json drizzle.config.ts ./

# Build the application
RUN bun build src/index.ts --outdir dist --target bun

# Production stage
FROM oven/bun:1.1.38-alpine AS production

WORKDIR /app

# Copy only production dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile -p

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY --from=builder /app/src/db/schema.ts ./src/db/schema.ts
COPY --from=builder /app/drizzle.config.ts ./

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

# Run the application
CMD ["bun", "run", "dist/index.js"]
