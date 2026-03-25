import { ProviderRuntimeController } from './provider-runtime.controller';

describe('ProviderRuntimeController', () => {
  function createController() {
    const advisorRuntimeProxyService = {
      getStatus: jest.fn().mockResolvedValue({
        status: 200,
        data: { ok: true, source: 'status' },
      }),
      getGraph: jest.fn().mockResolvedValue({
        status: 200,
        data: { ok: true, source: 'graph' },
      }),
    };
    const controller = new ProviderRuntimeController(
      advisorRuntimeProxyService as any,
    );
    return { controller, advisorRuntimeProxyService };
  }

  function mockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };
  }

  it('proxies advisor runtime status response unchanged', async () => {
    const { controller, advisorRuntimeProxyService } = createController();
    const res = mockRes();
    const req = { headers: { 'x-request-id': 'req-status' } } as any;

    await controller.getAdvisorStatus(req, res as any);

    expect(advisorRuntimeProxyService.getStatus).toHaveBeenCalledWith(
      req.headers,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ ok: true, source: 'status' });
  });

  it('proxies advisor runtime graph response unchanged', async () => {
    const { controller, advisorRuntimeProxyService } = createController();
    const res = mockRes();
    const req = { headers: { 'x-request-id': 'req-graph' } } as any;

    await controller.getAdvisorGraph(req, res as any);

    expect(advisorRuntimeProxyService.getGraph).toHaveBeenCalledWith(
      req.headers,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ ok: true, source: 'graph' });
  });
});
