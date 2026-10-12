/*
 * MarkNote — 公共工具与常量
 * 这个文件同时被内容脚本和各个页面（popup / 侧边栏 / 管理页）加载，
 * 所以只挂命名空间，不使用 import/export。
 */
(function () {
  'use strict';

  const MN = (globalThis.MN = globalThis.MN || {});

  /** 高亮配色。id 会写进数据里，不要随意改名；改颜色只需改这里的色值。 */
  MN.COLORS = [
    { id: 'yellow', label: '黄', light: '#ffe066', dark: '#8a6d00' },
    { id: 'green', label: '绿', light: '#a9f0a0', dark: '#1f6b2a' },
    { id: 'blue', label: '蓝', light: '#a5d8ff', dark: '#1b4f8a' },
    { id: 'pink', label: '粉', light: '#ffc9de', dark: '#8a2b52' },
    { id: 'purple', label: '紫', light: '#d0bfff', dark: '#4b2d8a' }
  ];

  MN.DEFAULT_SETTINGS = {
    defaultColor: 'yellow',
    showToolbar: true,      // 选中文字后自动弹出小工具条
    showSideBar: true,      // 页面右侧的小工具条
    showIndex: false,       // 高亮前面显示序号（1、2、3…）
    indexMode: 'position',  // position=按在页面里的位置排，order=按创建时间排
    copySuffix: false,      // 复制划线时是否附带来源链接
    copyNoticeAck: false,   // 是否已确认过「允许选中/复制」的使用提示（首次必须确认）
    markdownTemplate: 'quote', // quote | list
    customColors: [],       // 用户自己调出来的常用色，元素是 #rrggbb
    // AI 分析（任意 OpenAI 兼容接口）。注意：这里**不含密钥**，
    // 密钥单独存在 storage.local 的 aiKey 里，不会跟着「导出 JSON 备份」走。
    ai: {
      enabled: false,
      baseUrl: 'https://api.deepseek.com',
      // 故意留空：不同服务商的模型名完全不一样（deepseek-chat / 方舟接入点 ep-xxx / hunyuan-…），
      // 写死一个只会在别家上一直报「模型不存在」。留空 = 还没选，
      // 由管理页保存 API Key 时自动拉一次模型列表、取第一个当默认值。
      model: '',
      maxItems: 10,
      maxChars: 12000,
      temperature: 0.2,
      jsonMode: true,
      prompt: '',
      // 对话悬浮窗预填的默认提示词；留空用 ai.js 里的内置那句
      chatPrompt: '',
      defaultScope: 'selection'
    }
  };

  const COLOR_MAP = new Map(MN.COLORS.map((c) => [c.id, c]));

  /* ------------------------------------------------------------------ 颜色工具
   * 内置色用名字当 id（yellow / green…），自定义色直接用 #rrggbb 当 id。
   * 这样一来：设置里的色板就算丢了，划线里存的十六进制也还能原样渲染出来。
   */

  const HEX6 = /^#[0-9a-f]{6}$/;
  const HEX3 = /^#[0-9a-f]{3}$/;
  const BYTE = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));

  /**
   * 任意颜色输入 → {r,g,b}，认不出来返回 null。
   * 支持 #abc、#aabbcc、rgb(1,2,3)、rgba(1 2 3 / .5)、"1,2,3"、"1 2 3"、{r,g,b}。
   */
  MN.parseColor = function parseColor(input) {
    if (input === null || input === undefined || input === '') return null;
    if (typeof input === 'object') {
      if (input.r === undefined || input.g === undefined || input.b === undefined) return null;
      return { r: BYTE(input.r), g: BYTE(input.g), b: BYTE(input.b) };
    }
    const s = String(input).trim().toLowerCase();
    if (HEX6.test(s)) {
      return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) };
    }
    if (HEX3.test(s)) {
      return { r: parseInt(s[1] + s[1], 16), g: parseInt(s[2] + s[2], 16), b: parseInt(s[3] + s[3], 16) };
    }
    const fn = s.match(/^rgba?\(([^)]*)\)$/);
    const body = fn ? fn[1] : /^\d{1,3}[\s,]+\d{1,3}[\s,]+\d{1,3}$/.test(s) ? s : null;
    if (!body) return null;
    const parts = body.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    const nums = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return { r: BYTE(nums[0]), g: BYTE(nums[1]), b: BYTE(nums[2]) };
  };

  MN.toHex = function toHex(rgb) {
    const { r, g, b } = rgb || {};
    return '#' + [r, g, b].map((v) => BYTE(v).toString(16).padStart(2, '0')).join('');
  };

  /** 归一化成 #rrggbb；认不出来返回 null。 */
  MN.normalizeHex = function normalizeHex(input) {
    const rgb = MN.parseColor(input);
    return rgb ? MN.toHex(rgb) : null;
  };

  MN.rgbToHsv = function rgbToHsv({ r, g, b }) {
    const rr = BYTE(r) / 255;
    const gg = BYTE(g) / 255;
    const bb = BYTE(b) / 255;
    const max = Math.max(rr, gg, bb);
    const min = Math.min(rr, gg, bb);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === rr) h = ((gg - bb) / d) % 6;
      else if (max === gg) h = (bb - rr) / d + 2;
      else h = (rr - gg) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  };

  MN.hsvToRgb = function hsvToRgb({ h, s, v }) {
    const hh = ((((h % 360) + 360) % 360) / 60);
    const ss = Math.max(0, Math.min(1, Number(s) || 0));
    const vv = Math.max(0, Math.min(1, Number(v) || 0));
    const c = vv * ss;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = vv - c;
    const set = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hh) % 6] || [0, 0, 0];
    return { r: BYTE((set[0] + m) * 255), g: BYTE((set[1] + m) * 255), b: BYTE((set[2] + m) * 255) };
  };

  /** amount > 0 提亮，< 0 压暗，按明度缩放。 */
  MN.shade = function shade(input, amount) {
    const rgb = MN.parseColor(input);
    if (!rgb) return null;
    const hsv = MN.rgbToHsv(rgb);
    const a = Math.max(-1, Math.min(1, Number(amount) || 0));
    const v = a >= 0 ? hsv.v + (1 - hsv.v) * a : hsv.v * (1 + a);
    return MN.toHex(MN.hsvToRgb({ h: hsv.h, s: hsv.s, v }));
  };

  MN.darken = (input, amount = 0.55) => MN.shade(input, -Math.abs(amount));
  MN.lighten = (input, amount = 0.4) => MN.shade(input, Math.abs(amount));

  /** 在这个底色上，用深色字还是浅色字更清楚（预览、色板标签用）。 */
  MN.textOn = function textOn(input) {
    const rgb = MN.parseColor(input) || { r: 255, g: 255, b: 255 };
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    return L > 0.45 ? '#1f2937' : '#ffffff';
  };

  /* ---- 自定义色板（存在 settings.customColors 里） ---- */

  const CUSTOM = [];

  const asColorRecord = (hex) => ({
    id: hex,
    label: hex,
    light: hex,
    dark: MN.darken(hex, 0.62) || hex,
    custom: true
  });

  /** 当前自定义色（不含内置色）的记录副本。 */
  MN.customColors = () => CUSTOM.slice();

  /** 用一份 #rrggbb 列表重置自定义色板；返回生效后的列表。重复 / 非法值会被忽略。 */
  MN.setCustomColors = function setCustomColors(list) {
    const next = [];
    (Array.isArray(list) ? list : []).forEach((raw) => {
      const hex = MN.normalizeHex(typeof raw === 'string' ? raw : raw && (raw.light || raw.id || raw.hex));
      if (!hex) return;
      if (next.some((r) => r.id === hex)) return;
      next.push(asColorRecord(hex));
    });
    // 先摘掉这次不再要的，再登记新的（注意别把"已经在用的同一个颜色"当成重复丢掉）
    CUSTOM.forEach((c) => {
      if (!next.some((n) => n.id === c.id)) COLOR_MAP.delete(c.id);
    });
    CUSTOM.length = 0;
    next.forEach((c) => {
      CUSTOM.push(c);
      COLOR_MAP.set(c.id, c);
    });
    return CUSTOM.slice();
  };

  /** 把一个颜色加进自定义色板；返回归一化后的 #rrggbb。 */
  MN.addCustomColor = function addCustomColor(input) {
    const hex = MN.normalizeHex(input);
    if (!hex) return null;
    if (!CUSTOM.some((c) => c.id === hex)) {
      CUSTOM.push(asColorRecord(hex));
      COLOR_MAP.set(hex, CUSTOM[CUSTOM.length - 1]);
    }
    return hex;
  };

  /** 从自定义色板里摘掉一个颜色（已经划过的线不受影响）。 */
  MN.removeCustomColor = function removeCustomColor(input) {
    const hex = MN.normalizeHex(input);
    if (!hex) return null;
    const i = CUSTOM.findIndex((c) => c.id === hex);
    if (i < 0) return null;
    CUSTOM.splice(i, 1);
    COLOR_MAP.delete(hex);
    return hex;
  };

  /** 内置色 + 自定义色，界面上的色板按这个渲染。 */
  MN.allColors = () => [...MN.COLORS, ...CUSTOM];

  /**
   * 把任意颜色 id 解析成 {id,label,light,dark,custom}。
   * 顺序：内置色 → 自定义色 → 任意十六进制字面量 → 兜底黄色。
   */
  MN.colorOf = function colorOf(id) {
    if (id && COLOR_MAP.has(id)) return COLOR_MAP.get(id);
    const hex = MN.normalizeHex(id);
    if (hex) return COLOR_MAP.get(hex) || asColorRecord(hex);
    return COLOR_MAP.get('yellow');
  };

  MN.uid = function uid() {
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8) +
      '-' +
      Math.random().toString(36).slice(2, 6)
    );
  };

  /** 统一去掉 hash 和常见跟踪参数，作为「一篇文章」的键。 */
  /** 1.1.0 之前的旧算法：把 hash 一并丢掉。只用于把老数据迁移过来。 */
  MN.legacyUrlKey = function legacyUrlKey(raw) {
    try {
      const u = new URL(raw);
      u.hash = '';
      const drop = [];
      u.searchParams.forEach((_v, k) => {
        if (/^(utm_|spm|from|share_|ref$|fbclid|gclid)/i.test(k)) drop.push(k);
      });
      drop.forEach((k) => u.searchParams.delete(k));
      let s = u.toString();
      if (s.endsWith('?')) s = s.slice(0, -1);
      return s;
    } catch (_e) {
      return String(raw || '').split('#')[0];
    }
  };

  MN.normalizeUrl = function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      // hash 路由（#/article/1）代表的是另一个页面，必须保留：
      // 否则整个 SPA 的文章会共用一个 storage key，划线互相串台、也定位不上。
      // 页内锚点（#section-2）则要丢掉，不然同一篇文章滚一下就被当成不同页面。
      const hash = u.hash;
      u.hash = '';
      if (/^#!?\//.test(hash) || hash.slice(1).includes('/')) u.hash = hash;
      const drop = [];
      u.searchParams.forEach((_v, k) => {
        if (/^(utm_|spm|from|share_|ref$|fbclid|gclid)/i.test(k)) drop.push(k);
      });
      drop.forEach((k) => u.searchParams.delete(k));
      let s = u.toString();
      if (s.endsWith('?')) s = s.slice(0, -1);
      return s;
    } catch (_e) {
      return String(raw || '');
    }
  };

  MN.hostOf = function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_e) {
      return '';
    }
  };

  /** 标签是「无限层级」的：用 / 分隔，比如 技术/前端/CSS */
  MN.splitTag = (tag) =>
    String(tag || '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);

  MN.normalizeTag = (tag) => MN.splitTag(tag).join('/');

  /** 把一堆标签整理成树，供标签面板展示。 */
  MN.buildTagTree = function buildTagTree(tags) {
    const root = { name: '', path: '', count: 0, children: new Map() };
    tags.forEach((tag) => {
      const parts = MN.splitTag(tag);
      if (!parts.length) return;
      let node = root;
      node.count += 1;
      let path = '';
      parts.forEach((p) => {
        path = path ? path + '/' + p : p;
        if (!node.children.has(p)) {
          node.children.set(p, { name: p, path, count: 0, children: new Map() });
        }
        node = node.children.get(p);
        node.count += 1;
      });
    });
    const freeze = (node) => ({
      name: node.name,
      path: node.path,
      count: node.count,
      children: [...node.children.values()].map(freeze).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    });
    return freeze(root).children;
  };

  MN.fmtTime = function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  MN.clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  MN.debounce = function debounce(fn, wait) {
    let t = 0;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  /** 复制文本：优先 navigator.clipboard，失败退回 textarea + execCommand。 */
  MN.copyText = async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_e) {
      /* 继续用兜底方案 */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_e) {
      return false;
    }
  };

  /** 把一条划线渲染成 Markdown（Obsidian / Logseq / 思源 都能直接吃）。 */
  MN.annToMarkdown = function annToMarkdown(ann, opts = {}) {
    const tags = (ann.tags || []).map((t) => '#' + t.split('/').map((s) => s.replace(/\s+/g, '-')).join('/'));
    if (ann.type === 'image') {
      let out = `![${ann.note || '图片'}](${ann.image && ann.image.src ? ann.image.src : ann.text || ''})`;
      if (tags.length) out += '\n' + tags.join(' ');
      if (ann.note) out += `\n> ${ann.note}`;
      return out;
    }
    const text = (ann.text || '').replace(/\n+/g, ' ').trim();
    if (opts.template === 'list') {
      let out = `- ${text}`;
      if (tags.length) out += ` ${tags.join(' ')}`;
      if (ann.note) out += `\n\t- 笔记：${ann.note}`;
      return out;
    }
    let out = `> ${text}\n`;
    if (ann.note) out += `> 💬 ${ann.note}\n`;
    if (tags.length) out += `> ${tags.join(' ')}\n`;
    return out.trimEnd();
  };

  /** 按页面分组导出成完整 Markdown。 */
  MN.bundleToMarkdown = function bundleToMarkdown(annotations, opts = {}) {
    const byUrl = new Map();
    annotations.forEach((a) => {
      if (!byUrl.has(a.url)) byUrl.set(a.url, []);
      byUrl.get(a.url).push(a);
    });
    const chunks = [`# MarkNote 划线笔记导出\n\n导出时间：${MN.fmtTime(Date.now())}\n共 ${byUrl.size} 个页面、${annotations.length} 条划线\n`];
    [...byUrl.entries()]
      .sort((a, b) => Math.min(...b[1].map((x) => x.createdAt)) - Math.min(...a[1].map((x) => x.createdAt)))
      .forEach(([url, list]) => {
        const title = list[0].title || url;
        chunks.push(`\n---\n\n## ${title}\n\n<${url}>\n`);
        list.sort((a, b) => {
          const av = a.anchor ? a.anchor.startV : 0;
          const bv = b.anchor ? b.anchor.startV : 0;
          return av - bv;
        });
        list.forEach((a) => chunks.push('\n' + MN.annToMarkdown(a, opts) + '\n'));
      });
    return chunks.join('\n');
  };

  /** 序号的排序方式；存坏了或传了别的值就回落到「按页面位置」。 */
  MN.normalizeIndexMode = function (v) {
    return v === 'order' ? 'order' : 'position';
  };

  MN.MSG = {
    HIGHLIGHT_SELECTION: 'mn:highlight-selection',
    ADD_NOTE: 'mn:add-note',
    SUPER_COPY: 'mn:super-copy',
    MARK_IMAGE: 'mn:mark-image',
    TOGGLE_HIGHLIGHTS: 'mn:toggle-highlights',
    TOGGLE_UNLOCK: 'mn:toggle-unlock',
    TOGGLE_SIDEBAR_BAR: 'mn:toggle-sidebar-bar',
    TOGGLE_INDEX: 'mn:toggle-index',   // 开/关高亮序号
    CLEAR_PAGE: 'mn:clear-page',       // 清空本页所有划线（弹窗 / 侧栏发起）
    OPEN_SIDEBAR: 'mn:open-sidebar',
    OPEN_DASHBOARD: 'mn:open-dashboard',
    PAGE_STATE: 'mn:page-state',
    GET_ANNOTATIONS: 'mn:get-annotations',
    ANNOTATIONS_CHANGED: 'mn:annotations-changed',
    FOCUS_ANNOTATION: 'mn:focus-annotation',
    RELOAD_HIGHLIGHTS: 'mn:reload-highlights',
    GET_ACTIVE_TAB: 'mn:get-active-tab',
    SCROLL_TO: 'mn:scroll-to',
    AI_PANEL: 'mn:ai-panel',  // 打开页面里的 AI 分析面板（产出划线建议）
    AI_TALK: 'mn:ai-talk',     // 打开悬浮对话窗：多轮聊天，不产生任何划线
    AI_CHAT: 'mn:ai-chat',     // 内容脚本 → 后台：代发 AI 请求（后台才有跨域权限）
    AI_TEST: 'mn:ai-test',     // 管理页 → 后台：测试 API Key 通不通
    AI_MODELS: 'mn:ai-models'  // 管理页 → 后台：拉取这个接口支持的模型名
  };
})();
