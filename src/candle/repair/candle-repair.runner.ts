import { BadRequestException, Injectable } from '@nestjs/common';
import { CandleRepairService } from './candle-repair.service';
import {
  CandleRepairRequest,
  CandleRepairResponse,
  SeriesIntegrityReport,
} from './candle-repair.types';

@Injectable()
export class CandleRepairRunner {
  private runningRepair: Promise<CandleRepairResponse> | null = null;

  constructor(private readonly candleRepairService: CandleRepairService) {}

  async loadIntegrityReport(
    series?: CandleRepairRequest['series'],
  ): Promise<SeriesIntegrityReport[]> {
    return this.candleRepairService.loadIntegrityReport(series);
  }

  async run(request: CandleRepairRequest): Promise<CandleRepairResponse> {
    if (this.runningRepair) {
      throw new BadRequestException('Repair already running');
    }

    this.runningRepair = this.candleRepairService.executeRepair(request);
    try {
      return await this.runningRepair;
    } finally {
      this.runningRepair = null;
    }
  }
}
