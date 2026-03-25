import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AdvisorProxyService } from '../src/advisor-proxy/advisor-proxy.service';
import { DetectorProxyService } from '../src/detector-proxy/detector-proxy.service';
import { InspectorProxyService } from '../src/inspector-proxy/inspector-proxy.service';
import { ProviderGatewayController } from '../src/provider-gateway/provider-gateway.controller';

describe('Provider proxy coverage (e2e)', () => {
  let app: INestApplication;

  const mockDetectorProxy = {
    request: jest
      .fn()
      .mockResolvedValue({ status: 200, data: { ok: true, from: 'detector' } }),
    get: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
  };
  const mockInspectorProxy = {
    request: jest.fn().mockResolvedValue({
      status: 200,
      data: { ok: true, from: 'inspector' },
    }),
    get: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
  };
  const mockAdvisorProxy = {
    get: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ProviderGatewayController],
      providers: [
        { provide: DetectorProxyService, useValue: mockDetectorProxy },
        { provide: InspectorProxyService, useValue: mockInspectorProxy },
        { provide: AdvisorProxyService, useValue: mockAdvisorProxy },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('proxies detector and inspector via provider facade', async () => {
    await request(app.getHttpServer())
      .get('/provider/detector/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body.from).toBe('detector');
      });

    await request(app.getHttpServer())
      .get('/provider/inspector/metrics')
      .expect(200)
      .expect(({ body }) => {
        expect(body.from).toBe('inspector');
      });
  });

  it('aggregates provider system health', async () => {
    await request(app.getHttpServer())
      .get('/provider/system/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
        expect(body.services).toEqual({
          detector: 'ok',
          inspector: 'ok',
          advisor: 'ok',
          provider: 'ok',
        });
      });
  });
});
