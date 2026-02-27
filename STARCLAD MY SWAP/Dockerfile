FROM node:18-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json tsconfig.json ./
RUN npm ci
COPY modules ./modules
RUN npm run build

FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache dumb-init
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
RUN mkdir -p /app/secure /app/certs && chown nodejs:nodejs /app/secure /app/certs && chmod 700 /app/secure
USER nodejs
EXPOSE 3000 3443
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js", "start"]
