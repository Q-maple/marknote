/*
 * MarkNote — 侧边栏（Firefox 侧栏 / 其它浏览器的小窗口）
 * 数据优先从当前标签页的内容脚本拿（这样才能知道哪些划线「定位失败」），
 * 拿不到就退回去读本地存储。
 */
(function () {
  'use strict';

  const MN = globalThis.MN;
  const B = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : null;
  const C = globalThis.chrome;
  const api = B || C;

  const dom = {
    title: document.getElementById('page-title'),
    url: document.getElementById('page-url'),
    stats: document.getElementById('stats'),
    list: document.getElementById('list'),
    foot: document.getElementById('foot'),
    q: document.getElementById('q'),
    colorFilter: document.getElementById('color-filter'),
    btnIndex: document.getElementById('btn-index'),
    btnClear: document.getElementById('btn-clear'),
    tpl: document.getElementById('tpl-ann')
  };

  const state = { tabId: null, tabUrl: '', page: null, annotations: [], lost: [], filter: '', color: '', showIndex: false, indexMode: 'position', connected: false };

  /**
   * 和页面里算的是同一套序号（同一个规则、同一份数据），
   * 所以清单里看到 3 号，网页上那块高亮也是 3 号。
   */
  function indexMap() {
    const list = state.annotations.slice();
    const place = (a) => (typeof a.startV === 'number' ? a.startV : Number.MAX_SAFE_INTEGER);
    const born = (a) => Number(a.createdAt) || 0;
    list.sort((a, b) => {
      if (state.indexMode === 'order') return born(a) - born(b) || String(a.id).localeCompare(String(b.id));
      return place(a) - place(b) || born(a) - born(b);
    });
    const map = new Map();
    list.forEach((a, i) => map.set(a.id, i + 1));
    return map;
  }

  function send(msg) {
    try {
      const ret = api.runtime.sendMessage(msg);
      if (ret && typeof ret.then === 'function') ret.catch(() => {});
    } catch (_e) {
      /* 忽略 */
    }
  }

  async function sendToTab(msg) {
    if (!state.tabId) return null;
    try {
      if (B) return await B.tabs.sendMessage(state.tabId, msg);
      return await new Promise((resolve, reject) => {
        C.tabs.sendMessage(state.tabId, msg, (res) => {
          const err = C.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res);
        });
      });
    } catch (_e) {
      return null;
    }
  }

  /**
   * 颜色筛选的选项 = 内置色 + 自定义色 + 「本页实际用到的颜色」。
   * 最后一项是为了照顾设置里已经被删掉、但划线还留着的十六进制颜色。
   */
  function colorOptions() {
    const seen = new Set();
    const out = [];
    const push = (id, label, light) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label, light });
    };
    MN.allColors().forEach((c) => push(c.id, c.label, c.light));
    state.annotations.forEach((a) => {
      if (a.color) push(a.color, MN.colorOf(a.color).custom ? a.color : MN.colorOf(a.color).label, MN.colorOf(a.color).light);
    });
    return out;
  }

  function renderColorFilter() {
    const cur = state.color;
    const opts = colorOptions();
    dom.colorFilter.innerHTML =
      '<option value="">全部颜色</option>' +
      opts.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    dom.colorFilter.value = opts.some((c) => c.id === cur) ? cur : '';
    state.color = dom.colorFilter.value;
  }

  async function activeTab() {
    try {
      if (B) {
        const tabs = await B.tabs.query({ active: true, currentWindow: true });
        return tabs && tabs[0];
      }
      return await new Promise((resolve) => C.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t && t[0])));
    } catch (_e) {
      return null;
    }
  }

  async function load() {
    const tab = await activeTab();
    state.tabId = tab ? tab.id : null;
    state.tabUrl = tab ? tab.url : '';
    dom.url.textContent = state.tabUrl || '';
    dom.url.title = state.tabUrl || '';

    let page = null;
    if (state.tabId) page = await sendToTab({ type: MN.MSG.GET_ANNOTATIONS });
    // 内容脚本没应答（页面在装 / 更新 / 重新加载插件之前就打开了、PDF、扩展页…）：
    // 划线照旧从存储里读出来显示，但「定位 / 删除 / 关序号」这些按钮点了不会有反应，
    // 所以下面要在统计条里说清楚，别让人以为是插件坏了。
    state.connected = !!(page && Array.isArray(page.annotations));

    if (page && Array.isArray(page.annotations)) {
      state.page = page;
      state.annotations = page.annotations;
      state.lost = page.lost || [];
      dom.title.textContent = page.title || '当前页面划线';
    } else {
      // 内容脚本没应答（PDF、扩展页、还没加载完…）→ 直接读存储
      const list = state.tabUrl ? await MN.store.forUrl(state.tabUrl) : [];
      state.page = { count: list.length, hidden: false, unlocked: false };
      state.annotations = list.map((a) => ({
        id: a.id,
        color: a.color,
        note: a.note,
        tags: a.tags,
        text: a.text,
        type: a.type,
        createdAt: a.createdAt,
        startV: a.anchor && typeof a.anchor.startV === 'number' ? a.anchor.startV : null,
        lost: false
      }));
      state.lost = [];
      dom.title.textContent = list.length ? list[0].title || '当前页面划线' : '当前页面划线';
    }
    // 序号开关是全局设置，不依赖内容脚本活着（PDF / 扩展页也能看编号）
    const settings = (await MN.store.getSettings()) || {};
    state.showIndex = !!settings.showIndex;
    state.indexMode = MN.normalizeIndexMode(settings.indexMode);
    renderColorFilter();
    render();
  }

  function visible() {
    const q = state.filter.trim().toLowerCase();
    return state.annotations.filter((a) => {
      if (state.color && a.color !== state.color) return false;
      if (!q) return true;
      return (
        (a.text || '').toLowerCase().includes(q) ||
        (a.note || '').toLowerCase().includes(q) ||
        (a.tags || []).join(' ').toLowerCase().includes(q)
      );
    });
  }

  function render() {
    const list = visible();
    const idx = state.showIndex ? indexMap() : null;
    dom.list.innerHTML = '';
    if (!state.annotations.length) {
      dom.list.innerHTML =
        '<div class="empty">这一页还没有划线。<br><br>选中文字 → 点颜色即可高亮；<br>右键菜单里也有「高亮选中文字」。</div>';
    } else if (!list.length) {
      dom.list.innerHTML = '<div class="empty">没有符合条件的划线。</div>';
    }
    list.forEach((ann) => dom.list.appendChild(renderItem(ann, idx)));
    dom.btnIndex.dataset.on = state.showIndex ? '1' : '0';
    dom.btnIndex.title = state.showIndex ? '隐藏划线序号' : '显示划线序号（和网页上的编号一致）';

    const tagCount = new Set();
    state.annotations.forEach((a) => (a.tags || []).forEach((t) => tagCount.add(t)));
    dom.stats.innerHTML = `
      <span class="chip">${state.annotations.length} 条划线</span>
      <span class="chip">${tagCount.size} 个标签</span>
      ${state.lost.length ? `<span class="chip">${state.lost.length} 条定位失败</span>` : ''}
      ${!state.connected && /^https?:/i.test(state.tabUrl) ? '<span class="chip warn">此页面未连接插件 · 刷新（F5）后可用</span>' : ''}`;
    dom.foot.innerHTML = `<span>数据只存在本机</span><span>MarkNote</span>`;
  }

  function renderItem(ann, idx) {
    const node = dom.tpl.content.firstElementChild.cloneNode(true);
    const color = MN.colorOf(ann.color);
    node.style.borderLeftColor = color.light;
    node.dataset.id = ann.id;
    if (idx && idx.has(ann.id)) {
      const badge = document.createElement('span');
      badge.className = 'ann-idx';
      badge.textContent = String(idx.get(ann.id));
      badge.title = '网页上这块高亮的编号';
      node.querySelector('.dot').insertAdjacentElement('beforebegin', badge);
    }
    if (ann.lost) {
      node.classList.add('lost');
      node.querySelector('.ann-meta').insertAdjacentHTML('afterbegin', '<span class="badge-lost">定位失败</span>');
    }
    node.querySelector('.dot').style.background = color.light;
    node.querySelector('.ann-quote').textContent = ann.type === 'image' ? '［图片］' + (ann.text || '') : ann.text || '';
    const noteEl = node.querySelector('.ann-note');
    if (ann.note) noteEl.textContent = '💬 ' + ann.note;
    else noteEl.classList.add('hidden');
    node.querySelector('[data-role="time"]').textContent = MN.fmtTime(ann.createdAt || Date.now());
    const tagBox = node.querySelector('.tags');
    (ann.tags || []).forEach((t) => {
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = t;
      tagBox.appendChild(s);
    });
    return node;
  }

  /* --------------------------------------------------------------- 交互 */

  dom.list.addEventListener('click', async (e) => {
    const item = e.target.closest('.ann');
    if (!item) return;
    const id = item.dataset.id;
    const ann = state.annotations.find((a) => a.id === id);
    if (!ann) return;
    const btn = e.target.closest('[data-act]');

    if (!btn) {
      if (e.target.closest('.ann-edit')) return;
      const res = await sendToTab({ type: MN.MSG.FOCUS_ANNOTATION, id });
      if (!res || !res.ok) {
        await MN.copyText(ann.text || '');
        item.querySelector('.ann-quote').animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 400 });
      }
      return;
    }

    const act = btn.dataset.act;
    if (act === 'copy') {
      const text =
        ann.type === 'image'
          ? `![图片](${ann.text || ''})`
          : MN.annToMarkdown({ ...ann, tags: ann.tags || [] });
      await MN.copyText(text);
      flash(btn, '✓');
    } else if (act === 'note') {
      const box = item.querySelector('.ann-edit');
      const open = box.classList.toggle('hidden');
      if (!open) {
        box.querySelector('textarea').value = ann.note || '';
        renderEditTags(box, ann);
        box.querySelector('textarea').focus();
      }
    } else if (act === 'delete') {
      await MN.store.remove(id);
      await sendToTab({ type: MN.MSG.RELOAD_HIGHLIGHTS });
      state.annotations = state.annotations.filter((a) => a.id !== id);
      render();
    } else if (act === 'save') {
      const box = item.querySelector('.ann-edit');
      const note = box.querySelector('textarea').value.trim();
      const tags = (box._tags || []).slice();
      await MN.store.patch(id, { note, tags });
      ann.note = note;
      ann.tags = tags;
      await sendToTab({ type: MN.MSG.RELOAD_HIGHLIGHTS });
      render();
    } else if (act === 'untag') {
      const box = item.closest('.ann-edit');
      box._tags.splice(Number(btn.dataset.i), 1);
      renderEditTags(box, { tags: box._tags });
      e.stopPropagation();
    }
  });

  dom.list.addEventListener('keydown', (e) => {
    const box = e.target.closest('.ann-edit');
    if (!box) return;
    if (e.key === 'Enter' && e.target.classList.contains('tag-input')) {
      e.preventDefault();
      addEditTag(box, e.target.value);
      e.target.value = '';
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      box.querySelector('[data-act="save"]').click();
    }
  });

  function renderEditTags(box, ann) {
    if (!box._tags) box._tags = [...(ann.tags || [])];
    const holder = box.querySelector('.tags');
    holder.innerHTML = '';
    box._tags.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = t;
      const x = document.createElement('button');
      x.dataset.act = 'untag';
      x.dataset.i = i;
      x.textContent = '×';
      chip.appendChild(x);
      holder.appendChild(chip);
    });
  }

  function addEditTag(box, raw) {
    const tag = MN.normalizeTag(raw);
    if (!tag) return;
    if (!box._tags) box._tags = [];
    if (!box._tags.includes(tag)) box._tags.push(tag);
    renderEditTags(box, { tags: box._tags });
  }

  function flash(el, text) {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => (el.textContent = old), 900);
  }

  dom.q.addEventListener('input', () => {
    state.filter = dom.q.value;
    render();
  });

  dom.colorFilter.addEventListener('change', () => {
    state.color = dom.colorFilter.value;
    render();
  });

  document.getElementById('btn-reload').addEventListener('click', async () => {
    const res = await sendToTab({ type: MN.MSG.RELOAD_HIGHLIGHTS });
    if (res) {
      state.annotations = res.annotations || [];
      state.lost = res.lost || [];
      render();
    } else {
      await load();
    }
  });

  document.getElementById('btn-dash').addEventListener('click', () => {
    send({ type: MN.MSG.OPEN_DASHBOARD });
  });

  dom.btnIndex.addEventListener('click', async () => {
    const res = await sendToTab({ type: MN.MSG.TOGGLE_INDEX });
    if (res && typeof res.showIndex === 'boolean') {
      state.showIndex = res.showIndex;
    } else {
      state.showIndex = !state.showIndex;
      MN.store.setSettings({ showIndex: state.showIndex });
    }
    render();
  });

  dom.btnClear.addEventListener('click', async () => {
    const n = state.annotations.length;
    if (!n) {
      window.alert('本页还没有划线。');
      return;
    }
    if (!window.confirm(`清空本页的 ${n} 条划线？\n清空后页面里会给你 9 秒「撤销」机会；想更保险可以先去管理页导出备份。`)) return;
    const res = await sendToTab({ type: MN.MSG.CLEAR_PAGE });
    if (res && res.ok) {
      state.annotations = [];
      state.lost = [];
      render();
    } else {
      await load();
    }
  });

  MN.store.watchExternal();
  MN.store.onChange(MN.debounce(load, 120));
  api.tabs.onActivated && api.tabs.onActivated.addListener(() => load());
  api.tabs.onUpdated &&
    api.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === 'complete' && tabId === state.tabId) load();
    });
  window.addEventListener('focus', () => load());

  // 先把自定义色板读出来再渲染，颜色筛选里才有自定义色
  MN.store.getSettings().then(
    (s) => {
      MN.setCustomColors(s.customColors);
      load();
    },
    () => load()
  );
})();
