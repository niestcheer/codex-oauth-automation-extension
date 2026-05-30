const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('phone-sms/providers/madao.js', 'utf8');
const api = new Function('self', `${source}; return self.PhoneSmsMaDaoProvider;`)({});

function createJsonResponse(payload, ok = true, status = ok ? 200 : 400, statusText = ok ? 'OK' : 'Bad Request') {
  return {
    ok,
    status,
    statusText,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

test('MaDao direct acquire sends only direct fields and normalizes activation data', async () => {
  const requests = [];
  const provider = api.createProvider({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: new URL(url), options, body: JSON.parse(options.body) });
      return createJsonResponse({
        ticket_id: 'ticket-1',
        phone_number: '+441111111111',
        service: 'openai',
        country: 'gb',
        provider: 'Upstream A!',
        price: 0.123456,
        status: 'code_received',
      });
    },
  });

  const activation = await provider.acquireActivation({
    madaoBaseUrl: 'http://127.0.0.1:7822/',
    madaoHttpSecret: 'token-1',
    madaoMode: 'direct',
    madaoRoutingPlanId: 'route-plan-should-not-be-sent',
    madaoProviderId: 'Upstream A!',
    madaoCountry: 'gb',
    madaoOperator: 'Operator A!',
    madaoAutoPickCountry: 'false',
    madaoReusePhone: '1',
    madaoMinPrice: '0.01',
    madaoMaxPrice: '0.20',
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.toString(), 'http://127.0.0.1:7822/api/acquire');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token-1');
  assert.deepEqual(requests[0].body, {
    provider: 'upstreama',
    service: 'openai',
    auto_pick_country: false,
    reuse_phone: true,
    country: 'GB',
    metadata: {
      operator: 'operatora',
    },
    min_price: 0.01,
    max_price: 0.2,
  });
  assert.equal(activation.provider, 'madao');
  assert.equal(activation.activationId, 'ticket-1');
  assert.equal(activation.phoneNumber, '+441111111111');
  assert.equal(activation.countryId, 'GB');
  assert.equal(activation.madaoProviderId, 'upstreama');
  assert.equal(activation.madaoPrice, 0.1235);
  assert.equal(activation.madaoStatus, 'code_received');
});

test('MaDao routing acquire sends routing plan only', async () => {
  const requests = [];
  const provider = api.createProvider({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: new URL(url), body: JSON.parse(options.body) });
      return createJsonResponse({
        ticket_id: 'ticket-2',
        phone_number: '+442222222222',
        routing_plan_id: 'rp-openai',
        routing_item_id: 'route-1',
      });
    },
  });

  const activation = await provider.acquireActivation({
    madaoMode: 'routing_plan',
    madaoRoutingPlanId: 'rp-openai',
    madaoProviderId: 'direct-provider',
    madaoCountry: 'TH',
    madaoAutoPickCountry: false,
    madaoReusePhone: false,
    madaoMinPrice: '0.01',
    madaoMaxPrice: '0.20',
  });

  assert.deepEqual(requests[0].body, {
    provider: 'auto',
    service: 'openai',
    routing_plan_id: 'rp-openai',
  });
  assert.equal(activation.madaoRoutingPlanId, 'rp-openai');
  assert.equal(activation.madaoRoutingItemId, 'route-1');
});

test('MaDao direct acquire treats any operator as default route', async () => {
  const requests = [];
  const provider = api.createProvider({
    fetchImpl: async (_url, options = {}) => {
      requests.push({ body: JSON.parse(options.body) });
      return createJsonResponse({
        ticket_id: 'ticket-any',
        phone_number: '+66111111111',
        country: 'TH',
        provider: 'fivesim',
      });
    },
  });

  await provider.acquireActivation({
    madaoMode: 'direct',
    madaoProviderId: 'fivesim',
    madaoCountry: 'TH',
    madaoOperator: 'Any operator',
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {
    provider: 'fivesim',
    service: 'openai',
    auto_pick_country: true,
    reuse_phone: true,
    country: 'TH',
  });
});

test('MaDao poll extracts codes from nested messages and reports pending status', async () => {
  const statusEvents = [];
  const provider = api.createProvider({
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      if (body.ticket_id === 'pending-ticket') {
        return createJsonResponse({ status: 'waiting_code', message: 'still waiting' });
      }
      return createJsonResponse({
        messages: [
          { text: 'old text without code' },
          { body: 'OpenAI verification code: 765432' },
        ],
      });
    },
  });

  const pending = await provider.pollActivationCode({}, { activationId: 'pending-ticket' }, {
    onStatus: async (event) => statusEvents.push(event),
  });
  const code = await provider.pollActivationCode({}, { activationId: 'ready-ticket' });

  assert.equal(pending, '');
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].statusText, 'still waiting');
  assert.equal(code, '765432');
});

