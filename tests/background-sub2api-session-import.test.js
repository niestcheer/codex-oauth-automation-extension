const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function loadSub2ApiApiModule() {
  const source = fs.readFileSync('background/sub2api-api.js', 'utf8');
  return new Function('self', `${source}; return self.MultiPageBackgroundSub2ApiApi;`)({});
}

function loadSub2ApiSessionImportModule() {
  const source = fs.readFileSync('background/steps/sub2api-session-import.js', 'utf8');
  return new Function('self', `${source}; return self.MultiPageBackgroundSub2ApiSessionImport;`)({});
}

test('sub2api api imports current ChatGPT session through codex-session endpoint', async () => {
  const apiModule = loadSub2ApiApiModule();
  const fetchCalls = [];
  const logs = [];
  const importExpiresAt = Math.floor(Date.parse('2026-05-20T12:34:56.000Z') / 1000);

  const api = apiModule.createSub2ApiApi({
    addLog: async (message, level = 'info', options = {}) => {
      logs.push({ message, level, step: options.step, stepKey: options.stepKey });
    },
    normalizeSub2ApiUrl: (value) => value,
    DEFAULT_SUB2API_GROUP_NAME: 'codex',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      fetchCalls.push({ path: parsed.pathname, search: parsed.search, method: options.method || 'GET', body });

      if (parsed.pathname === '/api/v1/auth/login') {
        return createJsonResponse({
          code: 0,
          data: {
            access_token: 'admin-token',
          },
        });
      }
      if (parsed.pathname === '/api/v1/admin/groups/all') {
        return createJsonResponse({
          code: 0,
          data: [
            { id: 5, name: 'codex', platform: 'openai' },
          ],
        });
      }
      if (parsed.pathname === '/api/v1/admin/proxies/all') {
        return createJsonResponse({
          code: 0,
          data: [{
            id: 7,
            name: 'shadowrocket',
            protocol: 'socks5',
            host: '127.0.0.1',
            port: 1080,
            status: 'active',
          }],
        });
      }
      if (parsed.pathname === '/api/v1/admin/accounts/import/codex-session') {
        const parsedContent = JSON.parse(body.content);
        assert.equal(parsedContent.accessToken, 'access-token-from-state');
        assert.equal(parsedContent.user?.email, 'flow@example.com');
        assert.equal(body.priority, 3);
        assert.equal(body.proxy_id, 7);
        assert.deepStrictEqual(body.group_ids, [5]);
        assert.equal(body.auto_pause_on_expired, true);
        assert.equal(body.update_existing, true);
        assert.equal(body.expires_at, importExpiresAt);
        return createJsonResponse({
          code: 0,
          data: {
            total: 1,
            created: 0,
            updated: 1,
            skipped: 0,
            failed: 0,
            warnings: [{
              index: 1,
              message: '未包含 refresh_token，accessToken 过期后无法自动续期',
            }],
          },
        });
      }

      return createJsonResponse({ code: 1, message: `unexpected path ${parsed.pathname}` }, 404);
    },
  });

  const result = await api.importCurrentChatGptSession({
    sub2apiUrl: 'https://sub.example/admin/accounts',
    sub2apiEmail: 'admin@example.com',
    sub2apiPassword: 'secret',
    sub2apiGroupName: 'codex',
    sub2apiDefaultProxyName: 'shadowrocket',
    sub2apiAccountPriority: 3,
    session: {
      accessToken: 'access-token-from-session',
      expires: '2026-05-20T12:34:56.000Z',
      user: {
        email: 'flow@example.com',
      },
    },
    accessToken: 'access-token-from-state',
  }, {
    logLabel: '步骤 10',
    logOptions: { step: 10, stepKey: 'sub2api-session-import' },
    timeoutMs: 120000,
  });

  const importCall = fetchCalls.find((call) => call.path === '/api/v1/admin/accounts/import/codex-session');
  assert.ok(importCall, 'expected codex-session import call');
  assert.equal(result.verifiedStatus, 'SUB2API 会话导入完成：新建 0，更新 1，跳过 0，失败 0');
  assert.equal(result.sub2apiImportUpdated, 1);
  assert.equal(
    logs.some((entry) => entry.level === 'warn' && /refresh_token/.test(entry.message)),
    true
  );
});

