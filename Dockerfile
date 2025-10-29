# ───────────────────────────────
# Stage 1: Build
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS builder

WORKDIR /usr/src/monorepo

# Устанавливаем системные зависимости (для node-gyp, bufferutil и т.п.)
RUN apk add --no-cache bash coreutils git python3 make g++

# 🧩 Копируем конфиги и зависимости монорепы
COPY tsconfig*.json ./
COPY libs ./libs
COPY apps/provider/package*.json ./apps/provider/
COPY apps/provider/tsconfig*.json ./apps/provider/
COPY apps/provider/src ./apps/provider/src

# ⚙️ Устанавливаем зависимости
WORKDIR /usr/src/monorepo/apps/provider
RUN if [ -f package-lock.json ]; then \
    echo "Using npm ci (lockfile found)" && npm ci --no-fund --no-audit; \
    else \
    echo "Using npm install (no lockfile found)" && npm install --no-fund --no-audit; \
    fi

# 🏗️ Компиляция TypeScript
RUN npx tsc -p /usr/src/monorepo/apps/provider/tsconfig.json

# ───────────────────────────────
# Stage 2: Runtime
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

# 📦 Копируем артефакты сборки и package.json
COPY --from=builder /usr/src/monorepo/dist/apps/provider ./dist
COPY --from=builder /usr/src/monorepo/apps/provider/package*.json ./

# 🧹 Устанавливаем только прод-зависимости
RUN apk add --no-cache python3 make g++ && \
    if [ -f package-lock.json ]; then \
    echo "Installing prod deps via npm ci" && npm ci --omit=dev --no-fund --no-audit; \
    else \
    echo "Installing prod deps via npm install" && npm install --omit=dev --no-fund --no-audit; \
    fi && \
    npm cache clean --force && \
    apk del make g++ python3

# 👤 Безопасный пользователь
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["npm", "run", "start:prod"]
