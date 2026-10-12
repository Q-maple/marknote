/*
 * MarkNote — 后台脚本
 * 只做四件事：右键菜单、快捷键、把「打开侧边栏 / 打开管理页」这类请求转成浏览器动作，
 * 以及替内容脚本去调 AI 接口（内容脚本受页面 CORS 限制，后台才有跨域权限）。
 * 真正的划线逻辑都在内容脚本里，这里不碰页面内容。
 */
// Chromium 的 MV3 只认 background.service_worker（见 tools/make-chrome-manifest.py），
// 拿不到 manifest 里的第二个脚本，所以在这里手动补上；Firefox 走 manifest 的 scripts 列表，
// 那里没有 importScripts，会安静跳过。
try {
  if (typeof importScripts === 'function') importScripts('../common/ai.js');
} catch (e) {
  console.warn('[MarkNote] ai.js 预加载失败', e);
}

(function () {
  'use strict';

  const B = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : null;
  const C = globalThis.chrome;
  const api = B || C;

  function p(fn, thisArg, ...args) {
    if (B) return fn.apply(thisArg, args);
    return new Promise((resolve, reject) => {
      fn.apply(thisArg, [
        ...args,
        (res) => {
          const err = C.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res);
        }
      ]);
    });
  }

  const MSG = {
    HIGHLIGHT_SELECTION: 'mn:highlight-selection',
    ADD_NOTE: 'mn:add-note',
    SUPER_COPY: 'mn:super-copy',
    MARK_IMAGE: 'mn:mark-image',
    TOGGLE_HIGHLIGHTS: 'mn:toggle-highlights',
    TOGGLE_SIDEBAR_BAR: 'mn:toggle-sidebar-bar',
    OPEN_SIDEBAR: 'mn:open-sidebar',
    OPEN_DASHBOARD: 'mn:open-dashboard',
    AI_PANEL: 'mn:ai-panel',
    AI_TALK: 'mn:ai-talk',
    AI_CHAT: 'mn:ai-chat',
    AI_TEST: 'mn:ai-test',
    AI_MODELS: 'mn:ai-models'
  };

  const MENUS = [
    { id: 'mn-highlight', title: 'MarkNote：高亮选中文字', contexts: ['selection'] },
    { id: 'mn-note', title: 'MarkNote：高亮并写笔记', contexts: ['selection'] },
    { id: 'mn-ai', title: 'MarkNote：用 AI 分析选中文字', contexts: ['selection'] },
    { id: 'mn-talk', title: 'MarkNote：和 AI 讨论选中的文字', contexts: ['selection'] },
    { id: 'mn-copy', title: 'MarkNote：复制选中文字', contexts: ['selection'] },
    { id: 'mn-image', title: 'MarkNote：标记这张图片', contexts: ['image'] },
    { id: 'mn-sep', type: 'separator', contexts: ['all'] },
    { id: 'mn-sidebar', title: 'MarkNote：打开划线清单', contexts: ['all'] },
    { id: 'mn-dashboard', title: 'MarkNote：管理所有划线 / 导出', contexts: ['all'] },
    { id: 'mn-toggle', title: 'MarkNote：显示 / 隐藏本页高亮', contexts: ['all'] }
  ];

  function buildMenus() {
    try {
      api.contextMenus.removeAll(() => {
        MENUS.forEach((m) => {
          try {
            api.contextMenus.create(
              {
                id: m.id,
                title: m.title,
                type: m.type,
                contexts: m.contexts
              },
              () => void (C && C.runtime && C.runtime.lastError)
            );
          } catch (e) {
            console.warn('[MarkNote] 菜单创建失败', e);
          }
        });
      });
    } catch (e) {
      console.warn('[MarkNote] contextMenus 不可用', e);
    }
  }

  api.runtime.onInstalled.addListener(buildMenus);
  api.runtime.onStartup.addListener(buildMenus);
  if (api.contextMenus) buildMenus();

  /** 给当前标签页的内容脚本发消息，失败就安静返回 null（比如 about: 页面）。 */
  async function toActiveTab(msg) {
    try {
      const tabs = await p(api.tabs.query, api.tabs, { active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return null;
      return await p(api.tabs.sendMessage, api.tabs, tab.id, msg);
    } catch (_e) {
      return null;
    }
  }

  const MENU_ACTIONS = {
    'mn-highlight': MSG.HIGHLIGHT_SELECTION,
    'mn-note': MSG.ADD_NOTE,
    'mn-ai': MSG.AI_PANEL,
    'mn-talk': MSG.AI_TALK,
    'mn-copy': MSG.SUPER_COPY,
    'mn-image': MSG.MARK_IMAGE,
    'mn-toggle': MSG.TOGGLE_HIGHLIGHTS
  };

  api.contextMenus &&
    api.contextMenus.onClicked.addListener(async (info, tab) => {
      const type = MENU_ACTIONS[info.menuItemId];
      if (type) {
        try {
          await p(api.tabs.sendMessage, api.tabs, tab.id, { type });
        } catch (_e) {
          /* 页面没有内容脚本 */
        }
        return;
      }
      if (info.menuItemId === 'mn-sidebar') return openSidebar();
      if (info.menuItemId === 'mn-dashboard') return openDashboard();
    });

  api.commands &&
    api.commands.onCommand.addListener(async (command) => {
      const map = {
        'highlight-selection': MSG.HIGHLIGHT_SELECTION,
        'add-note': MSG.ADD_NOTE,
        'ai-analyze': MSG.AI_PANEL,
        'super-copy': MSG.SUPER_COPY,
        'toggle-highlights': MSG.TOGGLE_HIGHLIGHTS,
        'toggle-sidebar-bar': MSG.TOGGLE_SIDEBAR_BAR
      };
      if (command === 'toggle-sidebar') return openSidebar();
      const type = map[command];
      if (type) await toActiveTab({ type });
    });

  /** 打开侧边栏：Firefox 用 sidebar_action；别的浏览器退化成一个小弹窗。 */
  async function openSidebar() {
    const url = api.runtime.getURL('src/sidebar/sidebar.html');
    if (api.sidebarAction && api.sidebarAction.open) {
      try {
        if (api.sidebarAction.isOpen) {
          const open = await p(api.sidebarAction.isOpen, api.sidebarAction, {});
          if (open) return;
        }
        await p(api.sidebarAction.open, api.sidebarAction);
        return;
      } catch (_e) {
        /* 落到弹窗方案 */
      }
    }
    try {
      const tabs = await p(api.tabs.query, api.tabs, { active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      const key = 'mnSidebarWindow';
      const store = api.storage.session || api.storage.local;
      const got = await p(store.get, store, key);
      const winId = got && got[key];
      if (winId) {
        try {
          await p(api.windows.update, api.windows, winId, { focused: true });
          return;
        } catch (_e) {
          /* 窗口可能已经关了 */
        }
      }
      const win = await p(api.windows.create, api.windows, {
        url,
        type: 'popup',
        width: 420,
        height: 780,
        top: 60,
        left: Math.max(0, (tab && tab.width ? 1200 : 1100))
      });
      await p(store.set, store, { [key]: win.id });
      api.windows.onRemoved.addListener(function once(id) {
        if (id === win.id) {
          p(store.remove, store, key).catch(() => {});
        }
      });
    } catch (e) {
      console.warn('[MarkNote] 打开清单失败，改为新标签页', e);
      api.tabs.create({ url });
    }
  }

  function openDashboard() {
    return api.tabs.create({ url: api.runtime.getURL('src/dashboard/dashboard.html') });
  }

  /* ------------------------------------------------- AI（第三方 OpenAI 兼容接口）

     为什么放在后台：内容脚本发请求会受页面 CORS 限制，后台脚本带着 host_permissions
     出去不受影响。密钥只存在本机 storage.local 的 aiKey 里，不会跟着「导出 JSON 备份」走。
  */

  const AI_KEY = 'aiKey';

  function aiModule() {
    return (globalThis.MN && globalThis.MN.ai) || null;
  }

  async function readAiConfig() {
    const store = api.storage.local;
    const got = (await p(store.get, store, ['settings', AI_KEY])) || {};
    const settings = got.settings || {};
    const ai = aiModule();
    const config = ai ? ai.normalizeConfig(settings.ai) : settings.ai || {};
    return { config, apiKey: String(got[AI_KEY] || '') };
  }

  async function handleAiChat(msg) {
    const ai = aiModule();
    if (!ai) return { ok: false, code: 'nomodule', error: 'AI 模块没加载起来，重新载入一次扩展试试' };
    const { config, apiKey } = await readAiConfig();
    if (!config.enabled) return { ok: false, code: 'disabled', error: '还没有在管理页打开 AI 分析' };
    if (!apiKey) return { ok: false, code: 'nokey', error: '还没有配置 API Key' };
    if (!config.model) return { ok: false, code: 'nomodel', error: ai.NO_MODEL_HINT };
    const payload = msg.payload || {};
    const text = String(payload.text || '').trim();
    if (text.length < 10) return { ok: false, code: 'empty', error: '能分析的文字太少了' };

    const messages = ai.buildMessages({
      config,
      text: text.slice(0, config.maxChars),
      prompt: payload.prompt,
      scope: payload.scope,
      title: payload.title,
      url: payload.url
    });
    const res = await ai.chat({ apiKey, config, messages, timeoutMs: payload.timeoutMs });
    if (!res.ok) {
      const out = { ok: false, code: 'http', error: res.error, status: res.status };
      // 服务端嫌模型名不对时，顺手把可用模型拉回来，免得用户对着一个名字瞎猜
      if (ai.looksLikeModelError(res.error)) {
        const listed = await ai.listModels({ apiKey, config });
        if (listed.ok) {
          out.error = res.error + ai.modelHint(listed.models);
          out.models = listed.models;
        }
      }
      return out;
    }
    const parsed = ai.parseResult(res.content, { maxItems: config.maxItems });
    return {
      ok: true,
      items: parsed.items,
      warning: parsed.error || null,
      raw: parsed.items.length ? null : String(res.content || '').slice(0, 600),
      model: res.model || config.model,
      usage: res.usage || null
    };
  }

  /**
   * 悬浮窗里的多轮对话。和 handleAiChat 的区别：
   *   · 不解析 JSON、不产出任何划线结果，只把模型回的话原样带回去；
   *   · 强制关掉 jsonMode（对话要的是自然语言）；
   *   · 历史由内容脚本传过来，这里只管拼消息和发请求。
   */
  async function handleAiTalk(msg) {
    const ai = aiModule();
    if (!ai) return { ok: false, code: 'nomodule', error: 'AI 模块没加载起来，重新载入一次扩展试试' };
    const { config, apiKey } = await readAiConfig();
    if (!config.enabled) return { ok: false, code: 'disabled', error: '还没有在管理页打开 AI' };
    if (!apiKey) return { ok: false, code: 'nokey', error: '还没有配置 API Key' };
    if (!config.model) return { ok: false, code: 'nomodel', error: ai.NO_MODEL_HINT };
    const payload = msg.payload || {};
    const messages = ai.buildChatMessages({
      config,
      quote: payload.quote,
      title: payload.title,
      url: payload.url,
      history: payload.history
    });
    if (!messages) return { ok: false, code: 'empty', error: '还没有要问的问题' };

    const res = await ai.chat({
      apiKey,
      config: { ...config, jsonMode: false },
      messages,
      timeoutMs: payload.timeoutMs || 90000
    });
    if (!res.ok) {
      const out = { ok: false, code: 'http', error: res.error, status: res.status };
      if (ai.looksLikeModelError(res.error)) {
        const listed = await ai.listModels({ apiKey, config });
        if (listed.ok) {
          out.error = res.error + ai.modelHint(listed.models);
          out.models = listed.models;
        }
      }
      return out;
    }
    return {
      ok: true,
      reply: String(res.content || '').trim(),
      model: res.model || config.model,
      usage: res.usage || null
    };
  }

  async function handleAiModels() {
    const ai = aiModule();
    if (!ai) return { ok: false, code: 'nomodule', error: 'AI 模块没加载起来' };
    const { config, apiKey } = await readAiConfig();
    if (!apiKey) return { ok: false, code: 'nokey', error: '还没有配置 API Key' };
    const res = await ai.listModels({ apiKey, config });
    if (!res.ok) return { ok: false, code: 'http', error: res.error, status: res.status };
    return { ok: true, models: res.models };
  }

  async function handleAiTest() {
    const ai = aiModule();
    if (!ai) return { ok: false, code: 'nomodule', error: 'AI 模块没加载起来' };
    const { config, apiKey } = await readAiConfig();
    if (!apiKey) return { ok: false, code: 'nokey', error: '还没有配置 API Key' };
    // 测试连接也是要带模型名的；没选模型时先说清楚，别让用户对着服务端的报错猜
    if (!config.model) return { ok: false, code: 'nomodel', error: ai.NO_MODEL_HINT };
    const res = await ai.chat({
      apiKey,
      // 测试连接只验证「地址对不对、Key 通不通、模型名认不认」，
      // 不走 JSON 模式：否则接口会要求提示词里必须出现 json 这个词，白白多一个失败理由。
      config: { ...config, jsonMode: false },
      messages: [{ role: 'user', content: '只回复两个字：可用' }],
      timeoutMs: 30000
    });
    if (!res.ok) {
      const out = { ok: false, code: 'http', error: res.error, status: res.status };
      if (ai.looksLikeModelError(res.error)) {
        const listed = await ai.listModels({ apiKey, config });
        if (listed.ok) {
          out.error = res.error + ai.modelHint(listed.models);
          out.models = listed.models;
        }
      }
      return out;
    }
    return { ok: true, model: res.model || config.model, reply: String(res.content || '').trim().slice(0, 60) };
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === MSG.OPEN_SIDEBAR) {
      openSidebar().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === MSG.OPEN_DASHBOARD) {
      openDashboard().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === MSG.AI_TALK) {
      handleAiTalk(msg).then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, code: 'crash', error: (e && e.message) || String(e) })
      );
      return true;
    }
    if (msg.type === MSG.AI_CHAT) {
      handleAiChat(msg).then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, code: 'crash', error: (e && e.message) || String(e) })
      );
      return true;
    }
    if (msg.type === MSG.AI_TEST) {
      handleAiTest().then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, code: 'crash', error: (e && e.message) || String(e) })
      );
      return true;
    }
    if (msg.type === MSG.AI_MODELS) {
      handleAiModels().then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, code: 'crash', error: (e && e.message) || String(e) })
      );
      return true;
    }
    return false;
  });
})();
