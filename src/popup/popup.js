/*
 * MarkNote — 工具栏弹窗
 */
(function () {
  'use strict';

  const MN = globalThis.MN;
  const B = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : null;
  const C = globalThis.chrome;
  const api = B || C;

  const dom = {
    title: document.getElementById('page-title'),
    stats: document.getElementById('page-stats'),
    colors: document.getElementById('colors'),
    addCustom: document.getElementById('add-custom'),
    pickerHost: document.getElementById('picker-host'),
    customList: document.getElementById('custom-colors')
  };

  /** 最近一次读到的设置，自定义色板相关的操作都基于它。 */
  let settings = { ...MN.DEFAULT_SETTINGS };
  let picker = null;

  function sendBg(msg) {
    try {
      const r = api.runtime.sendMessage(msg);
      if (r && typeof r.then === 'function') r.catch(() => {});
    } catch (_e) {
      /* 忽略 */
    }
  }

  async function activeTab() {
    try {
      if (B) {
        const tabs = await B.tabs.query({ active: true, currentWindow: true });
        return tabs && tabs[0];
      }
      return await new Promise((res) => C.tabs.query({ active: true, currentWindow: true }, (t) => res(t && t[0])));
    } catch (_e) {
      return null;
    }
  }

  async function toTab(msg) {
    const tab = await activeTab();
    if (!tab || !tab.id) return null;
    try {
      if (B) return await B.tabs.sendMessage(tab.id, msg);
      return await new Promise((res) => C.tabs.sendMessage(tab.id, msg, (r) => res(C.runtime.lastError ? null : r)));
    } catch (_e) {
      return null;
    }
  }

  async function refresh() {
    const tab = await activeTab();
    const state = await toTab({ type: MN.MSG.PAGE_STATE });
    if (state) {
      dom.title.textContent = state.title || (tab && tab.url) || '当前页面';
      dom.title.title = (tab && tab.url) || '';
      dom.stats.innerHTML = `
        <span class="chip">${state.count} 条划线</span>
        ${state.lost && state.lost.length ? `<span class="chip">${state.lost.length} 条定位失败</span>` : ''}
        ${state.hidden ? '<span class="chip">高亮已隐藏</span>' : ''}
        ${state.showIndex ? '<span class="chip">序号已开</span>' : ''}
        ${state.unlocked ? '<span class="chip">已允许选中复制</span>' : ''}`;
    } else {
      const url = (tab && tab.url) || '';
      const list = url && !url.startsWith('about:') ? await MN.store.forUrl(url) : [];
      dom.title.textContent = (tab && tab.title) || url || '这个页面不支持划线';
      dom.stats.innerHTML = `<span class="chip">${list.length} 条划线</span>`;
    }
    settings = await MN.store.getSettings();
    MN.setCustomColors(settings.customColors);
    renderColors();
    renderCustomList();
  }

  function markDefault() {
    const cur = String(MN.colorOf(settings.defaultColor).light || '').toLowerCase();
    [...dom.colors.querySelectorAll('.dot')].forEach((d) => {
      d.dataset.active = String(d.dataset.light || '').toLowerCase() === cur ? '1' : '0';
    });
  }

  function renderColors() {
    dom.colors.innerHTML = MN.allColors()
      .map(
        (c) =>
          `<span class="dot" data-color="${c.id}" data-light="${c.light}" title="默认 ${
            c.custom ? c.label + '（自定义）' : c.label
          }" style="background:${c.light}"></span>`
      )
      .join('');
    markDefault();
  }

  /** 自定义色：点一下设为默认色，点 × 从常用色里移除（已划的线不受影响）。 */
  function renderCustomList() {
    const list = MN.customColors();
    dom.customList.innerHTML = '';
    if (!list.length) {
      dom.customList.innerHTML = '<span class="muted">还没有自定义颜色。</span>';
      return;
    }
    list.forEach((c) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = '设为默认色';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.light = c.light;
      dot.style.background = c.light;
      if (String(c.light).toLowerCase() === String(MN.colorOf(settings.defaultColor).light).toLowerCase()) {
        dot.dataset.active = '1';
      }
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(c.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = '从常用色里移除';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeCustom(c.id);
      });
      chip.appendChild(del);
      chip.addEventListener('click', () => pickDefault(c.id));
      dom.customList.appendChild(chip);
    });
  }

  async function pickDefault(color) {
    settings = await MN.store.setSettings({ defaultColor: color });
    markDefault();
    renderCustomList();
  }

  function closePicker() {
    if (picker) {
      try {
        picker.destroy();
      } catch (_e) {
        /* 忽略 */
      }
      picker = null;
    }
    dom.pickerHost.innerHTML = '';
    dom.pickerHost.hidden = true;
    dom.addCustom.textContent = '＋ 自定义颜色（色环 / RGB）';
  }

  async function removeCustom(hex) {
    const next = (settings.customColors || []).filter((x) => MN.normalizeHex(x) !== hex);
    settings = await MN.store.setSettings({ customColors: next });
    MN.setCustomColors(settings.customColors);
    renderColors();
    renderCustomList();
    if (picker) picker.refresh();
  }

  function openPicker() {
    closePicker();
    picker = MN.createColorPicker({
      value: MN.colorOf(settings.defaultColor).light,
      onPick: async (hex) => {
        await pickDefault(hex);
        closePicker();
      },
      onSave: async (hex) => {
        const list = (settings.customColors || []).slice();
        if (!list.some((x) => MN.normalizeHex(x) === hex)) list.push(hex);
        settings = await MN.store.setSettings({ customColors: list, defaultColor: hex });
        MN.setCustomColors(settings.customColors);
        renderColors();
        renderCustomList();
        closePicker();
      },
      onDelete: (hex) => removeCustom(hex),
      onCancel: closePicker
    });
    dom.pickerHost.appendChild(picker.el);
    dom.pickerHost.hidden = false;
    dom.addCustom.textContent = '收起取色器';
    picker.focus();
  }

  dom.colors.addEventListener('click', (e) => {
    const dot = e.target.closest('.dot');
    if (!dot) return;
    pickDefault(dot.dataset.color);
  });

  dom.addCustom.addEventListener('click', () => {
    if (dom.pickerHost.hidden) openPicker();
    else closePicker();
  });

  document.getElementById('open-sidebar').addEventListener('click', () => {
    sendBg({ type: MN.MSG.OPEN_SIDEBAR });
    window.close();
  });
  document.getElementById('open-dashboard').addEventListener('click', () => {
    sendBg({ type: MN.MSG.OPEN_DASHBOARD });
    window.close();
  });
  document.getElementById('toggle-hl').addEventListener('click', async () => {
    await toTab({ type: MN.MSG.TOGGLE_HIGHLIGHTS });
    refresh();
  });
  document.getElementById('toggle-bar').addEventListener('click', async () => {
    await toTab({ type: MN.MSG.TOGGLE_SIDEBAR_BAR });
    refresh();
  });
  document.getElementById('toggle-index').addEventListener('click', async () => {
    await toTab({ type: MN.MSG.TOGGLE_INDEX });
    refresh();
  });
  document.getElementById('clear-page').addEventListener('click', async () => {
    const st = await toTab({ type: MN.MSG.PAGE_STATE });
    const n = (st && st.count) || 0;
    if (!n) {
      dom.stats.innerHTML = '<span class="chip">本页还没有划线</span>';
      return;
    }
    // 破坏性操作给一次确认；误点也还有页面里 9 秒的「撤销」可以救
    if (!confirm(`清空本页的 ${n} 条划线？\n清空后页面里会给你 9 秒「撤销」机会，也可以先去「管理 / 导出」备份。`)) return;
    const r = await toTab({ type: MN.MSG.CLEAR_PAGE });
    await refresh(); // 先让它刷完，免得把下面这条回执覆盖掉
    if (r && r.ok) {
      dom.stats.innerHTML = `<span class="chip">已清空 ${r.cleared} 条（可在页面里点「撤销」找回）</span>`;
    }
  });
  // 复制辅助：默认关闭，首次使用必须先确认一次（确认结果记在本机设置里，之后不再打扰）
  document.getElementById('unlock').addEventListener('click', async () => {
    settings = settings || (await MN.store.getSettings());
    if (!settings.copyNoticeAck) {
      const ok = confirm(
        '「允许本页选中复制」只作用在你自己的浏览器里：\n' +
          '当某个网页自己禁用了选中或复制时，让你仍能选中并复制正在看的内容。\n\n' +
          '请遵守目标网站的使用条款，不要用它批量抓取或转载他人内容。\n\n' +
          '确认后不再提示（可在管理页里重新关闭这个功能）。'
      );
      if (!ok) return;
      settings = await MN.store.setSettings({ copyNoticeAck: true });
    }
    await toTab({ type: MN.MSG.TOGGLE_UNLOCK });
    refresh();
  });
  document.getElementById('super-copy').addEventListener('click', async () => {
    await toTab({ type: MN.MSG.SUPER_COPY });
    window.close();
  });
  // 悬浮窗对话：只在页面里聊，不产生任何划线
  document.getElementById('ai-talk').addEventListener('click', async () => {
    await toTab({ type: MN.MSG.AI_TALK });
    window.close();
  });
  document.getElementById('ai-analyze').addEventListener('click', async () => {
    // 选区在页面里，弹窗这边只知道「当前标签页」——让内容脚本自己去读选区
    await toTab({ type: MN.MSG.AI_PANEL });
    window.close();
  });

  const manifest = api.runtime.getManifest();
  document.getElementById('ver').textContent = 'v' + manifest.version;

  // 先按设置里的自定义色板渲染一帧，避免色板点闪一下
  MN.store.getSettings().then((s) => {
    settings = s;
    MN.setCustomColors(s.customColors);
    renderColors();
    renderCustomList();
  });
  refresh();
  MN.store.watchExternal();
  MN.store.onChange(MN.debounce(refresh, 150));
})();
