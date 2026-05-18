const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('auto-run controller preserves kiro flow across fresh reset and starts from the kiro first node', async () => {
  const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAutoRunController;`)(globalScope);

  const executedNodeIds = [];
  const kiroNodeIds = [
    'kiro-start-device-login',
    'kiro-submit-email',
    'kiro-submit-name',
    'kiro-submit-verification-code',
    'kiro-fill-password',
    'kiro-confirm-access',
    'kiro-upload-credential',
  ];
  const openAiNodeIds = ['open-chatgpt', 'submit-signup-email', 'fill-password'];
  let helperCalls = 0;
  let sessionSeed = 700;
  let currentState = {
    activeFlowId: 'kiro',
    flowId: 'kiro',
    panelMode: 'cpa',
    kiroSourceId: 'kiro-rs',
    kiroRsUrl: 'https://kiro.example/admin',
    kiroRsKey: 'demo-key',
    kiroRsApiRegion: 'ap-east-1',
    customFutureFlowField: 'future-ready',
    plusModeEnabled: false,
    plusPaymentMethod: 'paypal',
    phoneVerificationEnabled: false,
    phoneSignupReloginAfterBindEmailEnabled: false,
    autoRunSkipFailures: false,
    autoRunFallbackThreadIntervalMinutes: 0,
    autoRunDelayEnabled: false,
    autoRunDelayMinutes: 30,
    autoStepDelaySeconds: null,
    signupMethod: 'email',
    stepExecutionRangeByFlow: {
      openai: { enabled: false, fromStep: 1, toStep: 11 },
      kiro: { enabled: false, fromStep: 1, toStep: 7 },
    },
    nodeStatuses: {
      'open-chatgpt': 'stopped',
      'kiro-start-device-login': 'pending',
      'kiro-submit-email': 'pending',
      'kiro-submit-name': 'pending',
      'kiro-submit-verification-code': 'pending',
      'kiro-fill-password': 'pending',
      'kiro-confirm-access': 'pending',
      'kiro-upload-credential': 'pending',
    },
    tabRegistry: {
      stale: { tabId: 99 },
    },
    sourceLastUrls: {
      stale: 'https://chatgpt.com/',
    },
  };

  const runtime = {
    state: {
      autoRunActive: false,
      autoRunCurrentRun: 0,
      autoRunTotalRuns: 1,
      autoRunAttemptRun: 0,
      autoRunSessionId: 0,
    },
    get() {
      return { ...this.state };
    },
    set(updates = {}) {
      this.state = {
        ...this.state,
        ...updates,
      };
    },
  };

  const controller = api.createAutoRunController({
    addLog: async () => {},
    appendAccountRunRecord: async () => null,
    AUTO_RUN_MAX_RETRIES_PER_ROUND: 3,
    AUTO_RUN_RETRY_DELAY_MS: 3000,
    AUTO_RUN_TIMER_KIND_BEFORE_RETRY: 'before_retry',
    AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS: 'between_rounds',
    broadcastAutoRunStatus: async (phase, payload = {}, extraState = {}) => {
      currentState = {
        ...currentState,
        ...extraState,
        autoRunning: ['scheduled', 'running', 'waiting_step', 'waiting_email', 'retrying', 'waiting_interval'].includes(phase),
        autoRunPhase: phase,
        autoRunCurrentRun: payload.currentRun ?? currentState.autoRunCurrentRun ?? 0,
        autoRunTotalRuns: payload.totalRuns ?? currentState.autoRunTotalRuns ?? 1,
        autoRunAttemptRun: payload.attemptRun ?? currentState.autoRunAttemptRun ?? 0,
      };
    },
    broadcastStopToContentScripts: async () => {},
    cancelPendingCommands: () => {},
    clearStopRequest: () => {},
    createAutoRunSessionId: () => {
      sessionSeed += 1;
      return sessionSeed;
    },
    buildFreshAutoRunKeepState: (prevState = {}, context = {}) => {
      helperCalls += 1;
      assert.equal(context.targetRun, 1);
      assert.equal(context.attemptRun, 1);
      return {
        activeFlowId: prevState.activeFlowId,
        flowId: prevState.activeFlowId,
        panelMode: prevState.panelMode,
        kiroSourceId: prevState.kiroSourceId,
        kiroRsUrl: prevState.kiroRsUrl,
        kiroRsKey: prevState.kiroRsKey,
        kiroRsApiRegion: prevState.kiroRsApiRegion,
        customFutureFlowField: prevState.customFutureFlowField,
      };
    },
    ensureHotmailMailboxReadyForAutoRunRound: async () => {},
    getAutoRunStatusPayload: (phase, payload = {}) => ({
      autoRunning: ['scheduled', 'running', 'waiting_step', 'waiting_email', 'retrying', 'waiting_interval'].includes(phase),
      autoRunPhase: phase,
      autoRunCurrentRun: payload.currentRun ?? 0,
      autoRunTotalRuns: payload.totalRuns ?? 1,
      autoRunAttemptRun: payload.attemptRun ?? 0,
      autoRunSessionId: payload.sessionId ?? 0,
    }),
    getErrorMessage: (error) => error?.message || String(error || ''),
    getFirstUnfinishedNodeId: (statuses = {}, state = {}) => {
      const flowId = String(state?.activeFlowId || state?.flowId || 'openai').trim().toLowerCase();
      const candidateNodeIds = flowId === 'kiro' ? kiroNodeIds : openAiNodeIds;
      for (const nodeId of candidateNodeIds) {
        const status = String(statuses?.[nodeId] || 'pending').trim().toLowerCase();
        if (!['completed', 'manual_completed', 'skipped'].includes(status)) {
          return nodeId;
        }
      }
      return '';
    },
    getPendingAutoRunTimerPlan: () => null,
    getRunningNodeIds: () => [],
    getState: async () => ({
      ...currentState,
      nodeStatuses: { ...(currentState.nodeStatuses || {}) },
      tabRegistry: { ...(currentState.tabRegistry || {}) },
      sourceLastUrls: { ...(currentState.sourceLastUrls || {}) },
    }),
    getStopRequested: () => false,
    hasSavedNodeProgress: () => false,
    isAddPhoneAuthFailure: () => false,
    isGpcTaskEndedFailure: () => false,
    isPhoneSmsPlatformRateLimitFailure: () => false,
    isPlusCheckoutNonFreeTrialFailure: () => false,
    isRestartCurrentAttemptError: () => false,
    isStep4Route405RecoveryLimitFailure: () => false,
    isSignupUserAlreadyExistsFailure: () => false,
    isStopError: () => false,
    launchAutoRunTimerPlan: async () => false,
    normalizeAutoRunFallbackThreadIntervalMinutes: (value) => Math.max(0, Number(value) || 0),
    persistAutoRunTimerPlan: async () => {},
    resetState: async () => {
      currentState = {
        activeFlowId: 'openai',
        flowId: 'openai',
        panelMode: 'cpa',
        kiroSourceId: '',
        kiroRsUrl: '',
        kiroRsKey: '',
        kiroRsApiRegion: '',
        customFutureFlowField: '',
        plusModeEnabled: false,
        plusPaymentMethod: 'paypal',
        phoneVerificationEnabled: false,
        phoneSignupReloginAfterBindEmailEnabled: false,
        autoRunSkipFailures: false,
        autoRunFallbackThreadIntervalMinutes: 0,
        autoRunDelayEnabled: false,
        autoRunDelayMinutes: 30,
        autoStepDelaySeconds: null,
        signupMethod: 'email',
        stepExecutionRangeByFlow: {
          openai: { enabled: false, fromStep: 1, toStep: 11 },
          kiro: { enabled: false, fromStep: 1, toStep: 7 },
        },
        nodeStatuses: {},
        tabRegistry: {},
        sourceLastUrls: {},
      };
    },
    runAutoSequenceFromNode: async (nodeId) => {
      executedNodeIds.push(nodeId);
      assert.equal(currentState.activeFlowId, 'kiro');
      assert.equal(currentState.flowId, 'kiro');
      assert.equal(currentState.kiroSourceId, 'kiro-rs');
      assert.equal(currentState.kiroRsApiRegion, 'ap-east-1');
      assert.equal(currentState.customFutureFlowField, 'future-ready');
      currentState = {
        ...currentState,
        nodeStatuses: {
          'kiro-start-device-login': 'completed',
          'kiro-submit-email': 'completed',
          'kiro-submit-name': 'completed',
          'kiro-submit-verification-code': 'completed',
          'kiro-fill-password': 'completed',
          'kiro-confirm-access': 'completed',
          'kiro-upload-credential': 'completed',
        },
      };
    },
    runtime,
    setState: async (updates = {}) => {
      currentState = {
        ...currentState,
        ...updates,
        nodeStatuses: updates.nodeStatuses
          ? { ...updates.nodeStatuses }
          : currentState.nodeStatuses,
        tabRegistry: updates.tabRegistry
          ? { ...updates.tabRegistry }
          : currentState.tabRegistry,
        sourceLastUrls: updates.sourceLastUrls
          ? { ...updates.sourceLastUrls }
          : currentState.sourceLastUrls,
      };
    },
    sleepWithStop: async () => {},
    throwIfAutoRunSessionStopped: () => {},
    waitForRunningNodesToFinish: async () => currentState,
    chrome: {
      runtime: {
        sendMessage: () => Promise.resolve(),
      },
    },
  });

  await controller.autoRunLoop(1, { autoRunSkipFailures: false, mode: 'restart' });

  assert.deepStrictEqual(executedNodeIds, ['kiro-start-device-login']);
  assert.equal(helperCalls, 1);
});
