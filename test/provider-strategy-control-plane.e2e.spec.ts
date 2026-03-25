import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DetectorStrategyLoader } from '@barfinex/detector';
import { StrategySynthesisRequest } from '@barfinex/types';
import { ProviderGatewayController } from '../src/provider-gateway/provider-gateway.controller';
import { AdvisorProxyService } from '../src/advisor-proxy/advisor-proxy.service';
import { DetectorProxyService } from '../src/detector-proxy/detector-proxy.service';
import { InspectorProxyService } from '../src/inspector-proxy/inspector-proxy.service';
import { AdvisorStrategySynthesisController } from '../../advisor/src/strategy-synthesis/advisor-strategy-synthesis.controller';
import { AdvisorStrategySynthesisService } from '../../advisor/src/strategy-synthesis/advisor-strategy-synthesis.service';
import { AdvisorStrategySynthesisCandidateStore } from '../../advisor/src/strategy-synthesis/advisor-strategy-synthesis-candidate.store';
import { AdvisorStrategyCompatibilityCatalogService } from '../../advisor/src/strategy-synthesis/advisor-strategy-compatibility-catalog.service';
import { StrategyGovernanceService } from '../../advisor/src/decision-outcome/strategy-governance.service';
import { StrategyBudgetManagerService } from '../../advisor/src/strategy-synthesis/strategy-budget-manager.service';

