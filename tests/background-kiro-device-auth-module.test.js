const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadKiroDeviceAuthApi() {
  const source = fs.readFileSync('background/steps/kiro-device-auth.js', 'utf8');
  return new Function('self', `${source}; return self.MultiPageBackgroundKiroDeviceAuth;`)({});
}

function createResponse({ ok = true, status = 200, json = null, text = '' } = {}) {
  const bodyText = text || (json ? JSON.stringify(json) : '');
  return {
    ok,
    status,
    statusText: bodyText || `HTTP ${status}`,
    async text() {
      return bodyText;
    },
  };
}

function mergeUpdates(updatesList = []) {
  return updatesList.reduce((acc, item) => Object.assign(acc, item), {});
}

function createChromeRecorder() {
  const updates = [];
  return {
    updates,
    chrome: {
      tabs: {
        update: async (tabId, update) => {
          updates.push({ tabId, update });
        },
      },
    },
  };
}

test('kiro device auth module exposes a factory', () => {
  const api = loadKiroDeviceAuthApi();
  assert.equal(typeof api?.createKiroDeviceAuthExecutor, 'function');
  assert.equal(typeof api?.startBuilderIdDeviceLogin, 'function');
  assert.equal(typeof api?.uploadBuilderIdCredential, 'function');
});

