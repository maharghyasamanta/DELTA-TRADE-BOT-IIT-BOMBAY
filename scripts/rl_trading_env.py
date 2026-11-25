#!/usr/bin/env python3
"""
Delta Trade Bot - Reinforcement Learning (RL) Trading Environment & Trainer
Simulates paper money trading via an MDP (Markov Decision Process):
- State: Candle indicators, volatility Z-scores, current position, account PnL
- Actions: 0 = Flat/Hold, 1 = Buy/Long, 2 = Sell/Short
- Reward: Change in portfolio equity / risk-adjusted return (Sharpe-like incremental reward)
"""

import random
import math
import json

class TradingEnvironment:
    def __init__(self, candles, initial_balance=10000.0):
        self.candles = candles
        self.initial_balance = initial_balance
        self.reset()

    def reset(self):
        self.current_step = 20
        self.balance = self.initial_balance
        self.position = 0  # 0: None, 1: Long, -1: Short
        self.entry_price = 0.0
        self.equity = self.initial_balance
        self.peak_equity = self.initial_balance
        return self._get_state()

    def _get_state(self):
        if self.current_step >= len(self.candles):
            self.current_step = len(self.candles) - 1

        c = self.candles[self.current_step]
        prev_c = self.candles[self.current_step - 1]

        ret = (c['close'] - prev_c['close']) / prev_c['close']
        vol = abs(c['high'] - c['low']) / c['open']
        pos_state = float(self.position)

        # Discretize state for tabular Q-learning / feature representation
        return (
            1 if ret > 0 else 0,
            1 if vol > 0.01 else 0,
            int(pos_state + 1)  # 0: Short, 1: None, 2: Long
        )

    def step(self, action):
        """
        Actions:
        0: HOLD / FLAT
        1: LONG (Buy)
        2: SHORT (Sell)
        """
        c = self.candles[self.current_step]
        price = c['close']
        reward = 0.0

        # Position transitions & PnL calculation
        if action == 1:  # Long
            if self.position == -1:  # Close short
                pnl = (self.entry_price - price) * 100
                self.balance += pnl
                reward += pnl / 100.0
            if self.position <= 0:
                self.position = 1
                self.entry_price = price
        elif action == 2:  # Short
            if self.position == 1:  # Close long
                pnl = (price - self.entry_price) * 100
                self.balance += pnl
                reward += pnl / 100.0
            if self.position >= 0:
                self.position = -1
                self.entry_price = price
        elif action == 0:  # Hold / Flat
            if self.position == 1:
                reward += (price - self.entry_price) / self.entry_price * 10.0
            elif self.position == -1:
                reward += (self.entry_price - price) / self.entry_price * 10.0

        # Update equity
        unrealized = 0.0
        if self.position == 1:
            unrealized = (price - self.entry_price) * 100
        elif self.position == -1:
            unrealized = (self.entry_price - price) * 100

        self.equity = self.balance + unrealized
        if self.equity > self.peak_equity:
            self.peak_equity = self.equity

        # Drawdown penalty
        dd = (self.peak_equity - self.equity) / self.peak_equity
        reward -= dd * 5.0

        self.current_step += 1
        done = self.current_step >= len(self.candles) - 1 or self.equity <= 1000.0
        next_state = self._get_state() if not done else (0, 0, 1)

        return next_state, reward, done, {'equity': self.equity}

class QLearningAgent:
    def __init__(self, actions=3, alpha=0.1, gamma=0.99, epsilon=1.0):
        self.actions = actions
        self.alpha = alpha
        self.gamma = gamma
        self.epsilon = epsilon
        self.q_table = {}

    def get_q(self, state, action):
        return self.q_table.get((state, action), 0.0)

    def choose_action(self, state):
        if random.random() < self.epsilon:
            return random.randint(0, self.actions - 1)
        q_values = [self.get_q(state, a) for a in range(self.actions)]
        max_q = max(q_values)
        return q_values.index(max_q)

    def update(self, state, action, reward, next_state):
        current_q = self.get_q(state, action)
        max_next_q = max([self.get_q(next_state, a) for a in range(self.actions)])
        new_q = current_q + self.alpha * (reward + self.gamma * max_next_q - current_q)
        self.q_table[(state, action)] = new_q

def train_rl_agent():
    print("=" * 60)
    print(" Delta Trade Bot - Reinforcement Learning Training Agent ")
    print("=" * 60)

    # Generate synthetic training candles
    random.seed(42)
    candles = []
    price = 100.0
    for t in range(500):
        price *= (1.0 + random.gauss(0.0002, 0.015))
        candles.append({
            'open': price * 0.999,
            'high': price * 1.01,
            'low': price * 0.99,
            'close': price,
            'volume': random.uniform(1000, 10000)
        })

    env = TradingEnvironment(candles)
    agent = QLearningAgent()

    episodes = 50
    for ep in range(episodes):
        state = env.reset()
        total_reward = 0.0
        done = False
        while not done:
            action = agent.choose_action(state)
            next_state, reward, done, info = env.step(action)
            agent.update(state, action, reward, next_state)
            state = next_state
            total_reward += reward

        agent.epsilon = max(0.05, agent.epsilon * 0.95)
        if (ep + 1) % 10 == 0:
            print(f"Episode {ep + 1}/{episodes} | Final Equity: ${info['equity']:.2f} | Total Reward: {total_reward:.2f}")

    print("RL Agent training completed successfully using simulated paper money environment.")

if __name__ == '__main__':
    train_rl_agent()
