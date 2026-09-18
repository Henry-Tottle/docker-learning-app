# syntax=docker/dockerfile:1

# ---- Stage 1: install production dependencies ------------------------------
FROM node:22.23.2-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- Stage 2: the image that actually runs ----------------------------------
FROM node:22.23.2-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DB_PATH=/data/progress.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY Dockerfile docker-compose.yml .dockerignore ./
RUN mkdir -p /data && chown node:node /data \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "src/server.js"]