test('kiro start device login opens the auth tab and waits for the email entry page', async () => {
  const api = loadKiroDeviceAuthApi();
  const fetchCalls = [];
  const stateUpdates = [];
  const registerCalls = [];
  const reuseCalls = [];
  const completeCalls = [];
  const contentReadyCalls = [];
  const contentMessages = [];
  const stableWaitCalls = [];
  const { chrome, updates: tabUpdates } = createChromeRecorder();

  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTab: async (source, tabId, options = {}) => {
      contentReadyCalls.push({ source, tabId, options });
    },
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (url.endsWith('/client/register')) {
        return createResponse({
          ok: true,
          status: 200,
          json: {
            clientId: 'client-001',
            clientSecret: 'secret-001',
          },
        });
      }
      if (url.endsWith('/device_authorization')) {
        return createResponse({
          ok: true,
          status: 200,
          json: {
            deviceCode: 'device-code-001',
            userCode: 'ABCD-1234',
            verificationUri: 'https://device.example.com/start',
            verificationUriComplete: 'https://device.example.com/complete',
            interval: 7,
            expiresIn: 900,
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    getState: async () => ({}),
    registerTab: async (source, tabId) => {
      registerCalls.push({ source, tabId });
    },
    KIRO_DEVICE_AUTH_INJECT_FILES: [
      'shared/source-registry.js',
      'content/utils.js',
      'content/kiro-device-auth-page.js',
    ],
    reuseOrCreateTab: async (source, url) => {
      reuseCalls.push({ source, url });
      return 88;
    },
    sendToContentScriptResilient: async (source, message, options = {}) => {
      contentMessages.push({ source, message, options });
      return {
        ok: true,
        state: 'email_entry',
        url: 'https://device.example.com/complete',
      };
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async (tabId, options = {}) => {
      stableWaitCalls.push({ tabId, options });
    },
  });

  await executor.executeKiroStartDeviceLogin({
    nodeId: 'kiro-start-device-login',
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://oidc.us-east-1.amazonaws.com/client/register');
  assert.equal(fetchCalls[1].url, 'https://oidc.us-east-1.amazonaws.com/device_authorization');
  assert.deepEqual(fetchCalls[1].body, {
    clientId: 'client-001',
    clientSecret: 'secret-001',
    startUrl: 'https://view.awsapps.com/start',
  });
  assert.deepEqual(reuseCalls, [{
    source: 'kiro-device-auth',
    url: 'https://device.example.com/complete',
  }]);
  assert.deepEqual(registerCalls, [{
    source: 'kiro-device-auth',
    tabId: 88,
  }]);
  assert.deepEqual(tabUpdates, [{
    tabId: 88,
    update: { active: true },
  }]);
  assert.deepEqual(stableWaitCalls, [{
    tabId: 88,
    options: {
      timeoutMs: 45000,
      retryDelayMs: 300,
      stableMs: 2500,
      initialDelayMs: 300,
    },
  }]);
  assert.equal(contentReadyCalls.length, 1);
  assert.equal(contentMessages.length, 1);
  assert.equal(contentMessages[0].message.type, 'ENSURE_KIRO_PAGE_STATE');
  assert.deepEqual(contentMessages[0].message.payload.targetStates, ['email_entry']);

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroClientId, 'client-001');
  assert.equal(finalState.kiroClientSecret, 'secret-001');
  assert.equal(finalState.kiroDeviceAuthorizationCode, 'device-code-001');
  assert.equal(finalState.kiroDeviceCode, 'ABCD-1234');
  assert.equal(finalState.kiroLoginUrl, 'https://device.example.com/complete');
  assert.equal(finalState.kiroAuthRegion, 'us-east-1');
  assert.equal(finalState.kiroAuthIntervalSeconds, 7);
  assert.equal(finalState.kiroAuthStatus, 'waiting_user');
  assert.equal(finalState.kiroUploadStatus, 'waiting_login');
  assert.equal(finalState.kiroFullName, '');
  assert.equal(finalState.kiroVerificationRequestedAt, 0);

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-start-device-login');
  assert.equal(completeCalls[0].payload.kiroDeviceCode, 'ABCD-1234');
  assert.equal(completeCalls[0].payload.kiroLoginUrl, 'https://device.example.com/complete');
});

test('kiro submit email resolves the signup email, reactivates the auth tab, and waits for the name page', async () => {
  const api = loadKiroDeviceAuthApi();
  const stateUpdates = [];
  const completeCalls = [];
  const resolvedEmails = [];
  const contentMessages = [];
  const stableWaitCalls = [];
  const { chrome, updates: tabUpdates } = createChromeRecorder();

  let ensureCallIndex = 0;
  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => ({
      kiroAuthTabId: 88,
      kiroLoginUrl: 'https://device.example.com/complete',
      email: '',
      mailProvider: '163',
    }),
    isTabAlive: async (source) => source === 'kiro-device-auth',
    KIRO_DEVICE_AUTH_INJECT_FILES: [
      'shared/source-registry.js',
      'content/utils.js',
      'content/kiro-device-auth-page.js',
    ],
    resolveSignupEmailForFlow: async (state, options = {}) => {
      resolvedEmails.push({ state, options });
      return 'user@example.com';
    },
    sendToContentScriptResilient: async (source, message, options = {}) => {
      contentMessages.push({ source, message, options });
      if (message.type === 'ENSURE_KIRO_PAGE_STATE') {
        ensureCallIndex += 1;
        return {
          ok: true,
          state: ensureCallIndex === 1 ? 'email_entry' : 'name_entry',
          url: ensureCallIndex === 1
            ? 'https://device.example.com/complete'
            : 'https://device.example.com/name',
        };
      }
      if (message.type === 'EXECUTE_NODE') {
        return {
          ok: true,
          submitted: true,
          state: 'email_submitted',
          url: 'https://device.example.com/complete',
        };
      }
      throw new Error(`Unexpected content message: ${message.type}`);
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async (tabId, options = {}) => {
      stableWaitCalls.push({ tabId, options });
    },
  });

  await executor.executeKiroSubmitEmail({
    nodeId: 'kiro-submit-email',
    kiroAuthTabId: 88,
    kiroLoginUrl: 'https://device.example.com/complete',
    email: '',
    mailProvider: '163',
  });

  assert.equal(resolvedEmails.length, 1);
  assert.equal(resolvedEmails[0].state.nodeId, 'kiro-submit-email');
  assert.deepEqual(resolvedEmails[0].options, {
    preserveAccountIdentity: true,
  });
  assert.deepEqual(tabUpdates, [
    { tabId: 88, update: { active: true } },
    { tabId: 88, update: { active: true } },
  ]);
  assert.deepEqual(stableWaitCalls, [
    {
      tabId: 88,
      options: {
        timeoutMs: 45000,
        retryDelayMs: 300,
        stableMs: 2500,
        initialDelayMs: 300,
      },
    },
    {
      tabId: 88,
      options: {
        timeoutMs: 45000,
        retryDelayMs: 300,
        stableMs: 1500,
        initialDelayMs: 150,
      },
    },
  ]);
  assert.equal(contentMessages.length, 3);
  assert.deepEqual(contentMessages[0].message.payload.targetStates, ['email_entry']);
  assert.equal(contentMessages[1].message.nodeId, 'kiro-submit-email');
  assert.deepEqual(contentMessages[1].message.payload, { email: 'user@example.com' });
  assert.deepEqual(contentMessages[2].message.payload.targetStates, ['name_entry']);

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroAuthorizedEmail, 'user@example.com');
  assert.equal(finalState.kiroAuthError, '');
  assert.equal(finalState.kiroAuthStatus, 'waiting_user');
  assert.equal(finalState.kiroUploadError, '');
  assert.equal(finalState.kiroUploadStatus, 'waiting_login');
  assert.equal(finalState.kiroFullName, '');
  assert.equal(finalState.kiroVerificationRequestedAt, 0);

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-submit-email');
  assert.equal(completeCalls[0].payload.email, 'user@example.com');
  assert.equal(completeCalls[0].payload.accountIdentifierType, 'email');
  assert.equal(completeCalls[0].payload.accountIdentifier, 'user@example.com');
  assert.equal(completeCalls[0].payload.kiroNextState, 'name_entry');
  assert.equal(completeCalls[0].payload.kiroNextUrl, 'https://device.example.com/name');
});

test('kiro submit name generates a full name and waits for the otp page', async () => {
  const api = loadKiroDeviceAuthApi();
  const stateUpdates = [];
  const completeCalls = [];
  const contentMessages = [];
  const { chrome, updates: tabUpdates } = createChromeRecorder();

  let ensureCallIndex = 0;
  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    generateRandomName: () => ({ firstName: 'Ada', lastName: 'Lovelace' }),
    getState: async () => ({
      kiroAuthTabId: 88,
      kiroAuthorizedEmail: 'user@example.com',
      kiroLoginUrl: 'https://device.example.com/complete',
    }),
    isTabAlive: async (source) => source === 'kiro-device-auth',
    sendToContentScriptResilient: async (_source, message) => {
      contentMessages.push(message);
      if (message.type === 'ENSURE_KIRO_PAGE_STATE') {
        ensureCallIndex += 1;
        return {
          ok: true,
          state: ensureCallIndex === 1 ? 'name_entry' : 'otp_page',
          url: ensureCallIndex === 1
            ? 'https://device.example.com/name'
            : 'https://device.example.com/verify',
        };
      }
      if (message.type === 'EXECUTE_NODE') {
        return {
          ok: true,
          submitted: true,
          state: 'name_submitted',
          url: 'https://device.example.com/name',
        };
      }
      throw new Error(`Unexpected content message: ${message.type}`);
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async () => {},
  });

  await executor.executeKiroSubmitName({
    nodeId: 'kiro-submit-name',
    kiroAuthTabId: 88,
    kiroAuthorizedEmail: 'user@example.com',
    kiroLoginUrl: 'https://device.example.com/complete',
  });

  assert.deepEqual(tabUpdates, [{
    tabId: 88,
    update: { active: true },
  }]);
  assert.equal(contentMessages.length, 3);
  assert.deepEqual(contentMessages[0].payload.targetStates, ['name_entry']);
  assert.equal(contentMessages[1].nodeId, 'kiro-submit-name');
  assert.deepEqual(contentMessages[1].payload, { fullName: 'Ada Lovelace' });
  assert.deepEqual(contentMessages[2].payload.targetStates, ['otp_page']);

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroFullName, 'Ada Lovelace');
  assert.equal(finalState.kiroAuthError, '');
  assert.equal(finalState.kiroUploadError, '');
  assert.equal(typeof finalState.kiroVerificationRequestedAt, 'number');
  assert.equal(finalState.kiroVerificationRequestedAt > 0, true);

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-submit-name');
  assert.equal(completeCalls[0].payload.kiroFullName, 'Ada Lovelace');
  assert.equal(completeCalls[0].payload.kiroNextState, 'otp_page');
});

