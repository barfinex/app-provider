# ───────────────────────────────
# Stage 1: Build
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS builder
WORKDIR /usr/src/app

RUN apk add --no-cache bash coreutils

# 🟢 Копируем из корня монорепы (а не из .public)
COPY package*.json ./
COPY tsconfig*.json ./
COPY libs ./libs
COPY apps/provider ./apps/provider

# Устанавливаем зависимости монорепы
RUN npm install --no-fund --no-audit

# 🧩 Удаляем локальные ссылки на @barfinex/*
RUN node -e "\
    const fs = require('fs'); \
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')); \
    for (const k in pkg.dependencies) if (k.startsWith('@barfinex/')) delete pkg.dependencies[k]; \
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
    "

# ✅ Устанавливаем опубликованные пакеты @barfinex/*
RUN npm install --no-fund --no-audit --save \
    @barfinex/types \
    @barfinex/utils \
    @barfinex/key \
    @barfinex/config \
    @barfinex/plugin-driver \
    @barfinex/connectors \
    @barfinex/orders \
    @barfinex/detector \
    @barfinex/provider-ws-bridge \
    @barfinex/telegram

# 🏗️ Сборка через корневой package.json (теперь команда найдётся)
RUN npm run build:provider

# ───────────────────────────────
# Stage 2: Runtime
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS runtime
WORKDIR /usr/src/app

# Копируем только сборку и публичный package.json
COPY --from=builder /usr/src/app/dist ./dist
COPY apps/provider/.public/package*.json ./package.json

RUN npm install --omit=dev --no-fund --no-audit

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start:prod"]
