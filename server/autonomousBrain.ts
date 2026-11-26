import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DB_PATH = path.resolve(__filename, '../../models/trader_memory.db');

export interface AuxiliarySignals {
  rl_q_value: number;
  rl_action: number;
  ml_probability: number;
  daily_net_pct: number;
  target_locked: boolean;
}

let db: DatabaseSync | null = null;

function initDb(): DatabaseSync | null {
  if (db) return db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    return db;
  } catch {
    return null;
  }
}

export function getAuxiliarySignals(): AuxiliarySignals {
  const d = initDb();
  if (!d) {
    return {
      rl_q_value: 0,
      rl_action: 0,
      ml_probability: 0.5,
      daily_net_pct: 0,
      target_locked: false,
    };
  }

  try {
    // Get latest RL experience (Q-value and action)
    const latestExp: any = d.prepare(
      `SELECT q_value, action FROM experiences ORDER BY id DESC LIMIT 1`
    ).get();

    // Get latest ML model weights (simulated probability)
    const latestML: any = d.prepare(
      `SELECT weights_json FROM model_weights WHERE model_type = 'ml' ORDER BY version DESC LIMIT 1`
    ).get();

    // Get today's daily performance
    const today = new Date().toISOString().split('T')[0];
    const daily: any = d.prepare(
      `SELECT net_profit_pct, target_achieved FROM daily_performance WHERE date = ?`
    ).get(today);

    const rl_q_value = latestExp?.q_value ?? 0;
    const rl_action = latestExp?.action ?? 0;

    // Parse ML probability from weights (simplified)
    let ml_probability = 0.5;
    if (latestML?.weights_json) {
      try {
        const w = JSON.parse(latestML.weights_json);
        if (Array.isArray(w.weights) && w.weights.length > 0) {
          // Simple heuristic: positive average weight = bullish
          const avg = w.weights.reduce((a: number, b: number) => a + b, 0) / w.weights.length;
          ml_probability = Math.max(0, Math.min(1, 0.5 + avg * 5));
        }
      } catch {
        // ignore parse errors
      }
    }

    const daily_net_pct = daily?.net_profit_pct ?? 0;
    const target_locked = daily?.target_achieved === 1 || daily_net_pct >= 10.5;

    return {
      rl_q_value,
      rl_action,
      ml_probability,
      daily_net_pct,
      target_locked,
    };
  } catch (err) {
    console.error('[AutonomousBrain] Error fetching signals:', err);
    return {
      rl_q_value: 0,
      rl_action: 0,
      ml_probability: 0.5,
      daily_net_pct: 0,
      target_locked: false,
    };
  }
}

export function checkDailyTargetLock(): { locked: boolean; reason: string } {
  const signals = getAuxiliarySignals();
  if (signals.target_locked) {
    return { locked: true, reason: `Daily 10% target achieved (${signals.daily_net_pct.toFixed(2)}% net). Locking positions.` };
  }
  return { locked: false, reason: '' };
}