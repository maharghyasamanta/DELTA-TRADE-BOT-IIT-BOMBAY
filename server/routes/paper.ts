import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  FirebaseAuthError,
  verifyFirebaseIdToken,
  type VerifiedFirebaseUser,
} from '../firebaseTokenVerifier.ts';
import {
  explainClosedTrade,
  GeminiApiError,
  GeminiNotConfiguredError,
} from '../geminiClient.ts';
import { DeltaApiError } from '../deltaClient.ts';
import { PaperRunnerError } from '../paper/paperRunner.ts';
import {
  buildPaperTradeExplainPayload,
  cancelUserPaperOrder,
  createUserPaperSession,
  deleteUserPaperSession,
  evaluateUserHeldOutSplit,
  getAndRefreshUserPaperSession,
  getUserSessionAnalyticsAndDrift,
  listUserPaperSessions,
  PaperStoreError,
  restoreUserPaperSession,
  runUserWalkForwardSearch,
  submitUserPaperOrder,
  triggerUserKillSwitch,
  updateUserSessionSettings,
} from '../paper/paperStore.ts';
import {
  isValidId,
  validateCreateSessionInput,
  validateExplainClosedTradeInput,
  validateHeldOutEvalInput,
  validateRestoreSnapshotInput,
  validateSessionSettingsInput,
  validateSubmitOrderInput,
  validateWalkForwardInput,
} from '../paper/validators.ts';

interface AuthenticatedRequest extends Request {
  authUser?: VerifiedFirebaseUser;
}

function sendError(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({
    error,
    code,
    status,
    source: 'Paper Broker Engine',
    timestamp: new Date().toISOString(),
  });
}

async function requireFirebaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    sendError(
      res,
      401,
      'AUTH_REQUIRED',
      'Authentication required: provide a valid Firebase ID token in Authorization: Bearer header.',
    );
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    sendError(res, 401, 'AUTH_REQUIRED', 'Missing Firebase ID token.');
    return;
  }

  try {
    const user = await verifyFirebaseIdToken(token);
    req.authUser = user;
    next();
  } catch (err) {
    if (err instanceof FirebaseAuthError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid Firebase authentication token.');
  }
}

function handleRouteError(res: Response, err: unknown): void {
  if (err instanceof PaperStoreError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  if (err instanceof PaperRunnerError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  if (err instanceof DeltaApiError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  if (err instanceof GeminiNotConfiguredError) {
    sendError(res, 503, err.code, err.message);
    return;
  }
  if (err instanceof GeminiApiError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  sendError(
    res,
    500,
    'PAPER_INTERNAL_ERROR',
    err instanceof Error ? err.message : 'Unexpected paper trading error',
  );
}

export function createPaperRouter(): Router {
  const router = Router();
  router.use('/paper', requireFirebaseAuth);

  router.get('/paper/sessions', (req: AuthenticatedRequest, res: Response) => {
    const uid = req.authUser!.uid;
    res.json({
      data: { sessions: listUserPaperSessions(uid) },
      source: 'Paper Broker Engine (simulated)',
      fetchedAt: new Date().toISOString(),
    });
  });

  router.post('/paper/sessions', async (req: AuthenticatedRequest, res: Response) => {
    const validation = validateCreateSessionInput(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_REQUEST', validation.message);
      return;
    }
    try {
      const session = await createUserPaperSession(req.authUser!.uid, validation.value);
      res.status(201).json({
        data: session,
        source: 'Paper Broker Engine (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/paper/sessions/:sessionId/restore', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    const validation = validateRestoreSnapshotInput(req.body, sessionId, req.authUser!.uid);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_SNAPSHOT', validation.message);
      return;
    }
    try {
      const result = await restoreUserPaperSession(req.authUser!.uid, sessionId, {
        ...validation.value,
        equityCurve: [],
      });
      res.json({
        data: result,
        source: 'Paper Broker Engine (simulated replay)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/paper/sessions/:sessionId', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    try {
      const state = await getAndRefreshUserPaperSession(req.authUser!.uid, sessionId);
      res.json({
        data: state,
        source: 'Paper Broker Engine (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.delete('/paper/sessions/:sessionId', (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    const removed = deleteUserPaperSession(req.authUser!.uid, sessionId);
    res.json({
      data: { deleted: removed, sessionId },
      source: 'Paper Broker Engine (simulated)',
      fetchedAt: new Date().toISOString(),
    });
  });

  router.patch('/paper/sessions/:sessionId/settings', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    const validation = validateSessionSettingsInput(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_SETTINGS', validation.message);
      return;
    }
    try {
      const state = await updateUserSessionSettings(
        req.authUser!.uid,
        sessionId,
        validation.value,
      );
      res.json({
        data: state,
        source: 'Paper Broker Engine (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/paper/sessions/:sessionId/orders', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    const validation = validateSubmitOrderInput(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_ORDER', validation.message);
      return;
    }
    try {
      const result = await submitUserPaperOrder(req.authUser!.uid, sessionId, validation.value);
      res.status(result.order.status === 'REJECTED' ? 422 : 200).json({
        data: result,
        source: 'Paper Broker Engine (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.delete(
    '/paper/sessions/:sessionId/orders/:clientOrderId',
    (req: AuthenticatedRequest, res: Response) => {
      const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
      const clientOrderId =
        typeof req.params.clientOrderId === 'string' ? req.params.clientOrderId : '';
      if (!isValidId(sessionId) || !isValidId(clientOrderId)) {
        sendError(res, 400, 'INVALID_ID', 'Invalid sessionId or clientOrderId');
        return;
      }
      try {
        const result = cancelUserPaperOrder(req.authUser!.uid, sessionId, clientOrderId);
        res.json({
          data: result,
          source: 'Paper Broker Engine (simulated)',
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post('/paper/sessions/:sessionId/kill-switch', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    try {
      const result = await triggerUserKillSwitch(req.authUser!.uid, sessionId);
      res.json({
        data: result,
        source: 'Paper Broker Engine (simulated kill switch)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/paper/sessions/:sessionId/analytics', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    try {
      const result = await getUserSessionAnalyticsAndDrift(req.authUser!.uid, sessionId);
      res.json({
        data: result,
        source: 'Paper Broker Analytics (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/paper/sessions/:sessionId/walk-forward', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    const validation = validateWalkForwardInput(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_REQUEST', validation.message);
      return;
    }
    try {
      const report = await runUserWalkForwardSearch(
        req.authUser!.uid,
        sessionId,
        validation.value,
      );
      res.json({
        data: report,
        source: 'Paper Walk-Forward Worker (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/paper/sessions/:sessionId/held-out', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!isValidId(sessionId)) {
      sendError(res, 400, 'INVALID_SESSION_ID', 'Invalid sessionId');
      return;
    }
    const validation = validateHeldOutEvalInput(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_REQUEST', validation.message);
      return;
    }
    try {
      const result = await evaluateUserHeldOutSplit(
        req.authUser!.uid,
        sessionId,
        validation.value,
      );
      res.json({
        data: result,
        source: 'Paper Held-Out Audit (simulated)',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/paper/explain-trade', async (req: AuthenticatedRequest, res: Response) => {
    const validation = validateExplainClosedTradeInput(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_TRADE_PAYLOAD', validation.message);
      return;
    }
    try {
      const explainReq = buildPaperTradeExplainPayload(
        validation.value.trade,
        validation.value.contract,
      );
      const result = await explainClosedTrade(explainReq);
      res.json({
        data: result,
        source: 'Gemini (closed-trade review)',
        fetchedAt: result.generatedAt,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  return router;
}
