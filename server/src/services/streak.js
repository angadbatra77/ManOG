// Counts how many consecutive weeks (ending at lastIdx) satisfy qualifiesAt,
// walking backward from the latest candle. Used for both the buy screener
// (RSI>60 + above upper BB + bullish MACD) and sell signals (bearish MACD) so
// each stays listed for as long as it holds the condition, not just the one
// week it first triggered.
export function computeStreak(lastIdx, qualifiesAt) {
  if (lastIdx < 0 || !qualifiesAt(lastIdx)) return null;

  let streakStart = lastIdx;
  while (streakStart - 1 >= 0 && qualifiesAt(streakStart - 1)) {
    streakStart -= 1;
  }

  return { streakStart, weeksInState: lastIdx - streakStart + 1 };
}
