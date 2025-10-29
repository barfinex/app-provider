# ───────────────────────────────
# Stage 1: Build
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS builder

WORKDIR /usr/src/monorepo
RUN apk add --no-cache bash coreutils git

# 🧩 Copy project dependencies & configs
COPY tsconfig*.json ./
COPY libs ./libs
COPY apps/provider/package*.json ./apps/provider/
COPY apps/provider/tsconfig*.json ./apps/provider/
COPY apps/provider/src ./apps/provider/src

# ⚙️ Install dependencies
WORKDIR /usr/src/monorepo/apps/provider
RUN if [ -f package-lock.json ]; then \
    echo "Using npm ci (lockfile found)" && npm ci --no-fund --no-audit; \
    else \
    echo "Using npm install (no lockfile found)" && npm install --no-fund --no-audit; \
    fi

# 🏗️ Build TypeScript (absolute path fix)
RUN npx tsc -p /usr/src/monorepo/apps/provider/tsconfig.json

# ───────────────────────────────
# Stage 2: Runtime
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

# 📦 Copy build artifacts (from monorepo root dist)
COPY --from=builder /usr/src/monorepo/dist/apps/provider ./dist
COPY --from=builder /usr/src/monorepo/apps/provider/package*.json ./

# 🧹 Install only production deps
RUN if [ -f package-lock.json ]; then \
    echo "Installing prod deps via npm ci" && npm ci --omit=dev --no-fund --no-audit; \
    else \
    echo "Installing prod deps via npm install" && npm install --omit=dev --no-fund --no-audit; \
    fi && \
    npm cache clean --force

# 👤 Secure runtime user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["npm", "run", "start:prod"]
