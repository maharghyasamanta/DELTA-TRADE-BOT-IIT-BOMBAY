// Pure function — no side effects, no imports from server code
import type { AlpacaBar, NormalizedCandle } from '../contracts/alpaca';

function parseFiniteField(value: unknown, fieldName: string, index: number): number {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
    throw new Error(`Alpaca bar at index ${index} is missing required numeric field "${fieldName}"`);
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Alpaca bar at index ${index} has non-finite "${fieldName}" value`);
  }
  return num;
}

export function normalizeAlpacaBars(bars: AlpacaBar[]): NormalizedCandle[] {
  if (!Array.isArray(bars)) {
    throw new Error('Expected bars to be an array');
  }

  const byTime = new Map<number, NormalizedCandle>();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as unknown as Record<string, unknown> | null | undefined;
    if (!bar || typeof bar !== 'object') {
      throw new Error(`Alpaca bar at index ${i} must be an object`);
    }

    if (typeof bar.t !== 'string' || bar.t.trim().length === 0) {
      throw new Error(`Alpaca bar at index ${i} is missing valid timestamp "t"`);
    }

    const parsedMs = new Date(bar.t).getTime();
    if (Number.isNaN(parsedMs)) {
      throw new Error(`Alpaca bar at index ${i} has invalid timestamp "t": ${bar.t}`);
    }

    const time = Math.floor(parsedMs / 1000);
    const open = parseFiniteField(bar.o, 'o', i);
    const high = parseFiniteField(bar.h, 'h', i);
    const low = parseFiniteField(bar.l, 'l', i);
    const close = parseFiniteField(bar.c, 'c', i);
    const volume = parseFiniteField(bar.v, 'v', i);

    // Last bar wins when duplicate timestamps occur
    byTime.set(time, {
      time,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}
