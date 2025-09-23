# Provider Service

The `provider` service is part of the `barfin-network` ecosystem. It is designed to handle operations related to financial data, asset management, and integration with external financial APIs. This service is modular and built using the **NestJS** framework for scalability and maintainability.

---

## Features

- **Account Management**: User accounts and related services.
- **Asset Handling**: Provides data and operations for financial assets.
- **Candlestick Data**: Processes and serves OHLC data for charting.
- **Connectors**: Integrates with platforms like Binance, Tinkoff, Alpaca, and others.
- **Order Processing**: Manages orders and related operations.
- **Subscription Management**: Handles subscriptions for services.
- **Symbol Handling**: Manages financial symbols and metadata.
- **Custom Integration**: Allows for detector services and containerized deployments via Portainer.

---

## File Structure

The project is organized into distinct modules, each handling specific functionalities:

### Root Files
- **`.dockerignore`**: Specifies files to exclude from Docker builds.
- **`Dockerfile`**: Contains the steps to build the Docker container.
- **`tsconfig.app.json`**: TypeScript configuration file for the application.

### `src` Directory

#### 1. **Account Module**
- **Files**:
  - `account.controller.ts`: Defines API routes for account operations.
  - `account.service.ts`: Implements business logic for accounts.
  - `account.interface.ts`: Interfaces for account-related entities.

#### 2. **Asset Module**
- **Files**:
  - `asset.controller.ts`: API routes for assets.
  - `asset.service.ts`: Business logic for managing assets.

#### 3. **Candlestick Module**
- **Files**:
  - `candle.controller.ts`: Handles candlestick data APIs.
  - `candle.service.ts`: Processes candlestick data.
  - `candle.entity.ts`: Defines the candlestick data model.
  - `candleMetadata.entity.ts`: Metadata for candlesticks.

#### 4. **Connector Module**
- **Purpose**: Provides integration with external APIs.
- **Files**:
  - `connector.controller.ts`: API endpoints for connectors.
  - `connector.service.ts`: Manages integration logic.
  - `datasource/`: Includes services for platforms like Binance, Tinkoff, and Alpaca.

#### 5. **Order Module**
- **Files**:
  - `order.controller.ts`: API routes for order management.
  - `order.service.ts`: Implements order-related logic.
  - `order.entity.ts`: Data model for orders.

#### 6. **Subscription Module**
- **Files**:
  - `subscription.controller.ts`: Handles subscription-related requests.
  - `subscription.service.ts`: Manages subscriptions.
  - `subscription.entity.ts`: Data model for subscriptions.

#### 7. **Symbol Module**
- **Files**:
  - `symbol.controller.ts`: API endpoints for symbols.
  - `symbol.service.ts`: Business logic for symbols.
  - `symbol.entity.ts`: Data model for symbols.

#### 8. **Portainer Integration**
- **Files**:
  - `portainer.controller.ts`: API for Portainer integration.
  - `portainer.service.ts`: Business logic for managing containers.

---

## Deployment Instructions

### Prerequisites
- **Docker** and **Docker Compose** installed on the server.
- Environment variables set up in a `.env` file.

### Steps
1. **Build the Docker Image**:
   ```bash
   docker build -t provider-service:latest -f Dockerfile .
   ```

2. **Run the Container**:
   ```bash
   docker run -d -p 3000:3000 --env-file .env provider-service:latest
   ```

---

## Key Technologies

- **NestJS Framework**: Modular framework for Node.js.
- **TypeScript**: For type-safe development.
- **Docker**: For containerization.
- **External Integrations**: Binance, Alpaca, Tinkoff, and others.


---

## License

This project is licensed under the [Apache License 2.0](LICENSE) with additional restrictions.

### Key Terms:
1. **Attribution**: Proper credit must be given to the original author. This includes mentioning the author's name, "Barfin Network Limited", and linking to the official repository or website.
2. **Non-Commercial Use**: The use of this codebase for commercial purposes is **prohibited without explicit written permission from Barfin Network Limited**.
3. **Display Requirements**: When used for non-commercial purposes, the following must be included in any distribution, UI, or documentation:
   - The name "Barfin Network Limited".
   - The official logo of Barfin Network Limited.
   - A working link to the official website: [https://barfin.network/](https://barfin.network/).

For further details or to request permission for commercial use, please contact **Barfin Network Limited** through the official channel on our website: [https://barfin.network/](https://barfin.network/).