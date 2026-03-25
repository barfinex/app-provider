import { ProviderGatewayController } from './provider-gateway.controller';

describe('ProviderGatewayController', () => {
  function createController() {
    const advisorProxyService = {
      get: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
      post: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
    };
    const detectorProxyService = {
      request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
      get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    };
    const inspectorProxyService = {
      request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
      get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    };
    const controller = new ProviderGatewayController(
      detectorProxyService as any,
      inspectorProxyService as any,
      advisorProxyService as any,
    );
    return { controller, advisorProxyService };
  }

  function mockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
  }

  it('forwards strategy control POST endpoints to advisor proxy', async () => {
    const { controller, advisorProxyService } = createController();
    const req = {
      params: { strategyId: 'trend-pulse' },
      headers: { 'x-request-id': 'req-1' },
    } as any;
    const res = mockRes();

    await controller.promoteStrategy(req, res as any, {}, {});
    await controller.suppressStrategy(req, res as any, {}, {});
    await controller.archiveStrategy(req, res as any, {}, {});
    await controller.synthesizeStrategy(req, res as any, {}, {});

    expect((advisorProxyService.post as jest.Mock).mock.calls[0][0]).toBe(
      'strategies/trend-pulse/promote',
    );
    expect((advisorProxyService.post as jest.Mock).mock.calls[1][0]).toBe(
      'strategies/trend-pulse/suppress',
    );
    expect((advisorProxyService.post as jest.Mock).mock.calls[2][0]).toBe(
      'strategies/trend-pulse/archive',
    );
    expect((advisorProxyService.post as jest.Mock).mock.calls[3][0]).toBe(
      'strategies/synthesize',
    );
  });

  it('forwards strategy control GET endpoints to advisor proxy', async () => {
    const { controller, advisorProxyService } = createController();
    const req = {
      params: { strategyId: 'trend-pulse' },
      headers: { 'x-request-id': 'req-2' },
    } as any;
    const res = mockRes();

    await controller.listStrategies(req, res as any, {});
    await controller.listExperimentStrategies(req, res as any, {});
    await controller.strategyBudget(req, res as any, {});
    await controller.getStrategy(req, res as any, {});

    expect((advisorProxyService.get as jest.Mock).mock.calls[0][0]).toBe(
      'strategies',
    );
    expect((advisorProxyService.get as jest.Mock).mock.calls[1][0]).toBe(
      'strategies/experiments',
    );
    expect((advisorProxyService.get as jest.Mock).mock.calls[2][0]).toBe(
      'strategies/budget',
    );
    expect((advisorProxyService.get as jest.Mock).mock.calls[3][0]).toBe(
      'strategies/trend-pulse',
    );
  });

  it('forwards legacy synthesis endpoints to strategy endpoints with deprecation headers', async () => {
    const { controller, advisorProxyService } = createController();
    const req = {
      params: { strategyId: 'trend-pulse' },
      headers: { 'x-request-id': 'req-legacy' },
    } as any;
    const res = mockRes();

    await controller.synthesizeStrategyLegacy(req, res as any, {}, {});
    await controller.promoteStrategyLegacy(req, res as any, {}, {});
    await controller.listStrategiesLegacy(req, res as any, {});

    expect((advisorProxyService.post as jest.Mock).mock.calls[0][0]).toBe(
      'strategies/synthesize',
    );
    expect((advisorProxyService.post as jest.Mock).mock.calls[1][0]).toBe(
      'strategies/trend-pulse/promote',
    );
    expect((advisorProxyService.get as jest.Mock).mock.calls[0][0]).toBe(
      'strategies',
    );
    expect((res.setHeader as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('returns not found when legacy compatibility mode is disabled', async () => {
    process.env.ADVISOR_STRATEGY_CONTROL_PLANE_ENABLE_LEGACY_SYNTHESIS_COMPATIBILITY =
      'false';
    const { controller } = createController();
    const req = { params: {}, headers: {} } as any;
    const res = mockRes();
    await expect(
      controller.synthesizeStrategyLegacy(req, res as any, {}, {}),
    ).rejects.toThrow('disabled');
    delete process.env
      .ADVISOR_STRATEGY_CONTROL_PLANE_ENABLE_LEGACY_SYNTHESIS_COMPATIBILITY;
  });
});