test('kiro submit verification code polls mail, returns to the auth tab, and waits for the password page', async () => {
  const api = loadKiroDeviceAuthApi();
  const stateUpdates = [];
  const completeCalls = [];
  const mailPollCalls = [];
  const contentMessages = [];
  const mailOpenCalls = [];
  const { chrome, updates: tabUpdates } = createChromeRecorder();

  let ensureCallIndex = 0;
  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    getMailConfig: () => ({
      source: 'mail-163',
      url: 'https://mail.example.com/inbox',
      label: '163 邮箱',
    }),
    getState: async () => ({
      kiroAuthTabId: 88,
      kiroAuthorizedEmail: 'user@example.com',
      kiroLoginUrl: 'https://device.example.com/complete',
      kiroVerificationRequestedAt: 1700000000000,
      mailProvider: '163',
    }),
    isTabAlive: async (source) => source === 'kiro-device-auth',
    reuseOrCreateTab: async (source, url) => {
      mailOpenCalls.push({ source, url });
      return 66;
    },
    sendToContentScriptResilient: async (_source, message) => {
      contentMessages.push(message);
      if (message.type === 'ENSURE_KIRO_PAGE_STATE') {
        ensureCallIndex += 1;
        return {
          ok: true,
          state: ensureCallIndex === 1 ? 'otp_page' : 'password_page',
          url: ensureCallIndex === 1
            ? 'https://device.example.com/verify'
            : 'https://device.example.com/password',
        };
      }
      if (message.type === 'EXECUTE_NODE') {
        return {
          ok: true,
          submitted: true,
          state: 'verification_submitted',
          url: 'https://device.example.com/verify',
        };
      }
      throw new Error(`Unexpected content message: ${message.type}`);
    },
    sendToMailContentScriptResilient: async (mail, message, options = {}) => {
      mailPollCalls.push({ mail, message, options });
      return {
        ok: true,
        code: '654321',
        emailTimestamp: 1700000005000,
        mailId: 'mail-1',
      };
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async () => {},
  });

  await executor.executeKiroSubmitVerificationCode({
    nodeId: 'kiro-submit-verification-code',
    kiroAuthTabId: 88,
    kiroAuthorizedEmail: 'user@example.com',
    kiroLoginUrl: 'https://device.example.com/complete',
    kiroVerificationRequestedAt: 1700000000000,
    mailProvider: '163',
  });

  assert.deepEqual(mailOpenCalls, [{
    source: 'mail-163',
    url: 'https://mail.example.com/inbox',
  }]);
  assert.equal(mailPollCalls.length, 1);
  assert.equal(mailPollCalls[0].message.type, 'POLL_EMAIL');
  assert.equal(mailPollCalls[0].message.payload.targetEmail, 'user@example.com');
  assert.equal(mailPollCalls[0].message.payload.filterAfterTimestamp, 1700000000000);
  assert.deepEqual(tabUpdates, [
    { tabId: 88, update: { active: true } },
    { tabId: 88, update: { active: true } },
  ]);
  assert.equal(contentMessages.length, 3);
  assert.deepEqual(contentMessages[0].payload.targetStates, ['otp_page']);
  assert.equal(contentMessages[1].nodeId, 'kiro-submit-verification-code');
  assert.deepEqual(contentMessages[1].payload, { code: '654321' });
  assert.deepEqual(contentMessages[2].payload.targetStates, ['password_page']);

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroAuthError, '');
  assert.equal(finalState.kiroUploadError, '');

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-submit-verification-code');
  assert.equal(completeCalls[0].payload.code, '654321');
  assert.equal(completeCalls[0].payload.mailId, 'mail-1');
  assert.equal(completeCalls[0].payload.kiroNextState, 'password_page');
});

