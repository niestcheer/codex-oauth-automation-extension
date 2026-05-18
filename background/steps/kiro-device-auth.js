(function attachBackgroundKiroDeviceAuth(root, factory) {
  root.MultiPageBackgroundKiroDeviceAuth = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundKiroDeviceAuthModule() {
  const DEFAULT_REGION = 'us-east-1';
  const DEVICE_LOGIN_START_URL = 'https://view.awsapps.com/start';
  const DEFAULT_SCOPES = Object.freeze([
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist',
  ]);

  const MAIL_2925_FILTER_LOOKBACK_MS = 10 * 60 * 1000;
  const KIRO_AWS_VERIFICATION_CODE_PATTERNS = Object.freeze([
    Object.freeze({
      source: '(?:verification\\s*code|验证码|Your code is|code is)[：:\\s]*(\\d{6})',
      flags: 'gi',
    }),
    Object.freeze({
      source: '^\\s*(\\d{6})\\s*$',
      flags: 'gm',
    }),
    Object.freeze({
      source: '>\\s*(\\d{6})\\s*<',
      flags: 'g',
    }),
  ]);
  const KIRO_AWS_SENDER_FILTERS = Object.freeze([
    'no-reply@signin.aws',
    'no-reply@login.awsapps.com',
    'noreply@amazon.com',
    'account-update@amazon.com',
    'no-reply@aws.amazon.com',
    'noreply@aws.amazon.com',
    'aws',
  ]);
  const KIRO_AWS_SUBJECT_FILTERS = Object.freeze([
    'aws builder id',
    'verification',
    '验证码',
    'code',
    'aws',
  ]);
  const KIRO_AWS_REQUIRED_KEYWORDS = Object.freeze([
    'verification',
    '验证码',
    'code',
    'aws',
  ]);

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function normalizeRegion(value = '', fallback = DEFAULT_REGION) {
    return cleanString(value) || fallback;
  }

  function buildOidcBaseUrl(region = DEFAULT_REGION) {
    return `https://oidc.${normalizeRegion(region)}.amazonaws.com`;
  }

  function normalizeKiroRsBaseUrl(value = '') {
    const normalized = cleanString(value).replace(/\/+$/, '');
    if (!normalized) {
      throw new Error('缺少 kiro.rs 管理后台地址。');
    }
    return normalized.endsWith('/admin')
      ? normalized.slice(0, -'/admin'.length)
      : normalized;
  }

  async function readResponse(response) {
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }
    return { text, json };
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error ?? '未知错误');
  }

  function normalizeKiroUploadMessage(value = '') {
    const rawValue = cleanString(value);
    if (!rawValue) {
      return '上传成功';
    }

    const normalizedValue = rawValue.toLowerCase();
    if (normalizedValue === 'uploaded' || normalizedValue === 'credential uploaded.') {
      return '上传成功';
    }
    return rawValue;
  }

  function normalizePositiveInteger(value, fallback) {
    const numeric = Math.floor(Number(value));
    if (Number.isInteger(numeric) && numeric > 0) {
      return numeric;
    }
    return fallback;
  }

  function buildCredentialUploadOptions(state = {}) {
    const next = {
      priority: Math.max(0, Math.floor(Number(state?.kiroRsPriority) || 0)),
      authMethod: 'IdC',
      provider: 'BuilderId',
    };

    const endpoint = cleanString(state?.kiroRsEndpoint);
    const authRegion = cleanString(state?.kiroRsAuthRegion);
    const apiRegion = cleanString(state?.kiroRsApiRegion);
    if (endpoint) {
      next.endpoint = endpoint;
    }
    if (authRegion) {
      next.authRegion = authRegion;
    }
    if (apiRegion) {
      next.apiRegion = apiRegion;
    }

    if (state?.ipProxyEnabled) {
      const proxyUrl = cleanString(state?.ipProxyApiUrl)
        || (() => {
          const host = cleanString(state?.ipProxyHost);
          const port = cleanString(state?.ipProxyPort);
          if (!host || !port) {
            return '';
          }
          const protocol = cleanString(state?.ipProxyProtocol) || 'http';
          return `${protocol}://${host}:${port}`;
        })();
      if (proxyUrl) {
        next.proxyUrl = proxyUrl;
      }
      const proxyUsername = cleanString(state?.ipProxyUsername);
      const proxyPassword = String(state?.ipProxyPassword || '');
      if (proxyUsername) {
        next.proxyUsername = proxyUsername;
      }
      if (proxyPassword) {
        next.proxyPassword = proxyPassword;
      }
    }

    return next;
  }

  async function startBuilderIdDeviceLogin(region, fetchImpl) {
    const normalizedRegion = normalizeRegion(region);
    const oidcBaseUrl = buildOidcBaseUrl(normalizedRegion);
    const registerResponse = await fetchImpl(`${oidcBaseUrl}/client/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientName: 'Codex Registration Extension',
        clientType: 'public',
        scopes: DEFAULT_SCOPES,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: DEVICE_LOGIN_START_URL,
      }),
    });
    const registerBody = await readResponse(registerResponse);
    if (!registerResponse.ok) {
      throw new Error(`Builder ID 客户端注册失败：${cleanString(registerBody.text || registerResponse.statusText) || registerResponse.status}`);
    }

    const clientId = cleanString(registerBody.json?.clientId);
    const clientSecret = String(registerBody.json?.clientSecret || '');
    if (!clientId || !clientSecret) {
      throw new Error('Builder ID 客户端注册响应缺少凭据。');
    }

    const authorizationResponse = await fetchImpl(`${oidcBaseUrl}/device_authorization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl: DEVICE_LOGIN_START_URL,
      }),
    });
    const authorizationBody = await readResponse(authorizationResponse);
    if (!authorizationResponse.ok) {
      throw new Error(`Builder ID 设备授权失败：${cleanString(authorizationBody.text || authorizationResponse.statusText) || authorizationResponse.status}`);
    }

    const deviceCode = String(authorizationBody.json?.deviceCode || '');
    const userCode = cleanString(authorizationBody.json?.userCode);
    const verificationUri = cleanString(authorizationBody.json?.verificationUri);
    const verificationUriComplete = cleanString(
      authorizationBody.json?.verificationUriComplete || verificationUri
    );
    const interval = normalizePositiveInteger(authorizationBody.json?.interval, 5);
    const expiresIn = normalizePositiveInteger(authorizationBody.json?.expiresIn, 600);
    if (!deviceCode || !userCode || !verificationUriComplete) {
      throw new Error('Builder ID 设备授权响应缺少必要字段。');
    }

    return {
      clientId,
      clientSecret,
      deviceCode,
      expiresAt: Date.now() + expiresIn * 1000,
      expiresIn,
      interval,
      region: normalizedRegion,
      userCode,
      verificationUri,
      verificationUriComplete,
    };
  }

  async function pollBuilderIdDeviceAuth(params = {}, fetchImpl) {
    const oidcBaseUrl = buildOidcBaseUrl(params.region);
    const response = await fetchImpl(`${oidcBaseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        deviceCode: params.deviceCode,
      }),
    });
    const body = await readResponse(response);
    if (response.status === 200) {
      return {
        completed: true,
        accessToken: String(body.json?.accessToken || ''),
        refreshToken: String(body.json?.refreshToken || ''),
        expiresIn: normalizePositiveInteger(body.json?.expiresIn, 3600),
        region: normalizeRegion(params.region),
      };
    }
    if (response.status === 400) {
      const errorCode = cleanString(body.json?.error);
      if (errorCode === 'authorization_pending') {
        return { completed: false, status: 'pending' };
      }
      if (errorCode === 'slow_down') {
        return { completed: false, status: 'slow_down' };
      }
      if (errorCode === 'expired_token') {
        throw new Error('Kiro 设备登录已过期。');
      }
      if (errorCode === 'access_denied') {
        throw new Error('用户拒绝了 Builder ID 设备登录授权请求。');
      }
      throw new Error(`Builder ID 授权失败：${errorCode || cleanString(body.text || response.statusText) || response.status}`);
    }
    throw new Error(`Builder ID 令牌请求失败：HTTP ${response.status}`);
  }

  async function checkKiroRsConnection(baseUrl, apiKey, fetchImpl) {
    const normalizedBaseUrl = normalizeKiroRsBaseUrl(baseUrl);
    const response = await fetchImpl(`${normalizedBaseUrl}/api/admin/credentials`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': String(apiKey || ''),
      },
    });
    const body = await readResponse(response);
    if (response.ok) {
      return {
        ok: true,
        message: `kiro.rs 连接正常（HTTP ${response.status}）`,
      };
    }
    if (response.status === 405) {
      return {
        ok: true,
        message: 'kiro.rs 上传接口可访问。',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `kiro.rs API Key 被拒绝（HTTP ${response.status}）`,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        message: '未找到 kiro.rs 管理接口。',
      };
    }
    return {
      ok: false,
      message: cleanString(body.json?.error?.message || body.json?.message || body.text || response.statusText)
        || `kiro.rs 连接失败（HTTP ${response.status}）`,
    };
  }

  async function uploadBuilderIdCredential(baseUrl, apiKey, payload, fetchImpl) {
    const normalizedBaseUrl = normalizeKiroRsBaseUrl(baseUrl);
    const response = await fetchImpl(`${normalizedBaseUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': String(apiKey || ''),
      },
      body: JSON.stringify(payload),
    });
    const body = await readResponse(response);
    if (!response.ok) {
      const message = cleanString(body.json?.error?.message || body.json?.message || body.text || response.statusText)
        || `HTTP ${response.status}`;
      throw new Error(`kiro.rs 凭据上传失败：${message}`);
    }

    return {
      credentialId: Number(body.json?.credentialId || body.json?.credential_id || 0) || null,
      email: cleanString(body.json?.email),
      message: normalizeKiroUploadMessage(body.json?.message),
      raw: body.json,
    };
  }

  function createKiroDeviceAuthExecutor(deps = {}) {
    const {
      addLog = async () => {},
      chrome = (typeof globalThis !== 'undefined' ? globalThis.chrome : null),
      completeNodeFromBackground,
      ensureContentScriptReadyOnTab = null,
      ensureIcloudMailSession = null,
      ensureMail2925MailboxSession = null,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      generatePassword = null,
      generateRandomName = null,
      getMailConfig = null,
      getState = async () => ({}),
      getTabId = async () => null,
      HOTMAIL_PROVIDER = 'hotmail-api',
      LUCKMAIL_PROVIDER = 'luckmail-api',
      CLOUDFLARE_TEMP_EMAIL_PROVIDER = 'cloudflare-temp-email',
      CLOUD_MAIL_PROVIDER = 'cloudmail',
      YYDS_MAIL_PROVIDER = 'yyds-mail',
      MAIL_2925_VERIFICATION_INTERVAL_MS = 15000,
      MAIL_2925_VERIFICATION_MAX_ATTEMPTS = 15,
      isTabAlive = async () => false,
      KIRO_DEVICE_AUTH_INJECT_FILES = null,
      pollCloudflareTempEmailVerificationCode = null,
      pollCloudMailVerificationCode = null,
      pollHotmailVerificationCode = null,
      pollLuckmailVerificationCode = null,
      pollYydsMailVerificationCode = null,
      registerTab = async () => {},
      resolveSignupEmailForFlow = null,
      reuseOrCreateTab = async () => null,
      sendToContentScriptResilient = null,
      sendToMailContentScriptResilient = null,
      setPasswordState = async () => {},
      setState = async () => {},
      sleepWithStop = async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      throwIfStopped = () => {},
      waitForTabStableComplete = null,
    } = deps;

    if (typeof completeNodeFromBackground !== 'function') {
      throw new Error('Kiro device auth executor requires completeNodeFromBackground.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Kiro device auth executor requires fetch support.');
    }

    async function log(message, level = 'info', nodeId = '') {
      await addLog(message, level, nodeId ? { nodeId } : {});
    }

    async function activateTab(tabId) {
      if (!Number.isInteger(tabId) || !chrome?.tabs?.update) {
        return;
      }
      await chrome.tabs.update(tabId, { active: true });
    }

    async function getExecutionState(state = {}) {
      if (state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length) {
        return state;
      }
      return getState();
    }

    async function persistFailure(updates = {}) {
      if (updates && Object.keys(updates).length) {
        await setState(updates);
      }
    }

    async function ensureKiroAuthTab(state = {}, options = {}) {
      let tabId = Number.isInteger(state?.kiroAuthTabId)
        ? state.kiroAuthTabId
        : await getTabId('kiro-device-auth');
      const loginUrl = cleanString(state?.kiroLoginUrl || state?.kiroVerificationUriComplete || state?.kiroVerificationUri);

      if (Number.isInteger(tabId) && await isTabAlive('kiro-device-auth')) {
        return tabId;
      }

      if (!loginUrl) {
        throw new Error(options.missingUrlMessage || '缺少 Kiro 授权页地址，请先执行步骤 1。');
      }

      tabId = await reuseOrCreateTab('kiro-device-auth', loginUrl);
      if (!Number.isInteger(tabId)) {
        throw new Error(options.openFailedMessage || '无法打开 Kiro 授权页，请重试步骤 1。');
      }
      await registerTab('kiro-device-auth', tabId);
      await setState({ kiroAuthTabId: tabId });
      return tabId;
    }

    async function activateKiroAuthTab(state = {}, options = {}) {
      const tabId = await ensureKiroAuthTab(state, options);
      await activateTab(tabId);
      return tabId;
    }

    async function ensureKiroPageState(tabId, options = {}) {
      if (!Number.isInteger(tabId)) {
        throw new Error('缺少 Kiro 授权页标签页，无法继续执行。');
      }
      if (typeof waitForTabStableComplete === 'function') {
        await waitForTabStableComplete(tabId, {
          timeoutMs: 45000,
          retryDelayMs: 300,
          stableMs: Number(options.stableMs) || 1500,
          initialDelayMs: Number(options.initialDelayMs) || 150,
        });
      }
      if (typeof ensureContentScriptReadyOnTab === 'function') {
        await ensureContentScriptReadyOnTab('kiro-device-auth', tabId, {
          inject: Array.isArray(KIRO_DEVICE_AUTH_INJECT_FILES) ? KIRO_DEVICE_AUTH_INJECT_FILES : null,
          injectSource: 'kiro-device-auth',
          timeoutMs: 45000,
          retryDelayMs: 800,
          logMessage: options.injectLogMessage || 'Kiro 授权页内容脚本未就绪，正在等待页面恢复...',
        });
      }
      if (typeof sendToContentScriptResilient !== 'function') {
        return {
          state: Array.isArray(options.targetStates) ? options.targetStates[0] || '' : '',
          url: '',
        };
      }
      const result = await sendToContentScriptResilient('kiro-device-auth', {
        type: 'ENSURE_KIRO_PAGE_STATE',
        step: options.step || 0,
        source: 'background',
        payload: {
          targetStates: Array.isArray(options.targetStates) ? options.targetStates : [],
          timeoutMs: Number(options.pageTimeoutMs) || 30000,
          retryDelayMs: Number(options.pageRetryDelayMs) || 250,
          timeoutMessage: options.timeoutMessage || '',
        },
      }, {
        timeoutMs: Math.max(30000, Number(options.pageTimeoutMs) || 30000),
        retryDelayMs: 700,
        logMessage: options.readyLogMessage || '正在等待 Kiro 页面进入下一状态...',
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || { state: '', url: '' };
    }

    async function waitForKiroPageChange(tabId, options = {}) {
      if (!Number.isInteger(tabId)) {
        throw new Error('缺少 Kiro 授权页标签页，无法继续执行。');
      }
      if (typeof waitForTabStableComplete === 'function') {
        await waitForTabStableComplete(tabId, {
          timeoutMs: 45000,
          retryDelayMs: 300,
          stableMs: Number(options.stableMs) || 1200,
          initialDelayMs: Number(options.initialDelayMs) || 120,
        });
      }
      if (typeof ensureContentScriptReadyOnTab === 'function') {
        await ensureContentScriptReadyOnTab('kiro-device-auth', tabId, {
          inject: Array.isArray(KIRO_DEVICE_AUTH_INJECT_FILES) ? KIRO_DEVICE_AUTH_INJECT_FILES : null,
          injectSource: 'kiro-device-auth',
          timeoutMs: 45000,
          retryDelayMs: 800,
          logMessage: options.injectLogMessage || 'Kiro 授权页切换中，正在等待页面恢复...',
        });
      }
      if (typeof sendToContentScriptResilient !== 'function') {
        return { state: '', url: '' };
      }
      const result = await sendToContentScriptResilient('kiro-device-auth', {
        type: 'ENSURE_KIRO_STATE_CHANGE',
        step: options.step || 0,
        source: 'background',
        payload: {
          fromStates: Array.isArray(options.fromStates) ? options.fromStates : [],
          timeoutMs: Number(options.pageTimeoutMs) || 30000,
          retryDelayMs: Number(options.pageRetryDelayMs) || 250,
          timeoutMessage: options.timeoutMessage || '',
        },
      }, {
        timeoutMs: Math.max(30000, Number(options.pageTimeoutMs) || 30000),
        retryDelayMs: 700,
        logMessage: options.readyLogMessage || '正在等待 Kiro 页面完成跳转...',
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || { state: '', url: '' };
    }

    function resolveKiroFullName(state = {}) {
      const cachedName = cleanString(state?.kiroFullName);
      if (cachedName) {
        return cachedName;
      }
      if (typeof generateRandomName !== 'function') {
        throw new Error('Kiro 姓名步骤缺少随机姓名能力，无法继续执行。');
      }
      const generated = generateRandomName();
      if (typeof generated === 'string') {
        const normalized = cleanString(generated);
        if (normalized) {
          return normalized;
        }
      }
      const firstName = cleanString(generated?.firstName);
      const lastName = cleanString(generated?.lastName);
      const fullName = cleanString(`${firstName} ${lastName}`);
      if (!fullName) {
        throw new Error('Kiro 姓名步骤未生成有效姓名。');
      }
      return fullName;
    }

    function resolveKiroPassword(state = {}) {
      const existingPassword = String(state?.customPassword || state?.password || '');
      if (existingPassword) {
        return {
          password: existingPassword,
          mode: state?.customPassword ? 'custom' : 'reused',
        };
      }
      if (typeof generatePassword !== 'function') {
        throw new Error('Kiro 密码步骤缺少公共密码生成能力，无法继续执行。');
      }
      return {
        password: String(generatePassword() || ''),
        mode: 'generated',
      };
    }

    function getExpectedMail2925MailboxEmail(state = {}) {
      if (Boolean(state?.mail2925UseAccountPool)) {
        const currentAccountId = String(state?.currentMail2925AccountId || '').trim();
        const accounts = Array.isArray(state?.mail2925Accounts) ? state.mail2925Accounts : [];
        const currentAccount = accounts.find((account) => String(account?.id || '') === currentAccountId) || null;
        const accountEmail = String(currentAccount?.email || '').trim().toLowerCase();
        if (accountEmail) {
          return accountEmail;
        }
      }

      return String(state?.mail2925BaseEmail || '').trim().toLowerCase();
    }

    async function focusOrOpenMailTab(mail) {
      if (!mail?.source) {
        return;
      }
      const alive = await isTabAlive(mail.source);
      if (alive) {
        if (mail.navigateOnReuse) {
          await reuseOrCreateTab(mail.source, mail.url, {
            inject: mail.inject,
            injectSource: mail.injectSource,
          });
          return;
        }

        const tabId = await getTabId(mail.source);
        if (Number.isInteger(tabId)) {
          await activateTab(tabId);
        }
        return;
      }

      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    }

    function buildKiroVerificationPollPayload(step, state = {}, mail = {}, filterAfterTimestamp = 0) {
      const targetEmail = cleanString(state?.kiroAuthorizedEmail || state?.email).toLowerCase();
      const targetEmailHints = targetEmail ? [targetEmail] : [];
      const isMail2925Provider = String(mail?.provider || '').trim().toLowerCase() === '2925';
      const normalizedProvider = String(mail?.provider || '').trim().toLowerCase();
      const maxAttempts = normalizedProvider === String(LUCKMAIL_PROVIDER || '').trim().toLowerCase()
        ? 3
        : (isMail2925Provider ? MAIL_2925_VERIFICATION_MAX_ATTEMPTS : 5);
      const intervalMs = normalizedProvider === String(LUCKMAIL_PROVIDER || '').trim().toLowerCase()
        ? 15000
        : (isMail2925Provider ? MAIL_2925_VERIFICATION_INTERVAL_MS : 3000);

      return {
        flowId: 'kiro',
        step,
        targetEmail,
        targetEmailHints,
        filterAfterTimestamp,
        senderFilters: [...KIRO_AWS_SENDER_FILTERS],
        subjectFilters: [...KIRO_AWS_SUBJECT_FILTERS],
        requiredKeywords: [...KIRO_AWS_REQUIRED_KEYWORDS],
        codePatterns: [...KIRO_AWS_VERIFICATION_CODE_PATTERNS],
        mail2925MatchTargetEmail: isMail2925Provider
          && String(state?.mail2925Mode || '').trim().toLowerCase() === 'receive',
        maxAttempts,
        intervalMs,
      };
    }

    function getMailPollingResponseTimeoutMs(payload = {}) {
      const maxAttempts = Math.max(1, Math.floor(Number(payload?.maxAttempts) || 1));
      const intervalMs = Math.max(1, Number(payload?.intervalMs) || 3000);
      return Math.max(45000, maxAttempts * intervalMs + 25000);
    }

    async function pollKiroVerificationCode(step, state = {}, nodeId = '') {
      if (typeof getMailConfig !== 'function') {
        throw new Error('Kiro 验证码步骤缺少邮箱配置能力，无法继续执行。');
      }
      const mail = getMailConfig(state);
      if (mail?.error) {
        throw new Error(mail.error);
      }

      const requestedAt = Math.max(0, Number(state?.kiroVerificationRequestedAt) || Date.now());
      const filterAfterTimestamp = mail.provider === '2925'
        ? Math.max(0, requestedAt - MAIL_2925_FILTER_LOOKBACK_MS)
        : requestedAt;
      const pollPayload = buildKiroVerificationPollPayload(step, state, mail, filterAfterTimestamp);

      if (mail.source === 'icloud-mail' && typeof ensureIcloudMailSession === 'function') {
        await log(`步骤 ${step}：正在确认 ${mail.label || 'iCloud 邮箱'} 登录状态...`, 'info', nodeId);
        await ensureIcloudMailSession({
          state,
          step,
          actionLabel: `步骤 ${step}：确认 iCloud 邮箱登录状态`,
        });
      }

      throwIfStopped();
      if (mail.provider === HOTMAIL_PROVIDER) {
        await log(`步骤 ${step}：正在通过 ${mail.label || 'Hotmail'} 轮询验证码...`, 'info', nodeId);
        return pollHotmailVerificationCode(step, state, pollPayload);
      }
      if (mail.provider === LUCKMAIL_PROVIDER) {
        await log(`步骤 ${step}：正在通过 ${mail.label || 'LuckMail'} 轮询验证码...`, 'info', nodeId);
        return pollLuckmailVerificationCode(step, state, pollPayload);
      }
      if (mail.provider === CLOUDFLARE_TEMP_EMAIL_PROVIDER) {
        await log(`步骤 ${step}：正在通过 ${mail.label || 'Cloudflare Temp Email'} 轮询验证码...`, 'info', nodeId);
        return pollCloudflareTempEmailVerificationCode(step, state, pollPayload);
      }
      if (mail.provider === CLOUD_MAIL_PROVIDER) {
        await log(`步骤 ${step}：正在通过 ${mail.label || 'Cloud Mail'} 轮询验证码...`, 'info', nodeId);
        return pollCloudMailVerificationCode(step, state, pollPayload);
      }
      if (mail.provider === YYDS_MAIL_PROVIDER) {
        await log(`步骤 ${step}：正在通过 ${mail.label || 'YYDS Mail'} 轮询验证码...`, 'info', nodeId);
        return pollYydsMailVerificationCode(step, state, pollPayload);
      }

      if (mail.provider === '2925' && typeof ensureMail2925MailboxSession === 'function') {
        await log(`步骤 ${step}：正在确认 ${mail.label || '2925 邮箱'} 登录状态...`, 'info', nodeId);
        await ensureMail2925MailboxSession({
          accountId: state.currentMail2925AccountId || null,
          forceRelogin: false,
          allowLoginWhenOnLoginPage: Boolean(state?.mail2925UseAccountPool),
          expectedMailboxEmail: getExpectedMail2925MailboxEmail(state),
          actionLabel: `步骤 ${step}：确认 2925 邮箱登录状态`,
        });
      } else {
        await log(`步骤 ${step}：正在打开 ${mail.label || '邮箱'}...`, 'info', nodeId);
        await focusOrOpenMailTab(mail);
      }

      if (typeof sendToMailContentScriptResilient !== 'function') {
        throw new Error('Kiro 验证码步骤缺少邮箱内容脚本通信能力，无法继续执行。');
      }

      const responseTimeoutMs = getMailPollingResponseTimeoutMs(pollPayload);
      const result = await sendToMailContentScriptResilient(
        mail,
        {
          type: 'POLL_EMAIL',
          step,
          source: 'background',
          payload: pollPayload,
        },
        {
          timeoutMs: responseTimeoutMs,
          responseTimeoutMs,
          maxRecoveryAttempts: 2,
          logStep: step,
          logStepKey: 'kiro-submit-verification-code',
        }
      );

      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.code) {
        throw new Error(`步骤 ${step}：邮箱轮询结束，但未获取到验证码。`);
      }
      return result;
    }

    async function executeKiroStartDeviceLogin(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-start-device-login').trim();
      try {
        const auth = await startBuilderIdDeviceLogin(DEFAULT_REGION, fetchImpl);
        const loginUrl = cleanString(auth.verificationUriComplete || auth.verificationUri);
        const tabId = loginUrl ? await reuseOrCreateTab('kiro-device-auth', loginUrl) : null;
        if (!Number.isInteger(tabId)) {
          throw new Error('无法打开 Kiro 授权页，请重试步骤 1。');
        }
        await registerTab('kiro-device-auth', tabId);

        const updates = {
          kiroAccessToken: '',
          kiroAuthError: '',
          kiroAuthExpiresAt: auth.expiresAt,
          kiroAuthIntervalSeconds: auth.interval,
          kiroAuthRegion: auth.region,
          kiroAuthStatus: 'waiting_user',
          kiroAuthTabId: Number.isInteger(tabId) ? tabId : null,
          kiroAuthorizedEmail: '',
          kiroClientId: auth.clientId,
          kiroClientSecret: auth.clientSecret,
          kiroCredentialId: null,
          kiroDeviceAuthorizationCode: auth.deviceCode,
          kiroDeviceCode: auth.userCode,
          kiroFullName: '',
          kiroLastConnectionMessage: '',
          kiroLastUploadAt: 0,
          kiroLoginUrl: loginUrl,
          kiroRefreshToken: '',
          kiroUploadError: '',
          kiroUploadStatus: 'waiting_login',
          kiroUserCode: auth.userCode,
          kiroVerificationRequestedAt: 0,
          kiroVerificationUri: auth.verificationUri,
          kiroVerificationUriComplete: loginUrl,
        };

        await setState(updates);
        await activateTab(tabId);
        await ensureKiroPageState(tabId, {
          step: 1,
          targetStates: ['email_entry'],
          stableMs: 2500,
          initialDelayMs: 300,
          injectLogMessage: '步骤 1：Kiro 授权页内容脚本未就绪，正在等待页面恢复...',
          readyLogMessage: '步骤 1：正在等待 Kiro 授权页邮箱输入框加载完成...',
        });
        await log(`Kiro 授权页已就绪，请在下一步中获取邮箱并继续。当前授权码：${auth.userCode}`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, updates);
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroAuthError: message,
          kiroAuthStatus: 'error',
        });
        throw error;
      }
    }

    async function executeKiroSubmitEmail(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-submit-email').trim();
      try {
        const latestState = await getExecutionState(state);
        if (typeof resolveSignupEmailForFlow !== 'function') {
          throw new Error('Kiro 邮箱步骤缺少公共邮箱解析能力，无法继续执行。');
        }

        const tabId = await activateKiroAuthTab(latestState, {
          missingUrlMessage: '缺少 Kiro 授权页地址，请先执行步骤 1。',
          openFailedMessage: '无法恢复 Kiro 授权页，请重新执行步骤 1。',
        });
        await ensureKiroPageState(tabId, {
          step: 2,
          targetStates: ['email_entry'],
          stableMs: 2500,
          initialDelayMs: 300,
          injectLogMessage: '步骤 2：Kiro 授权页内容脚本未就绪，正在等待页面恢复...',
          readyLogMessage: '步骤 2：正在等待 Kiro 授权页邮箱输入框加载完成...',
        });

        const resolvedEmail = await resolveSignupEmailForFlow(latestState, {
          preserveAccountIdentity: true,
        });
        await log(`步骤 2：已获取邮箱 ${resolvedEmail}，正在提交到 Kiro 授权页...`, 'info', nodeId);

        await activateTab(tabId);
        const submitResult = await sendToContentScriptResilient('kiro-device-auth', {
          type: 'EXECUTE_NODE',
          nodeId: 'kiro-submit-email',
          step: 2,
          source: 'background',
          payload: {
            email: resolvedEmail,
          },
        }, {
          timeoutMs: 30000,
          retryDelayMs: 700,
          logMessage: '步骤 2：正在向 Kiro 授权页提交邮箱...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }

        const landingResult = await ensureKiroPageState(tabId, {
          step: 2,
          targetStates: ['name_entry'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 2：邮箱提交后页面切换中，正在等待 Kiro 授权页恢复...',
          readyLogMessage: '步骤 2：邮箱已提交，正在等待 Kiro 姓名页加载完成...',
          timeoutMessage: '邮箱提交后未进入姓名页，请检查当前邮箱是否已注册或页面是否异常。',
        });
        const updates = {
          kiroAuthorizedEmail: resolvedEmail,
          kiroAuthError: '',
          kiroAuthStatus: 'waiting_user',
          kiroFullName: '',
          kiroUploadError: '',
          kiroUploadStatus: 'waiting_login',
          kiroVerificationRequestedAt: 0,
        };
        await setState(updates);
        await log(`步骤 2：邮箱 ${resolvedEmail} 已提交，当前已进入姓名页。`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, {
          ...updates,
          email: resolvedEmail,
          accountIdentifierType: 'email',
          accountIdentifier: resolvedEmail,
          kiroNextState: landingResult?.state || '',
          kiroNextUrl: landingResult?.url || '',
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroAuthError: message,
        });
        throw error;
      }
    }

    async function executeKiroSubmitName(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-submit-name').trim();
      try {
        const latestState = await getExecutionState(state);
        if (!cleanString(latestState?.kiroAuthorizedEmail || latestState?.email)) {
          throw new Error('缺少 Kiro 授权邮箱，请先完成步骤 2。');
        }

        const tabId = await activateKiroAuthTab(latestState, {
          missingUrlMessage: '缺少 Kiro 授权页地址，请先执行步骤 1。',
          openFailedMessage: '无法恢复 Kiro 授权页，请重新执行步骤 1。',
        });
        await ensureKiroPageState(tabId, {
          step: 3,
          targetStates: ['name_entry'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 3：Kiro 姓名页内容脚本未就绪，正在等待页面恢复...',
          readyLogMessage: '步骤 3：正在等待 Kiro 姓名页加载完成...',
        });

        const fullName = resolveKiroFullName(latestState);
        const verificationRequestedAt = Date.now();
        await log(`步骤 3：正在填写姓名 ${fullName} 并继续...`, 'info', nodeId);

        const submitResult = await sendToContentScriptResilient('kiro-device-auth', {
          type: 'EXECUTE_NODE',
          nodeId: 'kiro-submit-name',
          step: 3,
          source: 'background',
          payload: {
            fullName,
          },
        }, {
          timeoutMs: 30000,
          retryDelayMs: 700,
          logMessage: '步骤 3：正在向 Kiro 姓名页提交姓名...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }

        const landingResult = await ensureKiroPageState(tabId, {
          step: 3,
          targetStates: ['otp_page'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 3：姓名提交后页面切换中，正在等待 Kiro 授权页恢复...',
          readyLogMessage: '步骤 3：姓名已提交，正在等待 Kiro 验证码页加载完成...',
          timeoutMessage: '姓名提交后未进入验证码页，请检查当前页面状态。',
        });
        const updates = {
          kiroAuthError: '',
          kiroFullName: fullName,
          kiroUploadError: '',
          kiroVerificationRequestedAt: verificationRequestedAt,
        };
        await setState(updates);
        await log('步骤 3：姓名已提交，当前已进入验证码页。', 'ok', nodeId);
        await completeNodeFromBackground(nodeId, {
          ...updates,
          kiroNextState: landingResult?.state || '',
          kiroNextUrl: landingResult?.url || '',
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroAuthError: message,
        });
        throw error;
      }
    }

    async function executeKiroSubmitVerificationCode(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-submit-verification-code').trim();
      try {
        const latestState = await getExecutionState(state);
        if (!cleanString(latestState?.kiroAuthorizedEmail || latestState?.email)) {
          throw new Error('缺少 Kiro 授权邮箱，请先完成步骤 2。');
        }

        const tabId = await activateKiroAuthTab(latestState, {
          missingUrlMessage: '缺少 Kiro 授权页地址，请先执行步骤 1。',
          openFailedMessage: '无法恢复 Kiro 授权页，请重新执行步骤 1。',
        });
        await ensureKiroPageState(tabId, {
          step: 4,
          targetStates: ['otp_page'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 4：Kiro 验证码页内容脚本未就绪，正在等待页面恢复...',
          readyLogMessage: '步骤 4：正在等待 Kiro 验证码页加载完成...',
        });

        const codeResult = await pollKiroVerificationCode(4, latestState, nodeId);
        const code = cleanString(codeResult?.code);
        if (!code) {
          throw new Error('未能获取到 Kiro 邮箱验证码。');
        }
        await log(`步骤 4：已获取验证码 ${code}，正在返回 Kiro 授权页提交...`, 'info', nodeId);

        await activateTab(tabId);
        const submitResult = await sendToContentScriptResilient('kiro-device-auth', {
          type: 'EXECUTE_NODE',
          nodeId: 'kiro-submit-verification-code',
          step: 4,
          source: 'background',
          payload: {
            code,
          },
        }, {
          timeoutMs: 30000,
          retryDelayMs: 700,
          logMessage: '步骤 4：正在向 Kiro 验证码页提交验证码...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }

        const landingResult = await ensureKiroPageState(tabId, {
          step: 4,
          targetStates: ['password_page'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 4：验证码提交后页面切换中，正在等待 Kiro 授权页恢复...',
          readyLogMessage: '步骤 4：验证码已提交，正在等待 Kiro 密码页加载完成...',
          timeoutMessage: '验证码提交后未进入密码页，请检查验证码是否失效或页面是否异常。',
        });
        const updates = {
          kiroAuthError: '',
          kiroUploadError: '',
        };
        await setState(updates);
        await log('步骤 4：验证码已提交，当前已进入密码页。', 'ok', nodeId);
        await completeNodeFromBackground(nodeId, {
          ...updates,
          code,
          emailTimestamp: Number(codeResult?.emailTimestamp || 0) || 0,
          mailId: String(codeResult?.mailId || ''),
          kiroNextState: landingResult?.state || '',
          kiroNextUrl: landingResult?.url || '',
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroAuthError: message,
        });
        throw error;
      }
    }

    async function executeKiroFillPassword(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-fill-password').trim();
      try {
        const latestState = await getExecutionState(state);
        const tabId = await activateKiroAuthTab(latestState, {
          missingUrlMessage: '缺少 Kiro 授权页地址，请先执行步骤 1。',
          openFailedMessage: '无法恢复 Kiro 授权页，请重新执行步骤 1。',
        });
        await ensureKiroPageState(tabId, {
          step: 5,
          targetStates: ['password_page'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 5：Kiro 密码页内容脚本未就绪，正在等待页面恢复...',
          readyLogMessage: '步骤 5：正在等待 Kiro 密码页加载完成...',
        });

        const passwordResolution = resolveKiroPassword(latestState);
        const password = passwordResolution.password;
        if (!password) {
          throw new Error('未生成有效的 Kiro 账户密码。');
        }
        if (typeof setPasswordState === 'function') {
          await setPasswordState(password);
        } else {
          await setState({ password });
        }

        const passwordModeLabel = passwordResolution.mode === 'custom'
          ? '自定义密码'
          : (passwordResolution.mode === 'reused' ? '复用现有密码' : '自动生成密码');
        await log(`步骤 5：正在填写 Kiro 账户密码（${passwordModeLabel}，${password.length} 位）...`, 'info', nodeId);

        const submitResult = await sendToContentScriptResilient('kiro-device-auth', {
          type: 'EXECUTE_NODE',
          nodeId: 'kiro-fill-password',
          step: 5,
          source: 'background',
          payload: {
            password,
          },
        }, {
          timeoutMs: 30000,
          retryDelayMs: 700,
          logMessage: '步骤 5：正在向 Kiro 密码页提交密码...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }

        const landingResult = await waitForKiroPageChange(tabId, {
          step: 5,
          fromStates: ['password_page'],
          stableMs: 1200,
          initialDelayMs: 120,
          injectLogMessage: '步骤 5：密码提交后页面切换中，正在等待 Kiro 授权页恢复...',
          readyLogMessage: '步骤 5：密码已提交，正在等待 Kiro 授权页完成跳转...',
          timeoutMessage: '密码提交后页面未离开密码页，请检查密码规则或当前页面提示。',
        });
        const updates = {
          kiroAuthError: '',
          kiroUploadError: '',
        };
        await setState(updates);
        await log(`步骤 5：密码已提交，当前页面状态：${landingResult?.state || 'unknown'}。`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, {
          ...updates,
          kiroNextState: landingResult?.state || '',
          kiroNextUrl: landingResult?.url || '',
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroAuthError: message,
        });
        throw error;
      }
    }

    async function executeKiroConfirmAccess(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-confirm-access').trim();
      try {
        const latestState = await getExecutionState(state);
        const clientId = cleanString(latestState.kiroClientId);
        const clientSecret = String(latestState.kiroClientSecret || '');
        const deviceCode = String(latestState.kiroDeviceAuthorizationCode || '');
        const region = normalizeRegion(latestState.kiroAuthRegion, DEFAULT_REGION);
        const expiresAt = Math.max(0, Number(latestState.kiroAuthExpiresAt) || 0);
        if (!clientId || !clientSecret || !deviceCode) {
          throw new Error('尚未启动 Kiro 设备登录，请先执行步骤 1。');
        }
        if (!expiresAt || expiresAt <= Date.now()) {
          throw new Error('Kiro 设备登录已过期，请重新执行步骤 1。');
        }

        const tabId = await activateKiroAuthTab(latestState, {
          missingUrlMessage: '缺少 Kiro 授权页地址，请先执行步骤 1。',
          openFailedMessage: '无法恢复 Kiro 授权页，请重新执行步骤 1。',
        });
        await setState({
          kiroAuthError: '',
          kiroAuthStatus: 'waiting_user',
          kiroUploadStatus: 'waiting_login',
        });
        let landingResult = await ensureKiroPageState(tabId, {
          step: 6,
          targetStates: ['authorization_page', 'success_page'],
          stableMs: 1500,
          initialDelayMs: 150,
          injectLogMessage: '步骤 6：Kiro 授权确认页内容脚本未就绪，正在等待页面恢复...',
          readyLogMessage: '步骤 6：正在等待 Kiro 授权确认页加载完成...',
          timeoutMessage: '未进入 Kiro 授权确认页，请检查当前页面状态。',
        });

        if (landingResult?.state !== 'success_page') {
          await log('步骤 6：正在确认访问并完成 Kiro 授权...', 'info', nodeId);
          const submitResult = await sendToContentScriptResilient('kiro-device-auth', {
            type: 'EXECUTE_NODE',
            nodeId: 'kiro-confirm-access',
            step: 6,
            source: 'background',
            payload: {
              maxActions: 3,
            },
          }, {
            timeoutMs: 60000,
            retryDelayMs: 700,
            logMessage: '步骤 6：正在处理 Kiro 授权确认页...',
          });
          if (submitResult?.error) {
            throw new Error(submitResult.error);
          }
          landingResult = {
            state: String(submitResult?.state || ''),
            url: String(submitResult?.url || ''),
          };
        }
        await log('步骤 6：授权页已完成，正在同步 Builder ID 凭据...', 'info', nodeId);
        let intervalSeconds = normalizePositiveInteger(latestState.kiroAuthIntervalSeconds, 5);
        while (Date.now() < expiresAt) {
          throwIfStopped();
          const result = await pollBuilderIdDeviceAuth({
            clientId,
            clientSecret,
            deviceCode,
            region,
          }, fetchImpl);
          if (result.completed) {
            const updates = {
              kiroAccessToken: result.accessToken,
              kiroAuthError: '',
              kiroAuthStatus: 'authorized',
              kiroRefreshToken: result.refreshToken,
              kiroUploadError: '',
              kiroUploadStatus: 'ready_to_upload',
            };
            await setState(updates);
            await log('步骤 6：确认访问已完成，已获取 Refresh Token。', 'ok', nodeId);
            await completeNodeFromBackground(nodeId, {
              ...updates,
              kiroNextState: landingResult?.state || '',
              kiroNextUrl: landingResult?.url || '',
            });
            return;
          }

          if (result.status === 'slow_down') {
            intervalSeconds = Math.max(intervalSeconds + 5, 10);
          }
          await sleepWithStop(intervalSeconds * 1000);
        }

        throw new Error('Kiro 设备登录已过期，请重新执行步骤 1。');
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroAuthError: message,
          kiroAuthStatus: /(expired|过期)/i.test(message) ? 'expired' : 'error',
        });
        throw error;
      }
    }

    async function executeKiroUploadCredential(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-upload-credential').trim();
      try {
        const latestState = await getExecutionState(state);
        const refreshToken = String(latestState.kiroRefreshToken || '');
        const clientId = cleanString(latestState.kiroClientId);
        const clientSecret = String(latestState.kiroClientSecret || '');
        const region = normalizeRegion(latestState.kiroAuthRegion, DEFAULT_REGION);
        const kiroRsUrl = String(latestState.kiroRsUrl || '');
        const kiroRsKey = String(latestState.kiroRsKey || '');
        if (!refreshToken || !clientId || !clientSecret) {
          throw new Error('缺少 Kiro Refresh Token，请先完成步骤 6。');
        }
        if (!cleanString(kiroRsUrl)) {
          throw new Error('缺少 kiro.rs 管理后台地址。');
        }
        if (!cleanString(kiroRsKey)) {
          throw new Error('缺少 kiro.rs API Key。');
        }

        await setState({
          kiroUploadError: '',
          kiroUploadStatus: 'uploading',
        });
        await log('步骤 7：正在上传 Builder ID 凭据到 kiro.rs...', 'info', nodeId);

        const connection = await checkKiroRsConnection(kiroRsUrl, kiroRsKey, fetchImpl);
        await setState({
          kiroLastConnectionMessage: connection.message,
        });
        if (!connection.ok) {
          throw new Error(connection.message);
        }

        const uploadOptions = buildCredentialUploadOptions(latestState);
        const uploadPayload = {
          refreshToken,
          clientId,
          clientSecret,
          region,
          ...(cleanString(latestState.kiroAuthorizedEmail)
            ? { email: cleanString(latestState.kiroAuthorizedEmail) }
            : {}),
          ...uploadOptions,
        };
        const uploadResult = await uploadBuilderIdCredential(
          kiroRsUrl,
          kiroRsKey,
          uploadPayload,
          fetchImpl
        );
        const updates = {
          kiroAuthorizedEmail: uploadResult.email || cleanString(latestState.kiroAuthorizedEmail),
          kiroCredentialId: uploadResult.credentialId,
          kiroLastUploadAt: Date.now(),
          kiroUploadError: '',
          kiroUploadStatus: normalizeKiroUploadMessage(uploadResult.message),
        };

        await setState(updates);
        await log(`步骤 7：kiro.rs 上传完成，状态：${updates.kiroUploadStatus}`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, updates);
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure({
          kiroUploadError: message,
          kiroUploadStatus: 'error',
        });
        throw error;
      }
    }

    return {
      executeKiroConfirmAccess,
      executeKiroFillPassword,
      executeKiroStartDeviceLogin,
      executeKiroSubmitEmail,
      executeKiroSubmitName,
      executeKiroSubmitVerificationCode,
      executeKiroUploadCredential,
    };
  }

  return {
    buildCredentialUploadOptions,
    checkKiroRsConnection,
    createKiroDeviceAuthExecutor,
    normalizeKiroRsBaseUrl,
    pollBuilderIdDeviceAuth,
    startBuilderIdDeviceLogin,
    uploadBuilderIdCredential,
  };
});