test('session import step reads current ChatGPT session and completes node', async () => {
  const moduleApi = loadSub2ApiSessionImportModule();
  const completed = [];
  const logs = [];
  const ensureCalls = [];
  const sentMessages = [];
  const importedPayloads = [];

  const executor = moduleApi.createSub2ApiSessionImportExecutor({
    addLog: async (message, level = 'info', options = {}) => {
      logs.push({ message, level, step: options.step, stepKey: options.stepKey });
    },
    chrome: {
      tabs: {
        get: async (tabId) => ({
          id: tabId,
          url: 'https://chatgpt.com/?model=gpt-4o',
        }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    createSub2ApiApi: () => ({
      importCurrentChatGptSession: async (state, options) => {
        importedPayloads.push({ state, options });
        return {
          verifiedStatus: 'SUB2API 会话导入完成：新建 1，更新 0，跳过 0，失败 0',
          sub2apiImportCreated: 1,
          sub2apiImportUpdated: 0,
          sub2apiImportSkipped: 0,
          sub2apiImportFailed: 0,
        };
      },
    }),
    ensureContentScriptReadyOnTabUntilStopped: async (source, tabId, options = {}) => {
      ensureCalls.push({ source, tabId, options });
    },
    getTabId: async () => null,
    isTabAlive: async () => false,
    normalizeSub2ApiUrl: (value) => value,
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      sentMessages.push({ tabId, source, message });
      return {
        session: {
          accessToken: 'session-access-token',
          expires: '2026-05-20T12:34:56.000Z',
          user: {
            email: 'flow@example.com',
          },
        },
        accessToken: 'session-access-token',
      };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabCompleteUntilStopped: async () => {},
    DEFAULT_SUB2API_GROUP_NAME: 'codex',
  });

  await executor.executeSub2ApiSessionImport({
    nodeId: 'sub2api-session-import',
    visibleStep: 10,
    plusCheckoutTabId: 91,
    sub2apiUrl: 'https://sub.example/admin/accounts',
    sub2apiEmail: 'admin@example.com',
    sub2apiPassword: 'secret',
    sub2apiGroupName: 'codex',
  });

  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].source, 'plus-checkout');
  assert.deepStrictEqual(ensureCalls[0].options.inject, [
    'content/utils.js',
    'content/operation-delay.js',
    'content/plus-checkout.js',
  ]);
  assert.deepStrictEqual(sentMessages, [{
    tabId: 91,
    source: 'plus-checkout',
    message: {
      type: 'PLUS_CHECKOUT_GET_STATE',
      source: 'background',
      payload: {
        includeSession: true,
        includeAccessToken: true,
      },
    },
  }]);
  assert.equal(importedPayloads.length, 1);
  assert.equal(importedPayloads[0].state.accessToken, 'session-access-token');
  assert.equal(importedPayloads[0].state.session.user.email, 'flow@example.com');
  assert.equal(completed.length, 1);
  assert.deepStrictEqual(completed[0], {
    nodeId: 'sub2api-session-import',
    payload: {
      verifiedStatus: 'SUB2API 会话导入完成：新建 1，更新 0，跳过 0，失败 0',
      sub2apiImportCreated: 1,
      sub2apiImportUpdated: 0,
      sub2apiImportSkipped: 0,
      sub2apiImportFailed: 0,
    },
  });
  assert.equal(
    logs.some((entry) => entry.stepKey === 'sub2api-session-import' && /读取当前 ChatGPT 登录会话/.test(entry.message)),
    true
  );
});

test('session import step rejects unsupported non-chatgpt tabs before reading session', async () => {
  const moduleApi = loadSub2ApiSessionImportModule();
  let sendCalled = false;

  const executor = moduleApi.createSub2ApiSessionImportExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async (tabId) => ({
          id: tabId,
          url: 'https://example.com/not-chatgpt',
        }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    createSub2ApiApi: () => ({
      importCurrentChatGptSession: async () => ({}),
    }),
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    getTabId: async () => 91,
    isTabAlive: async () => true,
    normalizeSub2ApiUrl: (value) => value,
    sendTabMessageUntilStopped: async () => {
      sendCalled = true;
      return {};
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executeSub2ApiSessionImport({
      nodeId: 'sub2api-session-import',
      visibleStep: 10,
    }),
    /当前标签页不在 ChatGPT \/ OpenAI 页面/
  );

  assert.equal(sendCalled, false);
});

test('background wires sub2api session import executor into the workflow runtime', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/steps\/sub2api-session-import\.js/);
  assert.match(source, /'sub2api-session-import': \(state\) => sub2ApiSessionImportExecutor\.executeSub2ApiSessionImport\(state\)/);
  assert.match(source, /'sub2api-session-import',\s*\n\s*'oauth-login'/);
});