test('kiro fill password reuses the shared password state and waits for the page to leave password state', async () => {
  const api = loadKiroDeviceAuthApi();
  const stateUpdates = [];
  const completeCalls = [];
  const contentMessages = [];
  const savedPasswords = [];
  const { chrome, updates: tabUpdates } = createChromeRecorder();

  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => ({
      kiroAuthTabId: 88,
      kiroLoginUrl: 'https://device.example.com/complete',
      customPassword: 'SharedPass123!',
    }),
    isTabAlive: async (source) => source === 'kiro-device-auth',
    sendToContentScriptResilient: async (_source, message) => {
      contentMessages.push(message);
      if (message.type === 'ENSURE_KIRO_PAGE_STATE') {
        return {
          ok: true,
          state: 'password_page',
          url: 'https://device.example.com/password',
        };
      }
      if (message.type === 'ENSURE_KIRO_STATE_CHANGE') {
        return {
          ok: true,
          state: 'authorization_page',
          url: 'https://device.example.com/authorize',
        };
      }
      if (message.type === 'EXECUTE_NODE') {
        return {
          ok: true,
          submitted: true,
          state: 'password_submitted',
          url: 'https://device.example.com/password',
        };
      }
      throw new Error(`Unexpected content message: ${message.type}`);
    },
    setPasswordState: async (password) => {
      savedPasswords.push(password);
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async () => {},
  });

  await executor.executeKiroFillPassword({
    nodeId: 'kiro-fill-password',
    kiroAuthTabId: 88,
    kiroLoginUrl: 'https://device.example.com/complete',
    customPassword: 'SharedPass123!',
  });

  assert.deepEqual(savedPasswords, ['SharedPass123!']);
  assert.deepEqual(tabUpdates, [{
    tabId: 88,
    update: { active: true },
  }]);
  assert.equal(contentMessages.length, 3);
  assert.deepEqual(contentMessages[0].payload.targetStates, ['password_page']);
  assert.equal(contentMessages[1].nodeId, 'kiro-fill-password');
  assert.deepEqual(contentMessages[1].payload, { password: 'SharedPass123!' });
  assert.deepEqual(contentMessages[2].payload.fromStates, ['password_page']);

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroAuthError, '');
  assert.equal(finalState.kiroUploadError, '');

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-fill-password');
  assert.equal(completeCalls[0].payload.kiroNextState, 'authorization_page');
  assert.equal(completeCalls[0].payload.kiroNextUrl, 'https://device.example.com/authorize');
});