describe('Provider strategy control plane (e2e)', () => {
  let app: INestApplication;

  const candidateRows = new Map<string, any>();
  const governanceStates = new Map<string, any>();
  const governanceHistory: any[] = [];
  const detectorDefinitions = new Map<string, any>();

  const keyFor = (strategyId: string, strategyVersion: string): string =>
    `${strategyId}::${strategyVersion}`;

  function createSynthesisController(): AdvisorStrategySynthesisController {
    const catalog = {
      getCatalog: jest.fn().mockReturnValue({
        detectorTypes: ['follow-trend'],
        indicators: ['rsi', 'sma'],
        plugins: ['trade-journal'],
        patterns: ['bullish-engulfing'],
        staticInstances: [
          {
            sysName: 'follow-trend',
            enabled: true,
            loaderSysName: 'follow-trend',
          },
        ],
      }),
    } as unknown as AdvisorStrategyCompatibilityCatalogService;

    const store = {
      upsert: jest.fn().mockImplementation(async (candidate: any) => {
        candidateRows.set(candidate.strategyId, { ...candidate });
        return candidate;
      }),
      list: jest
        .fn()
        .mockImplementation(async () =>
          Array.from(candidateRows.values()).map((v) => ({ ...v })),
        ),
      get: jest.fn().mockImplementation(async (strategyId: string) => {
        const row = candidateRows.get(strategyId);
        return row ? { ...row } : null;
      }),
      getBySynthesisHash: jest.fn().mockResolvedValue(null),
    } as unknown as AdvisorStrategySynthesisCandidateStore;

    const governance = {
      getStrategyGovernanceState: jest
        .fn()
        .mockImplementation(async (strategyId: string) => {
          const state = governanceStates.get(strategyId);
          return state ? { ...state } : null;
        }),
      applyLifecycleIntent: jest
        .fn()
        .mockImplementation(async (payload: any) => {
          const current = governanceStates.get(payload.strategyId);
          const currentRevision = Number(current?.revision ?? 0);
          const nextRevision = currentRevision + 1;
          const nextState =
            payload.intent === 'PROMOTE_TO_EXPERIMENT'
              ? 'EXPERIMENT'
              : payload.intent === 'SUPPRESS'
              ? 'SUPPRESSED'
              : payload.intent === 'ARCHIVE'
              ? 'ARCHIVED'
              : 'CANDIDATE';
          governanceStates.set(payload.strategyId, {
            strategyId: payload.strategyId,
            lifecycleState: nextState,
            revision: nextRevision,
          });
          const strategyVersion = payload.context?.strategyVersion || 'v1';
          const detectorKey = keyFor(payload.strategyId, strategyVersion);
          const existingDefinition = detectorDefinitions.get(detectorKey);
          if (existingDefinition) {
            const activationState =
              nextState === 'EXPERIMENT'
                ? 'EXPERIMENT'
                : nextState === 'ARCHIVED'
                ? 'ARCHIVED'
                : nextState === 'SUPPRESSED'
                ? 'SUPPRESSED'
                : 'SUPPRESSED';
            detectorDefinitions.set(detectorKey, {
              ...existingDefinition,
              activationState,
              updatedAt: Date.now(),
            });
          }
          governanceHistory.push({
            strategyId: payload.strategyId,
            nextState,
            transitionReason: `intent_${String(
              payload.intent || '',
            ).toLowerCase()}`,
          });
          return {
            applied: true,
            strategyId: payload.strategyId,
            lifecycleState: nextState,
            revision: nextRevision,
            mutationId: 'm'.repeat(64),
            runtimeReconciled: true,
            runtimeDrift: 'none',
          };
        }),
    } as unknown as StrategyGovernanceService;

    const loader = {
      buildLoadResults: jest
        .fn()
        .mockReturnValue([{ instance: { loaderSysName: 'follow-trend' } }]),
    } as unknown as DetectorStrategyLoader;

    const budgetManager = {
      validatePromotionBudget: jest.fn().mockResolvedValue({
        allowed: true,
        reasons: [],
        snapshot: {
          experimentBudget: {
            maxExperimentsGlobal: 20,
            maxExperimentsPerSymbol: 5,
            maxExperimentsPerDetectorType: 8,
            maxExperimentsPerStrategyFamily: 4,
          },
          experimentUsage: {
            global: 0,
            bySymbol: {},
            byDetectorType: {},
            byStrategyFamily: {},
          },
          remainingBudget: {
            global: 20,
            bySymbol: {},
            byDetectorType: {},
            byStrategyFamily: {},
          },
        },
      }),
      getBudgetSnapshot: jest.fn().mockResolvedValue({
        experimentBudget: {
          maxExperimentsGlobal: 20,
          maxExperimentsPerSymbol: 5,
          maxExperimentsPerDetectorType: 8,
          maxExperimentsPerStrategyFamily: 4,
        },
        experimentUsage: {
          global: 0,
          bySymbol: {},
          byDetectorType: {},
          byStrategyFamily: {},
        },
        remainingBudget: {
          global: 20,
          bySymbol: {},
          byDetectorType: {},
          byStrategyFamily: {},
        },
      }),
    } as unknown as StrategyBudgetManagerService;

    const service = new AdvisorStrategySynthesisService(
      catalog,
      store,
      governance,
      loader,
      budgetManager,
    );
    (service as any).detectorRegistry = {
      hydrateFromPersistence: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockImplementation((definition: any) => {
        const strategyId = definition?.metadata?.strategyId;
        const strategyVersion = definition?.metadata?.strategyVersion;
        detectorDefinitions.set(keyFor(strategyId, strategyVersion), {
          ...definition,
        });
        return definition;
      }),
      find: jest
        .fn()
        .mockImplementation((strategyId: string, strategyVersion: string) => {
          return (
            detectorDefinitions.get(keyFor(strategyId, strategyVersion)) || null
          );
        }),
    };

    return new AdvisorStrategySynthesisController(service);
  }

  function extractStrategyId(endpoint: string): string {
    const match = /^strategies\/([^/]+)/.exec(endpoint);
    return match?.[1] || '';
  }

  beforeAll(async () => {
    process.env.ADVISOR_STRATEGY_SYNTHESIS_ENABLED = 'true';
    candidateRows.clear();
    governanceStates.clear();
    governanceHistory.length = 0;
    detectorDefinitions.clear();

    const advisorController = createSynthesisController();
    const advisorProxy = {
      get: jest.fn().mockImplementation(async (endpoint: string) => {
        if (endpoint === 'strategies')
          return {
            status: 200,
            data: await advisorController.listStrategies(),
          };
        if (endpoint === 'strategies/experiments')
          return {
            status: 200,
            data: await advisorController.listExperiments(),
          };
        if (endpoint === 'strategies/budget')
          return { status: 200, data: await advisorController.getBudget() };
        if (/^strategies\/[^/]+$/.test(endpoint)) {
          return {
            status: 200,
            data: await advisorController.getStrategy(
              extractStrategyId(endpoint),
            ),
          };
        }
        return { status: 404, data: { error: `unknown endpoint ${endpoint}` } };
      }),
      post: jest
        .fn()
        .mockImplementation(
          async (endpoint: string, body: Record<string, unknown>) => {
            if (endpoint === 'strategies/synthesize') {
              return {
                status: 200,
                data: await advisorController.synthesize(
                  body as unknown as StrategySynthesisRequest,
                ),
              };
            }
            const strategyId = extractStrategyId(endpoint);
            if (endpoint.endsWith('/promote')) {
              return {
                status: 200,
                data: await advisorController.promote(strategyId),
              };
            }
            if (endpoint.endsWith('/suppress')) {
              return {
                status: 200,
                data: await advisorController.suppress(strategyId),
              };
            }
            if (endpoint.endsWith('/archive')) {
              return {
                status: 200,
                data: await advisorController.archive(strategyId),
              };
            }
            return {
              status: 404,
              data: { error: `unknown endpoint ${endpoint}` },
            };
          },
        ),
    } as unknown as AdvisorProxyService;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ProviderGatewayController],
      providers: [
        {
          provide: DetectorProxyService,
          useValue: {
            request: jest
              .fn()
              .mockResolvedValue({ status: 200, data: { ok: true } }),
            get: jest
              .fn()
              .mockResolvedValue({ status: 200, data: { ok: true } }),
          },
        },
        {
          provide: InspectorProxyService,
          useValue: {
            request: jest
              .fn()
              .mockResolvedValue({ status: 200, data: { ok: true } }),
            get: jest
              .fn()
              .mockResolvedValue({ status: 200, data: { ok: true } }),
          },
        },
        { provide: AdvisorProxyService, useValue: advisorProxy },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    delete process.env.ADVISOR_STRATEGY_SYNTHESIS_ENABLED;
    await app.close();
  });

  it('flows provider strategy control through advisor into detector+governance handoff', async () => {
    const requestBody: StrategySynthesisRequest = {
      strategyId: 'hardening-trend',
      strategyFamily: 'trend',
      strategyVersion: 'v1',
      detectorType: 'follow-trend',
      symbol: 'ETHUSDT',
      parameters: {
        riskPct: 0.01,
        maxPositions: 1,
        symbol: 'BTCUSDT',
      },
      indicatorDependencies: ['rsi', 'sma'],
      pluginDependencies: ['trade-journal'],
      patternDependencies: ['bullish-engulfing'],
      synthesisReason: 'control_plane_hardening_e2e',
      sourceContext: { symbol: 'SOLUSDT', trigger: 'provider_e2e' },
    };

    const synthesize = await request(app.getHttpServer())
      .post('/provider/strategies/synthesize')
      .send(requestBody)
      .expect(200);
    expect(synthesize.body.registered).toBe(true);
    expect(synthesize.body.candidate.symbol).toBe('ETHUSDT');
    expect(detectorDefinitions.has(keyFor('hardening-trend', 'v1'))).toBe(true);
    expect(governanceStates.get('hardening-trend')?.lifecycleState).toBe(
      'CANDIDATE',
    );
    expect(governanceStates.get('hardening-trend')?.revision).toBe(1);

    const promote = await request(app.getHttpServer())
      .post('/provider/strategies/hardening-trend/promote')
      .send({})
      .expect(200);
    expect(promote.body.promoted).toBe(true);
    expect(governanceStates.get('hardening-trend')?.lifecycleState).toBe(
      'EXPERIMENT',
    );
    expect(governanceStates.get('hardening-trend')?.revision).toBe(2);

    const details = await request(app.getHttpServer())
      .get('/provider/strategies/hardening-trend')
      .expect(200);
    expect(details.body.found).toBe(true);
    expect(details.body.candidate.symbol).toBe('ETHUSDT');
    expect(details.body.candidate.registeredInDetector).toBe(true);
    expect(details.body.candidate.governanceLifecycleState).toBe('EXPERIMENT');
    expect(details.body.candidate.runtimeState).toBe('EXPERIMENT');

    expect(
      governanceHistory.some(
        (entry) =>
          entry.strategyId === 'hardening-trend' &&
          entry.nextState === 'EXPERIMENT' &&
          entry.transitionReason === 'intent_promote_to_experiment',
      ),
    ).toBe(true);
  });
});
