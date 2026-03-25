import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiSecurity,
  ApiQuery,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorProxyService } from './advisor-proxy.service';

/**
 * AdvisorProxy — non-advisor-prefixed services: financial-api, news,
 * recommendations, financial-recommendations.
 *
 * These Advisor endpoints use controller prefixes that are NOT under
 * `advisor/`, so they require raw path forwarding (no `advisor/` prepend).
 */
@ApiTags('AdvisorProxy – Financial & Recommendations')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('advisor-proxy')
export class AdvisorProxyMiscController {
  constructor(private readonly svc: AdvisorProxyService) {}

  // ────────────────────── Financial API ──────────────────────

  @Get('financial-api/price')
  @ApiOperation({
    summary: 'Get instrument price',
    description:
      'Returns current price for a financial instrument via the Advisor financial-api module.',
  })
  @ApiQuery({
    name: 'instrument',
    required: true,
    type: String,
    description: 'Instrument identifier (e.g. BTCUSDT)',
  })
  @ApiOkResponse({ description: 'Price data for the instrument' })
  async financialApiPrice(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fqRaw('financial-api/price', query, res, req);
  }

  @Get('financial-api/historical')
  @ApiOperation({
    summary: 'Get historical instrument data',
    description: 'Returns historical price data for a financial instrument.',
  })
  @ApiQuery({
    name: 'instrument',
    required: true,
    type: String,
    description: 'Instrument identifier',
  })
  async financialApiHistorical(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fqRaw('financial-api/historical', query, res, req);
  }

  // ────────────────────── News ──────────────────────

  @Get('news/fetch')
  @ApiOperation({
    summary: 'Fetch news articles',
    description:
      'Fetches news articles matching the query. Used for market sentiment analysis.',
  })
  @ApiQuery({
    name: 'query',
    required: true,
    type: String,
    description: 'Search query for news',
  })
  async newsFetch(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fqRaw('news/fetch', query, res, req);
  }

  @Get('news/sentiment')
  @ApiOperation({
    summary: 'Analyze news sentiment',
    description:
      'Returns sentiment analysis of news articles for a given query.',
  })
  @ApiQuery({
    name: 'query',
    required: true,
    type: String,
    description: 'Search query for sentiment analysis',
  })
  async newsSentiment(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fqRaw('news/sentiment', query, res, req);
  }

  // ────────────────────── Recommendations ──────────────────────

  @Get('recommendations/signals')
  @ApiOperation({
    summary: 'Get trading signals',
    description: 'Returns trading signal recommendations for an instrument.',
  })
  @ApiQuery({ name: 'instrument', required: true, type: String })
  async recommendationsSignals(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fqRaw('recommendations/signals', query, res, req);
  }

  @Get('recommendations/portfolio')
  @ApiOperation({
    summary: 'Portfolio recommendations',
    description: 'Returns portfolio-level recommendations for a user.',
  })
  @ApiQuery({ name: 'userId', required: true, type: String })
  async recommendationsPortfolio(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fqRaw('recommendations/portfolio', query, res, req);
  }

  // ────────────────────── Financial Recommendations ──────────────────────

  @Post('financial-recommendations/trading-advice')
  @ApiOperation({
    summary: 'Get trading advice',
    description: 'LLM-powered trading advice for a specific instrument.',
  })
  async financialRecommendationsTradingAdvice(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fpRaw(
      'financial-recommendations/trading-advice',
      undefined,
      body,
      res,
      req,
    );
  }

  @Post('financial-recommendations/portfolio-optimization')
  @ApiOperation({
    summary: 'Optimize portfolio',
    description: 'LLM-powered portfolio optimization suggestions.',
  })
  async financialRecommendationsPortfolioOptimization(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fpRaw(
      'financial-recommendations/portfolio-optimization',
      undefined,
      body,
      res,
      req,
    );
  }

  @Post('financial-recommendations/scenario-analysis')
  @ApiOperation({
    summary: 'Scenario analysis',
    description: 'LLM-powered what-if scenario analysis for market conditions.',
  })
  async financialRecommendationsScenarioAnalysis(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fpRaw(
      'financial-recommendations/scenario-analysis',
      undefined,
      body,
      res,
      req,
    );
  }

  // ──────────────── helpers ────────────────

  /** GET with query → raw path (no advisor/ prefix) */
  private async fqRaw(
    rawPath: string,
    query: Record<string, unknown>,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.requestRaw(
      'GET',
      rawPath,
      query,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  /** POST with body → raw path (no advisor/ prefix) */
  private async fpRaw(
    rawPath: string,
    query: Record<string, unknown> | undefined,
    body: Record<string, unknown> | undefined,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.requestRaw(
      'POST',
      rawPath,
      query,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }
}