test('kiro confirm access completes the authorization page and then polls until refresh token is captured', async () => {
  const api = loadKiroDeviceAuthApi();
  const fetchCalls = [];
  const stateUpdates = [];
  const sleepCalls = [];
  const completeCalls = [];
  const contentMessages = [];
  const { chrome, updates: tabUpdates } = createChromeRecorder();

  let pollCount = 0;
  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null,
      });
      pollCount += 1;
      if (pollCount === 1) {
        return createResponse({
          ok: false,
          status: 400,
          json: { error: 'authorization_pending' },
        });
      }
      return createResponse({
        ok: true,
        status: 200,
        json: {
          accessToken: 'access-001',
          refreshToken: 'refresh-001',
          expiresIn: 3600,
        },
      });
    },
    getState: async () => ({
      kiroAuthTabId: 88,
      kiroClientId: 'client-001',
      kiroClientSecret: 'secret-001',
      kiroDeviceAuthorizationCode: 'device-code-001',
      kiroAuthRegion: 'us-east-1',
      kiroAuthExpiresAt: Date.now() + 60000,
      kiroAuthIntervalSeconds: 5,
      kiroLoginUrl: 'https://device.example.com/complete',
    }),
    isTabAlive: async (source) => source === 'kiro-device-auth',
    sendToContentScriptResilient: async (_source, message) => {
      contentMessages.push(message);
      if (message.type === 'ENSURE_KIRO_PAGE_STATE') {
        return {
          ok: true,
          state: 'authorization_page',
          url: 'https://device.example.com/authorize',
        };
      }
      if (message.type === 'EXECUTE_NODE') {
        return {
          ok: true,
          submitted: true,
          state: 'success_page',
          url: 'https://device.example.com/success',
        };
      }
      throw new Error(`Unexpected content message: ${message.type}`);
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async (ms) => {
      sleepCalls.push(ms);
    },
    throwIfStopped: () => {},
    waitForTabStableComplete: async () => {},
  });

  await executor.executeKiroConfirmAccess({
    nodeId: 'kiro-confirm-access',
    kiroAuthTabId: 88,
    kiroClientId: 'client-001',
    kiroClientSecret: 'secret-001',
    kiroDeviceAuthorizationCode: 'device-code-001',
    kiroAuthRegion: 'us-east-1',
    kiroAuthExpiresAt: Date.now() + 60000,
    kiroAuthIntervalSeconds: 5,
    kiroLoginUrl: 'https://device.example.com/complete',
  });

  assert.deepEqual(tabUpdates, [{
    tabId: 88,
    update: { active: true },
  }]);
  assert.equal(contentMessages.length, 2);
  assert.deepEqual(contentMessages[0].payload.targetStates, ['authorization_page', 'success_page']);
  assert.equal(contentMessages[1].nodeId, 'kiro-confirm-access');
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://oidc.us-east-1.amazonaws.com/token');
  assert.deepEqual(fetchCalls[0].body, {
    clientId: 'client-001',
    clientSecret: 'secret-001',
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    deviceCode: 'device-code-001',
  });
  assert.deepEqual(sleepCalls, [5000]);

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroAuthStatus, 'authorized');
  assert.equal(finalState.kiroRefreshToken, 'refresh-001');
  assert.equal(finalState.kiroAccessToken, 'access-001');
  assert.equal(finalState.kiroUploadStatus, 'ready_to_upload');

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-confirm-access');
  assert.equal(completeCalls[0].payload.kiroRefreshToken, 'refresh-001');
  assert.equal(completeCalls[0].payload.kiroNextState, 'success_page');
  assert.equal(completeCalls[0].payload.kiroNextUrl, 'https://device.example.com/success');
});

