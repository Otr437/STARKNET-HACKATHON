# ============================================================
#  RWA Oracle — Production Dockerfile
#  Multi-stage build: builder → production image
# ============================================================

# ── Stage 1: Builder ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install ALL deps (including dev)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S rwaoracle && \
    adduser  -u 1001 -S rwaoracle -G rwaoracle

WORKDIR /app

# Copy package files and install PRODUCTION deps only
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist/

# Create log directory
RUN mkdir -p /var/log/rwa-oracle && \
    chown -R rwaoracle:rwaoracle /var/log/rwa-oracle /app

USER rwaoracle

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

# Use dumb-init to handle PID 1 properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
