import type {
  ExplainSnapshotRequest,
  ExplainStructuredOutput,
  PaperTradeExplainRequest,
} from '../contracts/explain';

export const DISALLOWED_EXPLAIN_WORDS: readonly string[] = [
  'buy',
  'sell',
  'long',
  'short',
  'enter',
  'exit',
  'order',
  'position',
  'guaranteed',
  'predict',
];

const DISALLOWED_WORD_REGEX = new RegExp(
  `\\b(${DISALLOWED_EXPLAIN_WORDS.join('|')})\\b`,
  'gi',
);

export interface ExtractedNumberToken {
  raw: string;
  value: number;
  decimals: number;
}

export interface NumberGroundingResult {
  ok: boolean;
  offendingNumbers: number[];
  offendingTokens: string[];
}

export interface DisallowedContentResult {
  ok: boolean;
  matchedWords: string[];
}

export type ExplainGuardResult =
  | { ok: true }
  | {
      ok: false;
      code: 'DISALLOWED_CONTENT' | 'UNGROUNDED_OUTPUT';
      message: string;
      matchedWords?: string[];
      offendingNumbers?: number[];
    };

function normalizeTextForScan(text: string, lastCandleTime: number | null): string {
  // Normalize typographic minus U+2212 to ASCII '-'
  let cleaned = text.replace(/\u2212/g, '-');

  // If the snapshot carries a lastCandleTime Unix timestamp, strip exact formatted
  // UTC date/time renderings of that timestamp so calendar parts (e.g. 2026-11-23)
  // are not misclassified as ungrounded numeric claims.
  if (lastCandleTime !== null && Number.isFinite(lastCandleTime)) {
    const iso = new Date(lastCandleTime * 1000).toISOString();
    const datePart = iso.slice(0, 10); // YYYY-MM-DD
    const dateTimeMin = `${datePart} ${iso.slice(11, 16)}`; // YYYY-MM-DD HH:MM
    const dateTimeSec = `${datePart} ${iso.slice(11, 19)}`; // YYYY-MM-DD HH:MM:SS
    cleaned = cleaned
      .split(iso)
      .join(' ')
      .split(dateTimeSec)
      .join(' ')
      .split(dateTimeMin)
      .join(' ')
      .split(datePart)
      .join(' ');
  }

  return cleaned;
}

function collectNumbersFromString(
  rawText: string,
  lastCandleTime: number | null,
): ExtractedNumberToken[] {
  const cleaned = normalizeTextForScan(rawText, lastCandleTime);
  const tokens: ExtractedNumberToken[] = [];
  // Match numbers; only bind a leading +/- sign when NOT immediately preceded
  // by an alphanumeric or closing punctuation digit (so "3-10" extracts 3 and 10).
  const regex = /(?:^|[^0-9A-Za-z_])([+-]?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;

  // Alternative pass using boundary lookbehind-free scanning: advance lastIndex safely
  // Note: if two numbers are separated by single '-' like "3-10", the '-' between 3 and 10
  // IS preceded by '3', so we should extract digits separately from range separators.
  // Let's parse character-by-character or use a clean regex over unsigned numbers
  // and inspect the preceding character to decide sign!
  void regex;

  const numRegex = /\d+(?:\.\d+)?/g;
  while ((match = numRegex.exec(cleaned)) !== null) {
    const digits = match[0];
    const startIdx = match.index;
    const prevChar = startIdx > 0 ? cleaned[startIdx - 1] : '';
    const beforeSignChar = startIdx > 1 ? cleaned[startIdx - 2] : '';

    let sign = 1;
    let raw = digits;
    if (prevChar === '-' || prevChar === '+') {
      // Treat as unary sign only when not preceded by a digit or letter (e.g. "3-10" or "20-bar")
      const isBinaryRangeOrHyphen = /[0-9A-Za-z)\]]/.test(beforeSignChar);
      if (!isBinaryRangeOrHyphen) {
        sign = prevChar === '-' ? -1 : 1;
        raw = `${prevChar}${digits}`;
      }
    }

    const parsed = Number(digits) * sign;
    if (!Number.isFinite(parsed)) continue;

    const dotIdx = digits.indexOf('.');
    const decimals = dotIdx >= 0 ? digits.length - dotIdx - 1 : 0;

    tokens.push({
      raw,
      value: parsed,
      decimals,
    });
  }

  return tokens;
}