test('kiro upload credential checks connection and uploads builder id credential to kiro.rs', async () => {
  const api = loadKiroDeviceAuthApi();
  const fetchCalls = [];
  const stateUpdates = [];
  const completeCalls = [];

  const executor = api.createKiroDeviceAuthExecutor({
    addLog: async () => {},
    completeNodeFromBackground: async (nodeId, payload) => {
      completeCalls.push({ nodeId, payload });
    },
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (options.method === 'GET') {
        return createResponse({
          ok: true,
          status: 200,
          json: { success: true },
        });
      }
      return createResponse({
        ok: true,
        status: 200,
        json: {
          success: true,
          message: 'uploaded',
          credentialId: 321,
          email: 'aws-user@example.com',
        },
      });
    },
    getState: async () => ({
      kiroRefreshToken: 'refresh-001',
      kiroClientId: 'client-001',
      kiroClientSecret: 'secret-001',
      kiroAuthRegion: 'ap-southeast-1',
      kiroAuthorizedEmail: 'cached@example.com',
      kiroRsUrl: 'https://kiro.example.com/admin',
      kiroRsKey: 'admin-key-001',
      ipProxyEnabled: true,
      ipProxyProtocol: 'socks5',
      ipProxyHost: '127.0.0.1',
      ipProxyPort: '1080',
      ipProxyUsername: 'proxy-user',
      ipProxyPassword: 'proxy-pass',
    }),
    setState: async (updates) => {
      stateUpdates.push(updates);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  await executor.executeKiroUploadCredential({
    nodeId: 'kiro-upload-credential',
    kiroRefreshToken: 'refresh-001',
    kiroClientId: 'client-001',
    kiroClientSecret: 'secret-001',
    kiroAuthRegion: 'ap-southeast-1',
    kiroAuthorizedEmail: 'cached@example.com',
    kiroRsUrl: 'https://kiro.example.com/admin',
    kiroRsKey: 'admin-key-001',
    ipProxyEnabled: true,
    ipProxyProtocol: 'socks5',
    ipProxyHost: '127.0.0.1',
    ipProxyPort: '1080',
    ipProxyUsername: 'proxy-user',
    ipProxyPassword: 'proxy-pass',
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://kiro.example.com/api/admin/credentials');
  assert.equal(fetchCalls[0].method, 'GET');
  assert.equal(fetchCalls[0].headers['x-api-key'], 'admin-key-001');

  assert.equal(fetchCalls[1].url, 'https://kiro.example.com/api/admin/credentials');
  assert.equal(fetchCalls[1].method, 'POST');
  assert.equal(fetchCalls[1].headers['x-api-key'], 'admin-key-001');
  assert.deepEqual(fetchCalls[1].body, {
    refreshToken: 'refresh-001',
    clientId: 'client-001',
    clientSecret: 'secret-001',
    region: 'ap-southeast-1',
    email: 'cached@example.com',
    priority: 0,
    authMethod: 'IdC',
    provider: 'BuilderId',
    proxyUrl: 'socks5://127.0.0.1:1080',
    proxyUsername: 'proxy-user',
    proxyPassword: 'proxy-pass',
  });

  const finalState = mergeUpdates(stateUpdates);
  assert.equal(finalState.kiroLastConnectionMessage, 'kiro.rs 连接正常（HTTP 200）');
  assert.equal(finalState.kiroAuthorizedEmail, 'aws-user@example.com');
  assert.equal(finalState.kiroCredentialId, 321);
  assert.equal(finalState.kiroUploadStatus, '上传成功');
  assert.equal(typeof finalState.kiroLastUploadAt, 'number');
  assert.equal(finalState.kiroLastUploadAt > 0, true);

  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].nodeId, 'kiro-upload-credential');
  assert.equal(completeCalls[0].payload.kiroCredentialId, 321);
  assert.equal(completeCalls[0].payload.kiroUploadStatus, '上传成功');
});
