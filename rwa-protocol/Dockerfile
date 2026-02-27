FROM node:20-alpine

LABEL org.opencontainers.image.title="RWA Protocol Server"
LABEL org.opencontainers.image.description="Starknet RWA Protocol — API proxy + dashboard"

WORKDIR /app

# Copy the whole project
COPY . .

# Install server dependencies
WORKDIR /app/server
RUN npm install --production

# The server serves frontend from ../frontend/index.html
# So we need the full project structure mounted
WORKDIR /app

# Expose port (Render sets PORT env var automatically)
EXPOSE 3000

# Health check (Render uses this)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "server/server.js"]
