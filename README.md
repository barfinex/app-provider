<p >
  🌐 <b>Languages:</b>  
  <a href="README.md"><code>🇬🇧 English</code></a> ·
  <a href="README.ru.md"><code>🇷🇺 Русский</code></a> ·
  <code style="color:gray;">🇰🇿 Қазақша</code> ·
  <code style="color:gray;">🇨🇳 中文</code>
</p>

---
# 🧩 Provider Service

[![ghcr](https://img.shields.io/badge/GHCR-ghcr.io%2Fbarfinex%2Fprovider-blue?logo=github&logoColor=white)](https://ghcr.io/barfinex/provider)
[![dockerhub](https://img.shields.io/badge/DockerHub-barfinex%2Fprovider-blue?logo=docker&logoColor=white)](https://hub.docker.com/r/barfinex/provider)
[![image-size](https://img.shields.io/docker/image-size/barfinex/provider/latest?label=image%20size%2089MB?label=image%20size%2089MB?label=image%20size%2089MB?label=image%20size%2089MB?label=image%20size%2089MB?label=image%20size%2089MB?label=image%20size%2089MB?label=image%20size)](https://ghcr.io/barfinex/provider)
[![version](https://img.shields.io/badge/version-v31-blue)](https://ghcr.io/barfinex/provider)

---

## 📘 Overview

The `provider` service is part of the **Barfinex Trading Ecosystem**.  
It handles financial data aggregation, symbol management, order routing, and integrations  
with external financial APIs such as Binance, Tinkoff, and Alpaca.

Built with **NestJS** and **TypeScript**, this service is modular, scalable, and ready for distributed deployment.

---

## 🚀 Deployment

This service is automatically published via **GitHub Actions** and **semantic-release**.  
Each successful build exports the codebase, creates a GitHub Release,  
and publishes a Docker image to the GitHub Container Registry (GHCR):

```bash
# === GitHub Container Registry ===
docker pull ghcr.io/barfinex/provider:latest

# === Docker Hub ===
docker pull barfinex/provider:latest
```

---

## ✨ Features

- **Account Management** – user and trading account handling.  
- **Asset Handling** – provides asset data and operations.  
- **Candlestick Data** – processes and serves OHLC chart data.  
- **Connectors** – integrates with Binance, Tinkoff, Alpaca, and other APIs.  
- **Order Processing** – manages order placement and synchronization.  
- **Subscription Management** – event-based data streaming.  
- **Symbol Metadata** – manages symbol registry and metadata.  
- **Portainer Integration** – container management for enterprise clusters.  

---

## 📁 File Structure

### Root Files
- `.dockerignore` – files to exclude from Docker builds.  
- `Dockerfile` – build configuration for the service image.  
- `tsconfig.app.json` – TypeScript configuration for compilation.

### `src` Modules

| Module | Description |
|--------|--------------|
| **account** | Account routes and services |
| **asset** | Asset logic and APIs |
| **candle** | Candlestick and OHLC processing |
| **connector** | Integration with external data providers |
| **order** | Order lifecycle management |
| **subscription** | Subscription and event stream logic |
| **symbol** | Financial symbol registry and metadata |
| **portainer** | Management integration with Portainer CE |

---

## 🧰 Deployment Instructions

### 🧾 Prerequisites
- **Docker** and **Docker Compose** installed  
- A valid `.env` file configured (see below)

### 🏗️ Build and Run

```bash
# Build Docker image
docker build -t barfinex/provider:local -f apps/provider/Dockerfile .

# Run locally with .env
docker run -d -p 8081:8081 --env-file .env.production --name barfinex-provider barfinex/provider:local
```

Access at: **http://localhost:8081**

---

## ⚙️ Environment Configuration

The **Provider Service** uses environment variables to configure connections, security tokens, and integrations.  
Configuration files are environment-specific and located in the repository root.

| File | Purpose |
|------|----------|
| `.env.local` | Local development setup |
| `.env.production` | Docker/Production setup |
| `.env.example` | Template (safe to commit) |

---

### 🧩 Example Environment File

```bash
# ============================================
# 🌐 Application Environment
# ============================================
APP_IDENTITY=provider
NODE_ENV=development
CONFIG_FILE=config.json

# ============================================
# 🚀 Provider Service
# ============================================
PROVIDER_CONTAINER_NAME=provider
PROVIDER_IMAGE=ghcr.io/barfin-network/provider:latest
PROVIDER_COMMAND="yarn start:provider:dev"
PROVIDER_API_PORT=8081
PROVIDER_API_TOKEN="ExampleToken#123!ABC"

# ============================================
# 🔐 SSL Certificates (Local or Production)
# ============================================
SSL_CERT=./cert/localhost.pem
SSL_KEY=./cert/localhost-key.pem

# ============================================
# 🗄️ MongoDB
# ============================================
MONGO_CONTAINER_NAME=mongo
MONGO_IMAGE=mongo:6.0
MONGO_PORT=27017
MONGO_HOST=mongo
# MONGO_HOST=localhost
MONGO_ROOT_USERNAME=admin
MONGO_ROOT_PASSWORD=admin123
MONGO_DATABASE=barfinex_demo

# ============================================
# ⚡ Redis
# ============================================
REDIS_CONTAINER_NAME=redis
REDIS_IMAGE=redis:7.0
REDIS_PORT=6379
REDIS_HOST=redis
# REDIS_HOST=localhost
WEBSOCKET_SERVER_PORT=6380

# ============================================
# 🧠 Binance API (Production Keys)
# ============================================
BINANCE_API_KEY=prod-binance-key-123456
BINANCE_API_SECRET=prod-binance-secret-654321

# ============================================
# 🧪 Binance API (Testnet Keys)
# ============================================
TESTNET_BINANCE_SPOT_KEY=testnet-key-123456
TESTNET_BINANCE_SPOT_SECRET=testnet-secret-654321

# ============================================
# 💰 Alpaca API
# ============================================
ALPACA_API_KEY=alpaca-demo-key
ALPACA_API_SECRET=alpaca-demo-secret

# ============================================
# 💰 Tinkoff Invest API
# ============================================
TINKOFF_API_TOKEN=tinkoff-demo-token
TINKOFF_ACCOUNT_ID=tinkoff-demo-account

# ============================================
# 🤖 Telegram Bot
# ============================================
TELEGRAM_BOT_TOKEN=1234567890:AAExampleBotTokenDemo123
TELEGRAM_CHAT_ID=@barfinex_dev_channel

# ============================================
# 🌍 CORS and Origins
# ============================================
CORS_ORIGINS=https://studio.barfinex.example.com

# ============================================
# 🧰 Portainer (optional)
# ============================================
PONTEINER_CONTAINER_NAME=portainer
PONTEINER_IMAGE=portainer/portainer-ce:latest
PONTEINER_PORT=9000
PONTEINER_HOST=portainer
PONTEINER_ADMIN_USERNAME=admin
PONTEINER_ADMIN_PASSWORD=Admin123!

# ============================================
# 🧭 Redis Commander (optional)
# ============================================
REDIS_COMMANDER_CONTAINER_NAME=redis_commander
REDIS_COMMANDER_IMAGE=rediscommander/redis-commander:latest
REDIS_COMMANDER_PORT=8102
REDIS_COMMANDER_HOSTNAME=redis-commander
REDIS_COMMANDER_REDIS_HOST=redis

# ============================================
# 💻 Mongo Express (optional)
# ============================================
MONGO_EXPRESS_CONTAINER_NAME=mongo-express
MONGO_EXPRESS_IMAGE=mongo-express
MONGO_EXPRESS_PORT=8103
```

---

### 🛠️ Usage

```bash
# 1. Create a local env file
cp .env.example .env.local

# 2. For Docker/Production
cp .env.example .env.production
# Update NODE_ENV, MONGO_HOST, REDIS_HOST, CORS_ORIGINS

# 3. Run service
docker run -d -p 8081:8081 --env-file .env.production --name provider ghcr.io/barfinex/provider:latest
```

---

## 🔒 Tips for Security & Secrets Management

Proper handling of environment variables is essential for maintaining **security** and **operational integrity**  
across Barfinex microservices and CI/CD pipelines.

---

### 🧱 1. Never commit real `.env` files

Add the following to your `.gitignore`:
```bash
# Environment and Secrets
.env
.env.local
.env.production
.env.test
!*.example
certs/
*.pem
*.key
*.crt
```

---

### 🧰 2. Use GitHub Actions Secrets

Store sensitive variables in **Repository → Settings → Secrets and Variables → Actions**  
and access them securely in workflows:
```yaml
env:
  BINANCE_API_KEY: ${{ secrets.BINANCE_API_KEY }}
  BINANCE_API_SECRET: ${{ secrets.BINANCE_API_SECRET }}
  TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
```

---

### 🧳 3. Use Docker Secrets or Compose

```yaml
secrets:
  provider_env:
    file: .env.production

services:
  provider:
    image: ghcr.io/barfinex/provider:latest
    secrets:
      - provider_env
```

or via CLI:
```bash
docker run -d   --env-file .env.production   --name provider   ghcr.io/barfinex/provider:latest
```

---

### 🪪 4. Vault / External Secret Managers (Enterprise)

Use **HashiCorp Vault**, **AWS Secrets Manager**, or **Azure Key Vault**  
for production Barfinex infrastructure.

Example Vault paths:
```
secret/barfinex/provider/binance
secret/barfinex/provider/telegram
```

---

### 🧩 5. Common Variable Conventions

| Variable | Purpose |
|-----------|----------|
| `APP_IDENTITY` | Identifies service name |
| `NODE_ENV` | `development` / `production` |
| `CONFIG_FILE` | Path to configuration JSON |
| `PROVIDER_API_TOKEN` | Internal service token |
| `MONGO_HOST`, `REDIS_HOST` | Cluster networking variables |

---

## 🧩 Secure Deployment with Docker Compose

A sample `docker-compose.yml` structure for local or staging deployments:

```yaml
version: "3.9"

services:
  mongo:
    image: mongo:6.0
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: admin123

  redis:
    image: redis:7.0
    ports:
      - "6379:6379"

  provider:
    image: ghcr.io/barfinex/provider:latest
    container_name: provider
    env_file: .env.production
    ports:
      - "8081:8081"
    depends_on:
      - mongo
      - redis
```

Run everything with:
```bash
docker compose up -d
```

---

## 🧠 Key Technologies

- **NestJS** – Modular framework for Node.js  
- **TypeScript** – Type safety and maintainability  
- **Docker** – Containerized service architecture  
- **Binance / Alpaca / Tinkoff APIs** – External financial integrations  

---

## 📄 License

This project is licensed under the **Apache License 2.0**  
with additional **non-commercial and attribution restrictions**.

### Terms
1. Attribution to “Barfin Network Limited” and a link to [https://barfin.network/](https://barfin.network/).  
2. Commercial usage requires explicit written permission.  
3. Non-commercial redistributions must retain branding and links.

For permissions and commercial partnerships:  
📩 [https://barfin.network/](https://barfin.network/)

---
