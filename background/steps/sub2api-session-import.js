(function attachBackgroundSub2ApiSessionImport(root, factory) {
  root.MultiPageBackgroundSub2ApiSessionImport = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundSub2ApiSessionImportModule() {
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PLUS_CHECKOUT_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/plus-checkout.js'];

  function createSub2ApiSessionImportExecutor(deps = {}) {
    const {
      addLog: rawAddLog = async () => {},
      chrome,
      completeNodeFromBackground,
      ensureContentScriptReadyOnTabUntilStopped,
      getTabId,
      isTabAlive,
      normalizeSub2ApiUrl = (value) => value,
      registerTab,
      sendTabMessageUntilStopped,
      sleepWithStop = async () => {},
      throwIfStopped = () => {},
      waitForTabCompleteUntilStopped = async () => {},
      DEFAULT_SUB2API_GROUP_NAME = 'codex',
    } = deps;

    let sub2ApiApi = null;

    function addStepLog(step, message, level = 'info') {
      return rawAddLog(message, level, {
        step,
        stepKey: 'sub2api-session-import',
      });
    }

    function getSub2ApiApi() {
      if (sub2ApiApi) {
        return sub2ApiApi;
      }
      const factory = deps.createSub2ApiApi
        || self.MultiPageBackgroundSub2ApiApi?.createSub2ApiApi;
      if (typeof factory !== 'function') {
        throw new Error('SUB2API 接口模块未加载，无法导入当前 ChatGPT 会话。');
      }
      sub2ApiApi = factory({
        addLog: rawAddLog,
        normalizeSub2ApiUrl,
        DEFAULT_SUB2API_GROUP_NAME,
      });
      return sub2ApiApi;
    }

    function normalizeString(value = '') {
      return String(value || '').trim();
    }

    function resolveVisibleStep(state = {}) {
      const visibleStep = Math.floor(Number(state?.visibleStep) || 0);
      return visibleStep > 0 ? visibleStep : 10;
    }

    function isSupportedChatGptSessionUrl(url = '') {
      try {
        const parsed = new URL(String(url || ''));
        if (!/^https?:$/i.test(parsed.protocol)) {
          return false;
        }
        const hostname = String(parsed.hostname || '').trim().toLowerCase();
        return /(^|\.)chatgpt\.com$/.test(hostname)
          || hostname === 'chat.openai.com'
          || /(^|\.)openai\.com$/.test(hostname);
      } catch {
        return false;
      }
    }

    async function resolveSessionTabId(state = {}) {
      const registeredTabId = typeof getTabId === 'function'
        ? await getTabId(PLUS_CHECKOUT_SOURCE)
        : null;
      if (registeredTabId && typeof isTabAlive === 'function' && await isTabAlive(PLUS_CHECKOUT_SOURCE)) {
        return Number(registeredTabId) || 0;
      }

      const storedTabId = Number(state?.plusCheckoutTabId) || 0;
      if (storedTabId && chrome?.tabs?.get) {
        const tab = await chrome.tabs.get(storedTabId).catch(() => null);
        if (tab?.id) {
          if (typeof registerTab === 'function') {
            await registerTab(PLUS_CHECKOUT_SOURCE, tab.id);
          }
          return tab.id;
        }
      }

      throw new Error('未找到可读取 ChatGPT 会话的 Plus 标签页，请先完成当前 Plus 支付链路。');
    }

    async function getResolvedSessionTab(tabId, visibleStep) {
      const tab = await chrome?.tabs?.get?.(tabId).catch(() => null);
      if (!tab?.id) {
        throw new Error(`步骤 ${visibleStep}：Plus 会话标签页不存在或已关闭，无法继续导入 SUB2API。`);
      }
      if (!isSupportedChatGptSessionUrl(tab.url)) {
        throw new Error(`步骤 ${visibleStep}：当前标签页不在 ChatGPT / OpenAI 页面，无法读取当前登录会话。`);
      }
      return tab;
    }

    async function readCurrentChatGptSession(tabId, visibleStep) {
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: `步骤 ${visibleStep}：正在等待 ChatGPT 会话页完成加载，再继续读取当前登录会话...`,
      });

      const sessionResult = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
        type: 'PLUS_CHECKOUT_GET_STATE',
        source: 'background',
        payload: {
          includeSession: true,
          includeAccessToken: true,
        },
      });
      if (sessionResult?.error) {
        throw new Error(sessionResult.error);
      }

      const session = sessionResult?.session && typeof sessionResult.session === 'object' && !Array.isArray(sessionResult.session)
        ? sessionResult.session
        : null;
      const accessToken = normalizeString(
        sessionResult?.accessToken
        || session?.accessToken
      );
      if (!session && !accessToken) {
        throw new Error(`步骤 ${visibleStep}：未读取到有效的 ChatGPT 会话或 accessToken，请确认当前标签页仍处于已登录状态。`);
      }

      return {
        session,
        accessToken,
      };
    }

    async function executeSub2ApiSessionImport(state = {}) {
      throwIfStopped();
      const visibleStep = resolveVisibleStep(state);
      const api = getSub2ApiApi();

      await addStepLog(visibleStep, '正在定位当前 Plus 会话页并准备导入 SUB2API...', 'info');
      const tabId = await resolveSessionTabId(state);
      const tab = await getResolvedSessionTab(tabId, visibleStep);
      if (chrome?.tabs?.update) {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      }

      await addStepLog(visibleStep, '正在读取当前 ChatGPT 登录会话...', 'info');
      const sessionState = await readCurrentChatGptSession(tab.id, visibleStep);
      throwIfStopped();

      const result = await api.importCurrentChatGptSession({
        ...state,
        session: sessionState.session,
        accessToken: sessionState.accessToken,
      }, {
        visibleStep,
        logLabel: `步骤 ${visibleStep}`,
        logOptions: { step: visibleStep, stepKey: 'sub2api-session-import' },
        timeoutMs: 120000,
        importTimeoutMs: 120000,
      });

      await completeNodeFromBackground(state?.nodeId || 'sub2api-session-import', result);
    }

    return {
      executeSub2ApiSessionImport,
      isSupportedChatGptSessionUrl,
    };
  }

  return {
    createSub2ApiSessionImportExecutor,
  };
});
