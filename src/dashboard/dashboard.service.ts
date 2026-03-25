import { Injectable, Logger } from '@nestjs/common';
import { TradeSide } from '@barfinex/types';
import { AccountService } from '../account/account.service';
import { ConnectorService } from '../connector/connector.service';
import { DetectorService } from '../detector/detector.service';
import { InspectorService } from '../inspector/inspector.service';
import { AppRegistryService } from '../app-registry/app-registry.service';
import { EventSinkRepository } from '../questdb/event-sink/event-sink.repository';
import { WsEventsCatalogService } from '../ws-events/ws-events.catalog.service';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly accountService: AccountService,
    private readonly connectorService: ConnectorService,
    private readonly detectorService: DetectorService,
    private readonly inspectorService: InspectorService,
    private readonly appRegistryService: AppRegistryService,
    private readonly eventSinkRepository: EventSinkRepository,
    private readonly wsEventsCatalogService: WsEventsCatalogService,
  ) {}

  async getOverview(windowMinutes = 5): Promise<Record<string, unknown>> {
    const normalizedWindowMinutes = this.normalizeWindow(windowMinutes);
    const now = Date.now();

    const [connectors, detectors, inspectors, registryRows, wsCatalog] =
      await Promise.all([
        this.connectorService.getConnectorsList().catch(() => []),
        this.detectorService.getAllDetectors().catch(() => []),
        this.inspectorService.getAll().catch(() => []),
        this.appRegistryService.list({ includeInactive: true }).catch(() => []),
        Promise.resolve(this.wsEventsCatalogService.getCatalog()),
      ]);

    // Dashboard must be in-memory fast: use cached connector accounts state.
    // If state is not initialized yet, perform one-time load as fallback.
    let accounts = this.connectorService.getAllAccounts();
    if (!Array.isArray(accounts) || accounts.length === 0) {
      accounts = await this.accountService.getAll().catch(() => []);
    }

    const eventSinkRuntime = this.eventSinkRepository.getRuntimeStats(
      normalizedWindowMinutes,
    );

    const infra = this.buildInfrastructureSection({
      now,
      connectors: connectors as any[],
      detectors: detectors as any[],
      inspectors: inspectors as any[],
      registryRows: registryRows as any[],
      wsCatalog,
      eventsLast1m: eventSinkRuntime.eventsLast1m,
      eventsLastWindow: eventSinkRuntime.eventsLastWindow,
      windowMinutes: normalizedWindowMinutes,
      eventSinkWal: null,
    });

    const trading = this.buildTradingSection(accounts as any[]);
    const alerts = this.buildAlerts({ infra, trading });

    return {
      generatedAt: now,
      windowMinutes: normalizedWindowMinutes,
      infrastructure: infra,
      trading,
      alerts,
    };
  }

  private buildInfrastructureSection(args: {
    now: number;
    connectors: any[];
    detectors: any[];
    inspectors: any[];
    registryRows: any[];
    wsCatalog: { total: number; namespaces: Array<'/' | '/eventsink'> };
    eventsLast1m: number | null;
    eventsLastWindow: number | null;
    windowMinutes: number;
    eventSinkWal: { lag: number; suspended: boolean } | null;
  }): Record<string, unknown> {
    const {
      now,
      connectors,
      detectors,
      inspectors,
      registryRows,
      wsCatalog,
      eventsLast1m,
      eventsLastWindow,
      windowMinutes,
      eventSinkWal,
    } = args;

    const activeConnectors = connectors.filter((c) => c?.isActive).length;
    const activeDetectors = detectors.filter((d) => d?.isActive).length;

    const registryByType = {
      advisor: { active: 0, total: 0 },
      inspector: { active: 0, total: 0 },
      detector: { active: 0, total: 0 },
    };
    let staleApps = 0;
    for (const row of registryRows) {
      const key = String(row?.appType ?? '');
      if (key === 'advisor' || key === 'inspector' || key === 'detector') {
        registryByType[key].total += 1;
        if (row?.isActive) registryByType[key].active += 1;
      }
      if (!row?.isActive) staleApps += 1;
    }

    return {
      provider: {
        now,
        uptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
        env: process.env.NODE_ENV ?? 'local',
      },
      registry: {
        activeTotal: registryRows.filter((r) => r?.isActive).length,
        total: registryRows.length,
        staleOrInactive: staleApps,
        byType: registryByType,
      },
      connectors: {
        total: connectors.length,
        active: activeConnectors,
      },
      detectors: {
        total: detectors.length,
        active: activeDetectors,
      },
      inspectors: {
        total: inspectors.length,
      },
      realtime: {
        wsNamespaces: wsCatalog.namespaces,
        wsEventsCatalogTotal: wsCatalog.total,
        eventSink: {
          eventsLast1m,
          [`eventsLast${windowMinutes}m`]: eventsLastWindow,
          wal: eventSinkWal,
        },
      },
    };
  }

  private buildTradingSection(accounts: any[]): Record<string, unknown> {
    let walletBalanceTotal = 0;
    let availableBalanceTotal = 0;
    let balancesWithValuation = 0;
    let balancesWithoutValuation = 0;
    let assetCount = 0;
    let positionCount = 0;
    let longPositions = 0;
    let shortPositions = 0;
    let openOrders = 0;
    let dailyPnl = 0;
    let unrealizedPnlEstimate = 0;
    let notionalExposureUsd = 0;
    let marginUsedApprox = 0;

    let maxPositionNotional = 0;
    let maxPositionSymbol: string | null = null;

    for (const account of accounts) {
      for (const asset of account?.assets ?? []) {
        assetCount += 1;
        const walletBalance = Number(asset?.walletBalance ?? 0);
        const availableBalance = Number(asset?.availableBalance ?? 0);
        const symbol = String(asset?.symbol?.name ?? '').toUpperCase();
        const unitPrice = this.resolveAssetUnitPriceUsd(asset, symbol);

        if (unitPrice === null) {
          balancesWithoutValuation += 1;
          continue;
        }

        balancesWithValuation += 1;
        walletBalanceTotal += walletBalance * unitPrice;
        availableBalanceTotal += availableBalance * unitPrice;
      }

      const dayPnl = Number(account?.dailyProfit?.value ?? 0);
      if (Number.isFinite(dayPnl)) dailyPnl += dayPnl;

      for (const order of account?.orders ?? []) {
        const closeTime = Number(order?.closeTime ?? 0);
        if (!closeTime) openOrders += 1;
      }

      for (const position of account?.positions ?? []) {
        positionCount += 1;
        const side = String(position?.side ?? '').toUpperCase();
        if (side === TradeSide.LONG) longPositions += 1;
        if (side === TradeSide.SHORT) shortPositions += 1;

        const qty = Number(position?.quantity ?? 0);
        const entry = Number(position?.entryPrice ?? 0);
        const last = Number(position?.lastPrice ?? entry);
        const notional = Math.abs(qty * (last || entry || 0));
        notionalExposureUsd += notional;
        marginUsedApprox += Number(position?.initialMargin ?? 0);

        if (notional > maxPositionNotional) {
          maxPositionNotional = notional;
          maxPositionSymbol = String(position?.symbol?.name ?? '');
        }

        if (qty > 0 && entry > 0 && last > 0) {
          const sideFactor = side === TradeSide.SHORT ? -1 : 1;
          unrealizedPnlEstimate += (last - entry) * qty * sideFactor;
        }
      }
    }

    const balanceUtilizationPct =
      walletBalanceTotal > 0
        ? ((walletBalanceTotal - availableBalanceTotal) / walletBalanceTotal) *
          100
        : 0;

    return {
      accounts: {
        activeAccounts: accounts.length,
      },
      balances: {
        walletBalanceTotal,
        availableBalanceTotal,
        utilizationPct: balanceUtilizationPct,
        assetsTracked: assetCount,
        assetsWithValuation: balancesWithValuation,
        assetsWithoutValuation: balancesWithoutValuation,
      },
      pnl: {
        dailyPnl,
        unrealizedPnlEstimate,
      },
      risk: {
        openPositions: positionCount,
        longPositions,
        shortPositions,
        openOrders,
        notionalExposureUsd,
        marginUsedApprox,
        largestPosition: {
          symbol: maxPositionSymbol,
          notionalUsd: maxPositionNotional,
        },
      },
    };
  }

  private resolveAssetUnitPriceUsd(asset: any, symbol: string): number | null {
    // Stablecoins are already in quote currency.
    if (symbol === 'USDT' || symbol === 'USD' || symbol === 'USDC') return 1;

    const candidates = Array.isArray(asset?.price)
      ? asset.price
      : asset?.price
      ? [asset.price]
      : [];

    for (const item of candidates) {
      const currency = String(item?.currency ?? '').toUpperCase();
      const value = Number(item?.value);
      if (
        (currency === 'USDT' || currency === 'USD' || currency === 'USDC') &&
        Number.isFinite(value) &&
        value > 0
      ) {
        return value;
      }
    }

    return null;
  }

  private buildAlerts(args: {
    infra: Record<string, any>;
    trading: Record<string, any>;
  }): Array<{ severity: 'info' | 'warning'; code: string; message: string }> {
    const alerts: Array<{
      severity: 'info' | 'warning';
      code: string;
      message: string;
    }> = [];
    const infra = args.infra;
    const trading = args.trading;

    const registry = infra.registry ?? {};
    const byType = registry.byType ?? {};
    const advisorActive = Number(byType.advisor?.active ?? 0);
    const inspectorActive = Number(byType.inspector?.active ?? 0);
    const detectorActive = Number(byType.detector?.active ?? 0);

    if (advisorActive === 0) {
      alerts.push({
        severity: 'warning',
        code: 'ADVISOR_INACTIVE',
        message: 'No active advisor instance in app registry.',
      });
    }
    if (inspectorActive === 0) {
      alerts.push({
        severity: 'warning',
        code: 'INSPECTOR_INACTIVE',
        message: 'No active inspector instance in app registry.',
      });
    }
    if (detectorActive === 0) {
      alerts.push({
        severity: 'warning',
        code: 'DETECTOR_INACTIVE',
        message: 'No active detector instance in app registry.',
      });
    }

    const eventsLast1m = Number(infra.realtime?.eventSink?.eventsLast1m ?? 0);
    if (eventsLast1m === 0) {
      alerts.push({
        severity: 'warning',
        code: 'EVENT_FLOW_LOW',
        message: 'No event_sink events in the last minute.',
      });
    }

    const exposure = Number(trading.risk?.notionalExposureUsd ?? 0);
    const wallet = Number(trading.balances?.walletBalanceTotal ?? 0);
    if (wallet > 0 && exposure > wallet * 5) {
      alerts.push({
        severity: 'warning',
        code: 'HIGH_EXPOSURE',
        message:
          'Notional exposure is significantly higher than wallet balance.',
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        severity: 'info',
        code: 'SYSTEM_OK',
        message: 'No critical dashboard alerts detected.',
      });
    }
    return alerts;
  }

  private normalizeWindow(value: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 5;
    return Math.max(1, Math.min(1440, Math.floor(n)));
  }
}
