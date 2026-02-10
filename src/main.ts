import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';
import { applyProviderWsAdapter } from '@barfinex/provider-ws-bridge';

import * as dotenv from 'dotenv';
import { resolve } from 'path';
import * as fs from 'fs';

// 👇 Загружаем .env.{APP_MODE}, напр. .env.local / .env.production
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

async function bootstrap() {
  // 👇 Опции для HTTPS (если заданы SSL_CERT и SSL_KEY в .env)
  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    try {
      httpsOptions = {
        key: fs.readFileSync(resolve(process.cwd(), process.env.SSL_KEY)),
        cert: fs.readFileSync(resolve(process.cwd(), process.env.SSL_CERT)),
      };
      console.log('✅ HTTPS включён (сертификаты загружены)');
    } catch (e: any) {
      console.warn(
        `⚠️ Не удалось загрузить сертификаты (${process.env.SSL_KEY}, ${process.env.SSL_CERT}):`,
        e.message,
      );
    }
  }

  const app = await NestFactory.create(AppModule, { httpsOptions });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe());

  // 👇 Читаем CORS_ORIGINS из env
  const origins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  app.enableCors({
    origin: origins,
    credentials: true,
  });

  // Если нужен сокет-адаптер:
  // applyProviderWsAdapter(app, {
  //   path: '/ws',
  //   cors: { origin: origins, credentials: true },
  // });

  // 👇 Swagger
  const config = new DocumentBuilder()
    .setTitle('Barfinex.com Provider API')
    .setDescription(
      'This allows seamless interaction with multiple trading platforms through connectors. ' +
      'It offers methods for authentication, market data retrieval, order placement and cancellation, ' +
      'portfolio management, notifications, and account management. This API streamlines ' +
      'the development and integration of trading strategies and applications.',
    )
    .setVersion('1.0')
    .addTag('Connectors', 'Retrieve available market data providers...')
    .addTag('Detectors', 'Advanced algorithms for identifying market patterns...')
    .addTag('Inspectors', 'Risk management services in a trading system...')
    .addTag('Accounts', 'Get user account information...')
    .addTag('Orders', 'Place new buy/sell orders...')
    .addTag('Candles', 'Obtain historical candlestick data...')
    .addTag('Products', 'Access information about available trading products...')
    .addTag('Subscriptions', 'Subscribe to notifications about market events...')
    .addTag('Assets', 'Retrieve information about available assets...')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const PORT = process.env.PROVIDER_API_PORT || 8080;
  await app.listen(PORT, '0.0.0.0');

  const proto = httpsOptions ? 'https' : 'http';
  console.log(`🚀 Provider API is running on: ${proto}://localhost:${PORT}/api`);
  console.log(`📑 Documentation: ${proto}://localhost:${PORT}/docs`);
  console.log(`🔌 WebSocket (Socket.IO) at: ${proto}://localhost:${PORT}/ws`);
}
bootstrap();