test('MaDao timed poll tolerates transient fetch failures while waiting for code', async () => {
  const statusEvents = [];
  const waitEvents = [];
  const requests = [];
  const provider = api.createProvider({
    fetchImpl: async (_url, options = {}) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        throw new TypeError('Failed to fetch');
      }
      return createJsonResponse({
        sms: [
          { text: 'OpenAI verification code: 246810' },
        ],
      });
    },
  });

  const code = await provider.pollActivationCode({}, { activationId: 'retry-ticket' }, {
    timeoutMs: 5000,
    intervalMs: 1,
    maxRounds: 3,
    onStatus: async (event) => statusEvents.push(event),
    onWaitingForCode: async (event) => waitEvents.push(event),
  }, {
    sleepWithStop: async () => {},
  });

  assert.equal(code, '246810');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((body) => body.ticket_id), ['retry-ticket', 'retry-ticket']);
  assert.equal(statusEvents.length, 2);
  assert.equal(statusEvents[0].pollCount, 1);
  assert.match(statusEvents[0].statusText, /network_error: Failed to fetch/);
  assert.equal(waitEvents.length, 1);
  assert.equal(waitEvents[0].pollCount, 1);
});

test('MaDao direct rotate releases the current ticket without acquiring a new one', async () => {
  const requests = [];
  const provider = api.createProvider({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: new URL(url), body: JSON.parse(options.body) });
      return createJsonResponse({ released: true });
    },
  });

  const result = await provider.rotateActivation(
    { madaoMode: 'direct' },
    { activationId: 'ticket-old', phoneNumber: '+441111111111' },
    { releaseAction: 'ban' }
  );

  assert.deepEqual(
    requests.map((request) => request.url.pathname),
    ['/api/release']
  );
  assert.deepEqual(requests[0].body, { ticket_id: 'ticket-old', action: 'ban' });
  assert.equal(result.currentTicketId, 'ticket-old');
  assert.equal(result.nextActivation, null);
});

test('MaDao routing rotate rejects invalid replacement payloads', async () => {
  const provider = api.createProvider({
    fetchImpl: async () => createJsonResponse({
      current_ticket_id: 'ticket-old',
      next_ticket: {
        ticket_id: 'ticket-new',
      },
    }),
  });

  await assert.rejects(
    () => provider.rotateActivation(
      { madaoMode: 'routing_plan' },
      {
        activationId: 'ticket-old',
        phoneNumber: '+441111111111',
        madaoRoutingPlanId: 'rp-openai',
        madaoRoutingItemId: 'route-old',
      },
      { releaseAction: 'ban', reason: 'phone_number_used' }
    ),
    /MaDao/
  );
});

test('MaDao provider surfaces HTTP errors and request timeouts', async () => {
  const httpProvider = api.createProvider({
    fetchImpl: async () => createJsonResponse({ error: 'upstream unavailable' }, false, 503, 'Service Unavailable'),
  });

  await assert.rejects(
    () => httpProvider.acquireActivation({}),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.payload.error, 'upstream unavailable');
      assert.match(error.message, /upstream unavailable/);
      return true;
    }
  );

  const timeoutProvider = api.createProvider({
    fetchImpl: async (_url, options = {}) => {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
    requestTimeoutMs: 1,
  });

  await assert.rejects(
    () => timeoutProvider.acquireActivation({}),
    /MaDao/
  );
});
