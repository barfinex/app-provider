import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Dashboard overview',
    description:
      'Returns operational dashboard overview for the Provider (e.g. ingestion, connectors). Optional window in minutes.',
  })
  @ApiQuery({
    name: 'windowMinutes',
    required: false,
    description: 'Time window in minutes (default 5)',
  })
  @ApiOkResponse({ description: 'Dashboard overview payload' })
  async getOverview(@Query('windowMinutes') windowMinutes?: string) {
    return this.dashboardService.getOverview(Number(windowMinutes ?? 5));
  }
}
