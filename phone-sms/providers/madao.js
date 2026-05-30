// phone-sms/providers/madao.js - MaDao unified SMS backend adapter
(function attachMaDaoProvider(root, factory) {
  root.PhoneSmsMaDaoProvider = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createMaDaoProviderModule() {
  const PROVIDER_ID = 'madao';
  const DEFAULT_BASE_URL = 'http://127.0.0.1:7822';
  const DEFAULT_SERVICE = 'openai';
  const DEFAULT_MODE = 'routing_plan';
  const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
  const DEFAULT_POLL_TIMEOUT_MS = 180000;
  const DEFAULT_POLL_INTERVAL_MS = 5000;
  const PHONE_CODE_TIMEOUT_ERROR_PREFIX = 'PHONE_CODE_TIMEOUT::';
  const COUNTRY_BY_PHONE_PREFIX = Object.freeze([
    { prefix: '84', id: 'VN', label: 'Vietnam' },
    { prefix: '66', id: 'TH', label: 'Thailand' },
    { prefix: '62', id: 'ID', label: 'Indonesia' },
    { prefix: '44', id: 'GB', label: 'United Kingdom' },
    { prefix: '81', id: 'JP', label: 'Japan' },
    { prefix: '49', id: 'DE', label: 'Germany' },
    { prefix: '33', id: 'FR', label: 'France' },
    { prefix: '1', id: 'US', label: 'USA' },
  ]);

  function normalizeText(value = '', fallback = '') {
    return String(value || '').trim() || fallback;
  }

  function normalizeBaseUrl(value = '', fallback = DEFAULT_BASE_URL) {
    const trimmed = normalizeText(value, fallback);
    try {
      return new URL(trimmed).toString().replace(/\/+$/, '');
    } catch {
      return fallback;
    }
  }

  function normalizeMode(value = '') {
    return normalizeText(value).toLowerCase() === 'direct' ? 'direct' : DEFAULT_MODE;
  }

  function normalizeProviderId(value = '') {
    return normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  }

  function normalizeOperator(value = '') {
    const rawValue = normalizeText(value);
    const compactValue = rawValue.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!rawValue || compactValue === 'any' || compactValue === 'anyoperator') {
      return '';
    }
    return rawValue.toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  }

  function normalizeCountry(value = '') {
    const trimmed = normalizeText(value);
    if (!trimmed) {
      return '';
    }
    const lowered = trimmed.toLowerCase();
    if (lowered === 'any' || lowered === 'local') {
      return lowered;
    }
    if (/^[a-z]{2}$/i.test(trimmed)) {
      return trimmed.toUpperCase();
    }
    return lowered.replace(/[^a-z0-9_-]+/g, '');
  }

  function normalizeCountryKey(value) {
    return normalizeCountry(value);
  }

  function getRegionDisplayName(regionCode, locale = 'en') {
    const normalizedRegionCode = normalizeCountry(regionCode);
    const normalizedLocale = normalizeText(locale);
    if (!/^[A-Z]{2}$/.test(normalizedRegionCode) || !normalizedLocale || typeof Intl?.DisplayNames !== 'function') {
      return '';
    }
    try {
      return String(
        new Intl.DisplayNames([normalizedLocale], { type: 'region' }).of(normalizedRegionCode) || ''
      ).trim();
    } catch {
      return '';
    }
  }

  function normalizeCountryLabel(value = '', countryCode = '') {
    const label = normalizeText(value);
    if (label) {
      return label;
    }
    const normalizedCountryCode = normalizeCountry(countryCode);
    if (!normalizedCountryCode) {
      return '';
    }
    return getRegionDisplayName(normalizedCountryCode, 'en') || normalizedCountryCode;
  }

  function inferCountryFromPhoneNumber(phoneNumber = '') {
    const digits = String(phoneNumber || '').replace(/\D+/g, '');
    if (!digits) {
      return null;
    }
    const match = COUNTRY_BY_PHONE_PREFIX.find((entry) => digits.startsWith(entry.prefix));
    if (!match) {
      return null;
    }
    return {
      id: normalizeCountry(match.id),
      label: normalizeCountryLabel(match.label, match.id),
    };
  }

  function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
      return Boolean(fallback);
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (/^(false|0|no|off)$/i.test(normalized)) {
        return false;
      }
      if (/^(true|1|yes|on)$/i.test(normalized)) {
        return true;
      }
    }
    return Boolean(value);
  }

  function normalizePrice(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return Math.round(numeric * 10000) / 10000;
  }

  function buildHeaders(config = {}, extraHeaders = {}) {
    const headers = {
      Accept: 'application/json',
      ...extraHeaders,
    };
    const secret = normalizeText(config.httpSecret);
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }
    return headers;
  }

  function describePayload(payload) {
    if (payload && typeof payload === 'object') {
      const direct = normalizeText(payload.message || payload.error || payload.detail || payload.status);
      if (direct) {
        return direct;
      }
      try {
        return JSON.stringify(payload);
      } catch {
        return String(payload);
      }
    }
    return normalizeText(payload);
  }

  async function requestJson(config, path, options = {}) {
    const fetchImpl = config.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) {
      throw new Error('MaDao 网络请求实现不可用。');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), Number(config.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)
      : null;

    try {
      const url = new URL(path.replace(/^\/+/, ''), `${config.baseUrl.replace(/\/+$/, '')}/`);
      const method = normalizeText(options.method, 'GET').toUpperCase();
      const init = {
        method,
        headers: buildHeaders(config, options.headers || {}),
        signal: controller?.signal,
      };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
        init.headers['Content-Type'] = 'application/json';
      }
      const response = await fetchImpl(url.toString(), init);
      const rawText = await response.text();
      let payload = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = rawText;
      }
      if (!response.ok) {
        const error = new Error(`MaDao 请求失败：${describePayload(payload) || response.statusText || response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('MaDao 请求超时。');
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  function resolveConfig(state = {}, deps = {}) {
    return {
      baseUrl: normalizeBaseUrl(state?.madaoBaseUrl || DEFAULT_BASE_URL),
      httpSecret: normalizeText(state?.madaoHttpSecret),
      fetchImpl: deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
      requestTimeoutMs: deps.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  function mapAcquirePath(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'same_activation_retry') {
      return 'same_activation_retry';
    }
    if (normalized === 'exact_reuse') {
      return 'exact_reuse';
    }
    if (normalized === 'intent_reuse') {
      return 'intent_reuse';
    }
    return 'fresh_acquire';
  }

  function mapTicketStatus(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'waiting_code') {
      return 'waiting_code';
    }
    if (normalized === 'code_received') {
      return 'code_received';
    }
    if (normalized === 'finished') {
      return 'finished';
    }
    if (normalized === 'cancelled' || normalized === 'canceled') {
      return 'cancelled';
    }
    if (normalized === 'failed') {
      return 'failed';
    }
    return 'pending';
  }

  function buildAcquireRequest(state = {}, options = {}) {
    const mode = normalizeMode(options?.mode || state?.madaoMode);
    const routingPlanId = normalizeText(options?.routingPlanId || state?.madaoRoutingPlanId);
    const directProvider = normalizeProviderId(options?.providerId || state?.madaoProviderId);
    const request = {
      provider: mode === 'routing_plan' && routingPlanId ? 'auto' : (directProvider || 'auto'),
      service: normalizeText(options?.service || state?.madaoServiceName, DEFAULT_SERVICE),
    };
    const country = normalizeCountry(options?.country || state?.madaoCountry);
    const operator = normalizeOperator(options?.operator || state?.madaoOperator);
    const minPrice = normalizePrice(options?.minPrice ?? state?.madaoMinPrice);
    const maxPrice = normalizePrice(options?.maxPrice ?? state?.madaoMaxPrice);

    if (mode === 'routing_plan' && routingPlanId) {
      request.routing_plan_id = routingPlanId;
      return request;
    }

    request.auto_pick_country = normalizeBoolean(options?.autoPickCountry ?? state?.madaoAutoPickCountry, true);
    request.reuse_phone = normalizeBoolean(options?.reusePhone ?? state?.madaoReusePhone, true);
    if (country) {
      request.country = country;
    }
    if (operator) {
      request.metadata = { operator };
    }
    if (minPrice !== null) {
      request.min_price = minPrice;
    }
    if (maxPrice !== null) {
      request.max_price = maxPrice;
    }
    return request;
  }

  function normalizeActivationFromAcquire(payload = {}, fallback = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const ticketId = normalizeText(source.ticket_id || source.ticketId || source.id);
    const phoneNumber = normalizeText(source.phone_number || source.phoneNumber || source.phone);
    if (!ticketId || !phoneNumber) {
      return null;
    }
    const price = normalizePrice(source.price);
    return {
      activationId: ticketId,
      phoneNumber,
      provider: PROVIDER_ID,
      serviceCode: normalizeText(source.service || fallback.service, DEFAULT_SERVICE),
      countryId: normalizeCountry(source.country || fallback.country),
      countryLabel: normalizeText(source.country_label || source.countryLabel),
      maxUses: 1,
      successfulUses: 0,
      madaoProviderId: normalizeProviderId(source.provider || fallback.provider),
      madaoRoutingPlanId: normalizeText(source.routing_plan_id || source.routingPlanId || fallback.routing_plan_id),
      madaoRoutingPlanName: normalizeText(source.routing_plan_name || source.routingPlanName || fallback.routing_plan_name),
      madaoRoutingItemId: normalizeText(source.routing_item_id || source.routingItemId || fallback.routing_item_id),
      madaoAcquirePath: mapAcquirePath(source.acquire_path || source.acquirePath),
      madaoStatus: mapTicketStatus(source.status),
      ...(price !== null ? { madaoPrice: price } : {}),
    };
  }

  function normalizeActivation(record = {}, fallback = {}) {
    const direct = normalizeActivationFromAcquire(record, fallback);
    if (direct) {
      return direct;
    }
    const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    const ticketId = normalizeText(source.activationId || source.ticketId || source.id || fallback.activationId);
    const phoneNumber = normalizeText(source.phoneNumber || source.phone || fallback.phoneNumber);
    if (!ticketId || !phoneNumber) {
      return null;
    }
    const inferredCountry = inferCountryFromPhoneNumber(phoneNumber);
    const countryId = normalizeCountry(source.countryId ?? source.country ?? fallback.countryId ?? inferredCountry?.id);
    const price = normalizePrice(source.madaoPrice ?? source.price ?? fallback.madaoPrice ?? fallback.price);
    return {
      activationId: ticketId,
      phoneNumber,
      provider: PROVIDER_ID,
      serviceCode: normalizeText(source.serviceCode || source.service || fallback.serviceCode, DEFAULT_SERVICE),
      countryId,
      countryLabel: normalizeCountryLabel(source.countryLabel || source.country_label || fallback.countryLabel, countryId),
      maxUses: Math.max(1, Math.floor(Number(source.maxUses ?? fallback.maxUses) || 1)),
      successfulUses: Math.max(0, Math.floor(Number(source.successfulUses ?? fallback.successfulUses) || 0)),
      ...(source.source ? { source: normalizeText(source.source) } : {}),
      ...(source.phoneCodeReceived ? { phoneCodeReceived: true } : {}),
      ...(source.phoneCodeReceivedAt ? { phoneCodeReceivedAt: Math.max(0, Number(source.phoneCodeReceivedAt) || 0) } : {}),
      ...(source.madaoProviderId ? { madaoProviderId: normalizeProviderId(source.madaoProviderId) } : {}),
      ...(source.madaoRoutingPlanId ? { madaoRoutingPlanId: normalizeText(source.madaoRoutingPlanId) } : {}),
      ...(source.madaoRoutingPlanName ? { madaoRoutingPlanName: normalizeText(source.madaoRoutingPlanName) } : {}),
      ...(source.madaoRoutingItemId ? { madaoRoutingItemId: normalizeText(source.madaoRoutingItemId) } : {}),
      ...(source.madaoAcquirePath ? { madaoAcquirePath: mapAcquirePath(source.madaoAcquirePath) } : {}),
      ...(source.madaoStatus ? { madaoStatus: mapTicketStatus(source.madaoStatus) } : {}),
      ...(price !== null ? { madaoPrice: price } : {}),
    };
  }

  function resolveCountryLabel(_state = {}, countryId = '') {
    return normalizeCountryLabel('', countryId);
  }

  function resolveActivationCountry(activation = {}) {
    const normalizedActivation = normalizeActivation(activation)
      || (activation && typeof activation === 'object' ? activation : {});
    const inferredCountry = inferCountryFromPhoneNumber(normalizedActivation.phoneNumber);
    const countryId = normalizeCountry(normalizedActivation.countryId ?? normalizedActivation.country ?? inferredCountry?.id);
    return {
      id: countryId,
      label: normalizeCountryLabel(normalizedActivation.countryLabel || inferredCountry?.label, countryId),
    };
  }

  function getActivationCountryKey(activation = {}) {
    const normalizedActivation = normalizeActivation(activation)
      || (activation && typeof activation === 'object' ? activation : {});
    const inferredCountry = inferCountryFromPhoneNumber(normalizedActivation.phoneNumber);
    return normalizeCountryKey(normalizedActivation.countryId ?? normalizedActivation.country ?? inferredCountry?.id);
  }

  function getActivationPrice(activation = {}) {
    return normalizePrice(activation?.madaoPrice ?? activation?.selectedPrice ?? activation?.price ?? activation?.maxPrice);
  }

  function extractVerificationCode(value = '') {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }
    return text.match(/\b(\d{4,8})\b/)?.[1] || '';
  }

  function extractCodeFromPollPayload(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return extractVerificationCode(payload);
    }
    const candidates = [
      payload.code,
      payload.sms_code,
      payload.smsCode,
      payload.text,
      payload.message,
      payload.data?.code,
      payload.data?.text,
      payload.data?.message,
    ];
    for (const candidate of candidates) {
      const code = extractVerificationCode(candidate);
      if (code) {
        return code;
      }
    }
    const messages = Array.isArray(payload.messages)
      ? payload.messages
      : (Array.isArray(payload.sms) ? payload.sms : []);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index] || {};
      const code = extractVerificationCode(item.code || item.text || item.message || item.body);
      if (code) {
        return code;
      }
    }
    return '';
  }

  async function acquireActivation(state = {}, options = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    const requestBody = buildAcquireRequest(state, options);
    const payload = await requestJson(config, '/api/acquire', {
      method: 'POST',
      body: requestBody,
    });
    const activation = normalizeActivationFromAcquire(payload, requestBody);
    if (!activation) {
      throw new Error('MaDao 返回的激活记录无效。');
    }
    return activation;
  }

  async function pollActivation(state = {}, activation, deps = {}) {
    const config = resolveConfig(state, deps);
    const ticketId = normalizeText(activation?.activationId || activation?.ticketId);
    if (!ticketId) {
      throw new Error('MaDao 激活记录缺少 ticket_id。');
    }
    return requestJson(config, '/api/poll', {
      method: 'POST',
      body: {
        ticket_id: ticketId,
      },
    });
  }

  function isTransientPollNetworkError(error) {
    if (error?.status) {
      return false;
    }
    const name = normalizeText(error?.name);
    const message = normalizeText(error?.message || error);
    return /^(?:TypeError|AbortError)$/i.test(name)
      || /Failed to fetch|NetworkError|Load failed|fetch failed|ERR_(?:CONNECTION|NETWORK|TIMED_OUT)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|request timeout|timed?\s*out|aborted|\u8bf7\u6c42\u8d85\u65f6/i.test(message);
  }

  async function pollActivationCode(state = {}, activation, options = {}, deps = {}) {
    const configuredTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.max(1000, configuredTimeoutMs)
      : 0;
    if (!timeoutMs) {
      const payload = await pollActivation(state, activation, deps);
      const code = extractCodeFromPollPayload(payload);
      if (code) {
        return code;
      }
      if (typeof options.onStatus === 'function') {
        await options.onStatus({
          activation,
          statusText: describePayload(payload) || 'PENDING',
        });
      }
      return '';
    }

    const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
    const maxRoundsRaw = Math.floor(Number(options.maxRounds));
    const maxRounds = Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0 ? maxRoundsRaw : 0;
    const start = Date.now();
    let pollCount = 0;
    let lastResponse = '';
    while (Date.now() - start < timeoutMs) {
      if (maxRounds > 0 && pollCount >= maxRounds) {
        break;
      }
      deps.throwIfStopped?.();
      let payload = null;
      try {
        payload = await pollActivation(state, activation, deps);
      } catch (error) {
        if (!isTransientPollNetworkError(error)) {
          throw error;
        }
        pollCount += 1;
        const statusText = `network_error: ${normalizeText(error?.message || error, 'request failed')}`;
        lastResponse = statusText;
        if (typeof options.onStatus === 'function') {
          await options.onStatus({
            activation,
            elapsedMs: Date.now() - start,
            pollCount,
            statusText,
            timeoutMs,
          });
        }
        if (typeof options.onWaitingForCode === 'function') {
          await options.onWaitingForCode({
            activation,
            elapsedMs: Date.now() - start,
            pollCount,
            statusText,
            timeoutMs,
          });
        }
        await deps.sleepWithStop?.(intervalMs);
        continue;
      }
      const code = extractCodeFromPollPayload(payload);
      const statusText = normalizeText(
        payload?.status
        || payload?.madaoStatus
        || payload?.message
        || payload?.text
        || describePayload(payload),
        'PENDING'
      );
      lastResponse = statusText;
      pollCount += 1;
      if (typeof options.onStatus === 'function') {
        await options.onStatus({
          activation,
          elapsedMs: Date.now() - start,
          pollCount,
          statusText,
          timeoutMs,
        });
      }
      if (code) {
        return code;
      }
      if (/^(cancelled|canceled|failed|expired|timeout)$/i.test(statusText)) {
        throw new Error(`MaDao 订单在收到短信前已结束：${statusText}`);
      }
      if (typeof options.onWaitingForCode === 'function') {
        await options.onWaitingForCode({
          activation,
          elapsedMs: Date.now() - start,
          pollCount,
          statusText,
          timeoutMs,
        });
      }
      await deps.sleepWithStop?.(intervalMs);
    }
    throw new Error(`${PHONE_CODE_TIMEOUT_ERROR_PREFIX}等待手机验证码超时。${lastResponse ? ` MaDao 最后状态：${lastResponse}` : ''}`);
  }

  async function releaseActivation(state = {}, activation, action = 'cancel', deps = {}) {
    const config = resolveConfig(state, deps);
    const ticketId = normalizeText(activation?.activationId || activation?.ticketId);
    if (!ticketId) {
      throw new Error('MaDao 激活记录缺少 ticket_id。');
    }
    return requestJson(config, '/api/release', {
      method: 'POST',
      body: {
        ticket_id: ticketId,
        action: normalizeText(action, 'cancel').toLowerCase(),
      },
    });
  }

  async function replaceRoutingActivation(state = {}, activation, options = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    const ticketId = normalizeText(activation?.activationId || activation?.ticketId);
    if (!ticketId) {
      throw new Error('MaDao 激活记录缺少 ticket_id。');
    }
    const releaseAction = normalizeText(options?.releaseAction, 'cancel').toLowerCase() === 'ban'
      ? 'ban'
      : 'cancel';
    const payload = await requestJson(config, '/api/routing/replace', {
      method: 'POST',
      body: {
        ticket_id: ticketId,
        release_action: releaseAction,
        failed_item_id: normalizeText(options?.failedItemId || activation?.madaoRoutingItemId),
        reason: normalizeText(options?.reason),
      },
    });
    const nextTicket = normalizeActivationFromAcquire(payload?.next_ticket || payload?.nextTicket, {
      routing_plan_id: activation?.madaoRoutingPlanId,
      routing_plan_name: activation?.madaoRoutingPlanName,
      service: activation?.serviceCode,
    });
    if (!nextTicket) {
      throw new Error('MaDao 返回的下一条路由激活记录无效。');
    }
    return {
      currentTicketId: normalizeText(payload?.current_ticket_id || payload?.currentTicketId, ticketId),
      currentTicketRelease: payload?.current_ticket_release || payload?.currentTicketRelease || null,
      nextActivation: nextTicket,
    };
  }

  async function rotateActivation(state = {}, activation, options = {}, deps = {}) {
    const mode = normalizeMode(state?.madaoMode);
    const normalizedActivation = activation && typeof activation === 'object' ? activation : null;
    const releaseAction = normalizeText(options?.releaseAction, 'cancel').toLowerCase() === 'ban'
      ? 'ban'
      : 'cancel';
    if (mode === 'routing_plan' && normalizeText(normalizedActivation?.madaoRoutingPlanId)) {
      return replaceRoutingActivation(state, normalizedActivation, {
        releaseAction,
        failedItemId: options?.failedItemId || normalizedActivation?.madaoRoutingItemId,
        reason: options?.reason,
      }, deps);
    }
    const currentTicketRelease = await releaseActivation(state, normalizedActivation, releaseAction, deps);
    return {
      currentTicketId: normalizeText(normalizedActivation?.activationId || normalizedActivation?.ticketId),
      currentTicketRelease,
      nextActivation: null,
    };
  }

  async function finishActivation(state = {}, activation, deps = {}) {
    return releaseActivation(state, activation, 'finish', deps);
  }

  async function cancelActivation(state = {}, activation, deps = {}) {
    return releaseActivation(state, activation, 'cancel', deps);
  }

  async function banActivation(state = {}, activation, deps = {}) {
    return releaseActivation(state, activation, 'ban', deps);
  }

  async function reuseActivation(_state = {}, activation) {
    return activation && typeof activation === 'object' ? { ...activation } : activation;
  }

  async function requestAdditionalSms() {
    return '';
  }

  function resolveCountryCandidates() {
    return [];
  }

  function createProvider(deps = {}) {
    const capabilities = Object.freeze({
      supportsReusableActivation: false,
      supportsAutomaticFreeReuse: false,
      supportsFreeReusePreservation: false,
      supportsPageResend: false,
      supportsPageResendProbe: false,
      supportsRouteReplace: true,
      requiresCountrySelection: false,
    });
    return {
      id: PROVIDER_ID,
      label: 'MaDao',
      capabilities,
      defaultProduct: DEFAULT_SERVICE,
      normalizeCountryId: normalizeCountry,
      normalizeCountryLabel,
      normalizeCountryKey,
      normalizeActivation,
      resolveCountryLabel,
      resolveActivationCountry,
      getActivationCountryKey,
      getActivationPrice,
      requestActivation: (state, options = {}, runtimeDeps = {}) => acquireActivation(state, options, {
        ...deps,
        ...runtimeDeps,
      }),
      acquireActivation: (state, options = {}, runtimeDeps = {}) => acquireActivation(state, options, {
        ...deps,
        ...runtimeDeps,
      }),
      reuseActivation,
      pollActivation: (state, activation, runtimeDeps = {}) => pollActivation(state, activation, {
        ...deps,
        ...runtimeDeps,
      }),
      pollActivationCode: (state, activation, options = {}, runtimeDeps = {}) => pollActivationCode(state, activation, options, {
        ...deps,
        ...runtimeDeps,
      }),
      releaseActivation: (state, activation, action = 'cancel', runtimeDeps = {}) => releaseActivation(state, activation, action, {
        ...deps,
        ...runtimeDeps,
      }),
      finishActivation: (state, activation, runtimeDeps = {}) => finishActivation(state, activation, {
        ...deps,
        ...runtimeDeps,
      }),
      cancelActivation: (state, activation, runtimeDeps = {}) => cancelActivation(state, activation, {
        ...deps,
        ...runtimeDeps,
      }),
      banActivation: (state, activation, runtimeDeps = {}) => banActivation(state, activation, {
        ...deps,
        ...runtimeDeps,
      }),
      requestAdditionalSms,
      rotateActivation: (state, activation, options = {}, runtimeDeps = {}) => rotateActivation(state, activation, options, {
        ...deps,
        ...runtimeDeps,
      }),
      prepareActivationForReuse: async () => ({
        ok: false,
        reason: 'prepare_unsupported',
        message: 'MaDao 不支持自动白嫖复用准备。',
      }),
      canPersistReusableActivation: () => false,
      canPreserveActivationForFreeReuse: () => false,
      shouldUsePageResend: () => false,
      shouldProbePageResend: () => false,
      replaceRoutingActivation: (state, activation, options = {}, runtimeDeps = {}) => replaceRoutingActivation(state, activation, options, {
        ...deps,
        ...runtimeDeps,
      }),
      buildAcquireRequest,
      extractCodeFromPollPayload,
      mapAcquirePath,
      mapTicketStatus,
      normalizeActivation,
      normalizeActivationFromAcquire,
      resolveCountryCandidates,
      resolveConfig: (state = {}, runtimeDeps = {}) => resolveConfig(state, {
        ...deps,
        ...runtimeDeps,
      }),
    };
  }

  return {
    PROVIDER_ID,
    DEFAULT_BASE_URL,
    DEFAULT_MODE,
    DEFAULT_SERVICE,
    acquireActivation,
    buildAcquireRequest,
    createProvider,
    extractCodeFromPollPayload,
    mapAcquirePath,
    mapTicketStatus,
    normalizeActivation,
    normalizeActivationFromAcquire,
    normalizeCountry,
    normalizeCountryKey,
    normalizeCountryLabel,
    normalizeOperator,
    resolveActivationCountry,
    pollActivation,
    pollActivationCode,
    releaseActivation,
    finishActivation,
    cancelActivation,
    banActivation,
    replaceRoutingActivation,
    requestAdditionalSms,
    resolveConfig,
    resolveCountryCandidates,
    rotateActivation,
  };
});
