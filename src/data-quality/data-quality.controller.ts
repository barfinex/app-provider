import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { DataQualityService } from './data-quality.service';

@ApiTags('DataQuality')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('provider/data-quality')
export class DataQualityController {
  private readonly logger = new Logger(DataQualityController.name);

  constructor(private readonly dataQualityService: DataQualityService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Data quality overview',
    description:
      'Returns system summary, provider streams, symbol-level data quality, and advisor readiness (when Advisor is reachable).',
  })
  @ApiOkResponse({ description: 'ProviderDataQualityOverviewResponse' })
  async getOverview() {
    return this.dataQualityService.getOverview();
  }

  @Get('symbol/:symbol')
  @ApiOperation({
    summary: 'Per-symbol data quality',
    description: 'Returns data quality and advisor readiness for one symbol.',
  })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiOkResponse({ description: 'ProviderInstrumentDataQualityResponse' })
  async getInstrument(@Param('symbol') symbol: string) {
    const result = await this.dataQualityService.getInstrument(symbol);
    if (result == null) {
      return {
        symbol: symbol.trim().toUpperCase(),
        level: 'ERROR',
        maturity: 'INSUFFICIENT',
        issues: [],
        warnings: [],
        evaluatedAt: Date.now(),
        advisorEligible: false,
        advisorReadiness: null,
      };
    }
    return result;
  }

  @Get('issues')
  @ApiOperation({
    summary: 'Aggregated data quality issues',
    description:
      'Returns recent and per-symbol issues (deduplicated, sorted by time).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'DataQualityIssue[]' })
  async getIssues(@Query('limit') limit?: string) {
    const issues = await this.dataQualityService.getIssues();
    const cap = Math.min(100, Math.max(1, parseInt(limit ?? '50', 10) || 50));
    return issues.slice(0, cap);
  }

  @Get('advisor-readiness')
  @ApiOperation({
    summary: 'Advisor decision readiness',
    description:
      'Proxies Advisor data-quality/readiness or status. Returns per-symbol readiness when Advisor is reachable.',
  })
  @ApiOkResponse({ description: 'AdvisorDecisionReadinessStatus[] or null' })
  async getAdvisorReadiness() {
    return this.dataQualityService.getAdvisorReadiness();
  }

  @Get('desktop')
  @ApiOperation({
    summary: 'Desktop payload for Studio',
    description:
      'Single aggregated payload for the Studio data-quality desktop page: system summary, streams, symbol table, advisor readiness, blocked symbols, recent errors/warnings.',
  })
  @ApiOkResponse({ description: 'DataQualityDesktopPayload' })
  async getDesktop() {
    this.logger.debug('[STREAM_DEBUG] getDesktop entry');
    const payload = await this.dataQualityService.getDesktop();
    if (payload?.providerStreams) {
      this.logger.debug(
        `[STREAM_DEBUG] getDesktop providerStreams candles=${payload.providerStreams.candles?.status} trades=${payload.providerStreams.trades?.status} orderbook=${payload.providerStreams.orderbook?.status}`,
      );
    }
    return payload;
  }
}
