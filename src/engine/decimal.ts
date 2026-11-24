/**
 * Zero-dependency BigInt fixed-point arithmetic (1e-8 precision) and integer
 * tick helpers with explicit directional rounding:
 *  - Costs, fees, slippage, and margin requirements round UP (ceil).
 *  - Proceeds, payouts, and realizable equity round DOWN (floor).
 *
 * All money values serialize strictly as canonical decimal strings of BigInt
 * micro-units (1 unit = 10^-8 USDT / base asset) to avoid JSON precision loss.
 */

export const FIXED_SCALE_DIGITS = 8;
export const FIXED_SCALE = 100_000_000n; // 10^8
export const BPS_DENOM = 10_000n;
export const PCT_TO_RATIO_DENOM = 100n;

export type UnitsString = string;

const DECIMAL_STR_RE = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))\s*$/;

/**
 * Parse a decimal string (e.g. "61399.5", "0.0002", "-12.345") directly into
 * scaled BigInt units (10^8 scale) with no intermediate floating-point math.
 * Fractional digits beyond 8 are truncated toward zero by default or rounded
 * strictly using `roundMode`.
 */
export function parseFixedUnits(
  raw: string | number | bigint,
  roundMode: 'trunc' | 'up' | 'down' = 'trunc',
): bigint {
  if (typeof raw === 'bigint') {
    return raw;
  }
  const str = typeof raw === 'number' ? raw.toString() : raw;
  if (typeof str !== 'string') {
    throw new Error(`Invalid decimal input: ${String(raw)}`);
  }
  // Handle scientific notation like "1.25e-6" cleanly via string normalization
  const trimmed = str.trim();
  if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(trimmed)) {
    const expanded = expandScientificNotation(trimmed);
    return parseFixedUnits(expanded, roundMode);
  }

  const m = DECIMAL_STR_RE.exec(trimmed);
  if (!m) {
    throw new Error(`Invalid decimal string: "${raw}"`);
  }

  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? m[4] ?? '';

  const paddedFrac = (fracPart + '00000000').slice(0, FIXED_SCALE_DIGITS);
  const remainder = fracPart.slice(FIXED_SCALE_DIGITS);
  const hasNonZeroRemainder = /[1-9]/.test(remainder);

  let magnitude = BigInt(intPart) * FIXED_SCALE + BigInt(paddedFrac);
  if (hasNonZeroRemainder) {
    if (roundMode === 'up' && sign > 0n) {
      magnitude += 1n;
    } else if (roundMode === 'down' && sign < 0n) {
      magnitude += 1n;
    }
  }

  return magnitude === 0n ? 0n : sign * magnitude;
}

function expandScientificNotation(input: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(input);
  if (!match) {
    throw new Error(`Invalid scientific notation: "${input}"`);
  }
  const sign = match[1] === '-' ? '-' : '';
  const intDigits = match[2];
  const fracDigits = match[3] ?? '';
  const exp = Number.parseInt(match[4], 10);
  const allDigits = intDigits + fracDigits;
  const decimalPos = intDigits.length + exp;

  if (decimalPos <= 0) {
    return `${sign}0.${'0'.repeat(-decimalPos)}${allDigits}`;
  }
  if (decimalPos >= allDigits.length) {
    return `${sign}${allDigits}${'0'.repeat(decimalPos - allDigits.length)}`;
  }
  return `${sign}${allDigits.slice(0, decimalPos)}.${allDigits.slice(decimalPos)}`;
}

/**
 * Parse a percentage string (e.g. "0.25" for 0.25% or "0.5" for 0.5%) into
 * ratio units at 10^8 scale (i.e. divided by 100).
 */
export function parsePercentToRatioUnits(rawPercent: string): bigint {
  const pctUnits = parseFixedUnits(rawPercent, 'up');
  return divRoundUp(pctUnits, PCT_TO_RATIO_DENOM);
}

