const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadSessionReaderApi() {
  const source = fs.readFileSync('flows/openai/background/session-reader.js', 'utf8');
  const globalScope = {};
  new Function('self', `${source}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundOpenAiSessionReader;
}

test('OpenAI session reader recognizes supported ChatGPT and OpenAI session URLs', () => {
  const api = loadSessionReaderApi();

  assert.equal(api.isSupportedChatGptSessionUrl('https://chatgpt.com/?model=gpt-4o'), true);
  assert.equal(api.isSupportedChatGptSessionUrl('https://chat.openai.com/'), true);
  assert.equal(api.isSupportedChatGptSessionUrl('https://auth.openai.com/authorize'), true);
  assert.equal(api.isSupportedChatGptSessionUrl('chrome://extensions'), false);
  assert.equal(api.isSupportedChatGptSessionUrl('https://example.com'), false);
});

test('OpenAI session reader prefers active chatgpt tab before older OpenAI tabs', () => {
  const api = loadSessionReaderApi();
  const picked = api.pickPreferredSessionTab([
    { id: 3, url: 'https://auth.openai.com/authorize', active: true, currentWindow: true, lastAccessed: 999 },
    { id: 8, url: 'https://chatgpt.com/?model=gpt-4o', active: false, currentWindow: false, lastAccessed: 1 },
    { id: 9, url: 'https://example.com', active: true, currentWindow: true, lastAccessed: 1000 },
  ]);

  assert.equal(picked.id, 8);
});

test('OpenAI session reader falls back to active ChatGPT tab and reads current session', async () => {
  const api = loadSessionReaderApi();
  const ensureCalls = [];
  const sentMessages = [];
  const registerCalls = [];
  const sessionTab = {
    id: 77,
    url: 'https://chatgpt.com/?model=gpt-4o',
    active: true,
    currentWindow: true,
    lastAccessed: 1234,
  };

  const reader = api.createOpenAiSessionReader({
    chrome: {
      tabs: {
        get: async (tabId) => ({ ...sessionTab, id: tabId }),
        query: async (query) => (query.active ? [sessionTab] : []),
        update: async () => {},
      },
    },
    ensureContentScriptReadyOnTabUntilStopped: async (source, tabId, options = {}) => {
      ensureCalls.push({ source, tabId, options });
    },
    getTabId: async () => null,
    isTabAlive: async () => false,
    registerTab: async (source, tabId) => registerCalls.push({ source, tabId }),
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      sentMessages.push({ tabId, source, message });
      return {
        session: {
          accessToken: 'session-access-token',
          user: { email: 'flow@example.com' },
        },
        accessToken: 'session-access-token',
      };
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  const result = await reader.readCurrentSessionFromState({ plusCheckoutTabId: 0 }, {
    visibleStep: 12,
    targetLabel: 'webchat',
  });

  assert.equal(result.tabId, 77);
  assert.equal(result.accessToken, 'session-access-token');
  assert.equal(result.session.user.email, 'flow@example.com');
  assert.deepEqual(registerCalls, [{ source: 'plus-checkout', tabId: 77 }]);
  assert.equal(ensureCalls.length, 1);
  assert.deepEqual(ensureCalls[0].options.inject, [
    'content/utils.js',
    'content/operation-delay.js',
    'flows/openai/content/plus-checkout.js',
  ]);
  assert.deepEqual(sentMessages, [{
    tabId: 77,
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
});
