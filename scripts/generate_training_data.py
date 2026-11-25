#!/usr/bin/env python3
"""
Delta Trade Bot - RL Training Pipeline Export
Extracts paper trading session history, market candles, and trade outcomes
to generate training data for the Reinforcement Learning agent.
"""

import json
import math
import os
import sys
import glob

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "models")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def generate_synthetic_candles(num_bars=500, seed=42):
    """
    Generate synthetic OHLCV candle data matching CandlePoint schema.
    Replace with real fetch from Delta exchange or Alpaca history.
    """
    import random
    random.seed(seed)
    candles = []
    price = 100.0
    now = 1700000000
    step = 3600  # 1 hour bars
    for t in range(num_bars):
        price *= (1.0 + random.gauss(0.0002, 0.015))
        high = price * (1.0 + abs(random.gauss(0, 0.003)))
        low = price * (1.0 - abs(random.gauss(0, 0.003)))
        close = random.uniform(low, high)
        candles.append({
            "time": now + t * step,
            "open": price,
            "high": high,
            "low": low,
            "close": close,
            "volume": random.uniform(1000, 50000)
        })
        price = close
    return candles

def extract_features_and_labels(candles, window=20):
    """
    Compute feature vectors and labels for supervised / RL training.
    Features: return, MA20 ratio, volatility, volume ratio, position state
    Labels: 0=Hold, 1=Buy, 2=Sell (next bar direction)
    """
    dataset = []
    closes = [c['close'] for c in candles]
    volumes = [c.get('volume', 1.0) for c in candles]

    for i in range(window, len(closes) - 1):
        current_close = closes[i]
        prev_close = closes[i - 1]
        ret = (current_close - prev_close) / prev_close

        window_closes = closes[i - window:i]
        sma20 = sum(window_closes) / len(window_closes)
        ma_ratio = (current_close - sma20) / sma20

        rets = [(window_closes[j] - window_closes[j - 1]) / window_closes[j - 1] for j in range(1, len(window_closes))]
        vol = math.sqrt(sum(r**2 for r in rets) / len(rets)) if rets else 0.001

        avg_vol = sum(volumes[i - window:i]) / window if sum(volumes[i - window:i]) > 0 else 1.0
        vol_ratio = volumes[i] / avg_vol if avg_vol > 0 else 1.0

        # Label: next bar return sign
        next_close = closes[i + 1]
        future_return = (next_close - current_close) / current_close
        if future_return > 0.005:
            label = 1  # Buy
        elif future_return < -0.005:
            label = 2  # Sell
        else:
            label = 0  # Hold

        dataset.append({
            "features": [ret, ma_ratio, vol, vol_ratio],
            "label": label,
            "close": current_close,
            "time": candles[i]["time"]
        })

    return dataset

def main():
    print("=" * 60)
    print(" Delta Trade Bot - RL Training Data Export Pipeline ")
    print("=" * 60)

    # Check for existing exported paper trading data files
    data_files = glob.glob(os.path.join(os.path.dirname(__file__), "..", "models", "*.json"))
    if data_files:
        print(f"Found {len(data_files)} existing model/data files:")
        for f in data_files:
            print(f"  - {f}")

    candles = generate_synthetic_candles(num_bars=1000)
    print(f"Generated {len(candles)} synthetic candles (replace with real paper trading data).")

    dataset = extract_features_and_labels(candles)
    print(f"Extracted {len(dataset)} feature vectors.")

    output_path = os.path.abspath(os.path.join(OUTPUT_DIR, "rl_training_data.json"))
    with open(output_path, "w") as f:
        json.dump(dataset, f, indent=2)
    print(f"Training data exported to: {output_path}")

    # Print label distribution
    labels = [d['label'] for d in dataset]
    print(f"Label distribution: Hold={labels.count(0)}, Buy={labels.count(1)}, Sell={labels.count(2)}")

if __name__ == '__main__':
    main()
