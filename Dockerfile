# ───────────────────────────────
# Stage 1: Build
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS builder
WORKDIR /usr/src/app

# Установим bash/coreutils (для совместимости)
RUN apk add --no-cache bash coreutils

# Копируем package.json и package-lock.json из apps/provider
COPY package*.json ./

# Устанавливаем зависимости (без audit и fund)
RUN npm install --no-fund --no-audit

# Копируем весь исходный код из apps/provider
COPY . .

# 🧩 Удаляем локальные ссылки на @barfinex/* (используем версии с npm)
RUN node -e "\
    const fs = require('fs'); \
    const pkgPath = 'package.json'; \
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); \
    for (const dep in pkg.dependencies) { \
    if (dep.startsWith('@barfinex/')) delete pkg.dependencies[dep]; \
    } \
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2)); \
    "

# ✅ Устанавливаем опубликованные @barfinex/* пакеты
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

# 🏗️ Собираем provider (локально)
RUN npm run build


# ───────────────────────────────
# Stage 2: Runtime
# ───────────────────────────────
FROM node:20.11.1-alpine3.19 AS runtime
WORKDIR /usr/src/app

# Копируем собранный build
COPY --from=builder /usr/src/app/dist ./dist

# Копируем package.json и lock-файл
COPY package*.json ./

# Устанавливаем только прод-зависимости
RUN npm install --omit=dev --no-fund --no-audit

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start:prod"]
