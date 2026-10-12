/*
 * MarkNote — 管理页
 * 全部划线的搜索、按标签/颜色/网站筛选、批量删除、导出与备份。
 */
(function () {
  'use strict';

  const MN = globalThis.MN;
  const B = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : null;
  const C = globalThis.chrome;
  const api = B || C;

  const dom = {};
  const IDS = {
    q: 'q',
    color: 'color',
    site: 'site',
    template: 'template',
    stats: 'stats',
    list: 'list',
    tagTree: 'tag-tree',
    selInfo: 'sel-info',
    file: 'file',
    aiSummary: 'ai-summary',
    aiKey: 'ai-key',
    aiBase: 'ai-base',
    aiModel: 'ai-model',
    aiMax: 'ai-max',
    aiChars: 'ai-chars',
    aiJson: 'ai-json',
    aiEnabled: 'ai-enabled',
    aiPrompt: 'ai-prompt',
    aiChatPrompt: 'ai-chat-prompt',
    aiSave: 'ai-save',
    aiTest: 'ai-test',
    aiListModels: 'ai-list-models',
    aiModels: 'ai-models',
    aiModelList: 'ai-model-list',
    aiClear: 'ai-clear',
    aiStatus: 'ai-status',
    dispIndex: 'disp-index',
    dispMode: 'disp-mode',
    dispSummary: 'disp-summary',
    dangerSummary: 'danger-summary',
    clearAll: 'clear-all',
    clearAllStatus: 'clear-all-status'
  };
  Object.keys(IDS).forEach((k) => (dom[k] = document.getElementById(IDS[k])));
  dom.groupTpl = document.getElementById('tpl-group');
  dom.annTpl = document.getElementById('tpl-ann');

  const state = { all: [], filter: '', color: '', site: '', tag: '', selected: new Set() };
  let lastModelError = '';

  async function init() {
    bind();
    bindAi();
    bindDisplay();
    MN.store.watchExternal();
    MN.store.onChange(
      MN.debounce(async () => {
        // 别的地方改了序号开关（弹窗 / 侧栏）时，这张卡片也得跟着变
        try {
          fillDisplay(await MN.store.getSettings());
        } catch (_e) {
          /* 读不到就只刷列表 */
        }
        load();
      }, 120)
    );
    try {
      const s = await MN.store.getSettings();
      MN.setCustomColors(s.customColors);
      fillAi(s.ai);
      fillDisplay(s);
    } catch (_e) {
      /* 读不到设置就只用内置色 */
    }
    await loadAiKey();
    // 有 Key 却还没选模型（换了服务商、或从旧版本升上来）→ 打开管理页就顺手补上。
    // 注意要在 loadAiKey() 之后：autoPickModel 读的是输入框里的 Key。
    try {
      const cur = await MN.store.getSettings();
      if (!cur.ai.model && dom.aiKey.value.trim()) {
        autoPickModel({ keepCurrent: false })
          .then((picked) => {
            if (picked) aiStatus(`自动选好了模型「${picked}」，点「保存 AI 设置」即可`, 'ok');
          })
          .catch(() => {});
      }
    } catch (_e) {
      /* 读不到就算了，用户还能手填 */
    }
    load();
  }

  /* ------------------------------------------------------------------ AI 设置 */

  const AI_KEY = 'aiKey';

  async function readKey() {
    try {
      const got = await new Promise((resolve) => {
        const ret = api.storage.local.get([AI_KEY], (res) => resolve(res || {}));
        if (ret && typeof ret.then === 'function') ret.then((res) => resolve(res || {}));
      });
      return String((got && got[AI_KEY]) || '');
    } catch (_e) {
      return '';
    }
  }

  async function writeKey(key) {
    const store = api.storage.local;
    const patch = { [AI_KEY]: key };
    if (B) return B.storage.local.set(patch);
    await new Promise((resolve) => store.set(patch, resolve));
    return null;
  }

  /** 密钥单独存一个键，永远不进 settings、不进导出。 */
  async function loadAiKey() {
    const key = await readKey();
    dom.aiKey.value = key;
    dom.aiKey.placeholder = key ? MN.ai.maskKey(key) + '（已保存，改直接改这里）' : 'sk-…';
  }

  function fillAi(ai) {
    const cfg = MN.ai.normalizeConfig(ai);
    dom.aiEnabled.checked = cfg.enabled;
    dom.aiBase.value = cfg.baseUrl;
    dom.aiModel.value = cfg.model;
    dom.aiModel.placeholder = cfg.model ? '' : '保存 API Key 后自动拉取；也可手填';
    dom.aiMax.value = cfg.maxItems;
    dom.aiChars.value = cfg.maxChars;
    dom.aiJson.checked = cfg.jsonMode;
    dom.aiPrompt.value = cfg.prompt;
    dom.aiPrompt.placeholder = MN.ai.DEFAULT_PROMPT;
    dom.aiChatPrompt.value = cfg.chatPrompt || '';
    dom.aiChatPrompt.placeholder = '留空就用内置的：' + MN.ai.DEFAULT_CHAT_PROMPT;
    renderAiSummary(cfg);
  }

  function readAiForm() {
    return MN.ai.normalizeConfig({
      enabled: dom.aiEnabled.checked,
      baseUrl: dom.aiBase.value,
      model: dom.aiModel.value,
      maxItems: dom.aiMax.value,
      maxChars: dom.aiChars.value,
      jsonMode: dom.aiJson.checked,
      prompt: dom.aiPrompt.value,
      chatPrompt: dom.aiChatPrompt.value
    });
  }

  function renderAiSummary(cfg) {
    const c = cfg || MN.ai.normalizeConfig(null);
    dom.aiSummary.textContent = c.enabled ? `已开启 · ${c.model}` : '未开启';
  }

  function aiStatus(msg, kind) {
    dom.aiStatus.textContent = msg;
    dom.aiStatus.classList.toggle('ok', kind === 'ok');
    dom.aiStatus.classList.toggle('err', kind === 'err');
  }

  /**
   * 自动挑一个模型：拉一次列表，优先保留当前这个（还在列表里的话），
   * 否则取第一个。返回选中的模型名（没成功就返回 ''）。
   */
  async function autoPickModel(opts) {
    const o = opts || {};
    const key = dom.aiKey.value.trim();
    lastModelError = '';
    if (!key) {
      lastModelError = '还没填 API Key';
      return '';
    }
    dom.aiListModels.disabled = true;
    try {
      const res = await askBackground({ type: MN.MSG.AI_MODELS });
      if (!res || !res.ok || !res.models || !res.models.length) {
        lastModelError = (res && res.error) || '接口没有返回模型列表';
        return '';
      }
      renderModelChips(res.models);
      const cur = dom.aiModel.value.trim();
      const pick = o.keepCurrent !== false && res.models.indexOf(cur) >= 0 ? cur : res.models[0];
      dom.aiModel.value = pick;
      const cfg = readAiForm();
      await MN.store.setSettings({ ai: cfg });
      return pick;
    } finally {
      dom.aiListModels.disabled = false;
    }
  }

  /** 问后台要这个接口支持的模型名，拿到后铺成一排可点的标签。 */
  async function listModels() {
    const cfg = readAiForm();
    const key = dom.aiKey.value.trim();
    if (!key) {
      aiStatus('先填 API Key', 'err');
      return;
    }
    await MN.store.setSettings({ ai: cfg });
    await writeKey(key);
    aiStatus('正在问这个接口支持哪些模型…');
    dom.aiListModels.disabled = true;
    try {
      const res = await askBackground({ type: MN.MSG.AI_MODELS });
      if (res && res.ok && res.models && res.models.length) {
        renderModelChips(res.models);
        if (!dom.aiModel.value.trim()) {
          dom.aiModel.value = res.models[0];
          await MN.store.setSettings({ ai: readAiForm() });
          aiStatus(`拿到 ${res.models.length} 个模型，已先把「${res.models[0]}」填成默认值`, 'ok');
        } else {
          aiStatus(`拿到 ${res.models.length} 个模型，点一下就能换`, 'ok');
        }
      } else {
        aiStatus('没拿到模型列表：' + ((res && res.error) || '接口没有返回'), 'err');
      }
    } finally {
      dom.aiListModels.disabled = false;
    }
  }

  function bindAi() {
    dom.aiSave.addEventListener('click', async () => {
      const cfg = readAiForm();
      const key = dom.aiKey.value.trim();
      await MN.store.setSettings({ ai: cfg });
      await writeKey(key);
      await loadAiKey();
      renderAiSummary(cfg);

      if (!key) {
        aiStatus('设置已保存，但还没填 API Key —— 填上再保存一次', 'err');
        return;
      }

      // 填完 Key 就自动拉一次模型列表，并把第一个设成默认值
      if (!cfg.model) {
        aiStatus('已保存。正在拉取这个接口支持的模型…');
        const picked = await autoPickModel({ keepCurrent: false });
        if (picked) {
          renderAiSummary({ ...readAiForm(), model: picked });
          aiStatus(`已保存，模型自动选为「${picked}」` + (cfg.enabled ? '。回到网页刷新一下就能用' : '。记得勾上「打开 AI 分析」'), 'ok');
          return;
        }
        aiStatus(
          MN.ai.NO_MODEL_HINT + ' （自动拉取失败：' + (lastModelError || '接口没有返回模型列表') + '）',
          'err'
        );
        return;
      }

      aiStatus(
        !cfg.enabled
          ? '设置已保存，但 AI 还是关着的 —— 勾上「打开 AI 分析」再保存一次，网页里才用得上'
          : '已保存并打开。回到网页刷新一下（扩展重载过的话必须刷新），选中文字点 AI 就能用',
        cfg.enabled ? 'ok' : 'err'
      );
    });

    dom.aiListModels.addEventListener('click', () => {
      listModels().catch((e) => aiStatus('拉取失败：' + ((e && e.message) || String(e)), 'err'));
    });

    dom.aiTest.addEventListener('click', async () => {
      const cfg = readAiForm();
      const key = dom.aiKey.value.trim();
      if (!key) {
        aiStatus('先填 API Key', 'err');
        return;
      }
      await MN.store.setSettings({ ai: cfg });
      await writeKey(key);
      aiStatus('正在连接…');
      dom.aiTest.disabled = true;
      try {
        const res = await askBackground({ type: MN.MSG.AI_TEST });
        if (res && res.ok) {
          await loadAiKey();
          renderAiSummary(cfg);
          aiStatus(`通了 ✓ ${res.model || cfg.model} 回：${res.reply || '（空）'}`, 'ok');
        } else {
          // 模型名不对时后台会把可用模型一起带回来，直接铺出来省得再点一次
          if (res && res.models && res.models.length) renderModelChips(res.models);
          aiStatus('失败：' + ((res && res.error) || '未知错误'), 'err');
        }
      } finally {
        dom.aiTest.disabled = false;
      }
    });

    dom.aiClear.addEventListener('click', async () => {
      if (!confirm('确定清除本机保存的 API Key？清除后 AI 分析就不能用了。')) return;
      await writeKey('');
      await loadAiKey();
      renderModelChips([]);
      aiStatus('Key 已清除', 'ok');
    });

    dom.aiKey.addEventListener('change', () => {
      aiStatus(dom.aiKey.value.trim() ? '记得点「保存 AI 设置」' : '');
    });
  }

  /* --------------------------------------------------------------- 显示与清理 */

  function fillDisplay(s) {
    dom.dispIndex.checked = !!s.showIndex;
    dom.dispMode.value = MN.normalizeIndexMode(s.indexMode);
    dom.dispMode.disabled = !s.showIndex;
    renderDisplaySummary();
  }

  function renderDisplaySummary() {
    dom.dispSummary.textContent = dom.dispIndex.checked
      ? dom.dispMode.value === 'order'
        ? '已开启 · 按创建时间'
        : '已开启 · 按页面位置'
      : '已关闭';
    dom.dispMode.disabled = !dom.dispIndex.checked;
  }

  function bindDisplay() {
    // 这两个开关立刻生效（网页里的内容脚本会收到 storage 变更自己刷新），不用点保存
    dom.dispIndex.addEventListener('change', async () => {
      await MN.store.setSettings({ showIndex: dom.dispIndex.checked });
      renderDisplaySummary();
    });
    dom.dispMode.addEventListener('change', async () => {
      await MN.store.setSettings({ indexMode: dom.dispMode.value });
      renderDisplaySummary();
    });

    dom.clearAll.addEventListener('click', async () => {
      const all = state.all.length ? state.all : await MN.store.all();
      if (!all.length) {
        dom.clearAllStatus.textContent = '本来就是空的';
        return;
      }
      const pages = new Set(all.map((a) => MN.normalizeUrl(a.url || ''))).size;
      if (
        !window.confirm(
          `清空全部 ${all.length} 条划线（${pages} 个页面）？\n\n` +
            '这是本机唯一一份数据，删掉就没了。建议先「导出 JSON 备份」。\n' +
            '清空后下面会给一个「撤销」，但只在当前这个页面开着的时候有效。'
        )
      ) {
        return;
      }
      const snapshot = all.map((a) => JSON.parse(JSON.stringify(a)));
      try {
        await MN.store.removeMany(snapshot.map((a) => a.id));
      } catch (e) {
        dom.clearAllStatus.textContent = '清空失败：' + ((e && e.message) || e);
        return;
      }
      await load();
      renderClearAllStatus(snapshot);
    });
  }

  /** 清空之后给一个撤销入口：数据刚才就在手里，原样写回去就行。 */
  function renderClearAllStatus(snapshot) {
    dom.clearAllStatus.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = `已清空 ${snapshot.length} 条划线。`;
    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = '撤销';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await MN.store.importBundle({ annotations: snapshot }, 'merge');
      await load();
      dom.clearAllStatus.textContent = `已恢复 ${r.added} 条划线（${r.skipped} 条已存在）`;
    });
    dom.clearAllStatus.appendChild(span);
    dom.clearAllStatus.appendChild(document.createTextNode(' '));
    dom.clearAllStatus.appendChild(btn);
  }

  /** 可用模型：点一下就填到模型框里。 */
  function renderModelChips(models) {
    const list = models || [];
    dom.aiModelList.innerHTML = list.map((m) => `<option value="${esc(m)}"></option>`).join('');
    dom.aiModels.innerHTML = list
      .map((m) => `<button type="button" class="chip model" data-model="${esc(m)}">${esc(m)}</button>`)
      .join('');
    dom.aiModels.querySelectorAll('button[data-model]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dom.aiModel.value = btn.dataset.model;
        aiStatus('模型已填成 ' + btn.dataset.model + '，记得点「保存 AI 设置」（网页上的 AI 面板和对话窗里也能直接切）', 'ok');
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 问后台一件事（chrome 回调风格和 browser Promise 风格都兜住）。 */
  function askBackground(msg) {
    if (B) return B.runtime.sendMessage(msg).then((r) => r, (e) => ({ ok: false, error: (e && e.message) || String(e) }));
    return new Promise((resolve) => {
      C.runtime.sendMessage(msg, (r) => {
        const err = C.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : r || { ok: false, error: '后台没有响应' });
      });
    });
  }

  async function load() {
    state.all = await MN.store.all();
    state.selected = new Set([...state.selected].filter((id) => state.all.some((a) => a.id === id)));
    dom.dangerSummary.textContent = state.all.length
      ? `共 ${state.all.length} 条 · 清空后可以撤销`
      : '现在没有划线';
    renderColorFilter();
    renderSites();
    renderStats();
    renderTagTree();
    renderList();
  }

  /** 颜色筛选：内置色 + 自定义色 + 数据里实际出现过的颜色。 */
  function renderColorFilter() {
    const cur = dom.color.value;
    const seen = new Set();
    const out = [];
    const push = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label: MN.colorOf(id).custom ? id : MN.colorOf(id).label });
    };
    MN.allColors().forEach((c) => push(c.id));
    state.all.forEach((a) => push(a.color));
    dom.color.innerHTML =
      '<option value="">全部颜色</option>' + out.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    dom.color.value = out.some((c) => c.id === cur) ? cur : '';
    state.color = dom.color.value;
  }

  function renderStats() {
    const pages = new Set(state.all.map((a) => a.url));
    const tags = new Set();
    const notes = state.all.filter((a) => (a.note || '').trim()).length;
    state.all.forEach((a) => (a.tags || []).forEach((t) => tags.add(t)));
    const bytes = JSON.stringify(state.all).length;
    dom.stats.innerHTML = `
      <span class="chip">${state.all.length} 条划线</span>
      <span class="chip">${pages.size} 个页面</span>
      <span class="chip">${tags.size} 个标签</span>
      <span class="chip">${notes} 条带笔记</span>
      <span class="chip">约 ${(bytes / 1024).toFixed(1)} KB</span>`;
  }

  function renderSites() {
    const map = new Map();
    state.all.forEach((a) => map.set(a.site || MN.hostOf(a.url), (map.get(a.site || MN.hostOf(a.url)) || 0) + 1));
    const cur = dom.site.value;
    dom.site.innerHTML = '<option value="">全部网站</option>';
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([s, n]) => {
        const o = document.createElement('option');
        o.value = s;
        o.textContent = `${s || '(未知)'}（${n}）`;
        dom.site.appendChild(o);
      });
    dom.site.value = cur && map.has(cur) ? cur : '';
    state.site = dom.site.value;
  }

  function renderTagTree() {
    const counts = new Map();
    state.all.forEach((a) => (a.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    const tree = MN.buildTagTree([...counts.keys()]);
    dom.tagTree.innerHTML = '';
    if (!tree.length) {
      dom.tagTree.innerHTML = '<div class="muted">还没有标签。给划线写笔记时可以加，比如「技术/前端」。</div>';
      return;
    }
    const build = (nodes, host) => {
      nodes.forEach((n) => {
        const wrap = document.createElement('div');
        wrap.className = 'tag-node';
        const line = document.createElement('div');
        line.className = 'tag-line' + (state.tag === n.path ? ' active' : '');
        line.innerHTML = `<span class="grow">${n.name}</span><span class="count">${counts.get(n.path) || 0}</span>`;
        line.addEventListener('click', () => {
          state.tag = state.tag === n.path ? '' : n.path;
          renderTagTree();
          renderList();
        });
        wrap.appendChild(line);
        if (n.children && n.children.length) {
          const kids = document.createElement('div');
          kids.className = 'tag-children';
          wrap.appendChild(kids);
          build(n.children, kids);
        }
        host.appendChild(wrap);
      });
    };
    build(tree, dom.tagTree);
  }

  function filtered() {
    const q = state.filter.trim().toLowerCase();
    return state.all.filter((a) => {
      if (state.color && a.color !== state.color) return false;
      if (state.site && (a.site || MN.hostOf(a.url)) !== state.site) return false;
      if (state.tag && !(a.tags || []).some((t) => t === state.tag || t.startsWith(state.tag + '/'))) return false;
      if (!q) return true;
      return (
        (a.text || '').toLowerCase().includes(q) ||
        (a.note || '').toLowerCase().includes(q) ||
        (a.tags || []).join(' ').toLowerCase().includes(q) ||
        (a.url || '').toLowerCase().includes(q) ||
        (a.title || '').toLowerCase().includes(q)
      );
    });
  }

  function highlight(text, q) {
    const safe = String(text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    if (!q) return safe;
    const i = safe.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return safe;
    return safe.slice(0, i) + '<mark>' + safe.slice(i, i + q.length) + '</mark>' + safe.slice(i + q.length);
  }

  function renderList() {
    const list = filtered();
    dom.list.innerHTML = '';
    if (!list.length) {
      dom.list.innerHTML = '<div class="empty">没有符合条件的划线。</div>';
      updateSelInfo();
      return;
    }
    const byUrl = new Map();
    list.forEach((a) => {
      if (!byUrl.has(a.url)) byUrl.set(a.url, []);
      byUrl.get(a.url).push(a);
    });
    const q = state.filter.trim();

    [...byUrl.entries()]
      .sort((a, b) => Math.max(...b[1].map((x) => x.createdAt)) - Math.max(...a[1].map((x) => x.createdAt)))
      .forEach(([url, items]) => {
        const node = dom.groupTpl.content.firstElementChild.cloneNode(true);
        const a0 = items[0];
        const link = node.querySelector('.group-title');
        link.textContent = a0.title || url;
        link.href = url;
        node.querySelector('.group-url').textContent = url;
        node.querySelector('.group-count').textContent = `${items.length} 条`;
        const body = node.querySelector('.group-body');
        const groupCheck = node.querySelector('.pick-group');
        groupCheck.checked = items.every((a) => state.selected.has(a.id));
        groupCheck.addEventListener('change', () => {
          items.forEach((a) => (groupCheck.checked ? state.selected.add(a.id) : state.selected.delete(a.id)));
          renderList();
        });

        items
          .sort((a, b) => (a.anchor ? a.anchor.startV : 0) - (b.anchor ? b.anchor.startV : 0))
          .forEach((a) => {
            const item = dom.annTpl.content.firstElementChild.cloneNode(true);
            item.style.borderLeftColor = MN.colorOf(a.color).light;
            item.querySelector('.ann-quote').innerHTML =
              (a.type === 'image' ? '［图片］' : '') + highlight(a.text, q);
            const note = item.querySelector('.ann-note');
            if (a.note) note.innerHTML = '💬 ' + highlight(a.note, q);
            else note.classList.add('hidden');
            item.querySelector('.dot').style.background = MN.colorOf(a.color).light;
            item.querySelector('.time').textContent = MN.fmtTime(a.createdAt);
            const tags = item.querySelector('.tags');
            (a.tags || []).forEach((t) => {
              const s = document.createElement('span');
              s.className = 'tag';
              s.textContent = t;
              tags.appendChild(s);
            });
            const pick = item.querySelector('.pick');
            pick.checked = state.selected.has(a.id);
            pick.addEventListener('change', () => {
              if (pick.checked) state.selected.add(a.id);
              else state.selected.delete(a.id);
              updateSelInfo();
              groupCheck.checked = items.every((x) => state.selected.has(x.id));
            });
            item.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
              e.stopPropagation();
              await MN.copyText(MN.annToMarkdown(a, { template: dom.template.value }));
              e.target.textContent = '已复制';
              setTimeout(() => (e.target.textContent = '复制'), 900);
            });
            item.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
              e.stopPropagation();
              await MN.store.remove(a.id);
              state.selected.delete(a.id);
              await load();
            });
            body.appendChild(item);
          });
        dom.list.appendChild(node);
      });
    updateSelInfo();
  }

  function updateSelInfo() {
    dom.selInfo.textContent = state.selected.size ? `已选中 ${state.selected.size} 条` : '未选中';
  }

  /* ------------------------------------------------------------- 导出 / 导入 */

  function download(filename, text, type = 'text/plain') {
    const blob = new Blob([text], { type: type + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  function bind() {
    dom.q.addEventListener('input', () => {
      state.filter = dom.q.value;
      renderList();
    });
    dom.color.addEventListener('change', () => {
      state.color = dom.color.value;
      renderList();
    });
    dom.site.addEventListener('change', () => {
      state.site = dom.site.value;
      renderList();
    });
    document.getElementById('clear-tag').addEventListener('click', () => {
      state.tag = '';
      renderTagTree();
      renderList();
    });

    const picked = () => (state.selected.size ? state.all.filter((a) => state.selected.has(a.id)) : filtered());

    document.getElementById('export-md').addEventListener('click', () => {
      const list = picked();
      download(`marknote-${stamp()}.md`, MN.bundleToMarkdown(list, { template: dom.template.value }), 'text/markdown');
    });

    document.getElementById('copy-md').addEventListener('click', async (e) => {
      const md = MN.bundleToMarkdown(picked(), { template: dom.template.value });
      const ok = await MN.copyText(md);
      e.target.textContent = ok ? '已复制 ✓' : '复制失败';
      setTimeout(() => (e.target.textContent = '复制为 Markdown'), 1200);
    });

    document.getElementById('export-txt').addEventListener('click', () => {
      const list = picked();
      const lines = [];
      const byUrl = new Map();
      list.forEach((a) => {
        if (!byUrl.has(a.url)) byUrl.set(a.url, []);
        byUrl.get(a.url).push(a);
      });
      byUrl.forEach((items, url) => {
        lines.push(`【${items[0].title || url}】`);
        lines.push(url);
        items.forEach((a) => {
          lines.push('  · ' + (a.text || '').replace(/\n+/g, ' '));
          if (a.note) lines.push('    💬 ' + a.note);
          if ((a.tags || []).length) lines.push('    # ' + a.tags.join(' '));
        });
        lines.push('');
      });
      download(`marknote-${stamp()}.txt`, lines.join('\n'));
    });

    document.getElementById('export-json').addEventListener('click', async () => {
      const bundle = await MN.store.exportBundle();
      download(`marknote-backup-${stamp()}.json`, JSON.stringify(bundle, null, 2), 'application/json');
    });

    document.getElementById('import-json').addEventListener('click', () => dom.file.click());
    dom.file.addEventListener('change', async () => {
      const file = dom.file.files && dom.file.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        const res = await MN.store.importBundle(bundle, 'merge');
        alert(`导入完成：新增 ${res.added} 条，跳过重复 ${res.skipped} 条。`);
        await load();
      } catch (e) {
        alert('导入失败：' + e.message);
      } finally {
        dom.file.value = '';
      }
    });

    document.getElementById('select-all').addEventListener('click', () => {
      filtered().forEach((a) => state.selected.add(a.id));
      renderList();
    });

    document.getElementById('delete-sel').addEventListener('click', async () => {
      if (!state.selected.size) return alert('先在左侧勾选要删除的划线，或点「全选过滤结果」。');
      if (!confirm(`确定删除选中的 ${state.selected.size} 条划线？此操作不可撤销。`)) return;
      await MN.store.removeMany([...state.selected]);
      state.selected.clear();
      await load();
    });
  }

  init().catch((e) => console.warn('[MarkNote] 管理页初始化失败', e));
})();
