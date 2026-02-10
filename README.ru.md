<p>
  🌐 <b>Языки:</b>  
  <a href="README.md"><code>🇬🇧 English</code></a> ·
  <a href="README.ru.md"><code>🇷🇺 Русский</code></a> ·
  <code style="color:gray;">🇰🇿 Қазақша</code> ·
  <code style="color:gray;">🇨🇳 中文</code>
</p>

---

# 🧩 Сервис Provider

[![ghcr](https://img.shields.io/badge/GHCR-ghcr.io%2Fbarfinex%2Fprovider-blue?logo=github&logoColor=white)](https://ghcr.io/barfinex/provider)
[![dockerhub](https://img.shields.io/badge/DockerHub-barfinex%2Fprovider-blue?logo=docker&logoColor=white)](https://hub.docker.com/r/barfinex/provider)
[![image-size](https://img.shields.io/docker/image-size/barfinex/provider/latest?label=image%20size)](https://ghcr.io/barfinex/provider)
[![version](https://img.shields.io/badge/version-auto--updated-success)](https://ghcr.io/barfinex/provider)

---

## 📘 Обзор

Сервис `provider` является частью **Barfinex Trading Ecosystem**.  
Он отвечает за агрегацию финансовых данных, управление символами, маршрутизацию ордеров  
и интеграцию с внешними финансовыми API, такими как Binance, Tinkoff и Alpaca.

Создан с использованием **NestJS** и **TypeScript**, отличается модульной архитектурой, масштабируемостью  
и готовностью к распределённым развертываниям.

---

## 🚀 Развёртывание

Сервис автоматически публикуется через **GitHub Actions** и **semantic-release**.  
Каждая успешная сборка экспортирует исходный код, создаёт GitHub Release  
и публикует Docker-образ в **GitHub Container Registry (GHCR)**:

```bash
# === GitHub Container Registry ===
docker pull ghcr.io/barfinex/provider:latest

# === Docker Hub ===
docker pull barfinex/provider:latest
```

---

## ✨ Возможности

- **Управление аккаунтами** – обработка пользователей и торговых счетов.  
- **Работа с активами** – предоставление данных и операций по активам.  
- **Свечные данные (Candlestick)** – обработка и выдача OHLC-графиков.  
- **Коннекторы** – интеграция с Binance, Tinkoff, Alpaca и другими API.  
- **Обработка ордеров** – управление размещением и синхронизацией ордеров.  
- **Управление подписками** – потоковая передача данных на основе событий.  
- **Метаданные символов** – ведение реестра и метаданных торговых инструментов.  
- **Интеграция с Portainer** – управление контейнерами для корпоративных кластеров.  

---

## 📁 Структура проекта

### Корневые файлы
- `.dockerignore` – исключаемые из сборки Docker файлы.  
- `Dockerfile` – конфигурация сборки Docker-образа.  
- `tsconfig.app.json` – конфигурация TypeScript.

### Модули `src`

| Модуль | Описание |
|--------|-----------|
| **account** | Роуты и сервисы аккаунтов |
| **asset** | Логика и API для активов |
| **candle** | Обработка свечных (OHLC) данных |
| **connector** | Интеграция с внешними провайдерами данных |
| **order** | Управление жизненным циклом ордеров |
| **subscription** | Подписки и потоковая логика |
| **symbol** | Реестр и метаданные торговых инструментов |
| **portainer** | Интеграция с Portainer CE |

---

## 🧰 Инструкция по развертыванию

### 🧾 Предварительные требования
- Установлены **Docker** и **Docker Compose**  
- Настроен корректный файл `.env` (см. пример ниже)

### 🏗️ Сборка и запуск

```bash
# Сборка Docker-образа
docker build -t barfinex/provider:local -f apps/provider/Dockerfile .

# Локальный запуск с .env
docker run -d -p 8081:8081 --env-file .env.production --name barfinex-provider barfinex/provider:local
```

Доступ: **http://localhost:8081**

---

## ⚙️ Конфигурация окружения

Сервис **Provider** использует переменные окружения для настройки соединений, токенов безопасности и интеграций.  
Файлы конфигурации лежат в корне репозитория и разделены по окружениям.

| Файл | Назначение |
|------|-------------|
| `.env.local` | Настройки для локальной разработки |
| `.env.production` | Настройки для Docker/продакшена |
| `.env.example` | Шаблон (безопасен для коммита) |

---

### 🧩 Пример `.env` файла
```bash
APP_IDENTITY=provider
NODE_ENV=development

PROVIDER_API_PORT=8081
PROVIDER_API_TOKEN="ExampleToken#123"

MONGO_HOST=mongo
REDIS_HOST=redis

# QuestDB
QUESTDB_HOST=questdb
QUESTDB_PG_PORT=8812
QUESTDB_ILP_PORT=9009
QUESTDB_HTTP_PORT=9000
QUESTDB_USER=admin
QUESTDB_PASSWORD=quest
```

---

### 🛠️ Использование

```bash
# 1. Создать локальный .env
cp .env.example .env.local

# 2. Для Docker/Production
cp .env.example .env.production
# Обновите NODE_ENV, MONGO_HOST, REDIS_HOST, CORS_ORIGINS

# 3. Запустить сервис
docker run -d -p 8081:8081 --env-file .env.production --name provider ghcr.io/barfinex/provider:latest
```

---

## 🔒 Советы по безопасности и управлению секретами

Правильная работа с переменными окружения — ключ к **безопасности** и **стабильности**  
во всей микросервисной экосистеме Barfinex и CI/CD конвейерах.

---

### 🧱 1. Никогда не коммитьте реальные `.env` файлы

Добавьте в `.gitignore`:
```bash
# Environment и Secrets
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

### 🧰 2. Используйте Secrets GitHub Actions

Храните конфиденциальные переменные в **Settings → Secrets and Variables → Actions**  
и подключайте их в workflow:

```yaml
env:
  BINANCE_API_KEY: ${{ secrets.BINANCE_API_KEY }}
  BINANCE_API_SECRET: ${{ secrets.BINANCE_API_SECRET }}
  TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
```

---

### 🧳 3. Используйте Docker Secrets или Compose

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

или через CLI:
```bash
docker run -d --env-file .env.production --name provider ghcr.io/barfinex/provider:latest
```

---

### 🪪 4. Хранилища секретов (Vault / Enterprise)

Для продакшен-инфраструктуры Barfinex используйте **HashiCorp Vault**, **AWS Secrets Manager** или **Azure Key Vault**.

Примеры путей в Vault:
```
secret/barfinex/provider/binance
secret/barfinex/provider/telegram
```

---

### 🧩 5. Общие соглашения по переменным

| Переменная | Назначение |
|-------------|-------------|
| `APP_IDENTITY` | Имя сервиса |
| `NODE_ENV` | `development` / `production` |
| `CONFIG_FILE` | Путь к JSON конфигурации |
| `PROVIDER_API_TOKEN` | Внутренний сервисный токен |
| `MONGO_HOST`, `REDIS_HOST` | Сетевые параметры кластера |

---

## 🧩 Безопасное развертывание через Docker Compose

Пример `docker-compose.yml` для локальных и тестовых сред:

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

  questdb:
    image: questdb/questdb:latest
    ports:
      - "8812:8812"
      - "9000:9000"
      - "9009:9009"
    volumes:
      - ./data/questdb:/root/.questdb

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

Запуск:
```bash
docker compose up -d
```

---

## 🧠 Ключевые технологии

- **NestJS** – модульный фреймворк для Node.js  
- **TypeScript** – строгая типизация и масштабируемость  
- **Docker** – контейнеризация и оркестрация сервисов  
- **Binance / Alpaca / Tinkoff APIs** – внешние финансовые интеграции  
- **QuestDB** — хранилище временных рядов

---

## 📄 Лицензия

Проект распространяется под **Apache License 2.0**  
с дополнительными ограничениями на **некоммерческое использование** и **обязательную атрибуцию**.

### Условия
1. Указание авторства “Barfin Network Limited” и ссылка на [https://barfinex.com/](https://barfinex.com/).  
2. Коммерческое использование — только с письменного разрешения.  
3. Некоммерческие распространения должны сохранять брендинг и ссылки.

Для разрешений и партнёрств:  
📩 [https://barfinex.com/](https://barfinex.com/)

---
