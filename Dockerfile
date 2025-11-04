# ───────────────────────────────
# Stage 1: Build
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS builder

WORKDIR /usr/src/monorepo

# Устанавливаем системные зависимости (для node-gyp, bufferutil и т.п.)
RUN apk add --no-cache bash coreutils git python3 make g++

# 🧩 Копируем файлы монорепы
COPY package*.json ./ 
COPY tsconfig*.json ./ 
COPY libs ./libs
COPY apps/provider ./apps/provider

# ⚙️ Устанавливаем все зависимости
RUN npm install --no-fund --no-audit

# 🔧 Устанавливаем dev-зависимости для сборки
RUN npm install --no-fund --no-audit --save-dev typescript @types/node reflect-metadata

# 🏗️ Компиляция TypeScript (все библиотеки + provider)
RUN npx tsc -b apps/provider

# ───────────────────────────────
# Stage 2: Runtime
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS runtime

WORKDIR /usr/src/app
ENV NODE_ENV=production

# 📦 Копируем собранные артефакты
# ⚠️ Важно: провайдер компилируется в apps/provider/dist, а не dist/apps/provider
COPY --from=builder /usr/src/monorepo/apps/provider/dist ./dist
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

EXPOSE 8081
CMD ["npm", "run", "start:prod"]
