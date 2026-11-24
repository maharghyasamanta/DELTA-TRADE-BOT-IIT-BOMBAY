import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type {
  ExplainClosedTradeResponse,
  HeldOutEvaluationLog,
  PaperClosedTrade,
  PaperDriftReport,
  PaperParameterVersion,
  PaperRiskLimits,
  PaperSessionState,
  PaperTradeAnalytics,
  WalkForwardReport,
  WalkForwardSplitSummary,
} from '../contracts/paper';
import {
  cancelPaperOrderApi,
  createPaperSessionApi,
  deletePaperSessionApi,
  evaluateHeldOutApi,
  explainClosedTradeApi,
  fetchPaperAnalyticsApi,
  getPaperSessionApi,
  listPaperSessionsApi,
  restorePaperSessionApi,
  runWalkForwardApi,
  submitPaperOrderApi,
  triggerKillSwitchApi,
  updatePaperSettingsApi,
} from '../api/paperApi';
import {
  deleteSavedPaperSessionFromFirestore,
  loadSavedPaperSnapshotsFromFirestore,
  recordSubmittedOrderToFirestore,
  syncPaperStateToFirestore,
} from '../services/paperPersistence';

export function usePaperTrading(params: {
  user: User | null;
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
  active: boolean;
}) {
  const { user, getIdToken, active } = params;

  const [sessions, setSessions] = useState<PaperSessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<PaperTradeAnalytics | null>(null);
  const [drift, setDrift] = useState<PaperDriftReport | null>(null);
  const [walkForwardReport, setWalkForwardReport] = useState<WalkForwardReport | null>(null);
  const [heldOutResult, setHeldOutResult] = useState<{
    summary: WalkForwardSplitSummary;
    log: HeldOutEvaluationLog;
  } | null>(null);
  const [tradeReviews, setTradeReviews] = useState<Record<string, ExplainClosedTradeResponse>>({});
  const [reviewingTradeId, setReviewingTradeId] = useState<string | null>(null);

  const hasRestoredForUidRef = useRef<string | null>(null);

  const activeSession =
    sessions.find((s) => s.account.sessionId === activeSessionId) ?? sessions[0] ?? null;

  const requireToken = useCallback(async () => {
    const token = await getIdToken();
    if (!token) throw new Error('Sign in with Google to use Paper Trading.');
    return token;
  }, [getIdToken]);

  const upsertSession = useCallback((next: PaperSessionState) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.account.sessionId === next.account.sessionId);
      if (idx === -1) return [next, ...prev];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
    setActiveSessionId(next.account.sessionId);
  }, []);

  // Reconnect restore handshake from Firestore -> server replay (up to 7d) -> updated state
  const hydrateAndRestore = useCallback(async () => {
    if (!user) {
      setSessions([]);
      setActiveSessionId(null);
      hasRestoredForUidRef.current = null;
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const token = await requireToken();
      let serverSessions = await listPaperSessionsApi(token);

      if (hasRestoredForUidRef.current !== user.uid) {
        hasRestoredForUidRef.current = user.uid;
        const savedSnapshots = await loadSavedPaperSnapshotsFromFirestore(user.uid);
        let totalReplayedBars = 0;
        let totalReplayedTrades = 0;

        for (const snap of savedSnapshots.slice(0, 5)) {
          const alreadyOnServer = serverSessions.some(
            (s) => s.account.sessionId === snap.account.sessionId,
          );
          if (!alreadyOnServer) {
            try {
              const res = await restorePaperSessionApi(token, snap.account.sessionId, snap);
              totalReplayedBars += res.replayedBars;
              totalReplayedTrades += res.replayedTradesCount;
              await syncPaperStateToFirestore(user.uid, res.state, {
                forceEventWrite: res.replayedTradesCount > 0 || res.state.account.stale,
              });
            } catch {
              // Ignore invalid/obsolete snapshot cleanly
            }
          }
        }

        serverSessions = await listPaperSessionsApi(token);
        if (totalReplayedBars > 0) {
          setRestoreNotice(
            `Reconnected & replayed ${totalReplayedBars} missed closed bars (${totalReplayedTrades} simulated trades settled).`,
          );
        }
      }

      setSessions(serverSessions);
      if (serverSessions.length > 0) {
        setActiveSessionId((prev) =>
          prev && serverSessions.some((s) => s.account.sessionId === prev)
            ? prev
            : serverSessions[0].account.sessionId,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load paper trading sessions');
    } finally {
      setLoading(false);
    }
  }, [requireToken, user]);

  useEffect(() => {
    if (active && user) {
      void hydrateAndRestore();
    } else if (!user) {
      setSessions([]);
      setActiveSessionId(null);
      hasRestoredForUidRef.current = null;
    }
  }, [active, hydrateAndRestore, user]);

  // Live mark-price polling every 12s while Paper tab is active (writes Firestore at most every 60s!)
  useEffect(() => {
    if (!active || !user || !activeSession) return;
    const sessionId = activeSession.account.sessionId;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const token = await requireToken();
          const refreshed = await getPaperSessionApi(token, sessionId);
          upsertSession(refreshed);
          await syncPaperStateToFirestore(user.uid, refreshed, { forceEventWrite: false });
        } catch {
          // Ignore transient polling error
        }
      })();
    }, 12_000);
    return () => clearInterval(timer);
  }, [active, activeSession, requireToken, upsertSession, user]);

  const refreshAnalytics = useCallback(
    async (sessionId?: string) => {
      const targetId = sessionId ?? activeSession?.account.sessionId;
      if (!targetId || !user) return;
      try {
        const token = await requireToken();
        const res = await fetchPaperAnalyticsApi(token, targetId);
        setAnalytics(res.analytics);
        setDrift(res.drift);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to compute paper analytics');
      }
    },
    [activeSession?.account.sessionId, requireToken, user],
  );

  useEffect(() => {
    if (active && user && activeSession) {
      void refreshAnalytics(activeSession.account.sessionId);
    }
  }, [active, activeSession?.account.sessionId, activeSession?.closedTrades.length, refreshAnalytics, user]);

  const createSession = useCallback(
    async (input: {
      symbol: string;
      resolution: '15m' | '1h';
      startingBalanceUsdt: string;
      resetTimeZone: string;
      riskLimits?: Partial<PaperRiskLimits>;
    }) => {
      if (!user) return;
      setBusyAction('Creating session');
      setError(null);
      try {
        const token = await requireToken();
        const created = await createPaperSessionApi(token, input);
        upsertSession(created);
        await syncPaperStateToFirestore(user.uid, created, { forceEventWrite: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create paper session');
      } finally {
        setBusyAction(null);
      }
    },
    [requireToken, upsertSession, user],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!user) return;
      setBusyAction('Deleting session');
      setError(null);
      try {
        const token = await requireToken();
        await deletePaperSessionApi(token, sessionId);
        await deleteSavedPaperSessionFromFirestore(user.uid, sessionId);
        setSessions((prev) => prev.filter((s) => s.account.sessionId !== sessionId));
        setActiveSessionId((prev) => (prev === sessionId ? null : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete session');
      } finally {
        setBusyAction(null);
      }
    },
    [requireToken, user],
  );

  const submitOrder = useCallback(
    async (body: {
      clientOrderId: string;
      side: 'BUY' | 'SELL';
      type: 'MARKET' | 'LIMIT';
      contracts: number;
      limitPriceTicks?: number | null;
      stopLossTicks?: number | null;
      takeProfitTicks?: number | null;
      reduceOnly?: boolean;
    }) => {
      if (!user || !activeSession) return null;
      setBusyAction('Submitting simulated order');
      setError(null);
      try {
        const token = await requireToken();
        const res = await submitPaperOrderApi(token, activeSession.account.sessionId, body);
        upsertSession(res.state);
        await recordSubmittedOrderToFirestore(user.uid, res.order);
        await syncPaperStateToFirestore(user.uid, res.state, { forceEventWrite: true });
        if (res.order.status === 'REJECTED' && res.order.rejectionReason) {
          setError(res.order.rejectionReason);
        }
        return res;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to submit paper order');
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [activeSession, requireToken, upsertSession, user],
  );

  const cancelOrder = useCallback(
    async (clientOrderId: string) => {
      if (!user || !activeSession) return;
      setBusyAction('Cancelling order');
      setError(null);
      try {
        const token = await requireToken();
        const res = await cancelPaperOrderApi(
          token,
          activeSession.account.sessionId,
          clientOrderId,
        );
        upsertSession(res.state);
        await syncPaperStateToFirestore(user.uid, res.state, { forceEventWrite: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to cancel order');
      } finally {
        setBusyAction(null);
      }
    },
    [activeSession, requireToken, upsertSession, user],
  );

  const triggerKillSwitch = useCallback(async () => {
    if (!user || !activeSession) return;
    setBusyAction('Triggering Kill Switch');
    setError(null);
    try {
      const token = await requireToken();
      const res = await triggerKillSwitchApi(token, activeSession.account.sessionId);
      upsertSession(res.state);
      await syncPaperStateToFirestore(user.uid, res.state, { forceEventWrite: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kill switch failed');
    } finally {
      setBusyAction(null);
    }
  }, [activeSession, requireToken, upsertSession, user]);

  const updateSettings = useCallback(
    async (body: {
      strategyEnabled?: boolean;
      resetTimeZone?: string;
      riskLimits?: Partial<PaperRiskLimits>;
      activeVersion?: PaperParameterVersion;
      resetDailyLossHalt?: boolean;
      resetDrawdownHalt?: boolean;
      resetKillSwitch?: boolean;
      resetStaleSession?: boolean;
    }) => {
      if (!user || !activeSession) return;
      setBusyAction('Updating session settings');
      setError(null);
      try {
        const token = await requireToken();
        const updated = await updatePaperSettingsApi(
          token,
          activeSession.account.sessionId,
          body,
        );
        upsertSession(updated);
        await syncPaperStateToFirestore(user.uid, updated, { forceEventWrite: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update settings');
      } finally {
        setBusyAction(null);
      }
    },
    [activeSession, requireToken, upsertSession, user],
  );

  const runWalkForward = useCallback(
    async (fixedHalfSpreadTicks: number, lookbackBars: number) => {
      if (!user || !activeSession) return;
      setBusyAction('Running 3-split worker search');
      setError(null);
      try {
        const token = await requireToken();
        const report = await runWalkForwardApi(token, activeSession.account.sessionId, {
          fixedHalfSpreadTicks,
          lookbackBars,
        });
        setWalkForwardReport(report);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Walk-forward search failed');
      } finally {
        setBusyAction(null);
      }
    },
    [activeSession, requireToken, user],
  );

  const evaluateHeldOut = useCallback(
    async (version: PaperParameterVersion, lookbackBars: number) => {
      if (!user || !activeSession) return;
      setBusyAction('Evaluating held-out split');
      setError(null);
      try {
        const token = await requireToken();
        const res = await evaluateHeldOutApi(token, activeSession.account.sessionId, {
          version,
          lookbackBars,
        });
        setHeldOutResult({ summary: res.summary, log: res.log });
        const nextState: PaperSessionState = {
          ...activeSession,
          account: res.account,
          heldOutLogs: [res.log, ...activeSession.heldOutLogs],
        };
        upsertSession(nextState);
        await syncPaperStateToFirestore(user.uid, nextState, { forceEventWrite: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Held-out evaluation failed');
      } finally {
        setBusyAction(null);
      }
    },
    [activeSession, requireToken, upsertSession, user],
  );

  const explainTrade = useCallback(
    async (trade: PaperClosedTrade) => {
      if (!user || !activeSession) return;
      setReviewingTradeId(trade.tradeId);
      setError(null);
      try {
        const token = await requireToken();
        const res = await explainClosedTradeApi(token, {
          trade,
          contract: {
            symbol: activeSession.contract.symbol,
            tickSizeStr: activeSession.contract.tickSizeStr,
            contractValueStr: activeSession.contract.contractValueStr,
          },
        });
        setTradeReviews((prev) => ({ ...prev, [trade.tradeId]: res }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to explain closed trade');
      } finally {
        setReviewingTradeId(null);
      }
    },
    [activeSession, requireToken, user],
  );

  return {
    sessions,
    activeSession,
    setActiveSessionId,
    loading,
    busyAction,
    error,
    clearError: () => setError(null),
    restoreNotice,
    clearRestoreNotice: () => setRestoreNotice(null),
    analytics,
    drift,
    walkForwardReport,
    heldOutResult,
    tradeReviews,
    reviewingTradeId,
    refreshSessions: hydrateAndRestore,
    refreshAnalytics,
    createSession,
    deleteSession,
    submitOrder,
    cancelOrder,
    triggerKillSwitch,
    updateSettings,
    runWalkForward,
    evaluateHeldOut,
    explainTrade,
  };
}