/**
 * Format scaled BigInt units (10^8) to human decimal string with specified display decimals.
 */
export function formatFixedUnits(units: bigint, decimals = 2): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / FIXED_SCALE;
  const frac = abs % FIXED_SCALE;

  if (decimals <= 0) {
    return `${negative && whole > 0n ? '-' : ''}${whole.toString()}`;
  }

  const fullFrac = frac.toString().padStart(FIXED_SCALE_DIGITS, '0');
  const shownFrac =
    decimals <= FIXED_SCALE_DIGITS
      ? fullFrac.slice(0, decimals)
      : fullFrac.padEnd(decimals, '0');

  return `${negative ? '-' : ''}${whole.toString()}.${shownFrac}`;
}

export function unitsToDecimalNumber(units: bigint): number {
  return Number(units) / Number(FIXED_SCALE);
}

export function unitsToString(units: bigint): UnitsString {
  return units.toString();
}

export function stringToUnits(raw: string): bigint {
  if (typeof raw !== 'string' || !/^-?\d{1,38}$/.test(raw.trim())) {
    throw new Error(`Invalid BigInt units string: "${raw}"`);
  }
  return BigInt(raw.trim());
}

/**
 * Integer floor division (rounds toward -Infinity).
 */
export function divFloor(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('Division by zero');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r !== 0n && numerator < 0n) {
    return q - 1n;
  }
  return q;
}

/**
 * Integer ceiling division (rounds toward +Infinity).
 */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('Division by zero');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r !== 0n && numerator > 0n) {
    return q + 1n;
  }
  return q;
}

/**
 * Positive magnitude round UP helper.
 */
export function divRoundUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) {
    return divFloor(numerator, denominator);
  }
  return divCeil(numerator, denominator);
}

/**
 * (a * b) / denominator rounded DOWN (toward -Infinity) — use for proceeds/payouts.
 */
export function mulDivFloor(a: bigint, b: bigint, denominator: bigint = FIXED_SCALE): bigint {
  return divFloor(a * b, denominator);
}

/**
 * (a * b) / denominator rounded UP (toward +Infinity) — use for fees, slippage, margin requirements.
 */
export function mulDivCeil(a: bigint, b: bigint, denominator: bigint = FIXED_SCALE): bigint {
  return divCeil(a * b, denominator);
}

/**
 * Multiply two 1e-8 scaled quantities rounding DOWN.
 */
export function mulUnitsDown(a: bigint, b: bigint): bigint {
  return mulDivFloor(a, b, FIXED_SCALE);
}

/**
 * Multiply two 1e-8 scaled quantities rounding UP (always rounds away from 0 for positive costs).
 */
export function mulUnitsUp(a: bigint, b: bigint): bigint {
  return mulDivCeil(a, b, FIXED_SCALE);
}

/**
 * Convert a price (in 10^8 units) into integer tick count given tickSizeUnits (>0).
 */
export function priceUnitsToTicks(
  priceUnits: bigint,
  tickSizeUnits: bigint,
  mode: 'down' | 'up' | 'nearest' = 'nearest',
): number {
  if (tickSizeUnits <= 0n) {
    throw new Error('tickSizeUnits must be positive');
  }
  if (mode === 'down') {
    return Number(divFloor(priceUnits, tickSizeUnits));
  }
  if (mode === 'up') {
    return Number(divCeil(priceUnits, tickSizeUnits));
  }
  const doubled = priceUnits * 2n + tickSizeUnits;
  return Number(divFloor(doubled, tickSizeUnits * 2n));
}

export function ticksToPriceUnits(ticks: number, tickSizeUnits: bigint): bigint {
  if (!Number.isSafeInteger(ticks) || tickSizeUnits <= 0n) {
    throw new Error(`Invalid ticks (${ticks}) or tickSizeUnits (${tickSizeUnits})`);
  }
  return BigInt(ticks) * tickSizeUnits;
}

export function absBigInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
