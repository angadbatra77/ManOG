import { RSI, BollingerBands, MACD } from "technicalindicators";
import {
  RSI_PERIOD,
  BB_PERIOD,
  BB_STDDEV,
  MACD_FAST_PERIOD,
  MACD_SLOW_PERIOD,
  MACD_SIGNAL_PERIOD,
} from "../config.js";

/**
 * candles: array of {date, open, high, low, close, volume}, oldest first.
 * Returns aligned arrays (indexed the same as `candles`, with leading nulls
 * where the indicator isn't defined yet due to warm-up period).
 */
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);

  const rsiValues = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const bbValues = BollingerBands.calculate({
    period: BB_PERIOD,
    stdDev: BB_STDDEV,
    values: closes,
  });
  const macdValues = MACD.calculate({
    fastPeriod: MACD_FAST_PERIOD,
    slowPeriod: MACD_SLOW_PERIOD,
    signalPeriod: MACD_SIGNAL_PERIOD,
    values: closes,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const align = (arr) => {
    const pad = candles.length - arr.length;
    return Array.from({ length: candles.length }, (_, i) =>
      i < pad ? null : arr[i - pad]
    );
  };

  return {
    rsi: align(rsiValues),
    bb: align(bbValues),
    macd: align(macdValues),
  };
}
