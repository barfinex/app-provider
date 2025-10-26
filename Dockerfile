# ───────────────────────────────
# Stage 1: Build
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS builder
WORKDIR /usr/src/app

# Устанавливаем bash и coreutils (иногда нужны для скриптов)
RUN apk add --no-cache bash coreutils

# Копируем только манифесты для кеширования зависимостей
COPY package*.json ./

# Устанавливаем общие зависимости (build tools, shared scripts)
RUN npm install --no-fund --no-audit

# Копируем весь монорепозиторий
COPY . .

# 🧩 Удаляем локальные ссылки на @barfinex/*,
# чтобы использовать опубликованные npm-пакеты
RUN node -e "\
    const fs = require('fs'); \
    const pkgPath = 'apps/provider/package.json'; \
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); \
    for (const dep in pkg.dependencies) { \
    if (dep.startsWith('@barfinex/')) delete pkg.dependencies[dep]; \
    } \
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2)); \
    "

# ✅ Устанавливаем актуальные версии опубликованных пакетов @barfinex/*
RUN npm install --no-fund --no-audit --save \
    @barfinex/types \
    @barfinex/utils \
    @barfinex/key \
    @barfinex/config \
    @barfinex/plugin-driver \
    @barfinex/connectors \
    @barfinex/orders \
    @barfinex/detector \
    @barfinex/lib-provider-ws-bridge \
    @barfinex/telegram

# 🏗️ Собираем только provider-приложение
RUN npm run build:provider


# ───────────────────────────────
# Stage 2: Runtime
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS runtime
WORKDIR /usr/src/app

# Копируем собранное приложение
COPY --from=builder /usr/src/app/dist/apps/provider ./dist

# Копируем package.json для продовых зависимостей
COPY package*.json ./

# Устанавливаем только продовые зависимости
RUN npm install --omit=dev --no-fund --no-audit

# Среда запуска
ENV NODE_ENV=production

# Открываем порт, если нужно (NestJS по умолчанию 3000)
EXPOSE 3000

# Запускаем сервис
CMD ["npm", "run", "start:provider:prod"]
