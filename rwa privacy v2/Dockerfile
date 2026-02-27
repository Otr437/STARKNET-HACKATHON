FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/contracts/oracle-abi.ts ./src/contracts/

# Create logs directory
RUN mkdir -p logs

# Set environment
ENV NODE_ENV=production

# Run oracle
CMD ["node", "dist/index.js"]