export function extractAllowedNumbers(snapshot: ExplainSnapshotRequest): number[] {
  const values: number[] = [];

  const pushNum = (v: number | null | undefined) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
    }
  };

  pushNum(snapshot.candleCount);
  pushNum(snapshot.lastCandleTime);

  pushNum(snapshot.regime.score);
  pushNum(snapshot.regime.volZ);
  pushNum(snapshot.regime.trend);
  pushNum(snapshot.regime.changePointsInWindow);
  pushNum(snapshot.regime.lastChangePointAgeBars);

  const t = snapshot.guardrail.thresholdsUsed;
  pushNum(t.pauseScore);
  pushNum(t.pauseVolZ);
  pushNum(t.pauseChangePointAgeBars);
  pushNum(t.reduceScore);
  pushNum(t.reduceVolZ);
  pushNum(t.reduceChangePointAgeBars);

  const w = snapshot.windows;
  pushNum(w.volWindow);
  pushNum(w.volLookback);
  pushNum(w.trendWindow);
  pushNum(w.cusumVolWindow);
  pushNum(w.cusumK);
  pushNum(w.cusumH);
  pushNum(w.cusumDecayBars);
  pushNum(w.weights.volatility);
  pushNum(w.weights.trend);
  pushNum(w.weights.cusum);
  pushNum(w.requiredBarsForVolZ);
  pushNum(w.requiredBarsForTrend);
  pushNum(w.requiredBarsForCusum);
  pushNum(w.skippedNonPositiveCloses);

  // Also allow any numeric literals explicitly present inside snapshot strings
  // (e.g., timeframe "15m (24H)", "1Day", or deterministic guardrail reason strings).
  const stringSources: string[] = [
    snapshot.symbol,
    snapshot.timeframe,
    ...snapshot.guardrail.firedRules,
    ...snapshot.guardrail.reasons,
  ];
  for (const s of stringSources) {
    for (const tok of collectNumbersFromString(s, null)) {
      pushNum(tok.value);
    }
  }

  return values;
}

function isTokenGrounded(token: ExtractedNumberToken, allowed: readonly number[]): boolean {
  const candidate = token.value;
  for (const ref of allowed) {
    if (Math.abs(candidate - ref) <= 1e-9) {
      return true;
    }

    if (token.decimals >= 1) {
      // Allow rounding at the reported decimal precision (e.g. 1.92 matches 1.9234,
      // half-ULP tolerance = 0.5 * 10^-decimals + tiny float epsilon).
      const halfStep = 0.5 * Math.pow(10, -token.decimals) + 1e-9;
      if (Math.abs(candidate - ref) <= halfStep) {
        return true;
      }
    } else if (Math.abs(ref) >= 10 && Math.abs(candidate - Math.round(ref)) <= 1e-9) {
      // Allow rounded whole numbers for metrics >= 10 (e.g. score 36.3 -> 36).
      return true;
    }
  }
  return false;
}

export function validateNumberGrounding(
  output: ExplainStructuredOutput,
  snapshot: ExplainSnapshotRequest,
): NumberGroundingResult {
  const allowed = extractAllowedNumbers(snapshot);

  const textsToCheck: string[] = [
    output.summary,
    ...output.keyPoints.flatMap((kp) => [kp.label, kp.valueText, kp.meaning]),
    ...output.cautions,
    ...output.unavailable,
  ];

  const offendingNumbers: number[] = [];
  const offendingTokens: string[] = [];

  for (const text of textsToCheck) {
    const tokens = collectNumbersFromString(text, snapshot.lastCandleTime);
    for (const token of tokens) {
      if (!isTokenGrounded(token, allowed)) {
        offendingNumbers.push(token.value);
        offendingTokens.push(token.raw);
      }
    }
  }

  return {
    ok: offendingNumbers.length === 0,
    offendingNumbers,
    offendingTokens,
  };
}

export function validateDisallowedContent(
  output: ExplainStructuredOutput,
): DisallowedContentResult {
  const allTexts: string[] = [
    output.summary,
    ...output.keyPoints.flatMap((kp) => [kp.label, kp.valueText, kp.meaning]),
    ...output.cautions,
    ...output.unavailable,
  ];

  const matchedSet = new Set<string>();
  for (const text of allTexts) {
    DISALLOWED_WORD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DISALLOWED_WORD_REGEX.exec(text)) !== null) {
      matchedSet.add(match[1].toLowerCase());
    }
  }

  const matchedWords = Array.from(matchedSet);
  return {
    ok: matchedWords.length === 0,
    matchedWords,
  };
}

export const PAPER_TRADE_DISALLOWED_WORDS: readonly string[] = [
  'buy',
  'sell',
  'order',
  'position',
  'guaranteed',
  'predict',
];

