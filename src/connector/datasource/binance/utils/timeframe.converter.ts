import { CandleChartInterval } from 'binance-api-node';
import { TimeFrame } from '@barfinex/types';
import { AppError, ErrorEnvironment } from '../../../../error';

export function convertTimeFrame(interval: TimeFrame): CandleChartInterval {
  switch (interval) {
    case TimeFrame.min1:
      return CandleChartInterval.ONE_MINUTE;
    case TimeFrame.min5:
      return CandleChartInterval.FIVE_MINUTES;
    case TimeFrame.min15:
      return CandleChartInterval.FIFTEEN_MINUTES;
    case TimeFrame.min30:
      return CandleChartInterval.THIRTY_MINUTES;
    case TimeFrame.h1:
      return CandleChartInterval.ONE_HOUR;
    case TimeFrame.h2:
      return CandleChartInterval.TWO_HOURS;
    case TimeFrame.h4:
      return CandleChartInterval.FOUR_HOURS;
    case TimeFrame.day:
      return CandleChartInterval.ONE_DAY;
  }

  throw new AppError(ErrorEnvironment.Provider, 'Unsupported interval');
}
