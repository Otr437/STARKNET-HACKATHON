# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY modules/ ./modules/
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Runtime deps only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output
COPY --from=builder /build/dist ./dist
COPY frontend/ ./frontend/

# Secure directories
RUN mkdir -p /app/secure /app/certs && chmod 700 /app/secure

# Non-root user
RUN addgroup -S starclad && adduser -S starclad -G starclad && chown -R starclad:starclad /app
USER starclad

EXPOSE 3000 3443

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js", "start"]