const PAPER_TRADE_DISALLOWED_REGEX = new RegExp(
  `\\b(${PAPER_TRADE_DISALLOWED_WORDS.join('|')})\\b`,
  'gi',
);

export function extractAllowedNumbersFromPaperTrade(req: PaperTradeExplainRequest): number[] {
  const values: number[] = [];
  const pushNum = (v: number | null | undefined) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
    }
  };

  pushNum(req.contracts);
  pushNum(req.openedAtSec);
  pushNum(req.closedAtSec);
  pushNum(req.entryScore);
  pushNum(req.entryVolZ);
  pushNum(req.entryTrend);
  pushNum(req.exitScore);
  pushNum(req.exitVolZ);
  pushNum(req.exitTrend);

  const stringSources: string[] = [
    req.symbol,
    req.entryPriceDisplay,
    req.exitPriceDisplay,
    req.grossPnlDisplay,
    req.feesDisplay,
    req.slippageDisplay,
    req.fundingDisplay,
    req.liquidationPenaltyDisplay,
    req.netPnlDisplay,
    req.parameterVersionId,
    ...req.entryFiredRules,
    ...req.exitFiredRules,
  ];
  for (const s of stringSources) {
    for (const tok of collectNumbersFromString(s, null)) {
      pushNum(tok.value);
    }
  }
  return values;
}

export function validatePaperTradeExplainOutput(
  output: ExplainStructuredOutput,
  req: PaperTradeExplainRequest,
): ExplainGuardResult {
  const allTexts: string[] = [
    output.summary,
    ...output.keyPoints.flatMap((kp) => [kp.label, kp.valueText, kp.meaning]),
    ...output.cautions,
    ...output.unavailable,
  ];

  const matchedSet = new Set<string>();
  for (const text of allTexts) {
    PAPER_TRADE_DISALLOWED_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAPER_TRADE_DISALLOWED_REGEX.exec(text)) !== null) {
      matchedSet.add(match[1].toLowerCase());
    }
  }
  if (matchedSet.size > 0) {
    const matchedWords = Array.from(matchedSet);
    return {
      ok: false,
      code: 'DISALLOWED_CONTENT',
      message: `Trade review blocked: output contained disallowed directive/predictive word(s): ${matchedWords.join(', ')}`,
      matchedWords,
    };
  }

  const allowed = extractAllowedNumbersFromPaperTrade(req);
  const offendingNumbers: number[] = [];
  const offendingTokens: string[] = [];

  for (const text of allTexts) {
    // Strip formatted dates from openedAtSec and closedAtSec
    let cleaned = text;
    for (const ts of [req.openedAtSec, req.closedAtSec]) {
      const iso = new Date(ts * 1000).toISOString();
      const datePart = iso.slice(0, 10);
      const dtMin = `${datePart} ${iso.slice(11, 16)}`;
      const dtSec = `${datePart} ${iso.slice(11, 19)}`;
      cleaned = cleaned.split(iso).join(' ').split(dtSec).join(' ').split(dtMin).join(' ').split(datePart).join(' ');
    }
    const tokens = collectNumbersFromString(cleaned, null);
    for (const token of tokens) {
      if (!isTokenGrounded(token, allowed)) {
        offendingNumbers.push(token.value);
        offendingTokens.push(token.raw);
      }
    }
  }

  if (offendingNumbers.length > 0) {
    return {
      ok: false,
      code: 'UNGROUNDED_OUTPUT',
      message: `Trade review blocked: ungrounded numeric value(s) detected: ${offendingTokens.join(', ')}`,
      offendingNumbers,
    };
  }

  return { ok: true };
}

export function validateExplainOutput(
  output: ExplainStructuredOutput,
  snapshot: ExplainSnapshotRequest,
): ExplainGuardResult {
  const contentCheck = validateDisallowedContent(output);
  if (!contentCheck.ok) {
    return {
      ok: false,
      code: 'DISALLOWED_CONTENT',
      message: `Explanation blocked: output contained disallowed directive/predictive word(s): ${contentCheck.matchedWords.join(', ')}`,
      matchedWords: contentCheck.matchedWords,
    };
  }

  const groundingCheck = validateNumberGrounding(output, snapshot);
  if (!groundingCheck.ok) {
    return {
      ok: false,
      code: 'UNGROUNDED_OUTPUT',
      message: `Explanation blocked: ungrounded numeric value(s) detected: ${groundingCheck.offendingTokens.join(', ')}`,
      offendingNumbers: groundingCheck.offendingNumbers,
    };
  }

  return { ok: true };
}
