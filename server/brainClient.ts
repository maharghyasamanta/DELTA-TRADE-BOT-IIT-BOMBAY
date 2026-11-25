import type {
  PaperStrategyContext,
  StrategyDecision,
} from '../src/engine/paperStrategy.ts';

const BRAIN_API_KEY = process.env.BRAIN_API_KEY?.trim() ?? '';
const BRAIN_API_BASE = process.env.BRAIN_API_BASE?.trim() ?? 'https://openrouter.ai/api/v1';
const BRAIN_MODEL = process.env.BRAIN_MODEL?.trim() ?? 'deepseek/deepseek-r1-distill-qwen-32b';

export const BRAIN_CONFIGURED = Boolean(BRAIN_API_KEY);

export async function queryBrainDecision(ctx: PaperStrategyContext): Promise<StrategyDecision> {
  if (!BRAIN_CONFIGURED) {
    throw new Error('Brain API key not configured');
  }

  // Create a clean representation of the context for the LLM
  const promptContext = {
    symbol: ctx.signal.candleCount > 0 ? ctx.closedCandles[ctx.closedCandles.length - 1] : 'Unknown',
    regime: {
      score: ctx.signal.score,
      trend: ctx.signal.trend,
      volZ: ctx.signal.volZ,
      changePoints: ctx.signal.changePointsInWindow,
      lastChangePointAge: ctx.signal.lastChangePointAgeBars,
    },
    guardrail: {
      decision: ctx.guardrail.decision,
      firedRules: ctx.guardrail.firedRules,
    },
    position: ctx.currentPosition ? {
      side: ctx.currentPosition.side,
      contracts: ctx.currentPosition.contracts,
      unrealizedPnl: ctx.currentPosition.unrealizedPnlUnits,
    } : null,
    params: ctx.params,
  };

  try {
    const response = await fetch(`${BRAIN_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRAIN_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/maharghyasamanta/DELTA-TRADE-BOT-IIT-BOMBAY',
        'X-Title': 'Delta Trade Bot IIT Bombay',
      },
      body: JSON.stringify({
        model: BRAIN_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are an expert quantitative trading engine.
Your task is to analyze market regime data and provide a trade decision.
You must return ONLY a JSON object in this exact format:
{
  "action": "LONG" | "SHORT" | "FLAT" | "HOLD",
  "desiredSizeFractionBps": number (0-10000, where 10000 is 100%),
  "stopLossOffsetTicks": number | null,
  "takeProfitOffsetTicks": number | null,
  "reason": "string explaining logic"
}
Decision Logic:
- LONG/SHORT: Enter new or add to position.
- FLAT: Close all positions.
- HOLD: Do nothing.
- Ticks: offsets from current price. 1 tick = tickSize.
- Target Accuracy: > 60%. Be conservative.`,
          },
          {
            role: 'user',
            content: `Current Market State: ${JSON.stringify(promptContext, null, 2)}`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1, // Keep it deterministic
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    // Some models might wrap JSON in markdown blocks
    const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
    const decision = JSON.parse(jsonStr) as StrategyDecision;

    // Validation
    if (!['LONG', 'SHORT', 'FLAT', 'HOLD'].includes(decision.action)) {
      decision.action = 'HOLD';
    }

    return decision;
  } catch (err) {
    console.error('[BrainClient] Decision failed:', err);
    return {
      action: 'HOLD',
      desiredSizeFractionBps: 0,
      stopLossOffsetTicks: null,
      takeProfitOffsetTicks: null,
      reason: `Brain Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
