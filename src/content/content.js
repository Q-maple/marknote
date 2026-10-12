/*
 * MarkNote — 内容脚本
 *
 * 负责页面里发生的一切：
 *   · 选中文字 → 弹出小工具条 → 多色高亮 / 加笔记 / 复制
 *   · 点已有高亮 → 就地编辑笔记、标签、颜色、删除
 *   · 右键图片 → 标记图片
 *   · 右侧常驻小工具条
 *   · 复制辅助（页面禁止选中 / 复制时，仅在你自己的浏览器里放开，默认关闭）
 * 所有界面都塞在一个 shadow root 里，避免污染宿主页面样式，也避免被页面 CSS 改写。
 */
(function () {
  'use strict';

  if (globalThis.__marknoteLoaded) return;
  globalThis.__marknoteLoaded = true;

  const MN = globalThis.MN;
  if (!MN || !MN.anchors || !MN.store) return;

  const B = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : null;
  const C = globalThis.chrome;
  const api = B || C;

  /** 给后台发消息，没人在听也不报错。 */
  function sendBg(msg) {
    try {
      const ret = api.runtime.sendMessage(msg);
      if (ret && typeof ret.then === 'function') ret.catch(() => {});
    } catch (_e) {
      /* 忽略 */
    }
  }

  const state = {
    settings: { ...MN.DEFAULT_SETTINGS },    annotations: [],
    lost: [],
    host: null,
    shadow: null,
    el: {},
    popoverAnn: null,
    editingTags: [],
    pendingImageElement: null,
    lastContextTarget: null,
    unlocked: false,
    unlockHandler: null,
    hidden: false,
    href: location.href,
    toolbarTimer: null,
    domObserver: null,
    domRetryTimer: null,
    lostRetryTimer: null,
    lostRetryStep: 0,
    lostNotified: false,
    lastSelectAt: 0,
    picker: null,
    pickerRange: null,
    aiOpen: false,
    aiBusy: false,
    aiScope: 'selection',
    aiRange: null,
    aiDraft: '',
    aiItems: [],
    aiInfo: '',
    aiError: '',
    aiCode: '',
    aiRaw: '',
    // 悬浮对话窗：只活在内存里，关掉窗口就没了（不落库、不产生划线）
    talkOpen: false,
    talkBusy: false,
    talkQuote: '',
    talkMsgs: [],
    talkInput: '',
    talkInputIsDefault: false,   // 输入框里现在是不是那句预填的默认提示词
    talkError: '',
    talkCode: '',
    talkPos: null,
    talkDrag: null,
    // 页面内的模型切换菜单（AI 分析面板和对话窗共用）
    modelMenuFor: '',
    modelBusy: false,
    modelError: '',
    modelCode: '',
    modelList: [],
    modelAnchor: null,
    modelCache: { models: [], at: 0, baseUrl: '' }
  };

  /* ------------------------------------------------------------------ 界面骨架 */

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .mn {
    position: fixed; inset: 0; pointer-events: none;
    font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #1f2937; z-index: 2147483000;
  }
  .mn button { font: inherit; cursor: pointer; border: none; background: none; color: inherit; }
  .mn .card {
    pointer-events: auto; position: absolute;
    background: #fff; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(15, 23, 42, .18), 0 0 0 1px rgba(15, 23, 42, .08);
  }
  /* Firefox 把 hidden 当"表现属性"实现，优先级低于作者样式；Chrome 同理。
     只要下面给元素写了 display，hidden 就形同虚设 —— 于是工具条/弹层/侧栏永远隐藏不掉。
     这条规则把它们拉回来，作为 setShown() 内联样式之外的第二道保险。 */
  .mn [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    .mn { color: #e5e7eb; }
    .mn .card { background: #1f2430; box-shadow: 0 8px 28px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
  }

  /* 自定义颜色面板：外框交给取色器自己画 */
  .mn .mn-picker { padding: 0; background: none; box-shadow: none; border-radius: 0; }

  /* 选中文字后的小工具条 */
  .mn-toolbar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; }
  .mn-dot {
    width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.12);
  }
  .mn-dot:hover { transform: scale(1.12); }
  .mn-dot[data-active="1"] { border-color: #3b5bdb; }
  /* 自定义颜色入口：一个彩色小方块（色环的缩略），点开是取色器 */
  .mn-dot-add {
    width: 20px; height: 20px; border-radius: 5px; padding: 0; flex: none;
    border: 1px solid rgba(15, 23, 42, .22);
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; line-height: 1; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .55);
    background: conic-gradient(from 0deg,
      #ff5f6d 0deg, #ffc371 60deg, #a8e063 120deg, #56c1ff 180deg, #b06ab3 240deg, #ff5f6d 300deg);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .45);
  }
  .mn-dot-add:hover { transform: scale(1.12); }
  .mn-dot-add[data-active="1"] { border-color: #3b5bdb; box-shadow: 0 0 0 1px #3b5bdb; }
  .mn-toolbar .sep { width: 1px; height: 18px; background: rgba(120,130,150,.3); margin: 0 3px; }
  .mn-tbtn { padding: 3px 7px; border-radius: 6px; white-space: nowrap; }
  .mn-tbtn:hover { background: rgba(120,130,150,.16); }

  /* 批注弹层 */
  .mn-pop { width: 330px; padding: 12px; display: flex; flex-direction: column; gap: 9px; }
  .mn-quote {
    max-height: 76px; overflow: auto; padding: 8px 10px; border-radius: 8px;
    background: rgba(255, 224, 102, .35); font-size: 12.5px; white-space: pre-wrap;
  }
  .mn-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .mn-pop textarea, .mn-pop input {
    width: 100%; font: inherit; padding: 7px 9px; border-radius: 8px;
    border: 1px solid rgba(120,130,150,.4); background: transparent; color: inherit; resize: vertical;
  }
  .mn-pop textarea { min-height: 62px; }
  .mn-pop textarea:focus, .mn-pop input:focus { outline: 2px solid rgba(59,91,219,.5); border-color: transparent; }
  .mn-chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px 2px 8px;
    border-radius: 999px; background: rgba(59,91,219,.14); font-size: 12px;
  }
  .mn-chip button { opacity: .6; font-size: 13px; line-height: 1; }
  .mn-chip button:hover { opacity: 1; }
  .mn-main { padding: 6px 12px; border-radius: 8px; background: #3b5bdb; color: #fff; font-weight: 600; }
  .mn-main:hover { background: #3451c6; }
  .mn-ghost { padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(120,130,150,.4); }
  .mn-ghost:hover { background: rgba(120,130,150,.14); }
  .mn-ghost.danger { color: #e03131; border-color: rgba(224,49,49,.5); }
  .mn-meta { font-size: 11.5px; opacity: .62; display: flex; justify-content: space-between; gap: 8px; }

  /* 右侧常驻小工具条 */
  .mn-side {
    /* 必须显式写 pointer-events:auto：外面那层 .mn 是 none（为了不挡页面点击），
       而 pointer-events 是可继承属性，不写这一条整条侧栏就点不动。 */
    pointer-events: auto;
    position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 7px;
    padding: 8px 6px; border-radius: 999px;
    background: rgba(255,255,255,.92); backdrop-filter: blur(6px);
    box-shadow: 0 6px 20px rgba(15,23,42,.16), 0 0 0 1px rgba(15,23,42,.07);
    opacity: .45; transition: opacity .15s ease;
  }
  .mn-side:hover { opacity: 1; }
  @media (prefers-color-scheme: dark) {
    .mn-side { background: rgba(31,36,48,.94); box-shadow: 0 6px 20px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
  }
  .mn-side .mn-dot { width: 17px; height: 17px; }
  .mn-side-btn {
    width: 26px; height: 26px; border-radius: 50%; font-size: 14px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .mn-side-btn:hover { background: rgba(120,130,150,.18); }
  .mn-side-btn[data-on="1"] { background: rgba(59,91,219,.18); }
  .mn-side-count { font-size: 11px; opacity: .7; font-variant-numeric: tabular-nums; }

  .mn-toast {
    position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 999px; background: rgba(17,24,39,.9); color: #fff;
    font-size: 12.5px; opacity: 0; transition: opacity .2s ease; pointer-events: none;
    max-width: min(560px, calc(100vw - 40px));
  }
  .mn-toast.show { opacity: 1; }
  /* 带「撤销」这类按钮的提示条要点得到，所以单独放开鼠标事件 */
  .mn-toast.has-act { pointer-events: auto; padding-right: 7px; }
  .mn-toast-msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mn-toast-act {
    flex: none; border: 0; border-radius: 999px; padding: 4px 12px;
    font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
    color: #111827; background: #ffe066;
  }
  .mn-toast-act:hover { background: #ffd43b; }

  /* AI 分析面板：一个居中的模态卡片 */
  .mn-ai-mask {
    pointer-events: auto; position: absolute; inset: 0;
    background: rgba(15, 23, 42, .3);
  }
  .mn-ai {
    display: flex; flex-direction: column; overflow: hidden;
    width: 460px; max-width: calc(100vw - 28px); max-height: min(78vh, 720px);
    left: 50%; top: 50%; transform: translate(-50%, -50%);
    padding: 0;
  }
  .mn-ai-head {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px;
    border-bottom: 1px solid rgba(120,130,150,.22); flex: none;
  }
  .mn-ai-head strong { font-size: 13.5px; }
  .mn-ai-scope { display: flex; gap: 4px; margin-left: auto; }
  .mn-ai-scope button {
    font-size: 12px; padding: 3px 9px; border-radius: 999px;
    border: 1px solid rgba(120,130,150,.45); opacity: .72;
  }
  .mn-ai-scope button[data-on="1"] { background: #3b5bdb; border-color: #3b5bdb; color: #fff; opacity: 1; }
  .mn-ai-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
  .mn-ai-prompt {
    width: 100%; min-height: 56px; max-height: 140px; resize: vertical;
    font: inherit; font-size: 12.5px; padding: 7px 9px; border-radius: 8px;
    border: 1px solid rgba(120,130,150,.45); background: transparent; color: inherit;
  }
  .mn-ai-prompt:focus { outline: 2px solid rgba(59,91,219,.5); border-color: transparent; }
  .mn-ai-foot { display: flex; align-items: center; gap: 8px; }
  .mn-ai-status { font-size: 12px; opacity: .7; flex: 1; min-width: 0; word-break: break-word; }
  .mn-ai-status.error { color: #e03131; opacity: 1; font-weight: 600; }
  /* 服务端报错原文：可能又长又是英文，单独放一块可滚动的区域，别把面板撑歪 */
  .mn-ai-err {
    font-size: 12px;
    line-height: 1.55;
    color: #b42318;
    background: rgba(224, 49, 49, .07);
    border: 1px solid rgba(224, 49, 49, .22);
    border-radius: 8px;
    padding: 7px 9px;
    max-height: 132px;
    overflow: auto;
    word-break: break-word;
    white-space: pre-wrap;
  }
  @media (prefers-color-scheme: dark) {
    .mn-ai-err { color: #ffb4ab; background: rgba(224, 49, 49, .12); }
  }
  .mn-ai-btn { padding: 6px 13px; border-radius: 8px; font-size: 12.5px; white-space: nowrap; }
  .mn-ai-btn.primary { background: #3b5bdb; color: #fff; font-weight: 600; }
  .mn-ai-btn.primary:hover { background: #3451c6; }
  .mn-ai-btn.ghost { border: 1px solid rgba(120,130,150,.45); }
  .mn-ai-btn.ghost:hover { background: rgba(120,130,150,.14); }
  .mn-ai-btn[disabled] { opacity: .45; cursor: default; }
  .mn-ai-hint { font-size: 11.5px; opacity: .68; line-height: 1.45; }
  .mn-ai-item {
    display: flex; gap: 8px; padding: 8px 9px;
    border: 1px solid rgba(120,130,150,.28); border-radius: 9px;
  }
  .mn-ai-item.miss { opacity: .58; }
  .mn-ai-item input[type="checkbox"] { margin: 2px 0 0; flex: none; }
  .mn-ai-item .mn-ai-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; flex: none; }
  .mn-ai-item .grow { flex: 1; min-width: 0; display: block; }
  .mn-ai-quote {
    display: block; font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
    max-height: 3.9em; overflow: hidden;
  }
  .mn-ai-note {
    width: 100%; margin-top: 5px; font: inherit; font-size: 12.5px; padding: 5px 8px;
    border-radius: 7px; border: 1px solid rgba(120,130,150,.4); background: transparent; color: inherit;
  }
  .mn-ai-note:focus { outline: 2px solid rgba(59,91,219,.45); border-color: transparent; }
  .mn-ai-badge {
    display: inline-block; margin-top: 5px; font-size: 11px; padding: 1px 7px;
    border-radius: 999px; background: rgba(224,49,49,.15); color: #e03131;
  }
  /* AI 对话：一个悬浮小窗（不是模态，可以一边看页面一边聊） */
  .mn-talk {
    display: flex; flex-direction: column; overflow: hidden;
    width: 380px; max-width: calc(100vw - 24px);
    min-height: 190px; max-height: min(64vh, 560px);
    padding: 0;
  }
  .mn-talk-head {
    display: flex; align-items: center; gap: 6px; padding: 8px 10px;
    border-bottom: 1px solid rgba(120,130,150,.22); flex: none;
    cursor: grab;
  }
  .mn-talk-head:active { cursor: grabbing; }
  .mn-talk-head strong { font-size: 13px; }
  .mn-talk-model { font-size: 11px; opacity: .6; }
  .mn-talk-chip {
    font-size: 11px; padding: 1px 7px; border-radius: 999px; max-width: 132px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: rgba(59,91,219,.12); color: #3b5bdb;
  }
  .mn-talk-chip.empty { background: rgba(120,130,150,.16); color: inherit; opacity: .6; }
  .mn-talk-body {
    flex: 1; min-height: 88px; overflow: auto; padding: 10px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .mn-talk-msg {
    font-size: 12.5px; line-height: 1.6; padding: 7px 10px; border-radius: 10px;
    max-width: 92%; white-space: normal; word-break: break-word;
  }
  .mn-talk-msg.user { align-self: flex-end; background: #3b5bdb; color: #fff; border-bottom-right-radius: 3px; }
  .mn-talk-msg.assistant { align-self: flex-start; background: rgba(120,130,150,.14); border-bottom-left-radius: 3px; }
  .mn-talk-msg.assistant code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    background: rgba(15,23,42,.09); padding: 1px 4px; border-radius: 4px;
  }
  .mn-talk-msg.pending { opacity: .7; display: flex; align-items: center; gap: 6px; }
  .mn-talk-empty { font-size: 12px; opacity: .62; line-height: 1.6; }
  .mn-talk-foot { flex: none; padding: 8px 10px 9px; border-top: 1px solid rgba(120,130,150,.22); }
  .mn-talk-inputrow { display: flex; align-items: flex-end; gap: 7px; }
  .mn-talk-inputrow textarea {
    flex: 1; min-width: 0; min-height: 40px; max-height: 108px; resize: vertical;
    font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 8px;
    border: 1px solid rgba(120,130,150,.45); background: transparent; color: inherit;
  }
  .mn-talk-inputrow textarea:focus { outline: 2px solid rgba(59,91,219,.5); border-color: transparent; }
  .mn-talk-tip { font-size: 11px; opacity: .55; margin-top: 5px; }
  @media (prefers-color-scheme: dark) {
    .mn-talk-msg.user { background: #3b5bdb; }
    .mn-talk-msg.assistant { background: rgba(255,255,255,.09); }
    .mn-talk-chip { background: rgba(120,150,255,.18); color: #a9c1ff; }
  }
  /* 页面内切换模型：一个小小的下拉菜单 */
  .mn-model-btn {
    font-size: 11.5px; padding: 2px 8px; border-radius: 999px; max-width: 156px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    border: 1px solid rgba(120,130,150,.45); opacity: .85;
  }
  .mn-model-btn:hover { background: rgba(120,130,150,.14); opacity: 1; }
  .mn-models {
    display: flex; flex-direction: column; overflow: hidden;
    min-width: 220px; max-width: min(340px, calc(100vw - 16px));
    max-height: min(56vh, 420px); padding: 0;
  }
  .mn-models-head {
    display: flex; align-items: center; gap: 6px; padding: 8px 10px;
    border-bottom: 1px solid rgba(120,130,150,.22); flex: none; font-size: 12.5px;
  }
  .mn-models-list { overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 3px; }
  .mn-model-item {
    text-align: left; font-size: 12.5px; padding: 6px 9px; border-radius: 7px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .mn-model-item:hover { background: rgba(120,130,150,.14); }
  .mn-model-item[data-on="1"] { background: rgba(59,91,219,.14); color: #3b5bdb; font-weight: 600; }
  .mn-models-hint { font-size: 11px; opacity: .62; line-height: 1.5; padding: 8px 10px; }
  .mn-models-actions { padding: 0 10px 9px; }
  @media (prefers-color-scheme: dark) {
    .mn-model-item[data-on="1"] { background: rgba(120,150,255,.18); color: #a9c1ff; }
  }
  .mn-spin {
    display: inline-block; width: 11px; height: 11px; margin-right: 5px; vertical-align: -1px;
    border: 2px solid rgba(59,91,219,.3); border-top-color: #3b5bdb; border-radius: 50%;
    animation: mn-spin .7s linear infinite;
  }
  @keyframes mn-spin { to { transform: rotate(360deg); } }
  `;

  /** 统一的显示 / 隐藏。hidden 属性会被作者样式里的 display 压掉，所以内联样式兜底。 */
  function setShown(el, on) {
    if (!el) return;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'marknote-host';
    host.setAttribute('data-mn-skip', '1');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="mn">
        <div class="card mn-toolbar" hidden></div>
        <div class="card mn-pop" hidden></div>
        <div class="card mn-picker" hidden></div>
        <div class="mn-ai-mask" hidden></div>
        <div class="card mn-ai" hidden></div>
        <div class="card mn-talk" hidden></div>
        <div class="card mn-models" hidden></div>
        <div class="mn-side" hidden></div>
        <div class="mn-toast"></div>
      </div>`;
    (document.documentElement || document.body).appendChild(host);
    state.host = host;
    state.shadow = shadow;
    state.el.toolbar = shadow.querySelector('.mn-toolbar');
    state.el.pop = shadow.querySelector('.mn-pop');
    state.el.picker = shadow.querySelector('.mn-picker');
    state.el.aiMask = shadow.querySelector('.mn-ai-mask');
    state.el.ai = shadow.querySelector('.mn-ai');
    state.el.talk = shadow.querySelector('.mn-talk');
    state.el.models = shadow.querySelector('.mn-models');
    state.el.side = shadow.querySelector('.mn-side');
    state.el.toast = shadow.querySelector('.mn-toast');
    renderToolbar();
    renderPopover();
    renderSideBar();
  }

  /**
   * 颜色点。active 可以是内置色 id，也可以是 #rrggbb（自定义色）——
   * 所以这里按实际色值比对，而不是按 id。
   */
  const dotsHTML = (active) => {
    const cur = String(MN.colorOf(active).light || '').toLowerCase();
    const dots = MN.allColors()
      .map(
        (c) =>
          `<button class="mn-dot" data-act="color" data-color="${c.id}" data-active="${
            String(c.light).toLowerCase() === cur ? 1 : 0
          }" title="${c.custom ? c.label + '（自定义）' : c.label}" style="background:${c.light}"></button>`
      )
      .join('');
    const isCustom = !MN.COLORS.some((c) => c.light.toLowerCase() === cur);
    return (
      dots +
      `<button class="mn-dot-add" data-act="custom" data-active="${isCustom ? 1 : 0}" title="自定义颜色：色环 / RGB">＋</button>`
    );
  };

  function renderToolbar() {
    state.el.toolbar.innerHTML = `
      ${dotsHTML(state.settings.defaultColor)}
      <span class="sep"></span>
      <button class="mn-tbtn" data-act="ai" title="用 AI 分析选中的文字（Alt+Shift+A）">AI</button>
      <button class="mn-tbtn" data-act="talk" title="和 AI 就这段文字聊几句（不产生划线）">对话</button>
      <button class="mn-tbtn" data-act="note" title="高亮并写笔记">笔记</button>
      <button class="mn-tbtn" data-act="copy" title="复制选中的文字">复制</button>`;
  }

  function renderSideBar() {
    const el = state.el.side;
    el.innerHTML = `
      ${dotsHTML(state.settings.defaultColor)}
      <button class="mn-side-btn" data-act="ai" title="AI 分析：选中文字，或分析整页正文">✦</button>
      <button class="mn-side-btn" data-act="list" title="打开划线清单">☰</button>
      <button class="mn-side-btn" data-act="eye" data-on="${state.hidden ? 1 : 0}" title="显示 / 隐藏本页高亮">◉</button>
      <button class="mn-side-btn" data-act="unlock" data-on="${state.unlocked ? 1 : 0}" title="允许本页选中 / 复制（仅在你的浏览器里，首次需在弹窗里确认）">⧉</button>
      <button class="mn-side-btn" data-act="dismiss" title="隐藏这条侧栏（可在扩展弹窗里再打开）">✕</button>
      <div class="mn-side-count" data-role="count">0</div>`;
    setShown(el, !!state.settings.showSideBar);
  }

  function renderPopover() {
    const pop = state.el.pop;
    const ann = state.popoverAnn;
    if (!ann) {
      setShown(pop, false);
      pop.innerHTML = '';
      return;
    }
    const color = MN.colorOf(ann.color);
    const quote =
      ann.type === 'image' ? `［图片］${ann.image && ann.image.src ? ann.image.src : ''}` : ann.anchor.exact;
    pop.innerHTML = `
      <div class="mn-quote" style="background:${color.light}66">${escapeHtml(quote)}</div>
      <div class="mn-row">${dotsHTML(ann.color)}</div>
      <textarea data-role="note" placeholder="写点想法…（⌘/Ctrl + Enter 保存）">${escapeHtml(ann.note || '')}</textarea>
      <div class="mn-row" data-role="tags"></div>
      <input data-role="taginput" list="mn-taglist" placeholder="加标签，回车确认；用 / 分多级，例如 技术/前端" >
      <datalist id="mn-taglist"></datalist>
      <div class="mn-row" style="justify-content: space-between">
        <span class="mn-meta">${MN.fmtTime(ann.createdAt || Date.now())}</span>
        <span class="mn-row">
          <button class="mn-ghost" data-act="talk">AI 对话</button>
          <button class="mn-ghost" data-act="copy">复制</button>
          <button class="mn-ghost danger" data-act="delete">删除</button>
          <button class="mn-main" data-act="save">保存</button>
        </span>
      </div>`;
    renderTagChips();
    fillTagList();
    setShown(pop, true);
  }

  function renderTagChips() {
    const box = state.el.pop.querySelector('[data-role="tags"]');
    if (!box) return;
    box.innerHTML = state.editingTags
      .map((t, i) => `<span class="mn-chip">${escapeHtml(t)}<button data-act="untag" data-i="${i}">×</button></span>`)
      .join('');
  }

  function fillTagList() {
    const list = state.el.pop.querySelector('#mn-taglist');
    if (!list) return;
    const tags = new Set();
    state.annotations.forEach((a) => (a.tags || []).forEach((t) => tags.add(t)));
    list.innerHTML = [...tags].map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 提示条。第三个参数给了就带一个按钮（比如「撤销」），点完自动收起。
   * action: { label, onClick, keepOpen }
   */
  function toast(msg, ms = 1800, action) {
    const el = state.el.toast;
    if (!el) return;
    el.textContent = '';
    const text = document.createElement('span');
    text.className = 'mn-toast-msg';
    text.textContent = msg;
    el.appendChild(text);
    if (action && action.label) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mn-toast-act';
      btn.textContent = action.label;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(toast._t);
        el.classList.remove('show');
        if (action.onClick) action.onClick();
      });
      el.appendChild(btn);
      el.classList.add('has-act');
    } else {
      el.classList.remove('has-act');
    }
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ------------------------------------------------------------------ 高亮序号

     序号用伪元素画（content: attr(data-idx)），**绝不往正文里插节点**——
     插了会改变页面的可见文本，定位引擎下次就对不上了。
  */

  /** 给本页每条标注算一个序号：默认按在正文里的位置，也可以按创建时间。 */
  function indexMap() {
    const mode = MN.normalizeIndexMode(state.settings.indexMode);
    const list = state.annotations.slice();
    const place = (a) => (a.anchor && typeof a.anchor.startV === 'number' ? a.anchor.startV : Number.MAX_SAFE_INTEGER);
    const born = (a) => Number(a.createdAt) || 0;
    list.sort((a, b) => {
      if (mode === 'order') return born(a) - born(b) || String(a.id).localeCompare(String(b.id));
      // 定位失败的排最后，按创建时间兜底；同一处（比如同位置的图片标注）再按时间
      return place(a) - place(b) || born(a) - born(b);
    });
    const map = new Map();
    list.forEach((a, i) => map.set(a.id, i + 1));
    return map;
  }

  /**
   * 把序号刷到高亮上。一条标注可能被拆成好几个 <mark>（跨了 <b> 之类），
   * 只给第一个带序号，剩下的只做标记，免得同一个号出现两次。
   */
  function applyIndexNumbers() {
    if (!document.body) return;
    document.querySelectorAll('mark.mn-hl').forEach((m) => {
      delete m.dataset.idx;
      delete m.dataset.idxCont;
    });
    if (!state.settings.showIndex) return;
    const map = indexMap();
    const done = new Set();
    document.querySelectorAll('mark.mn-hl').forEach((m) => {
      const id = m.dataset.ann;
      if (!id || !map.has(id)) return;
      if (done.has(id)) {
        m.dataset.idxCont = '1';
        return;
      }
      done.add(id);
      m.dataset.idx = String(map.get(id));
    });
  }

  /* ------------------------------------------------------------------ 高亮渲染 */

  function applyAnnotation(ann) {
    if (ann.type === 'image') {
      const img = findImage(ann);
      if (!img) {
        state.lost.push(ann);
        return false;
      }
      img.classList.add('mn-img-hl');
      img.dataset.mnAnn = ann.id;
      return true;
    }
    if (!ann.anchor) {
      state.lost.push(ann);
      return false;
    }
    // 已经画过了就只刷新样式，避免并发刷新时重复包裹
    const existing = document.querySelectorAll(`mark.mn-hl[data-ann="${ann.id}"]`);
    if (existing.length) {
      existing.forEach((m) => decorateMark(m, ann));
      return true;
    }
    const spans = MN.anchors.textNodes(document.body);
    const bounds = MN.anchors.resolveVirtual(ann.anchor, spans, MN.anchors.virtualTextFrom(spans));
    if (!bounds) {
      state.lost.push(ann);
      return false;
    }
    const marks = MN.anchors.wrapVirtualRange(spans, bounds[0], bounds[1], ann, MN.colorOf(ann.color));
    if (!marks.length) {
      state.lost.push(ann);
      return false;
    }
    marks.forEach((m) => decorateMark(m, ann));
    return true;
  }

  /** 给高亮元素补上颜色、笔记标记等属性（重复调用安全）。 */
  function decorateMark(m, ann) {
    const c = MN.colorOf(ann.color);
    m.dataset.color = ann.color;
    m.style.setProperty('--mn-bg', c.light);
    m.style.setProperty('--mn-bg-dark', c.dark);
    if (ann.note) m.dataset.note = '1';
    else delete m.dataset.note;
    m.title = ann.note ? ann.note : 'MarkNote 划线';
  }

  /**
   * 把一条标注的最新版本同步进内存里的列表。
   * 以前这里靠"写入后整页重渲染"兜底，现在本页面自己的写入不再触发重渲染，
   * 就必须显式维护，否则侧边栏 / 导出的数据会停在旧值。
   */
  function syncLocal(rec) {
    if (!rec || !rec.id) return;
    const i = state.annotations.findIndex((a) => a.id === rec.id);
    if (i >= 0) state.annotations[i] = rec;
    else state.annotations.push(rec);
    updateCount();
  }

  /** 新划线立刻上屏；若并发的 reload 已经把它算进去了，就不要再塞一遍。 */
  function addLocal(ann) {
    syncLocal(ann);
    applyAnnotation(ann);
  }

  function renderAll() {
    if (document.body) MN.anchors.unwrapAll(document.body);
    document.querySelectorAll('img.mn-img-hl').forEach((img) => {
      img.classList.remove('mn-img-hl');
      delete img.dataset.mnAnn;
    });
    state.lost = [];
    state.annotations.forEach(applyAnnotation);
    applyIndexNumbers();
    updateCount();
    if (state.lost.length) {
      if (!state.lostNotified) {
        state.lostNotified = true;
        toast(`有 ${state.lost.length} 处标注暂时没找到位置，正在自动重试`, 2400);
      }
      scheduleLostRetries();
    }
  }

  /**
   * 刷新后标注消失，最常见的两个原因是"内容还没渲染出来"和"页面把正文整段换掉了"。
   * 光在 document_idle 里试一次不够，这里给一条退避重试阶梯，配合下面的 DOM 观察器。
   */
  function scheduleLostRetries() {
    if (!state.lost.length || state.lostRetryTimer) return;
    const delays = [900, 2600, 6000, 15000];
    if (state.lostRetryStep >= delays.length) return;
    const wait = delays[state.lostRetryStep++];
    state.lostRetryTimer = setTimeout(() => {
      state.lostRetryTimer = null;
      if (!state.lost.length) return;
      renderAll();
    }, wait);
  }

  /**
   * SPA / 懒加载 / 评论区滚动加载：正文是在内容脚本注入之后才进 DOM 的。
   * 只要还有没定位上的划线，DOM 一有变动就重试；全部定位成功后回调会立刻返回，开销可以忽略。
   */
  function watchDom() {
    if (state.domObserver || typeof MutationObserver !== 'function' || !document.body) return;
    state.domObserver = new MutationObserver(() => {
      if (!state.lost.length || state.domRetryTimer) return;
      state.domRetryTimer = setTimeout(() => {
        state.domRetryTimer = null;
        if (state.lost.length) renderAll();
      }, 500);
    });
    state.domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function updateCount() {
    const el = state.el.side && state.el.side.querySelector('[data-role="count"]');
    if (el) el.textContent = String(state.annotations.length);
  }

  function findImage(ann) {
    const src = ann.image && ann.image.src;
    if (!src) return null;
    const all = [...document.querySelectorAll('img')];
    return (
      all.find((img) => img.src === src || img.currentSrc === src) ||
      (typeof ann.image.index === 'number' ? all[ann.image.index] : null) ||
      null
    );
  }

  /**
   * 取本页划线。1.1.0 改了 URL 键的算法（hash 路由不再被抹平），
   * 这里顺手把老键下、而且在本页确实能定位到的划线认领过来，避免升级后"全部消失"。
   */
  async function loadAnnotations() {
    const list = await MN.store.forUrl(location.href);
    if (list.length) return list;
    const legacyKey = MN.legacyUrlKey(location.href);
    const curKey = MN.normalizeUrl(location.href);
    if (!legacyKey || legacyKey === curKey) return list;
    const orphans = (await MN.store.all()).filter(
      (a) => a.url === legacyKey && a.type === 'text' && a.anchor
    );
    if (!orphans.length) return list;
    const spans = MN.anchors.textNodes(document.body);
    const vt = MN.anchors.virtualTextFrom(spans);
    const adopted = [];
    for (const a of orphans) {
      if (!MN.anchors.resolveVirtual(a.anchor, spans, vt)) continue; // 本页定位不上就不认领，免得串台
      try {
        await MN.store.patch(a.id, { url: curKey });
        adopted.push({ ...a, url: curKey });
      } catch (_e) {
        /* 迁移失败就跳过，不影响其它划线 */
      }
    }
    if (adopted.length) console.info(`[MarkNote] 已把 ${adopted.length} 条旧键划线迁移到当前页面`);
    return adopted;
  }

  async function reload() {
    try {
      state.lostRetryStep = 0;
      state.annotations = await loadAnnotations();
      renderAll();
    } catch (e) {
      console.warn('[MarkNote] 载入划线失败', e);
    }
  }

  /**
   * 一键清空本页划线。故意不做二次确认弹窗（那就不叫一键了），
   * 改成先删掉、再给 9 秒「撤销」——手里正好有刚删掉的完整数据，撤销就是原样写回去。
   */
  async function clearPageAnnotations() {
    const list = state.annotations.slice();
    if (!list.length) {
      toast('本页还没有划线');
      return { ok: true, cleared: 0 };
    }
    const ids = list.map((a) => a.id);
    try {
      await MN.store.removeMany(ids);
    } catch (e) {
      toast('清空失败：' + ((e && e.message) || e));
      return { ok: false, error: (e && e.message) || String(e) };
    }
    closePopover();
    closePicker();
    hideToolbar();
    await reload();
    toast(`已清空本页 ${list.length} 条划线`, 9000, {
      label: '撤销',
      onClick: async () => {
        try {
          const r = await MN.store.importBundle({ annotations: list }, 'merge');
          await reload();
          toast(`已恢复 ${r.added} 条划线`);
        } catch (e) {
          toast('恢复失败：' + ((e && e.message) || e), 4000);
        }
      }
    });
    return { ok: true, cleared: list.length };
  }

  const scheduleReload = MN.debounce(() => {
    const openId = state.popoverAnn && state.popoverAnn.id;
    reload().then(() => {
      if (openId) {
        const still = state.annotations.find((a) => a.id === openId);
        if (still) {
          state.popoverAnn = still;
          renderPopover();
        } else {
          closePopover();
        }
      }
    });
  }, 60);

  /* ------------------------------------------------------------------ 自定义颜色 */

  function closePicker() {
    const holder = state.el.picker;
    if (state.picker) {
      try {
        state.picker.destroy();
      } catch (_e) {
        /* 忽略 */
      }
      state.picker = null;
    }
    if (holder) {
      holder.innerHTML = '';
      setShown(holder, false);
    }
    state.pickerRange = null;
  }

  /** 把颜色套到「正在编辑的划线 / 当前选区 / 默认色」上。 */
  async function applyPickedColor(hex, opts = {}) {
    const norm = MN.normalizeHex(hex);
    if (!norm) return;
    if (opts.save) await saveCustomColor(norm);

    if (state.popoverAnn) {
      await applyColorToAnnotation(state.popoverAnn, norm);
      renderPopover();
      return;
    }
    // opts.range 是打开取色器那一刻记下的选区：输入框会抢焦点，事后再取就没了
    const range = opts.range || state.pickerRange || currentSelectionRange();
    if (range) {
      await createFromSelection(norm, { range });
      return;
    }
    state.settings.defaultColor = norm;
    await MN.store.setSettings({ defaultColor: norm });
    renderToolbar();
    renderSideBar();
    toast('默认颜色已切换为 ' + norm);
  }

  /** 加进 settings.customColors，并让工具条 / 批注层 / 取色器的色板立即更新。 */
  async function saveCustomColor(hex) {
    const list = Array.isArray(state.settings.customColors) ? state.settings.customColors.slice() : [];
    if (!list.some((c) => MN.normalizeHex(c) === hex)) list.push(hex);
    state.settings.customColors = list;
    MN.setCustomColors(list);
    await MN.store.setSettings({ customColors: list });
    renderToolbar();
    renderSideBar();
    if (state.popoverAnn) renderPopover();
    if (state.picker) state.picker.setValue(hex);
    toast('已把 ' + hex + ' 加入常用色');
  }

  /** 从常用色里删掉一个颜色。已经划好的线不受影响，只是色板上不再出现它。 */
  async function deleteCustomColor(hex) {
    const list = (Array.isArray(state.settings.customColors) ? state.settings.customColors : []).filter(
      (c) => MN.normalizeHex(c) !== hex
    );
    if (list.length === (state.settings.customColors || []).length) return;
    state.settings.customColors = list;
    MN.setCustomColors(list);
    await MN.store.setSettings({ customColors: list });
    renderToolbar();
    renderSideBar();
    if (state.popoverAnn) renderPopover();
    toast('已从常用色移除 ' + hex);
  }

  /**
   * 在 anchorEl 旁边弹出取色器。打开时先把当前选区记下来：
   * 取色器里的输入框会抢走焦点，等到点「应用」时再取选区就晚了。
   */
  function openPicker(anchorEl) {
    const holder = state.el.picker;
    if (!holder || !MN.createColorPicker) return;
    const editing = state.popoverAnn || null;
    const selRange = editing ? null : currentSelectionRange();
    state.pickerRange = selRange;
    if (state.picker) {
      try {
        state.picker.destroy();
      } catch (_e) {
        /* 忽略 */
      }
      state.picker = null;
    }
    holder.innerHTML = '';
    state.picker = MN.createColorPicker({
      root: state.shadow,
      value: MN.colorOf(editing ? editing.color : state.settings.defaultColor).light,
      onPick: (hex) => {
        applyPickedColor(hex, { range: selRange });
        closePicker();
      },
      onSave: (hex) => {
        applyPickedColor(hex, { save: true, range: selRange });
        closePicker();
      },
      onDelete: (hex) => {
        deleteCustomColor(hex);
      },
      onCancel: closePicker
    });
    holder.appendChild(state.picker.el);
    setShown(holder, true);

    const rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const w = holder.offsetWidth || 288;
    const h = holder.offsetHeight || 250;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const anchor = rect && (rect.width || rect.height) ? rect : { left: vw / 2 - w / 2, right: vw / 2 + w / 2, top: vh - 220, bottom: vh - 180, width: 0 };
    let top = anchor.bottom + 8;
    if (top + h > vh - 8) top = anchor.top - h - 8;
    const left = Math.max(8, Math.min(vw - w - 8, anchor.left + anchor.width / 2 - w / 2));
    holder.style.left = Math.round(left) + 'px';
    holder.style.top = Math.round(Math.max(8, Math.min(vh - h - 8, top))) + 'px';
    state.picker.focus();
  }

  /** 别的地方改了设置（比如在弹窗里加了个常用色），页面里的色板跟着刷新。 */
  async function refreshSettings() {
    try {
      const s = (await MN.store.getSettings()) || {};
      state.settings = { ...state.settings, ...s };
      MN.setCustomColors(state.settings.customColors);
      applyIndexNumbers();
      renderToolbar();
      renderSideBar();
      if (state.popoverAnn) renderPopover();
    } catch (_e) {
      /* 读不到就沿用旧设置 */
    }
  }

  /* ------------------------------------------------------------------ AI 分析

     流程：选一段文字（或整页正文）→ 加上你写的提示词 → 后台代发请求给你自己配置的那个接口
     → 模型回一批「原文片段 + 颜色 + 批注」→ 在这里对照页面把片段锚定成 Range
     → 你挑要哪几条 → 落库成普通划线（之后和手划的完全一样）。
  */

  const AI_MAX_PAGE_CHARS = 12000;

  /** 后台才有跨域权限，AI 请求一律走它。 */
  async function askAi(type, extra) {
    const msg = { type, ...(extra || {}) };
    try {
      if (B) return (await B.runtime.sendMessage(msg)) || { ok: false, error: '后台没有响应' };
      return await new Promise((resolve) => {
        C.runtime.sendMessage(msg, (res) => {
          const err = C.runtime.lastError;
          if (err) resolve({ ok: false, error: MN.sendErrorText(err) });
          else resolve(res || { ok: false, error: '后台没有响应' });
        });
      });
    } catch (e) {
      return { ok: false, error: MN.sendErrorText(e) };
    }
  }

  function aiConfig() {
    return MN.ai ? MN.ai.normalizeConfig(state.settings.ai) : null;
  }

  function selectionText() {
    if (!state.aiRange) return '';
    try {
      return String(state.aiRange.toString() || '').trim();
    } catch (_e) {
      return '';
    }
  }

  function pageText(limit) {
    const spans = MN.anchors.textNodes(document.body);
    const vt = String(MN.anchors.virtualTextFrom(spans) || '');
    const cleaned = vt.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return cleaned.slice(0, limit || AI_MAX_PAGE_CHARS);
  }

  /**
   * 把 AI 摘出来的片段在页面上找回来。
   * 先精确找；找不到就把两边的空白都压掉再找一次（换行、缩进差异是最常见的失配原因）。
   */
  function findQuoteRange(quote) {
    const q = String(quote || '').trim();
    if (q.length < 2) return null;
    let spans;
    let vt;
    try {
      spans = MN.anchors.textNodes(document.body);
      vt = MN.anchors.virtualTextFrom(spans);
    } catch (_e) {
      return null;
    }
    if (!vt) return null;

    let start = vt.indexOf(q);
    let len = q.length;
    if (start < 0) {
      const target = q.replace(/\s+/g, '');
      if (!target) return null;
      const map = [];
      let squashed = '';
      for (let i = 0; i < vt.length; i += 1) {
        if (/\s/.test(vt[i])) continue;
        map.push(i);
        squashed += vt[i];
      }
      const at = squashed.indexOf(target);
      if (at < 0) return null;
      start = map[at];
      len = map[at + target.length - 1] - start + 1;
    }
    try {
      return MN.anchors.rangeFromVirtual(spans, start, start + len) || null;
    } catch (_e) {
      return null;
    }
  }

  function aiItemHTML(it, idx) {
    const color = MN.colorOf(it.color);
    const miss = it.found === false;
    return `
      <div class="mn-ai-item${miss ? ' miss' : ''}">
        <input type="checkbox" data-ai-input="pick" data-i="${idx}" ${it.enabled && !miss ? 'checked' : ''} ${
          miss ? 'disabled' : ''
        } title="要不要写入这条" />
        <span class="mn-ai-dot" style="background:${color.light}" title="${escapeHtml(color.label)}"></span>
        <span class="grow">
          <span class="mn-ai-quote">${escapeHtml(it.quote)}</span>
          <input class="mn-ai-note" data-ai-input="note" data-i="${idx}" value="${escapeHtml(it.note || '')}"
            placeholder="给这条写句批注（可以改）" />
          ${miss ? '<span class="mn-ai-badge">这段原文在页面上找不到，可能已被展开 / 折叠</span>' : ''}
        </span>
      </div>`;
  }

  function renderAiPanel() {
    const el = state.el.ai;
    if (!el) return;
    const cfg = aiConfig();
    const ready = !!(cfg && cfg.enabled && MN.ai);
    const scope = state.aiScope === 'page' ? 'page' : 'selection';
    const items = state.aiItems || [];
    const usable = items.filter((it) => it.enabled && it.found !== false).length;

    const head = `
      <div class="mn-ai-head">
        <strong>AI 分析</strong>
        <button type="button" class="mn-model-btn" data-ai="model" title="切换模型（保存为本机默认）">${
          escapeHtml(cfg.model || '选模型')
        } ▾</button>
        <span class="mn-ai-scope">
          <button type="button" data-ai="scope" data-scope="selection" data-on="${scope === 'selection' ? 1 : 0}">选中文字</button>
          <button type="button" data-ai="scope" data-scope="page" data-on="${scope === 'page' ? 1 : 0}">整页正文</button>
        </span>
        <button type="button" class="mn-tbtn" data-ai="close" title="关闭（Esc）">✕</button>
      </div>`;

    if (!ready) {
      el.innerHTML =
        head +
        `<div class="mn-ai-body">
          <div class="mn-ai-hint">
            ${
              MN.ai
                ? `AI 分析还没打开。到管理页最下面的「<b>AI 分析（第三方接口）</b>」卡片里：填上 API Key、
                   <b>勾上「打开 AI 分析」</b>，再点「保存 AI 设置」。<br />
                   改完设置如果这里还是这句话，刷新一下当前页面（扩展重载过之后，页面里的脚本也得重新注入）。`
                : `AI 模块没加载起来（分发出来的包里少了 <code>src/common/ai.js</code>），
                   请重新载入一次扩展；如果还不行，说明这个包是坏的。`
            }<br />
            开启后，点「分析」时会把<b>你选中的那段文字</b>发给你配置的那个接口，除此之外不会上传任何东西。
          </div>
          <div class="mn-ai-actions"><button type="button" class="mn-ai-btn primary" data-ai="setup">去管理页设置</button></div>
        </div>`;
      return;
    }

    // 服务端的报错可能很长（比如「支持的模型有…」），塞进状态行会把面板撑歪，
    // 所以状态行只说「失败」，原文单独放一块可滚动的区域。
    const status = state.aiBusy
      ? '<span class="mn-spin"></span>正在请 ' + escapeHtml(cfg.model) + ' 分析…'
      : state.aiError
        ? '分析失败'
        : escapeHtml(state.aiInfo || '');
    const statusCls = state.aiBusy ? '' : state.aiError ? ' error' : '';

    el.innerHTML =
      head +
      `<div class="mn-ai-body">
        <textarea class="mn-ai-prompt" data-ai-input="prompt" rows="2"
          placeholder="${escapeHtml(cfg.prompt || MN.ai.DEFAULT_PROMPT)}">${escapeHtml(state.aiDraft)}</textarea>
        ${
          state.aiError && !state.aiBusy
            ? `<div class="mn-ai-err" role="alert">${escapeHtml(state.aiError)}</div>`
            : ''
        }
        <div class="mn-ai-foot">
          <span class="mn-ai-status${statusCls}">${status || escapeHtml(scope === 'selection' ? '选中文字后按「分析」' : '分析整页正文')}</span>
          ${
            // 报错大多要在管理页改设置（模型名、Key、开关），顺手给个直达按钮
            !state.aiBusy && state.aiError && state.aiCode
              ? '<button type="button" class="mn-ai-btn ghost" data-ai="setup">去管理页</button>'
              : ''
          }
          <button type="button" class="mn-ai-btn primary" data-ai="run" ${state.aiBusy ? 'disabled' : ''}>${
            items.length ? '重新分析' : '开始分析'
          }</button>
        </div>
        ${items.length ? `<div class="mn-ai-list">${items.map(aiItemHTML).join('')}</div>` : ''}
        ${
          state.aiRaw && !items.length
            ? `<div class="mn-ai-hint">模型原话：${escapeHtml(state.aiRaw.slice(0, 300))}</div>`
            : ''
        }
        <div class="mn-ai-foot">
          <span class="mn-ai-hint" data-role="pick-count">${
            items.length ? `勾选 ${usable} / ${items.length} 条` : `模型 ${escapeHtml(cfg.model)} · 最多 ${cfg.maxItems} 处`
          }</span>
          <span class="grow" style="flex:1"></span>
          ${
            items.length
              ? `<button type="button" class="mn-ai-btn ghost" data-ai="close">取消</button>
                 <button type="button" class="mn-ai-btn primary" data-ai="apply" ${usable ? '' : 'disabled'}>写入划线</button>`
              : ''
          }        </div>
        <div class="mn-ai-hint">写入后就是普通划线：可以改颜色、加标签、删除。文字会发给你配置的接口，本机之外不留存。</div>
      </div>`;
  }

  function openAiPanel(opts) {
    const o = opts || {};
    const sel = currentSelectionRange();
    state.aiRange = sel || null;
    state.aiOpen = true;
    if (o.scope) state.aiScope = o.scope === 'page' ? 'page' : 'selection';
    else state.aiScope = sel ? 'selection' : 'page';
    // 文本域里要预填「默认提示词」，方便直接改
    if (!state.aiDraft) state.aiDraft = (aiConfig() || {}).prompt || '';
    state.aiItems = [];
    state.aiError = '';
    state.aiInfo = '';
    state.aiCode = '';
    state.aiRaw = '';
    hideToolbar();
    closePicker();
    closePopover();
    setShown(state.el.aiMask, true);
    setShown(state.el.ai, true);
    renderAiPanel();
  }

  function closeAiPanel() {
    closeModelMenu();
    state.aiOpen = false;
    state.aiBusy = false;
    state.aiItems = [];
    state.aiError = '';
    state.aiInfo = '';
    state.aiCode = '';
    state.aiRaw = '';
    state.aiRange = null;
    setShown(state.el.aiMask, false);
    setShown(state.el.ai, false);
  }

  async function runAi() {
    if (state.aiBusy) return;
    const cfg = aiConfig();
    if (!cfg || !cfg.enabled) {
      renderAiPanel();
      return;
    }
    const scope = state.aiScope === 'page' ? 'page' : 'selection';
    const raw = scope === 'page' ? pageText(cfg.maxChars) : selectionText();
    const text = raw.slice(0, cfg.maxChars);
    if (text.replace(/\s+/g, '').length < 10) {
      state.aiError =
        scope === 'page' ? '这一页没抓到多少正文，可能内容还在加载' : '先选中一段文字，或者切到「整页正文」';
      renderAiPanel();
      return;
    }
    state.aiBusy = true;
    state.aiItems = [];
    state.aiError = '';
    state.aiInfo = '';
    state.aiRaw = '';
    renderAiPanel();

    const res = await askAi(MN.MSG.AI_CHAT, {
      payload: {
        text,
        prompt: state.aiDraft,
        scope,
        title: document.title,
        url: location.href
      }
    });
    state.aiBusy = false;
    if (!res || !res.ok) {
      state.aiError = (res && res.error) || '请求失败';
      state.aiCode = (res && res.code) || '';
      state.aiRaw = (res && res.raw) || '';
      renderAiPanel();
      return;
    }
    state.aiCode = '';
    state.aiItems = (res.items || []).map((it) => ({
      quote: it.quote,
      note: it.note || '',
      color: it.color,
      reason: it.reason || '',
      enabled: true,
      found: !!findQuoteRange(it.quote)
    }));
    const bits = [];
    if (res.model) bits.push(res.model);
    bits.push(`发出 ${text.length} 字`);
    if (state.aiItems.length) {
      bits.push(`命中 ${state.aiItems.filter((it) => it.found).length}/${state.aiItems.length} 处`);
    }
    if (res.usage && res.usage.total_tokens) bits.push(`用了 ${res.usage.total_tokens} tokens`);
    if (res.warning) bits.push(res.warning);
    state.aiInfo = bits.join(' · ');
    if (!state.aiItems.length) {
      state.aiError = res.warning || '模型没给出能用的划线';
      state.aiRaw = String(res.raw || '').slice(0, 400);
    }
    renderAiPanel();
  }

  async function applyAiItems() {
    const picks = (state.aiItems || []).filter((it) => it.enabled && it.found !== false);
    if (!picks.length) return;
    const seen = new Set(
      state.annotations.map((a) => String(a.text || '').replace(/\s+/g, ' ').toLowerCase())
    );
    let added = 0;
    let dup = 0;
    let missed = 0;
    for (const it of picks) {
      const key = String(it.quote).replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) {
        dup += 1;
        continue;
      }
      const range = findQuoteRange(it.quote);
      const anchor = range ? MN.anchors.serializeRange(range, document.body) : null;
      if (!anchor) {
        missed += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const ann = await MN.store.put({
        url: MN.normalizeUrl(location.href),
        title: document.title || location.hostname,
        site: MN.hostOf(location.href),
        color: it.color || state.settings.defaultColor,
        type: 'text',
        text: anchor.exact,
        note: String(it.note || '').trim(),
        tags: [],
        anchor,
        source: 'ai'
      });
      addLocal(ann);
      seen.add(key);
      added += 1;
    }
    closeAiPanel();
    const parts = [`AI 写入 ${added} 条划线`];
    if (dup) parts.push(`跳过重复 ${dup} 条`);
    if (missed) parts.push(`${missed} 条没找到位置`);
    toast(parts.join('，'), 2600);
  }

  /** 面板里的点击都走这里（内容会整块重绘，所以用事件委托）。 */
  function onAiClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-ai]') : null;
    if (!btn) return;
    const act = btn.dataset.ai;
    if (act === 'close') {
      e.preventDefault();
      closeAiPanel();
      return;
    }
    if (act === 'scope') {
      e.preventDefault();
      state.aiScope = btn.dataset.scope === 'page' ? 'page' : 'selection';
      renderAiPanel();
      return;
    }
    if (act === 'setup') {
      e.preventDefault();
      sendBg({ type: MN.MSG.OPEN_DASHBOARD });
      return;
    }
    if (act === 'model') {
      e.preventDefault();
      toggleModelMenu('ai', btn);
      return;
    }
    if (act === 'run') {
      e.preventDefault();
      runAi().catch((err) => {
        state.aiBusy = false;
        state.aiError = '分析出错了：' + ((err && err.message) || String(err));
        renderAiPanel();
      });
      return;
    }
    if (act === 'apply') {
      e.preventDefault();
      applyAiItems().catch((err) => {
        console.warn('[MarkNote] AI 写入失败', err);
        toast('写入失败：' + ((err && err.message) || String(err)), 2600);
      });
    }
  }

  function onAiInput(e) {
    const t = e.target;
    if (!t || !t.dataset) return;
    const kind = t.dataset.aiInput;
    if (kind === 'prompt') {
      state.aiDraft = t.value;
      return;
    }
    const idx = Number(t.dataset.i);
    const item = state.aiItems[idx];
    if (!item) return;
    if (kind === 'pick') item.enabled = !!t.checked;
    else if (kind === 'note') item.note = t.value;
    else return;
    // 勾选数量那行文字要跟着变，但不重绘整块（否则输入框会失焦）
    const foot = state.el.ai.querySelector('[data-role="pick-count"]');
    if (foot) {
      const usable = state.aiItems.filter((it) => it.enabled && it.found !== false).length;
      foot.textContent = `勾选 ${usable} / ${state.aiItems.length} 条`;
    }
    const applyBtn = state.el.ai.querySelector('[data-ai="apply"]');
    if (applyBtn) applyBtn.disabled = !state.aiItems.some((it) => it.enabled && it.found !== false);
  }

  /* --------------------------------------------------- AI 对话（悬浮窗，多轮聊天）

     和上面的「AI 分析」是两件事：
       · 分析：一次性请求 → 拿回一批高亮建议 → 勾选后落库成划线；
       · 对话：悬浮窗里连续聊，请求只带回一段文字，**永远不写任何划线**。
     对话只活在内存里（state.talkMsgs），关掉窗口就整体丢掉——不落库、不导出、刷新即失。
  */

  const TALK_W = 380;

  /** 对话预填用的默认提示词：管理页填过就用填的，否则用内置那句。 */
  function chatDefaultPrompt() {
    const cfg = aiConfig() || {};
    const custom = String(cfg.chatPrompt || '').trim();
    if (custom) return custom;
    return (MN.ai && MN.ai.DEFAULT_CHAT_PROMPT) || '帮我解释这段文字的意思，并指出其中的重点。';
  }

  /**
   * 从「上一个值」和「现在的值」里算出用户新敲进去的那部分。
   * 用来实现「输入框里预填了默认提示词，用户一打字就把它清掉」：
   * 不管用户是接在末尾写、全选替换、还是插在中间，都只留下他自己写的内容。
   */
  function insertedText(prev, next) {
    const a = String(prev === undefined || prev === null ? '' : prev);
    const b = String(next === undefined || next === null ? '' : next);
    if (a === b) return '';
    const min = Math.min(a.length, b.length);
    let p = 0;
    while (p < min && a[p] === b[p]) p += 1;
    let s = 0;
    while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
    return b.slice(p, b.length - s);
  }

  function talkReady() {
    const cfg = aiConfig();
    return !!(cfg && cfg.enabled && MN.ai);
  }

  /** 把窗口放回它该在的位置（拖过就一直用拖到的位置）。 */
  function applyTalkPos() {
    const el = state.el.talk;
    if (!el) return;
    const w = el.offsetWidth || TALK_W;
    const h = el.offsetHeight || 260;
    const pos = state.talkPos || { left: window.innerWidth - w - 24, top: 72 };
    const left = Math.max(4, Math.min(pos.left, Math.max(4, window.innerWidth - w - 4)));
    const top = Math.max(4, Math.min(pos.top, Math.max(4, window.innerHeight - h - 4)));
    state.talkPos = { left, top };
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  /** 悬浮窗里的正文：先转义，再放一点点 Markdown，绝不让模型的话变成 HTML。 */
  function talkTextHTML(raw) {
    let t = escapeHtml(String(raw === undefined || raw === null ? '' : raw));
    t = t.replace(/`([^`\n]{1,200})`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>');
    t = t.replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '· ');
    return t.replace(/\n/g, '<br>');
  }

  function talkMsgHTML(m) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const body = role === 'assistant' ? talkTextHTML(m.content) : escapeHtml(m.content).replace(/\n/g, '<br>');
    return `<div class="mn-talk-msg ${role}">${body}</div>`;
  }

  function talkChipHTML() {
    const q = state.talkQuote || '';
    if (!q) return '<span class="mn-talk-chip empty">没有引用文字</span>';
    const short = q.length > 22 ? q.slice(0, 22) + '…' : q;
    return `<span class="mn-talk-chip" title="${escapeHtml(q)}">「${escapeHtml(short)}」</span>`;
  }

  function renderTalk() {
    const el = state.el.talk;
    if (!el) return;
    const cfg = aiConfig();
    const ready = talkReady();
    const msgs = state.talkMsgs || [];
    const head = `
      <div class="mn-talk-head" data-talk-drag="1" title="按住拖动">
        <strong>AI 对话</strong>
        ${
          ready
            ? `<button type="button" class="mn-model-btn" data-talk="model" title="切换模型（保存为本机默认）">${escapeHtml(
                cfg.model || '选模型'
              )} ▾</button>`
            : '<span class="mn-talk-model">未开启</span>'
        }
        ${talkChipHTML()}
        <span class="grow"></span>
        <button type="button" class="mn-tbtn" data-talk="clear" title="清空这几轮对话（窗口不关）">清空</button>
        <button type="button" class="mn-tbtn" data-talk="close" title="关闭：对话只在窗口里，关掉就没了（Esc）">✕</button>
      </div>`;

    if (!ready) {
      el.innerHTML =
        head +
        `<div class="mn-talk-body">
          <div class="mn-ai-hint">
            ${
              MN.ai
                ? `AI 还没打开。到管理页最下面的「<b>AI 分析（第三方接口）</b>」卡片里：填上 API Key、
                   <b>勾上「打开 AI 分析」</b>，再点「保存 AI 设置」。`
                : `AI 模块没加载起来（包里少了 <code>src/common/ai.js</code>），请重新载入一次扩展。`
            }<br />
            开启后，这里的每一轮对话都会把你引用的那段文字和对话记录发给你配置的那个接口。
            对话不会写进划线，关掉窗口就丢。
          </div>
          <div class="mn-ai-actions"><button type="button" class="mn-ai-btn primary" data-talk="setup">去管理页设置</button></div>
        </div>`;
      applyTalkPos();
      return;
    }

    const body = msgs.length
      ? msgs.map(talkMsgHTML).join('')
      : `<div class="mn-talk-empty">就这段文字问点什么吧。<br />这里只是聊天，<b>不会产生任何划线</b>；关掉窗口对话就丢了。</div>`;
    const status = state.talkBusy
      ? '<div class="mn-talk-msg assistant pending"><span class="mn-spin"></span>正在想…</div>'
      : '';
    const err = state.talkError && !state.talkBusy ? `<div class="mn-ai-err" role="alert">${escapeHtml(state.talkError)}</div>` : '';
    el.innerHTML =
      head +
      `<div class="mn-talk-body" data-role="talk-msgs">${body}${status}</div>
       <div class="mn-talk-foot">
         ${err}
         <div class="mn-talk-inputrow">
           <textarea data-talk-input="q" rows="2" placeholder="Enter 发送 · Shift+Enter 换行"
             ${state.talkBusy ? 'disabled' : ''}>${escapeHtml(state.talkInput)}</textarea>
           <button type="button" class="mn-ai-btn primary" data-talk="send" ${state.talkBusy ? 'disabled' : ''}>发送</button>
         </div>
         <div class="mn-talk-tip">${
           state.talkInputIsDefault
             ? '框里是默认提示词，直接发送就行；一开始打字它就让位给你的问题。'
             : '只在这个窗口里对话，关掉即清空；不会写入划线。'
         }</div>
       </div>`;
    applyTalkPos();
    const box = el.querySelector('[data-role="talk-msgs"]');
    if (box) box.scrollTop = box.scrollHeight;
    if (state.talkFocus) {
      state.talkFocus = false;
      const ta = el.querySelector('[data-talk-input="q"]');
      if (ta) {
        try {
          ta.focus();
          // 预填的默认提示词整段选中：这样第一次敲键盘就是「替换」，不用先手动删
          if (state.talkInputIsDefault) ta.select();
          else ta.setSelectionRange(ta.value.length, ta.value.length);
        } catch (_e) {
          /* 拿不到焦点就算了 */
        }
      }
    }
  }

  /**
   * 打开（或重新聚焦）对话窗。
   * 引用的文字变了就当新对话；同一个引用再点一次则保留原来的几轮，只把窗口拉到前面。
   */
  function openTalk(opts) {
    const o = opts || {};
    let quote = String(o.quote || '').trim();
    let range = null;
    if (!quote) {
      range = currentSelectionRange();
      if (range) {
        try {
          quote = String(range.toString() || '').trim();
        } catch (_e) {
          quote = '';
        }
      }
    }
    const next = quote.slice(0, (MN.ai && MN.ai.CHAT_LIMITS && MN.ai.CHAT_LIMITS.maxQuoteChars) || 6000);
    const sameTopic = state.talkOpen && state.talkQuote === next;
    if (!sameTopic) {
      state.talkMsgs = [];
      state.talkError = '';
      state.talkCode = '';
      // 新对话：输入框里先放一句默认提示词（用户不动它，点发送就按这句问）
      state.talkInput = chatDefaultPrompt();
      state.talkInputIsDefault = true;
    }
    state.talkQuote = next;
    state.talkOpen = true;
    state.talkFocus = true;
    if (!state.talkPos) {
      // 第一次打开：贴着选中的那段文字放，放不下就退回右上角
      let left = window.innerWidth - TALK_W - 24;
      let top = 72;
      if (range) {
        try {
          const rect = range.getBoundingClientRect();
          if (rect && (rect.width || rect.height)) {
            left = Math.max(12, Math.min(rect.left, window.innerWidth - TALK_W - 12));
            top = Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - 260));
          }
        } catch (_e) {
          /* 选区跨了被删掉的节点，用默认位置 */
        }
      }
      state.talkPos = { left, top };
    }
    hideToolbar();
    closePicker();
    closePopover();
    setShown(state.el.talk, true);
    renderTalk();
  }

  /** 关掉窗口 = 丢掉这几轮对话（这是设计：对话只活在窗口里）。 */
  function closeTalk() {
    closeModelMenu();
    state.talkOpen = false;
    state.talkBusy = false;
    state.talkMsgs = [];
    state.talkQuote = '';
    state.talkInput = '';
    state.talkInputIsDefault = false;
    state.talkError = '';
    state.talkCode = '';
    state.talkFocus = false;
    state.talkDrag = null;
    setShown(state.el.talk, false);
    if (state.el.talk) state.el.talk.innerHTML = '';
  }

  /** 发一轮。只发请求、只显示回复——**不落库、不产生划线**。 */
  async function sendTalk() {
    if (state.talkBusy) return;
    // 没动过输入框（或第一轮直接点发送、框是空的）→ 就按默认提示词问
    const typed = String(state.talkInput || '').trim();
    const q = typed || (state.talkInputIsDefault || !(state.talkMsgs || []).length ? chatDefaultPrompt() : '');
    if (!q) return;
    if (!talkReady()) {
      renderTalk();
      return;
    }
    // 历史 = 之前的几轮 + 这次这句（上下文由后台按 ai.CHAT_LIMITS 裁剪）
    const history = (state.talkMsgs || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))
      .concat([{ role: 'user', content: q }]);
    state.talkMsgs = [...(state.talkMsgs || []), { role: 'user', content: q }];
    state.talkInput = '';
    state.talkInputIsDefault = false;
    state.talkBusy = true;
    state.talkError = '';
    state.talkFocus = true;
    renderTalk();

    const res = await askAi(MN.MSG.AI_TALK, {
      payload: {
        quote: state.talkQuote,
        title: document.title,
        url: location.href,
        history
      }
    });
    state.talkBusy = false;
    if (!state.talkOpen) return; // 等待期间用户把窗口关了
    if (!res || !res.ok) {
      // 失败就把那句问题放回输入框，改一改再发；历史里不留这条没答上的
      state.talkMsgs = state.talkMsgs.slice(0, -1);
      state.talkInput = q;
      state.talkInputIsDefault = false;
      state.talkError = (res && res.error) || '请求失败';
      state.talkCode = (res && res.code) || '';
      state.talkFocus = true;
      renderTalk();
      return;
    }
    state.talkError = '';
    state.talkCode = '';
    const reply = String(res.reply || '').trim();
    state.talkMsgs = [
      ...state.talkMsgs,
      { role: 'assistant', content: reply || '（模型没有返回内容）' }
    ];
    state.talkFocus = true;
    renderTalk();
  }

  function onTalkClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-talk]') : null;
    if (!btn) return;
    const act = btn.dataset.talk;
    if (act === 'close') {
      e.preventDefault();
      closeTalk();
      return;
    }
    if (act === 'clear') {
      e.preventDefault();
      state.talkMsgs = [];
      state.talkError = '';
      state.talkCode = '';
      state.talkFocus = true;
      renderTalk();
      return;
    }
    if (act === 'setup') {
      e.preventDefault();
      sendBg({ type: MN.MSG.OPEN_DASHBOARD });
      return;
    }
    if (act === 'model') {
      e.preventDefault();
      toggleModelMenu('talk', btn);
      return;
    }
    if (act === 'send') {
      e.preventDefault();
      sendTalk().catch((err) => {
        state.talkBusy = false;
        state.talkError = '出错了：' + ((err && err.message) || String(err));
        renderTalk();
      });
    }
  }

  function onTalkInput(e) {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.talkInput !== 'q') return;
    if (state.talkInputIsDefault) {
      // 预填的默认提示词不该跟用户写的东西混在一起：
      // 只留下他新敲进去的那部分，默认那段直接让位。
      const typed = insertedText(state.talkInput, t.value);
      state.talkInputIsDefault = false;
      state.talkInput = typed;
      t.value = typed;
      try {
        t.setSelectionRange(typed.length, typed.length);
      } catch (_e) {
        /* 拿不到光标就算了 */
      }
      return;
    }
    state.talkInput = t.value;
  }

  function onTalkDragStart(e) {
    if (e.button !== 0) return;
    const onHead = e.target && e.target.closest ? e.target.closest('[data-talk-drag]') : null;
    if (!onHead) return;
    if (e.target.closest && e.target.closest('button')) return; // 点的是按钮就别拖
    const box = state.el.talk.getBoundingClientRect();
    state.talkDrag = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    e.preventDefault();
  }

  function onTalkDragMove(e) {
    if (!state.talkDrag) return;
    const el = state.el.talk;
    const w = el.offsetWidth || TALK_W;
    const h = el.offsetHeight || 260;
    state.talkPos = {
      left: Math.max(4, Math.min(e.clientX - state.talkDrag.dx, window.innerWidth - w - 4)),
      top: Math.max(4, Math.min(e.clientY - state.talkDrag.dy, window.innerHeight - h - 4))
    };
    applyTalkPos();
  }

  function onTalkDragEnd() {
    state.talkDrag = null;
  }

  /* ------------------------------------------------ 页面内切换模型（分析 / 对话共用）

     模型名是跟着服务商走的（deepseek-chat / 方舟的接入点 ep-xxx / hunyuan-…），
     所以不在代码里写死：这里点开一个菜单，实时问一次 /models，选谁就存进设置当默认，
     分析面板和对话窗立刻都跟着换。
  */

  const MODEL_CACHE_MS = 5 * 60 * 1000;

  function modelMenuEl() {
    return state.el.models;
  }

  function closeModelMenu() {
    state.modelMenuFor = '';
    state.modelError = '';
    state.modelCode = '';
    setShown(modelMenuEl(), false);
    if (modelMenuEl()) modelMenuEl().innerHTML = '';
  }

  /** 把菜单贴到按钮旁边（放不下就翻到上面 / 里侧），并保证整块在视口里。 */
  function placeModelMenu(anchor) {
    const el = modelMenuEl();
    if (!el || !anchor) return;
    let box = { left: 0, bottom: 0, top: 0, width: 0 };
    try {
      box = anchor.getBoundingClientRect();
    } catch (_e) {
      /* 拿不到就贴在左上角 */
    }
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 160;
    const left = Math.max(6, Math.min(box.left, window.innerWidth - w - 6));
    let top = box.bottom + 6;
    if (top + h > window.innerHeight - 6) top = Math.max(6, box.top - h - 6);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function modelMenuHTML() {
    const cfg = aiConfig() || {};
    const list = state.modelList || [];
    const cur = cfg.model || '';
    const head = `
      <div class="mn-models-head">
        <strong>选择模型</strong>
        <span class="grow"></span>
        <button type="button" class="mn-tbtn" data-model-act="reload" ${state.modelBusy ? 'disabled' : ''}>重新拉取</button>
      </div>`;
    if (state.modelBusy) {
      return head + '<div class="mn-models-hint"><span class="mn-spin"></span>正在问这个接口支持哪些模型…</div>';
    }
    if (state.modelError) {
      return (
        head +
        `<div class="mn-ai-err" role="alert">${escapeHtml(state.modelError)}</div>` +
        `<div class="mn-models-hint">${
          state.modelCode === 'nokey' || state.modelCode === 'nomodule'
            ? '到管理页把 API Key 填上再回来。'
            : '也可以到管理页手填模型名（不同服务商的写法不一样，方舟还要用接入点 ID）。'
        }</div>` +
        '<div class="mn-models-actions"><button type="button" class="mn-ai-btn ghost" data-model-act="setup">去管理页</button></div>'
      );
    }
    if (!list.length) {
      return head + '<div class="mn-models-hint">这个接口没有返回模型列表，到管理页手填模型名吧。</div>';
    }
    return (
      head +
      `<div class="mn-models-list">${list
        .map(
          (m) =>
            `<button type="button" class="mn-model-item" data-model-act="pick" data-model="${escapeHtml(m)}" data-on="${
              m === cur ? 1 : 0
            }" title="${escapeHtml(m)}">${escapeHtml(m)}${m === cur ? ' ✓' : ''}</button>`
        )
        .join('')}</div>` +
      `<div class="mn-models-hint">共 ${list.length} 个 · 来自 ${escapeHtml(cfg.baseUrl || '')}<br />选完立刻生效，并保存为本机默认。</div>`
    );
  }

  function renderModelMenu(anchor) {
    const el = modelMenuEl();
    if (!el) return;
    // 拉取是异步的：等结果回来时用户可能已经按 Esc / 点了别处把菜单关了，
    // 这时候绝不能再把它显示出来（不然菜单会「自己弹回来」）。
    if (!state.modelMenuFor) {
      el.innerHTML = '';
      setShown(el, false);
      return;
    }
    el.innerHTML = modelMenuHTML();
    setShown(el, true);
    placeModelMenu(anchor);
  }

  /** 问后台要模型列表；force=true 时忽略缓存。 */
  async function loadModels(force) {
    const cfg = aiConfig() || {};
    const fresh = state.modelCache.models.length && Date.now() - state.modelCache.at < MODEL_CACHE_MS && state.modelCache.baseUrl === cfg.baseUrl;
    if (!force && fresh) {
      state.modelList = state.modelCache.models.slice();
      state.modelError = '';
      state.modelCode = '';
      if (state.modelMenuFor) renderModelMenu(state.modelAnchor);
      return state.modelList;
    }
    state.modelBusy = true;
    state.modelError = '';
    state.modelCode = '';
    renderModelMenu(state.modelAnchor);
    const res = await askAi(MN.MSG.AI_MODELS);
    state.modelBusy = false;
    if (!res || !res.ok || !res.models || !res.models.length) {
      state.modelError = (res && res.error) || '没有拿到模型列表';
      state.modelCode = (res && res.code) || '';
      state.modelList = [];
    } else {
      state.modelList = res.models.slice();
      state.modelCache = { models: res.models.slice(), at: Date.now(), baseUrl: cfg.baseUrl };
    }
    renderModelMenu(state.modelAnchor);
    return state.modelList;
  }

  function toggleModelMenu(which, anchor) {
    if (state.modelMenuFor === which) {
      closeModelMenu();
      return;
    }
    state.modelAnchor = anchor || null;
    state.modelMenuFor = which;
    // 先把菜单显示出来（带「正在拉取」），再把结果填进去
    state.modelList = state.modelCache.models.slice();
    state.modelBusy = false;
    state.modelError = '';
    renderModelMenu(anchor);
    loadModels(false).catch((err) => {
      state.modelBusy = false;
      state.modelError = '拉取失败：' + ((err && err.message) || String(err));
      renderModelMenu(state.modelAnchor);
    });
  }

  /** 选中一个模型：写进设置（本机默认），两个面板一起换。 */
  async function pickModel(name) {
    const m = String(name || '').trim();
    if (!m) return;
    const ai = { ...(state.settings.ai || {}), model: m };
    state.settings.ai = ai;
    closeModelMenu();
    try {
      await MN.store.setSettings({ ai: { model: m } });
    } catch (e) {
      toast('模型没存上：' + ((e && e.message) || e), 2600);
      return;
    }
    renderAiPanel();
    renderTalk();
    toast('已切换到 ' + m + '（以后默认就用它）');
  }

  function onModelMenuClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-model-act]') : null;
    if (!btn) return;
    const act = btn.dataset.modelAct;
    if (act === 'pick') {
      e.preventDefault();
      pickModel(btn.dataset.model).catch(() => {});
      return;
    }
    if (act === 'reload') {
      e.preventDefault();
      loadModels(true).catch(() => {});
      return;
    }
    if (act === 'setup') {
      e.preventDefault();
      sendBg({ type: MN.MSG.OPEN_DASHBOARD });
    }
  }

  /* ------------------------------------------------------------------ 新建划线 */

  function currentSelectionRange() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!range.toString().trim()) return null;
      const node = range.startContainer;
      if (state.host && state.host.contains(node)) return null;
      if (MN.anchors.isSkipped(node.nodeType === 1 ? node : node.parentElement)) return null;
      return range;
    } catch (_e) {
      // 页面自己改 DOM 之后，旧的选区可能已经指向被删掉的节点，读它会抛异常
      return null;
    }
  }

  /** 改一条已有划线的颜色：落盘 + 立刻重绘（顺带更新内存里的副本，避免下次重渲染又变回去）。 */
  async function applyColorToAnnotation(ann, color) {
    if (!ann || !color) return null;
    const updated = await MN.store.patch(ann.id, { color });
    const target = updated || { ...ann, color };
    syncLocal(target);
    if (state.popoverAnn && state.popoverAnn.id === ann.id) state.popoverAnn = target;
    document
      .querySelectorAll(`mark.mn-hl[data-ann="${ann.id}"]`)
      .forEach((m) => decorateMark(m, target));
    return target;
  }

  /**
   * 选区是不是几乎完全落在同一条已有划线里？
   * 是的话说明用户想"改这条的颜色 / 加笔记"，而不是再叠一条新的上去
   * —— 之前这里会叠出两条互相压着的划线，看起来就是"颜色改不了"。
   */
  function annotationUnderRange(range) {
    const elOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
    const s = elOf(range.startContainer);
    const e = elOf(range.endContainer);
    if (!s || !e) return null;
    const sm = s.closest && s.closest('mark.mn-hl[data-ann]');
    const em = e.closest && e.closest('mark.mn-hl[data-ann]');
    if (!sm || sm !== em) return null;
    const ann = state.annotations.find((a) => a.id === sm.dataset.ann);
    if (!ann) return null;
    const annLen = ((ann.anchor && ann.anchor.exact) || ann.text || '').length;
    const selLen = range.toString().trim().length;
    return annLen && selLen / annLen >= 0.5 ? ann : null;
  }

  async function createFromSelection(color, opts = {}) {
    // 取色器里点「应用」时页面选区可能已经被输入框抢走，所以允许把选区传进来
    const range = opts.range || currentSelectionRange();
    if (!range) {
      toast('先选中一段文字');
      return null;
    }
    const covered = annotationUnderRange(range);
    if (covered) {
      if (opts.openEditor) {
        hideToolbar();
        openEditor(covered, null);
        return covered;
      }
      const want = color || state.settings.defaultColor;
      await applyColorToAnnotation(covered, want);
      toast('已把这条划线改成「' + MN.colorOf(want).label + '」');
      return covered;
    }
    const anchor = MN.anchors.serializeRange(range, document.body);
    if (!anchor) {
      toast('这段内容没法划线');
      return null;
    }
    const ann = await MN.store.put({
      url: MN.normalizeUrl(location.href),
      title: document.title || location.hostname,
      site: MN.hostOf(location.href),
      color: color || state.settings.defaultColor,
      type: 'text',
      text: anchor.exact,
      note: '',
      tags: [],
      anchor
    });
    addLocal(ann);
    hideToolbar();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (opts.openEditor) {
      const marks = document.querySelectorAll(`mark.mn-hl[data-ann="${ann.id}"]`);
      openEditor(ann, marks[0]);
    } else {
      toast('已高亮，点它可以写笔记');
    }
    return ann;
  }

  async function markImage() {
    const target = state.lastContextTarget;
    let img = null;
    if (target) {
      if (target.tagName === 'IMG') img = target;
      else if (target.querySelector) img = target.querySelector('img');
    }
    if (!img) {
      toast('没找到要标记的图片，请右键图片本身');
      return null;
    }
    const all = [...document.querySelectorAll('img')];
    const ann = await MN.store.put({
      url: MN.normalizeUrl(location.href),
      title: document.title || location.hostname,
      site: MN.hostOf(location.href),
      color: state.settings.defaultColor,
      type: 'image',
      text: img.currentSrc || img.src,
      note: '',
      tags: [],
      image: { src: img.currentSrc || img.src, index: all.indexOf(img) }
    });
    addLocal(ann);
    openEditor(ann, img);
    return ann;
  }

  /* ------------------------------------------------------------------ 工具条与弹层 */

  function isInsideOurUI(node) {
    return !!(state.host && node && (state.host === node || state.host.contains(node)));
  }

  /** Range 的位置。老浏览器 / 特殊节点上 getBoundingClientRect 可能没有，退化成元素位置。 */
  function rectOf(range) {
    try {
      const r = range.getBoundingClientRect();
      if (r && (r.width || r.height || r.top || r.left || r.bottom)) return r;
    } catch (_e) {
      /* 继续兜底 */
    }
    try {
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el && el.getBoundingClientRect) return el.getBoundingClientRect();
    } catch (_e) {
      /* 继续兜底 */
    }
    return { left: window.innerWidth / 2 - 100, top: 80, width: 0, height: 0, bottom: 80, right: 0 };
  }

  function showToolbar(rect) {
    const bar = state.el.toolbar;
    setShown(bar, true);
    const w = bar.offsetWidth || 230;
    const h = bar.offsetHeight || 36;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top - h - 8;
    if (top < 6) top = rect.bottom + 8;
    left = MN.clamp(left, 8, window.innerWidth - w - 8);
    top = MN.clamp(top, 6, window.innerHeight - h - 6);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  /**
   * 收起工具条。这里刻意 **不** 取消待显示的定时器：
   * 那个定时器活 10ms，并且会重新读一次当前选区 —— 由它做唯一裁决，
   * 就能保证"选取刚结束时的任何杂散事件（click / scroll / selectionchange）"都不会把工具条掐死。
   */
  function hideToolbar() {
    if (state.el.toolbar) setShown(state.el.toolbar, false);
  }

  function openEditor(ann, anchorEl) {
    state.popoverAnn = ann;
    state.editingTags = [...(ann.tags || [])];
    renderPopover();
    const pop = state.el.pop;
    const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const rect = r && (r.width || r.height) ? r : { left: window.innerWidth / 2 - 165, top: 90, width: 0, height: 0, bottom: 90 };
    const w = pop.offsetWidth || 330;
    const h = pop.offsetHeight || 260;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 10);
    left = MN.clamp(left, 8, window.innerWidth - w - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.querySelector('[data-role="note"]').focus();
  }

  function closePopover() {
    state.popoverAnn = null;
    state.editingTags = [];
    if (state.el.pop) {
      setShown(state.el.pop, false);
      state.el.pop.innerHTML = '';
    }
  }

  async function saveEditor() {
    const ann = state.popoverAnn;
    if (!ann) return;
    const note = state.el.pop.querySelector('[data-role="note"]').value.trim();
    const color = state.el.pop.querySelector('.mn-dot[data-active="1"]');
    const updated = await MN.store.patch(ann.id, {
      note,
      tags: state.editingTags,
      color: color ? color.dataset.color : ann.color
    });
    if (updated) {
      state.popoverAnn = updated;
      syncLocal(updated);
      document.querySelectorAll(`mark.mn-hl[data-ann="${updated.id}"]`).forEach((m) => decorateMark(m, updated));
      toast('已保存');
    }
  }

  /** 摘掉某条划线的 <mark>，把文字原样还回去。 */
  function removeMarksFor(id) {
    document.querySelectorAll(`mark.mn-hl[data-ann="${id}"]`).forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      if (parent.normalize) parent.normalize();
    });
  }

  async function deleteEditor() {
    const ann = state.popoverAnn;
    if (!ann) return;
    await MN.store.remove(ann.id);
    // 以前这一步是靠 onChange 触发的整页重渲染兜的，现在自己摘干净
    removeMarksFor(ann.id);
    state.annotations = state.annotations.filter((a) => a.id !== ann.id);
    updateCount();
    closePopover();
    toast('已删除');
  }

  function addTagFromInput() {
    const input = state.el.pop.querySelector('[data-role="taginput"]');
    const raw = input.value.trim();
    if (!raw) return;
    const tag = MN.normalizeTag(raw);
    if (tag && !state.editingTags.includes(tag)) state.editingTags.push(tag);
    input.value = '';
    renderTagChips();
  }

  /* 工具条 / 弹层的事件委托 */
  function uiClickHandler(e) {
    const inMenu =
      e.target.closest &&
      (e.target.closest('.mn-models') || e.target.closest('[data-ai="model"], [data-talk="model"]'));
    // 点菜单和「模型按钮」以外的地方就把菜单收起来（菜单内部交给 onModelMenuClick）
    if (!inMenu && state.modelMenuFor) closeModelMenu();
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    e.preventDefault();
    e.stopPropagation();

    if (act === 'color') {
      closePicker();
      const color = btn.dataset.color;
      if (state.popoverAnn) {
        state.el.pop.querySelectorAll('.mn-dot').forEach((d) => (d.dataset.active = d === btn ? '1' : '0'));
        // 立即生效：颜色不该等到按「保存」才变
        applyColorToAnnotation(state.popoverAnn, color);
        return;
      }
      if (state.pendingImageElement) return;
      const range = currentSelectionRange();
      if (range) createFromSelection(color);
      else {
        state.settings.defaultColor = color;
        MN.store.setSettings({ defaultColor: color });
        state.el.side.querySelectorAll('.mn-dot').forEach((d) => (d.dataset.active = d.dataset.color === color ? '1' : '0'));
        toast('默认颜色已切换为「' + MN.colorOf(color).label + '」');
      }
      return;
    }

    if (act === 'custom') {
      if (state.el.picker && !state.el.picker.hidden) closePicker();
      else openPicker(btn);
      return;
    }

    if (act === 'note') return createFromSelection(state.settings.defaultColor, { openEditor: true });
    if (act === 'ai') {
      openAiPanel({ scope: currentSelectionRange() ? 'selection' : 'page' });
      return;
    }
    if (act === 'talk') {
      // 从高亮弹层点进来就用那条划线的原文当引用；从工具条点进来就用当前选区
      const ann = state.popoverAnn;
      const quote = ann ? String((ann.anchor && ann.anchor.exact) || ann.text || '') : '';
      openTalk(quote ? { quote } : {});
      return;
    }
    if (act === 'copy') {
      const range = currentSelectionRange();
      const text = range ? range.toString() : state.popoverAnn ? state.popoverAnn.text : '';
      if (text) MN.copyText(text).then((ok) => toast(ok ? '已复制 ' + text.length + ' 字' : '复制失败'));
      return;
    }
    if (act === 'save') return saveEditor();
    if (act === 'delete') return deleteEditor();
    if (act === 'untag') {
      state.editingTags.splice(Number(btn.dataset.i), 1);
      renderTagChips();
      return;
    }
    if (act === 'list') {
      sendBg({ type: MN.MSG.OPEN_SIDEBAR });
      return;
    }
    if (act === 'eye') {
      state.hidden = !state.hidden;
      document.documentElement.classList.toggle('mn-hide-hl', state.hidden);
      btn.dataset.on = state.hidden ? '1' : '0';
      toast(state.hidden ? '已隐藏本页高亮' : '已显示本页高亮');
      return;
    }
    if (act === 'dismiss') {
      state.settings.showSideBar = false;
      MN.store.setSettings({ showSideBar: false });
      setShown(state.el.side, false);
      toast('已隐藏右侧工具条，可在扩展弹窗里重新打开');
      return;
    }
    if (act === 'unlock') {
      toggleCopyUnlock().then((r) => {
        if (r.ok) btn.dataset.on = state.unlocked ? '1' : '0';
      });
    }
  }

  /* ------------------------------------------------------- 复制辅助（默认关闭） */

  /**
   * 复制辅助的总开关。没确认过使用提示之前一律不开——不管是从侧栏点、还是从弹窗发消息过来。
   * 拒绝时返回 needAck，弹窗据此提示用户去确认。
   */
  async function toggleCopyUnlock() {
    if (!state.unlocked && !state.settings.copyNoticeAck) {
      // 弹窗那边刚写完确认标记，storage 变更可能还没同步到这个页面，重新读一次
      try {
        const fresh = await MN.store.getSettings();
        state.settings.copyNoticeAck = !!fresh.copyNoticeAck;
      } catch (_e) {
        /* 读不到就按没确认处理 */
      }
    }
    if (!state.unlocked && !state.settings.copyNoticeAck) {
      toast('首次使用请点扩展图标 →「允许本页选中复制」，确认过使用提示后这里就能用了', 4200);
      return { ok: false, needAck: true, unlocked: false };
    }
    setCopyUnlock(!state.unlocked);
    renderSideBar();
    toast(
      state.unlocked
        ? '已允许在本页选中与复制（仅你的浏览器；请遵守该网站的使用条款）'
        : '已恢复网页原本的选中与复制限制',
      2600
    );
    return { ok: true, unlocked: state.unlocked };
  }

  function setCopyUnlock(enable) {
    state.unlocked = !!enable;
    document.documentElement.classList.toggle('mn-unlock-copy', state.unlocked);
    if (state.unlocked && !state.unlockHandler) {
      // 注册在 window 捕获阶段，抢在页面自己的 oncopy 之前把事件掐掉
      state.unlockHandler = (e) => {
        if (!state.unlocked) return;
        if (isInsideOurUI(e.target)) return;
        if (e.type === 'copy' || e.type === 'cut' || e.type === 'selectstart' || e.type === 'contextmenu') {
          e.stopImmediatePropagation();
        }
      };
      ['copy', 'cut', 'selectstart', 'contextmenu'].forEach((t) =>
        window.addEventListener(t, state.unlockHandler, true)
      );
      document.oncopy = null;
      document.oncontextmenu = null;
    } else if (!state.unlocked && state.unlockHandler) {
      ['copy', 'cut', 'selectstart', 'contextmenu'].forEach((t) =>
        window.removeEventListener(t, state.unlockHandler, true)
      );
      state.unlockHandler = null;
    }
  }

  async function copySelection() {
    const range = currentSelectionRange();
    let text = range ? range.toString() : '';
    if (!text) {
      const sel = window.getSelection();
      text = sel ? sel.toString() : '';
    }
    if (!text.trim()) {
      const article = document.querySelector('article, main, #content, .content') || document.body;
      text = (article.innerText || '').trim().slice(0, 20000);
      if (!text) {
        toast('没有可复制的内容');
        return false;
      }
      const ok = await MN.copyText(text);
      toast(ok ? '没选中文字，已复制正文前 2 万字' : '复制失败');
      return ok;
    }
    if (state.settings.copySuffix) {
      text = `${text}\n\n> 摘自：${document.title} ${location.href}`;
    }
    const ok = await MN.copyText(text);
    toast(ok ? '已复制 ' + text.length + ' 字' : '复制失败');
    return ok;
  }

  /* ------------------------------------------------------------------ 事件绑定 */

  function bindEvents() {
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('contextmenu', (e) => {
      state.lastContextTarget = e.target;
    }, true);
    window.addEventListener('scroll', () => {
      hideToolbar();
      closePicker();
    }, true);
    window.addEventListener('resize', () => {
      hideToolbar();
      closePicker();
    });
    state.el.aiMask.addEventListener('click', () => closeAiPanel());
    state.el.talk.addEventListener('click', onTalkClick);
    state.el.talk.addEventListener('input', onTalkInput);
    // 点进输入框时，如果里面还是那句预填的默认提示词，就整段选中
    state.el.talk.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.dataset || t.dataset.talkInput !== 'q') return;
      if (!state.talkInputIsDefault) return;
      try {
        t.select();
      } catch (_e) {
        /* 个别环境不支持就算了，反正 input 里还会兜一层 */
      }
    });
    state.el.talk.addEventListener('mousedown', onTalkDragStart);
    state.el.models.addEventListener('click', onModelMenuClick);
    window.addEventListener('resize', () => state.modelMenuFor && closeModelMenu());
    document.addEventListener('scroll', () => state.modelMenuFor && closeModelMenu(), true);
    document.addEventListener('mousemove', onTalkDragMove, true);
    document.addEventListener('mouseup', onTalkDragEnd, true);
    state.el.talk.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (state.modelMenuFor) closeModelMenu();
        else closeTalk();
        return;
      }
      // Enter 发送，Shift+Enter 换行
      if (e.key === 'Enter' && !e.shiftKey && e.target.matches('[data-talk-input="q"]')) {
        e.preventDefault();
        sendTalk().catch(() => {});
      }
    });
    state.el.ai.addEventListener('click', onAiClick);
    state.el.ai.addEventListener('input', onAiInput);
    state.el.ai.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAiPanel();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches('[data-ai-input="prompt"]')) {
        e.preventDefault();
        runAi();
      }
    });
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('blur', () => hideToolbar());
    window.addEventListener('pageshow', () => scheduleReload());
    state.shadow.addEventListener('click', uiClickHandler);
    state.shadow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (state.modelMenuFor) {
          closeModelMenu();
          return;
        }
        hideToolbar();
        closePopover();
        closePicker();
      }
      if (e.key === 'Enter' && e.target.matches('[data-role="taginput"]')) {
        e.preventDefault();
        addTagFromInput();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches('[data-role="note"]')) {
        e.preventDefault();
        saveEditor();
      }
    });
    state.shadow.addEventListener('input', (e) => {
      if (e.target.matches('[data-role="taginput"]') && /[,，]$/.test(e.target.value)) addTagFromInput();
    });
  }

  function onMouseUp(e) {
    if (isInsideOurUI(e.target)) return;
    if (!state.settings.showToolbar) return;
    clearTimeout(state.toolbarTimer);
    state.toolbarTimer = setTimeout(() => {
      state.toolbarTimer = null;
      const range = currentSelectionRange();
      if (!range) {
        hideToolbar();
        return;
      }
      state.lastSelectAt = Date.now(); // 刚完成一次选取
      if (state.popoverAnn) return;
      showToolbar(rectOf(range));
    }, 10);
  }

  /**
   * 选区没了就把工具条收起来。
   * 用户"取消选取"的方式不止一种：点别处、按 Esc、按方向键、点到 iframe 里、
   * 甚至页面自己把选区清掉 —— 光靠 click/mouseup 覆盖不全，selectionchange 才是唯一可靠的信号。
   */
  function onSelectionChange() {
    if (state.popoverAnn) return;
    if (currentSelectionRange()) return;
    if (state.toolbarTimer) return; // 拖选刚抬起，等那 10ms 的判定跑完
    hideToolbar();
  }

  function onDocumentClick(e) {
    if (isInsideOurUI(e.target)) return;
    // 点到页面上了：取色器（挂在工具条 / 批注层旁边）也该收起来
    if (state.el.picker && !state.el.picker.hidden) closePicker();
    const mark = e.target.closest && e.target.closest('mark.mn-hl');
    const img = e.target.closest && e.target.closest('img.mn-img-hl');
    // 拖动选取文字后浏览器补发的 click 会落在 mark 上。这时候不该抢走工具条去弹批注框
    // —— 用户刚刚才选完字，想要的是"用哪个颜色"，不是"编辑哪个批注"。
    const justSelected = state.toolbarTimer || Date.now() - state.lastSelectAt < 350;
    if (justSelected && currentSelectionRange()) return;
    if (mark) {
      const ann = state.annotations.find((a) => a.id === mark.dataset.ann);
      if (ann) {
        hideToolbar();
        openEditor(ann, mark);
        return;
      }
    }
    if (img) {
      const ann = state.annotations.find((a) => a.id === img.dataset.mnAnn);
      if (ann) {
        hideToolbar();
        openEditor(ann, img);
        return;
      }
    }
    if (state.popoverAnn) closePopover();
    // 注意：拖动选取文字之后，Firefox / Chrome 还会补发一个 click。
    // 这个 click 不能把刚刚排队的工具条掐掉（hideToolbar 会清掉待显示的定时器），
    // 所以只有在"确实没有选区"时才收起 —— 真正的取消选取会走 selectionchange。
    if (!currentSelectionRange()) hideToolbar();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (state.modelMenuFor) {
        closeModelMenu();
        return;
      }
      if (state.aiOpen) {
        closeAiPanel();
        return;
      }
      if (state.talkOpen) {
        closeTalk();
        return;
      }
      hideToolbar();
      closePopover();
      closePicker();
    }
  }

  /* ------------------------------------------------------------------ 消息接口 */

  function bindMessages() {
    api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      const reply = (data) => {
        try {
          sendResponse(data);
        } catch (_e) {
          /* 通道已关闭 */
        }
      };
      switch (msg.type) {
        case MN.MSG.HIGHLIGHT_SELECTION:
          createFromSelection(msg.color || state.settings.defaultColor).then((a) => reply({ ok: !!a }));
          return true;
        case MN.MSG.ADD_NOTE:
          createFromSelection(state.settings.defaultColor, { openEditor: true }).then((a) => reply({ ok: !!a }));
          return true;
        case MN.MSG.SUPER_COPY:
          copySelection().then((ok) => reply({ ok }));
          return true;
        case MN.MSG.MARK_IMAGE:
          markImage().then((a) => reply({ ok: !!a }));
          return true;
        case MN.MSG.TOGGLE_HIGHLIGHTS:
          state.hidden = !state.hidden;
          document.documentElement.classList.toggle('mn-hide-hl', state.hidden);
          renderSideBar();
          reply({ ok: true, hidden: state.hidden });
          return true;
        case MN.MSG.TOGGLE_UNLOCK:
          toggleCopyUnlock().then((r) => reply(r));
          return true;
        case MN.MSG.TOGGLE_SIDEBAR_BAR:
          state.settings.showSideBar = !state.settings.showSideBar;
          MN.store.setSettings({ showSideBar: state.settings.showSideBar });
          renderSideBar();
          reply({ ok: true, showSideBar: state.settings.showSideBar });
          return true;
        case MN.MSG.TOGGLE_INDEX:
          state.settings.showIndex = !state.settings.showIndex;
          MN.store.setSettings({ showIndex: state.settings.showIndex });
          applyIndexNumbers();
          toast(state.settings.showIndex ? '已显示划线序号' : '已隐藏划线序号');
          reply({ ok: true, showIndex: state.settings.showIndex });
          return true;
        case MN.MSG.CLEAR_PAGE:
          clearPageAnnotations().then((r) => reply(r));
          return true;
        case MN.MSG.RELOAD_HIGHLIGHTS:
          reload().then(() => reply(pageState()));
          return true;
        case MN.MSG.AI_PANEL:
          openAiPanel({ scope: msg.scope || (currentSelectionRange() ? 'selection' : 'page'), });
          reply({ ok: true });
          return true;
        case MN.MSG.AI_TALK:
          openTalk(msg.quote ? { quote: msg.quote } : {});
          reply({ ok: true, ready: talkReady() });
          return true;
        case MN.MSG.PAGE_STATE:
        case MN.MSG.GET_ANNOTATIONS:
          reply(pageState());
          return true;
        case MN.MSG.FOCUS_ANNOTATION: {
          const mark =
            document.querySelector(`mark.mn-hl[data-ann="${msg.id}"]`) ||
            document.querySelector(`img.mn-img-hl[data-mn-ann="${msg.id}"]`);
          if (mark) {
            mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
            mark.classList.add('mn-flash');
            setTimeout(() => mark.classList.remove('mn-flash'), 2600);
            reply({ ok: true });
          } else {
            reply({ ok: false, reason: 'lost' });
          }
          return true;
        }
        default:
          return false;
      }
    });
  }

  function pageState() {
    return {
      url: location.href,
      title: document.title,
      count: state.annotations.length,
      hidden: state.hidden,
      unlocked: state.unlocked,
      showSideBar: state.settings.showSideBar,
      showIndex: !!state.settings.showIndex,
      indexMode: MN.normalizeIndexMode(state.settings.indexMode),
      lost: state.lost.map((a) => a.id),
      annotations: state.annotations.map((a) => ({
        id: a.id,
        color: a.color,
        note: a.note,
        tags: a.tags,
        type: a.type,
        text: a.text,
        createdAt: a.createdAt,
        // 侧边栏要按同样的规则算序号，所以位置也带上
        startV: a.anchor && typeof a.anchor.startV === 'number' ? a.anchor.startV : null,
        lost: state.lost.some((l) => l.id === a.id)
      }))
    };
  }

  /* ------------------------------------------------------------------ 启动 */

  function watchUrlChange() {
    setInterval(() => {
      if (location.href !== state.href) {
        state.href = location.href;
        hideToolbar();
        closePopover();
        closePicker();
        closeModelMenu();
        closeTalk(); // 对话是「这一页这段文字」的事，换页就清掉
        reload();
      }
    }, 800);
  }

  async function init() {
    state.settings = await MN.store.getSettings();
    MN.setCustomColors(state.settings.customColors);
    const aiCfg = aiConfig();
    state.aiScope = (aiCfg && aiCfg.defaultScope) || 'selection';
    state.aiDraft = (aiCfg && aiCfg.prompt) || '';
    MN.store.watchExternal();
    buildUI();
    bindEvents();
    bindMessages();
    await reload();
    watchDom();
    // 只对"别人改的"重新渲染：本页面自己的写入已经就地更新过 DOM 了，
    // 再拆掉重建会让页面闪一下，还会把用户当前的选区弄没。
    MN.store.onChange(async (_url, origin) => {
      // 设置也可能在别的页面被改（比如弹窗里加了个常用色），色板要跟着刷新
      await refreshSettings();
      if (origin !== 'local') scheduleReload();
    });
    watchUrlChange();
  }

  init().catch((e) => console.warn('[MarkNote] 初始化失败', e));
})();
