const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/gopay-manual-confirm.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundGoPayManualConfirm;`)(globalScope);

test('GoPay manual confirm executor publishes pending manual confirmation state for OAuth continuation', async () => {
  const stateUpdates = [];
  const broadcasts = [];
  const events = [];
  const executor = api.createGoPayManualConfirmExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    broadcastDataUpdate: (payload) => {
      broadcasts.push(payload);
    },
    chrome: {
      tabs: {
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    getNodeIdsForState: () => [
      'open-chatgpt',
      'plus-checkout-create',
      'plus-checkout-billing',
      'gopay-subscription-confirm',
      'oauth-login',
    ],
    getTabId: async () => 42,
    isTabAlive: async () => true,
    registerTab: async () => {},
    setState: async (payload) => {
      stateUpdates.push(payload);
    },
  });

  await executor.executeGoPayManualConfirm({
    nodeId: 'gopay-subscription-confirm',
    plusCheckoutTabId: 42,
    plusCheckoutUrl: 'https://chatgpt.com/checkout/openai_llc/session',
  });

  assert.equal(stateUpdates.length, 1);
  assert.equal(stateUpdates[0].plusManualConfirmationPending, true);
  assert.equal(stateUpdates[0].plusManualConfirmationMethod, 'gopay');
  assert.equal(stateUpdates[0].plusManualConfirmationStep, 7);
  assert.match(String(stateUpdates[0].plusManualConfirmationRequestId || ''), /^gopay-/);
  assert.match(stateUpdates[0].plusManualConfirmationMessage, /OAuth 登录/);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].plusManualConfirmationPending, true);
  assert.deepStrictEqual(
    events.find((event) => event.type === 'tab-update'),
    { type: 'tab-update', tabId: 42, payload: { active: true } }
  );
  assert.match(
    events.find((event) => event.type === 'log')?.message || '',
    /确认后继续OAuth 登录/
  );
});

test('GoPay manual confirm executor switches continuation copy to SUB2API session import when the effective tail is session-based', async () => {
  const stateUpdates = [];
  const events = [];
  const executor = api.createGoPayManualConfirmExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    broadcastDataUpdate: () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    getNodeIdsForState: () => [
      'open-chatgpt',
      'plus-checkout-create',
      'plus-checkout-billing',
      'gopay-subscription-confirm',
      'sub2api-session-import',
    ],
    getTabId: async () => 42,
    isTabAlive: async () => true,
    registerTab: async () => {},
    setState: async (payload) => {
      stateUpdates.push(payload);
    },
  });

  await executor.executeGoPayManualConfirm({
    nodeId: 'gopay-subscription-confirm',
    visibleStep: 9,
    plusCheckoutTabId: 42,
    plusCheckoutUrl: 'https://chatgpt.com/checkout/openai_llc/session',
  });

  assert.equal(stateUpdates.length, 1);
  assert.equal(stateUpdates[0].plusManualConfirmationStep, 9);
  assert.match(stateUpdates[0].plusManualConfirmationMessage, /导入当前 ChatGPT 会话到 SUB2API/);
  assert.match(
    events.find((event) => event.type === 'log')?.message || '',
    /确认后继续导入当前 ChatGPT 会话到 SUB2API/
  );
});
