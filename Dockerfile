# ───────────────────────────────
# Stage 1: build
# ───────────────────────────────
FROM node:18.17.1-alpine3.18 AS builder
WORKDIR /usr/src/app

# Copy only package manifests for caching
COPY package*.json ./

# Install root dependencies (shared tooling, build scripts, etc.)
RUN npm ci

# Copy entire repo
COPY . .

# 🧩 Remove local path references to @barfinex/* (use npm registry versions instead)
RUN node -e "\
    const fs = require('fs'); \
    const pkg = JSON.parse(fs.readFileSync('./apps/provider/package.json')); \
    for (const dep in pkg.dependencies) { \
    if (dep.startsWith('@barfinex/')) { \
    delete pkg.dependencies[dep]; \
    } \
    } \
    fs.writeFileSync('./apps/provider/package.json', JSON.stringify(pkg, null, 2)); \
    "

# ✅ Install all @barfinex/* packages from npm (latest versions)
RUN npm install \
    @barfinex/types \
    @barfinex/utils \
    @barfinex/key \
    @barfinex/config \
    @barfinex/plugin-driver \
    @barfinex/connectors \
    @barfinex/orders \
    @barfinex/detector \
    @barfinex/lib-provider-ws-bridge \
    @barfinex/telegram --save

# Build only the provider app (monorepo aware)
RUN npm run build:provider

# ───────────────────────────────
# Stage 2: runtime
# ───────────────────────────────
FROM node:18.17.1-alpine3.18 AS runtime
WORKDIR /usr/src/app

# Copy built provider service
COPY --from=builder /usr/src/app/dist/apps/provider ./dist

# Copy package manifests for runtime deps
COPY package*.json ./
RUN npm ci --omit=dev

# Run provider in production mode
CMD ["npm", "run", "start:provider:prod"]
