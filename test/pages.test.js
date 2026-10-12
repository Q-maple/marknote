/*
 * MarkNote 扩展页面冒烟测试（jsdom + 假的扩展 API）
 *
 * 跑法：node test/pages.test.js
 * 目的：确认侧边栏 / 管理页 / 弹窗这三个页面能真正跑起来：脚本不报错、数据渲染出来。
 */
const loadJsdom = require('./_jsdom');
const fs = require('fs');
const os = require('os');
const path = require('path');
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = loadJsdom() || {});
} catch (_e) {
  console.error('需要 jsdom：先执行 `npm i jsdom`');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));

const SEED = {
  'ann:a1': {
    id: 'a1',
    url: 'https://example.com/article',
    title: '示例文章',
    site: 'example.com',
    color: 'yellow',
    type: 'text',
    text: '第一段被划线的文字',
    note: '我的想法',
    tags: ['技术/前端', '待读'],
    anchor: { exact: '第一段被划线的文字', prefix: '', suffix: '', startV: 0, endV: 9, textLength: 100 },
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  'ann:a2': {
    id: 'a2',
    url: 'https://example.com/article',
    title: '示例文章',
    site: 'example.com',
    color: 'green',
    type: 'text',
    text: '第二段被划线的文字',
    note: '',
    tags: [],
    anchor: { exact: '第二段被划线的文字', prefix: '', suffix: '', startV: 20, endV: 29, textLength: 100 },
    createdAt: 1700000001000,
    updatedAt: 1700000001000
  },
  'ann:a3': {
    id: 'a3',
    url: 'https://other.test/page',
    title: '别的页面',
    site: 'other.test',
    color: 'blue',
    type: 'text',
    text: '另一个网站上的划线',
    note: '',
    tags: ['技术'],
    anchor: { exact: '另一个网站上的划线', prefix: '', suffix: '', startV: 1, endV: 9, textLength: 50 },
    createdAt: 1700000002000,
    updatedAt: 1700000002000
  },
  settings: { defaultColor: 'pink', showToolbar: true, showSideBar: true, copySuffix: false, markdownTemplate: 'quote' }
};

function makeChrome(data, opts = {}) {
  const runtime = {
    lastError: null,
    getManifest: () => ({ version: '1.0.0' }),
    getURL: (p) => 'moz-extension://test/' + p,
    sendMessage: () => Promise.resolve(null),
    onMessage: { addListener() {} }
  };
  return {
    runtime,
    storage: {
      local: {
        get(keys, cb) {
          let out;
          if (keys === null || keys === undefined) out = clone(data);
          else if (typeof keys === 'string') out = keys in data ? { [keys]: clone(data[keys]) } : {};
          else if (Array.isArray(keys)) {
            out = {};
            keys.forEach((k) => k in data && (out[k] = clone(data[k])));
          } else {
            out = {};
            Object.keys(keys).forEach((k) => (out[k] = k in data ? clone(data[k]) : keys[k]));
          }
          setTimeout(() => cb(out), 0);
        },
        set: (obj, cb) => setTimeout(() => {
          Object.assign(data, clone(obj));
          cb && cb();
        }, 0),
        remove: (keys, cb) => setTimeout(() => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]);
          cb && cb();
        }, 0)
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    tabs: {
      query(_q, cb) {
        const list = [{ id: 7, url: 'https://example.com/article', title: '示例文章', active: true, width: 1440 }];
        if (typeof _q === 'function') return _q(list);
        setTimeout(() => cb(list), 0);
        return Promise.resolve(list);
      },
      sendMessage(_id, _msg, cb) {
        // 模拟「这一页没有内容脚本」→ 页面应该退回读本地存储
        runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        setTimeout(() => {
          if (cb) cb(undefined);
          runtime.lastError = null;
        }, 0);
        // 用回调风格的调用不返回 Promise，和真实的 chrome.tabs.sendMessage 一致
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    windows: { create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve(), onRemoved: { addListener() {} } }
  };
}

async function openPage(rel, data) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message + (e.detail ? ' :: ' + e.detail : '')));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const file = path.join(ROOT, rel);
  const dom = await JSDOM.fromFile(file, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.chrome = makeChrome(data);
    }
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  await sleep(250);
  return { dom, errors, doc: dom.window.document };
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.error('  ✗ ' + name + (extra !== undefined ? '  →  ' + extra : ''));
  }
}

(async function main() {
  console.log('\n[1] 侧边栏');
  {
    const data = clone(SEED);
    const { doc, errors } = await openPage('src/sidebar/sidebar.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    check('标题是当前页面', /示例文章|当前页面划线/.test(doc.getElementById('page-title').textContent), doc.getElementById('page-title').textContent);
    check('统计显示 2 条划线', doc.getElementById('stats').textContent.includes('2 条划线'), doc.getElementById('stats').textContent.trim());
    // 测试环境里 tabs.sendMessage 必失败（等价于「页面在装插件之前就打开了」）：
    // 侧栏不能装作一切正常——「定位 / 删除」按钮这时点了是没有反应的。
    check('侧栏也提示页面未连接插件', doc.querySelector('#stats .chip.warn') !== null,
      doc.getElementById('stats').textContent.trim());
    check('侧栏提示里教人刷新页面', /刷新（F5）/.test(doc.getElementById('stats').textContent),
      doc.getElementById('stats').textContent.trim());
    check('列出了 2 条划线', doc.querySelectorAll('#list .ann').length === 2, String(doc.querySelectorAll('#list .ann').length));
    check('笔记渲染出来', doc.getElementById('list').textContent.includes('我的想法'));
    check('标签渲染出来', doc.getElementById('list').textContent.includes('技术/前端'));
    check('颜色下拉有 5 项', doc.getElementById('color-filter').options.length === 6, String(doc.getElementById('color-filter').options.length));
    // 搜索过滤
    const q = doc.getElementById('q');
    q.value = '第二段';
    q.dispatchEvent(new dom2Event(doc, 'input'));
    await sleep(30);
    check('搜索可以过滤', doc.querySelectorAll('#list .ann').length === 1, String(doc.querySelectorAll('#list .ann').length));
  }

  console.log('\n[2] 管理页');
  {
    const { doc, errors } = await openPage('src/dashboard/dashboard.html', clone(SEED));
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    check('统计显示 3 条划线', doc.getElementById('stats').textContent.includes('3 条划线'), doc.getElementById('stats').textContent.trim());
    check('按页面分组为 2 组', doc.querySelectorAll('#list .group').length === 2, String(doc.querySelectorAll('#list .group').length));
    check('标签树有节点', doc.querySelectorAll('#tag-tree .tag-line').length >= 3, String(doc.querySelectorAll('#tag-tree .tag-line').length));
    check('网站下拉有 3 项', doc.getElementById('site').options.length === 3, String(doc.getElementById('site').options.length));
    check('列出了全部 3 条', doc.querySelectorAll('#list .ann').length === 3, String(doc.querySelectorAll('#list .ann').length));
    // 点标签过滤
    const lines = [...doc.querySelectorAll('#tag-tree .tag-line')];
    const tech = lines.find((l) => l.textContent.startsWith('技术'));
    tech.dispatchEvent(new dom2Event(doc, 'click'));
    await sleep(30);
    check('点标签筛选生效', doc.querySelectorAll('#list .ann').length === 2, String(doc.querySelectorAll('#list .ann').length));
  }

  console.log('\n[3] 弹窗');
  {
    const { doc, errors } = await openPage('src/popup/popup.html', clone(SEED));
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    check('颜色点有 5 个', doc.querySelectorAll('#colors .dot').length === 5, String(doc.querySelectorAll('#colors .dot').length));
    check('默认色标记在 pink 上', doc.querySelector('#colors .dot[data-active="1"]').dataset.color === 'pink', doc.querySelector('#colors .dot[data-active="1"]') && doc.querySelector('#colors .dot[data-active="1"]').dataset.color);
    check('显示版本号', doc.getElementById('ver').textContent === 'v1.0.0', doc.getElementById('ver').textContent);
    check('显示本页划线数', doc.getElementById('page-stats').textContent.includes('2 条划线'), doc.getElementById('page-stats').textContent.trim());
    // 测试环境里 tabs.sendMessage 必失败（等价于「页面在装插件之前就打开了」）：
    // 这时弹窗必须把「点按钮没反应」的原因说出来。
    check('页面未连接插件时给出可见提示', doc.querySelector('#page-stats .chip.warn') !== null,
      doc.getElementById('page-stats').textContent.trim());
    check('提示里教人刷新页面', /刷新（F5）/.test(doc.getElementById('page-stats').textContent),
      doc.getElementById('page-stats').textContent.trim());
    check('提示不夹英文原文', !/Receiving end/.test(doc.getElementById('page-stats').textContent),
      doc.getElementById('page-stats').textContent.trim());
  }

  console.log('\n[4] 弹窗：自定义颜色（色环 / RGB / 常用色）');
  {
    const data = clone(SEED);
    const { dom, doc, errors } = await openPage('src/popup/popup.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    check('一开始没有自定义色', doc.getElementById('custom-colors').textContent.includes('还没有自定义颜色'),
      doc.getElementById('custom-colors').textContent.trim());

    doc.getElementById('add-custom').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(40);
    const pk = doc.querySelector('#picker-host .mn-pk');
    check('取色器打开了', !!pk && doc.getElementById('picker-host').hidden === false);
    check('有色环', !!pk && !!pk.querySelector('.mn-pk-ring'));
    check('有饱和 / 明度方块', !!pk && !!pk.querySelector('.mn-pk-sv'));
    check('有 RGB 三个输入框', !!pk && ['r', 'g', 'b'].every((k) => pk.querySelector(`[data-ch="${k}"]`)));
    check('有系统取色器', !!pk && pk.querySelector('[data-ch="native"]').type === 'color');

    const setCh = (k, v) => {
      const el = pk.querySelector(`[data-ch="${k}"]`);
      el.value = String(v);
      el.dispatchEvent(dom2Event(doc, 'input'));
    };
    setCh('r', 59);
    setCh('g', 91);
    setCh('b', 219);
    check('HEX 跟着 RGB 走', pk.querySelector('[data-ch="hex"]').value === '#3b5bdb',
      pk.querySelector('[data-ch="hex"]').value);

    pk.querySelector('[data-pk="save"]').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('写进了 settings.customColors',
      Array.isArray(data.settings.customColors) && data.settings.customColors.indexOf('#3b5bdb') >= 0,
      JSON.stringify(data.settings.customColors));
    check('默认色一起改成自定义色', data.settings.defaultColor === '#3b5bdb', String(data.settings.defaultColor));
    check('颜色点多了一个', doc.querySelectorAll('#colors .dot').length === 6,
      String(doc.querySelectorAll('#colors .dot').length));
    check('自定义色被标成默认', (doc.querySelector('#colors .dot[data-active="1"]') || {}).dataset.color === '#3b5bdb',
      doc.querySelector('#colors .dot[data-active="1"]') && doc.querySelector('#colors .dot[data-active="1"]').dataset.color);
    check('常用色列表里有它', doc.getElementById('custom-colors').textContent.includes('#3b5bdb'),
      doc.getElementById('custom-colors').textContent.trim());
    check('点「存为常用色」后取色器收起', doc.getElementById('picker-host').hidden === true);

    // 再打开一次：取色器应该带着当前默认色
    doc.getElementById('add-custom').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(40);
    const pk2 = doc.querySelector('#picker-host .mn-pk');
    check('再次打开时带着当前颜色', pk2.querySelector('[data-ch="hex"]').value === '#3b5bdb',
      pk2.querySelector('[data-ch="hex"]').value);
    check('常用色出现在取色器色板里', !!pk2.querySelector('.mn-pk-sw[data-color="#3b5bdb"]'));
    const rgbW = parseInt(dom.window.getComputedStyle(pk2.querySelector('[data-ch="r"]')).width, 10);
    check('RGB 输入框宽度够放下三位数', rgbW >= 50, String(rgbW));
    const pkW = parseInt(dom.window.getComputedStyle(pk2).width, 10);
    check('取色器整体放了宽（不低于 300px）', pkW >= 300, String(pkW));
    check('弹窗也放大了（不低于 380px）', parseInt(dom.window.getComputedStyle(doc.body).width, 10) >= 380,
      dom.window.getComputedStyle(doc.body).width);

    // 删除常用色（一）：取色器色板里自定义色右上角的 ×
    check('自定义色带删除钮', !!pk2.querySelector('.mn-pk-sw[data-color="#3b5bdb"] .mn-pk-sw-del'));
    check('内置色没有删除钮', !pk2.querySelector('.mn-pk-sw[data-color="yellow"] .mn-pk-sw-del'));
    pk2.querySelector('.mn-pk-sw[data-color="#3b5bdb"] .mn-pk-sw-del').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('从取色器里删掉后设置也清了',
      !(data.settings.customColors || []).some((c) => c === '#3b5bdb'),
      JSON.stringify(data.settings.customColors));
    check('删掉后色板点回到 5 个', doc.querySelectorAll('#colors .dot').length === 5,
      String(doc.querySelectorAll('#colors .dot').length));
    check('删掉后常用色列表也空了', doc.getElementById('custom-colors').textContent.includes('还没有自定义颜色'),
      doc.getElementById('custom-colors').textContent.trim());
    check('删掉后取色器里的色板也没了',
      !doc.querySelector('#picker-host .mn-pk-sw[data-color="#3b5bdb"]'));
    check('删掉后取色器还开着', doc.getElementById('picker-host').hidden === false);

    // 再用「存为常用色」加回来
    const pk3 = doc.querySelector('#picker-host .mn-pk');
    const hexIn = pk3.querySelector('[data-ch="hex"]');
    hexIn.value = '#3b5bdb';
    hexIn.dispatchEvent(dom2Event(doc, 'input'));
    pk3.querySelector('[data-pk="save"]').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('能再加回来', (data.settings.customColors || []).indexOf('#3b5bdb') >= 0, JSON.stringify(data.settings.customColors));
    doc.getElementById('add-custom').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(40);
    doc.getElementById('add-custom').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(40);

    // 删除常用色（二）：弹窗常用色列表里的 ×
    doc.querySelector('#custom-colors .chip button').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(60);
    check('移除后设置里没了',
      !(data.settings.customColors || []).some((c) => c === '#3b5bdb'),
      JSON.stringify(data.settings.customColors));
    check('移除后颜色点回到 5 个', doc.querySelectorAll('#colors .dot').length === 5,
      String(doc.querySelectorAll('#colors .dot').length));
    check('移除后默认色仍然保留（已划的线不受影响）', data.settings.defaultColor === '#3b5bdb',
      String(data.settings.defaultColor));
  }

  console.log('\n[5] 侧边栏：颜色筛选包含自定义色与历史颜色');
  {
    const data = clone(SEED);
    data.settings.customColors = ['#3b5bdb'];
    data['ann:a1'] = { ...data['ann:a1'], color: '#ff0099' }; // 色板里已经没有、但划线还在的颜色
    const { dom, doc, errors } = await openPage('src/sidebar/sidebar.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    const values = [...doc.getElementById('color-filter').options].map((o) => o.value);
    check('筛选里有自定义色', values.indexOf('#3b5bdb') >= 0, values.join(','));
    check('筛选里有数据里残留的颜色', values.indexOf('#ff0099') >= 0, values.join(','));
    check('内置色一个不少', ['yellow', 'green', 'blue', 'pink', 'purple'].every((c) => values.indexOf(c) >= 0), values.join(','));

    const filter = doc.getElementById('color-filter');
    filter.value = '#ff0099';
    filter.dispatchEvent(dom2Event(doc, 'change'));
    await sleep(30);
    check('按残留颜色筛选生效', doc.querySelectorAll('#list .ann').length === 1,
      String(doc.querySelectorAll('#list .ann').length));
    check('筛出来的就是那条', doc.querySelector('#list .ann').textContent.includes('第一段被划线的文字'));
    check('按自定义色筛选（本页没有）→ 空', (() => {
      filter.value = '#3b5bdb';
      filter.dispatchEvent(dom2Event(doc, 'change'));
      return true;
    })());
    await sleep(30);
    check('没有匹配时给出提示', doc.querySelectorAll('#list .ann').length === 0 &&
      doc.getElementById('list').textContent.includes('没有符合条件'), doc.getElementById('list').textContent.trim());
  }

  console.log('\n[6] 管理页：AI 设置卡片');
  {
    const data = clone(SEED);
    const { dom, doc, errors } = await openPage('src/dashboard/dashboard.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    check('AI 卡片是折叠的（不挤占划线列表）', doc.getElementById('ai-card').open === false);
    check('折叠时也标注了状态', doc.getElementById('ai-summary').textContent.includes('未开启'),
      doc.getElementById('ai-summary').textContent);

    const field = (id) => doc.getElementById(id);
    check('默认接口地址是 DeepSeek', field('ai-base').value === 'https://api.deepseek.com', field('ai-base').value);
    check(
      '不再写死模型名（留空），并提示保存 Key 后会自动拉取',
      field('ai-model').value === '' && /自动拉取/.test(field('ai-model').placeholder || ''),
      JSON.stringify({ value: field('ai-model').value, ph: field('ai-model').placeholder })
    );
    check('默认是关着的', field('ai-enabled').checked === false);
    check('默认提示词框给了占位文案', (field('ai-prompt').placeholder || '').includes('批注'));
    check('一开始没有 Key', field('ai-key').value === '');

    // 填好一份配置并保存：模型框是空的 → 应该自动拉一次并选第一个
    const askedAi = [];
    dom.window.chrome.runtime.sendMessage = (msg, cb) => {
      askedAi.push(msg.type);
      const res =
        msg.type === 'mn:ai-models'
          ? { ok: true, models: ['deepseek-chat', 'deepseek-reasoner'] }
          : { ok: true };
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };
    check('有「对话默认提示词」这一栏', !!field('ai-chat-prompt'));
    check('它的占位文案带出内置那句', /帮我解释这段文字的意思/.test(field('ai-chat-prompt').placeholder || ''),
      field('ai-chat-prompt').placeholder);
    field('ai-key').value = 'sk-test-abcdef123456';
    field('ai-enabled').checked = true;
    field('ai-max').value = '7';
    field('ai-prompt').value = '只要结论';
    field('ai-chat-prompt').value = '先给我一句话总结';
    field('ai-save').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(140);
    check('保存后写进了 settings', data.settings.ai && data.settings.ai.enabled === true, JSON.stringify(data.settings.ai));
    check('保存时自动拉了一次模型列表', askedAi.includes('mn:ai-models'), askedAi.join(','));
    check('自动把第一个模型设成默认值', field('ai-model').value === 'deepseek-chat', field('ai-model').value);
    check('自动选的模型也落盘了', data.settings.ai.model === 'deepseek-chat', JSON.stringify(data.settings.ai.model));
    check('状态里说清了是自动选的', /自动选为/.test(field('ai-status').textContent), field('ai-status').textContent);
    check('模型标签也铺出来了', doc.querySelectorAll('#ai-models button[data-model]').length === 2,
      String(doc.querySelectorAll('#ai-models button[data-model]').length));
    check('上限也存了', data.settings.ai.maxItems === 7, JSON.stringify(data.settings.ai));
    check('提示词存了', data.settings.ai.prompt === '只要结论', data.settings.ai.prompt);
    check('对话默认提示词也存了', data.settings.ai.chatPrompt === '先给我一句话总结', data.settings.ai.chatPrompt);
    check('Key 单独存，不进 settings', data.aiKey === 'sk-test-abcdef123456' && !JSON.stringify(data.settings).includes('sk-test'),
      JSON.stringify({ aiKey: data.aiKey, settings: data.settings }));
    check('状态提示保存成功', field('ai-status').textContent.includes('已保存'), field('ai-status').textContent);
    check('折叠标题变成已开启', field('ai-summary').textContent.includes('已开启'), field('ai-summary').textContent);

    // 「导出 JSON 备份」不能把 Key 带走
    const bundle = await dom.window.MN.store.exportBundle();
    check('导出备份里没有 Key', !JSON.stringify(bundle).includes('sk-test-abcdef'), JSON.stringify(bundle.settings));
    check('导出备份里有 AI 设置（但不含密钥）', !!bundle.settings.ai && bundle.settings.ai.enabled === true);

    // 数字输错了也会被夹回来
    field('ai-max').value = '999';
    field('ai-base').value = 'not-a-url';
    field('ai-save').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(60);
    check('上限被夹到 30', data.settings.ai.maxItems === 30, String(data.settings.ai.maxItems));
    check('乱七八糟的地址退回官方地址', data.settings.ai.baseUrl === 'https://api.deepseek.com', data.settings.ai.baseUrl);

    // 测试连接：后台回什么就显示什么
    dom.__answered = [];
    dom.window.chrome.runtime.sendMessage = (msg, cb) => {
      dom.__answered.push(msg);
      const res = { ok: true, model: 'deepseek-chat', reply: '可用' };
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };
    field('ai-test').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('测试连接发的是 mn:ai-test', dom.__answered.length === 1 && dom.__answered[0].type === 'mn:ai-test',
      JSON.stringify(dom.__answered));
    check('通了显示回执', field('ai-status').textContent.includes('通了'), field('ai-status').textContent);

    // 接口报错也要说人话
    dom.window.chrome.runtime.sendMessage = (msg, cb) => {
      const res = { ok: false, code: 'http', error: 'Authentication Fails' };
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };
    field('ai-test').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('失败时把服务端的原话显示出来', field('ai-status').textContent.includes('Authentication Fails'),
      field('ai-status').textContent);
    check('失败标成红色', field('ai-status').classList.contains('err'));

    // 拉取可用模型：一键拿到接口支持的名字，点一下填进模型框
    dom.__answered = [];
    dom.window.chrome.runtime.sendMessage = (msg, cb) => {
      dom.__answered.push(msg);
      const res = { ok: true, models: ['deepseek-flash', 'deepseek-v4-pro'] };
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };
    const modelsBox = doc.getElementById('ai-models');
    // 上面保存时已经自动拉过一次了，所以现在标签就已经在了
    check('保存后标签已经自动铺好', modelsBox.querySelectorAll('button[data-model]').length === 2,
      String(modelsBox.querySelectorAll('button[data-model]').length));
    check('有一句解释怎么找模型名', doc.getElementById('ai-models-hint').textContent.includes('拉取可用模型'));
    field('ai-list-models').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('拉模型发的是 mn:ai-models', dom.__answered[0].type === 'mn:ai-models', JSON.stringify(dom.__answered));
    check('铺出了两个可点的模型标签', modelsBox.querySelectorAll('button[data-model]').length === 2,
      String(modelsBox.querySelectorAll('button[data-model]').length));
    check('标签上写着模型名', modelsBox.textContent.includes('deepseek-v4-pro'), modelsBox.textContent.trim());
    check('模型框挂了 datalist（能自动补全）',
      doc.getElementById('ai-model').getAttribute('list') === 'ai-model-list' &&
        doc.querySelectorAll('#ai-model-list option').length === 2,
      String(doc.querySelectorAll('#ai-model-list option').length));
    modelsBox.querySelector('button[data-model="deepseek-v4-pro"]').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(30);
    check('点一下就把模型填进去了', field('ai-model').value === 'deepseek-v4-pro', field('ai-model').value);
    check('填完提醒要保存', field('ai-status').textContent.includes('保存'), field('ai-status').textContent);

    // 测试连接报「模型名不对」时，也应该顺手把可用模型铺出来
    dom.window.chrome.runtime.sendMessage = (msg, cb) => {
      const res = {
        ok: false,
        code: 'http',
        error: 'The supported API model names are deepseek-flash, deepseek-v4-pro（这个接口可用的模型：deepseek-flash、deepseek-v4-pro）',
        models: ['deepseek-flash', 'deepseek-v4-pro']
      };
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };
    modelsBox.innerHTML = '';
    field('ai-test').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('报错时也铺出可用模型', modelsBox.querySelectorAll('button[data-model]').length === 2,
      String(modelsBox.querySelectorAll('button[data-model]').length));
    check('错误原文照旧显示', field('ai-status').textContent.includes('supported API model names'),
      field('ai-status').textContent);

    // 清除 Key
    dom.window.confirm = () => true;
    field('ai-clear').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(60);
    check('清除后 Key 没了', !data.aiKey, JSON.stringify(data.aiKey));
    check('清除后输入框空了', field('ai-key').value === '');
    check('清除后给了反馈', field('ai-status').textContent.includes('清除'), field('ai-status').textContent);
    check('清除后把模型标签也收掉', modelsBox.querySelectorAll('button').length === 0);
  }

  console.log('\n[6b] 管理页：填了 API Key 就自动勾上「打开 AI 分析」');
  {
    const data = clone(SEED);
    const { dom, doc, errors } = await openPage('src/dashboard/dashboard.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    const field = (id) => doc.getElementById(id);
    check('什么都没填时依然默认关着（默认值没被改）', field('ai-enabled').checked === false);
    check('初始摘要还是未开启', field('ai-summary').textContent.includes('未开启'), field('ai-summary').textContent);

    // 保存 Key 时后台要配合返回模型列表
    dom.window.chrome.runtime.sendMessage = (msg, cb) => {
      const res = { ok: true, models: ['deepseek-chat'] };
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };

    // 1) 往 Key 框里打字 / 粘贴 → 开关自动勾上
    field('ai-key').value = 'sk-auto-abcdef123456';
    field('ai-key').dispatchEvent(dom2Event(doc, 'input'));
    check('填了 Key 自动勾上开关', field('ai-enabled').checked === true);
    check('折叠标题立刻变成已开启', field('ai-summary').textContent.includes('已开启'), field('ai-summary').textContent);
    check('提示里说清了是顺手勾的', field('ai-status').textContent.includes('顺手勾上'), field('ai-status').textContent);

    // 2) 自动勾上的状态保存后真的落盘，不用再手动勾一次
    field('ai-save').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(140);
    check('自动勾上后保存，enabled 落盘为 true', data.settings.ai && data.settings.ai.enabled === true,
      JSON.stringify(data.settings.ai));
    check('Key 也存进去了', data.aiKey === 'sk-auto-abcdef123456', JSON.stringify(data.aiKey));

    // 3) 用户亲手取消勾选后，再改 Key 不再强行勾回来
    field('ai-enabled').checked = false;
    field('ai-enabled').dispatchEvent(dom2Event(doc, 'change'));
    field('ai-key').value = 'sk-auto-2';
    field('ai-key').dispatchEvent(dom2Event(doc, 'input'));
    check('取消勾选后就不再自动勾回来（以用户选择为准）', field('ai-enabled').checked === false);
  }

  console.log('\n[7] 侧边栏：序号与清空入口');
  {
    // startV 顺序和创建时间顺序故意反着来，验证两种排序
    const data = {
      settings: { defaultColor: 'yellow', showIndex: true, indexMode: 'position' },
      'ann:a1': { ...clone(SEED['ann:a1']), id: 'a1', anchor: { exact: 'x', prefix: '', suffix: '', startV: 90, endV: 99, textLength: 100 } },
      'ann:a2': { ...clone(SEED['ann:a2']), id: 'a2', anchor: { exact: 'y', prefix: '', suffix: '', startV: 5, endV: 14, textLength: 100 } }
    };
    const { doc, errors } = await openPage('src/sidebar/sidebar.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    const badges = () => [...doc.querySelectorAll('#list .ann')].map((n) => {
      const b = n.querySelector('.ann-idx');
      return b ? b.textContent : '';
    });
    check('开了序号后每条都有编号', badges().every(Boolean), badges().join(','));
    check('按位置排：startV 小的排在前面（5 在前，90 在后）',
      doc.querySelectorAll('#list .ann')[0].dataset.id === 'a2' && doc.querySelectorAll('#list .ann')[1].dataset.id === 'a1',
      [...doc.querySelectorAll('#list .ann')].map((n) => n.dataset.id).join(','));
    check('编号和位置一致：第一条是 1', badges().join(',') === '1,2', badges().join(','));
    check('序号按钮标成开启状态', doc.getElementById('btn-index').dataset.on === '1');

    // 侧边栏里的开关：没有内容脚本时也要能改（退回写设置）
    doc.getElementById('btn-index').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(120);
    check('再点一下关掉序号', data.settings.showIndex === false, JSON.stringify(data.settings));
    check('关掉后清单里没有编号了', badges().every((b) => b === ''), badges().join(','));
    check('序号按钮不再高亮', doc.getElementById('btn-index').dataset.on === '0');

    // 清空按钮：没有内容脚本时应该只弹确认、不清数据（免得误删）
    let confirmed = '';
    doc.defaultView.confirm = (msg) => {
      confirmed = String(msg);
      return true;
    };
    const before = Object.keys(data).filter((k) => k.startsWith('ann:')).length;
    doc.getElementById('btn-clear').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(120);
    check('清空前会问一句', confirmed.includes('清空本页'), confirmed);
    check('问的时候报了几条', confirmed.includes('2 条'), confirmed);
    check('提到可以撤销 / 备份', /撤销/.test(confirmed) && /备份/.test(confirmed), confirmed);
    check('没有内容脚本时不会真的删数据', Object.keys(data).filter((k) => k.startsWith('ann:')).length === before,
      String(Object.keys(data).filter((k) => k.startsWith('ann:')).length));
  }

  console.log('\n[8] 弹窗：序号开关与清空本页');
  {
    const data = clone(SEED);
    const { dom, doc } = await openPage('src/popup/popup.html', data);
    check('有「显示 / 隐藏序号」按钮', !!doc.getElementById('toggle-index'));
    check('有「清空本页划线」按钮', !!doc.getElementById('clear-page'));
    check('清空按钮是危险色', doc.getElementById('clear-page').classList.contains('danger'));

    // 没连上内容脚本 → 不让点确认、也不报错
    let asked = 0;
    doc.defaultView.confirm = () => {
      asked += 1;
      return true;
    };
    doc.getElementById('clear-page').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('读不到页面状态时不弹确认', asked === 0, String(asked));
    check('而是提示本页还没有划线', doc.getElementById('page-stats').textContent.includes('还没有划线'),
      doc.getElementById('page-stats').textContent);

    // 假装页面那边活着
    dom.window.chrome.tabs.sendMessage = (id, msg, cb) => {
      const res =
        msg.type === 'mn:page-state'
          ? { count: 3, title: '示例文章', url: 'https://example.com/article', showIndex: true, hidden: false, unlocked: false, lost: [] }
          : msg.type === 'mn:clear-page'
            ? { ok: true, cleared: 3 }
            : { ok: true, showIndex: true };
      if (cb) setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };
    doc.getElementById('clear-page').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('确认框里报出条数', asked === 1, String(asked));
    await sleep(60);
    check('清空后回执写进统计条', doc.getElementById('page-stats').textContent.includes('已清空 3 条'),
      doc.getElementById('page-stats').textContent);
    check('回执里提醒可以撤销', doc.getElementById('page-stats').textContent.includes('撤销'),
      doc.getElementById('page-stats').textContent);
  }

  console.log('\n[9] 管理页：序号设置 + 清空全部');
  {
    const data = clone(SEED);
    const { doc, errors } = await openPage('src/dashboard/dashboard.html', data);
    check('没有脚本错误', errors.length === 0, errors.join(' | '));
    const field = (id) => doc.getElementById(id);
    check('序号卡片是折叠的', field('disp-card').open === false);
    check('折叠时标注状态', field('disp-summary').textContent.includes('已关闭'), field('disp-summary').textContent);
    check('默认没勾序号', field('disp-index').checked === false);
    check('默认按页面位置', field('disp-mode').value === 'position', field('disp-mode').value);
    check('没勾序号时排序不可选', field('disp-mode').disabled === true);

    field('disp-index').checked = true;
    field('disp-index').dispatchEvent(dom2Event(doc, 'change'));
    await sleep(80);
    check('勾上就立刻写进设置', data.settings.showIndex === true, JSON.stringify(data.settings));
    check('摘要跟着变', field('disp-summary').textContent.includes('按页面位置'), field('disp-summary').textContent);
    check('摘要说已开启', field('disp-summary').textContent.startsWith('已开启'), field('disp-summary').textContent);
    check('勾上后排序可选', field('disp-mode').disabled === false);

    field('disp-mode').value = 'order';
    field('disp-mode').dispatchEvent(dom2Event(doc, 'change'));
    await sleep(80);
    check('换排序方式也立刻生效', data.settings.indexMode === 'order', JSON.stringify(data.settings));
    check('摘要跟着写成按创建时间', field('disp-summary').textContent.includes('按创建时间'), field('disp-summary').textContent);

    // 清空全部
    const annKeys = () => Object.keys(data).filter((k) => k.startsWith('ann:'));
    const total = annKeys().length;
    check('一共 3 条划线（含别的网站）', total === 3, String(total));
    check('危险区标出总数', field('danger-summary').textContent.includes('共 3 条'), field('danger-summary').textContent);
    let confirmed = '';
    doc.defaultView.confirm = (msg) => {
      confirmed = String(msg);
      return true;
    };
    field('clear-all').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(150);
    check('清空前问一句', /清空全部 3 条/.test(confirmed), confirmed);
    check('确认里报了页面数', /2 个页面/.test(confirmed), confirmed);
    check('确认里提醒先备份', /备份/.test(confirmed), confirmed);
    check('存储真的清空了', annKeys().length === 0, annKeys().join(','));
    check('列表也空了', doc.getElementById('list').textContent.includes('没有') || doc.querySelectorAll('#list .ann').length === 0);
    const undo = field('clear-all-status').querySelector('button');
    check('给了撤销按钮', !!undo && undo.textContent === '撤销', field('clear-all-status').innerHTML);
    check('回执说明清了几条', field('clear-all-status').textContent.includes('已清空 3 条'), field('clear-all-status').textContent);

    undo.dispatchEvent(dom2Event(doc, 'click'));
    await sleep(200);
    check('撤销把数据写回来了', annKeys().length === 3, annKeys().join(','));
    check('撤销后回执说恢复了几条', field('clear-all-status').textContent.includes('已恢复 3 条'), field('clear-all-status').textContent);
    check('撤销后列表又渲染出来', doc.querySelectorAll('#list .ann').length > 0,
      String(doc.querySelectorAll('#list .ann').length));
  }

  console.log('\n[10] 复制辅助：弹窗端的首次确认门');
  {
    const data = clone(SEED);
    const { dom, doc } = await openPage('src/popup/popup.html', data);
    const sent = [];
    // 记录发往内容脚本的消息，同时假装内容脚本守规矩地按 ack 决定开不开
    dom.window.chrome.tabs.sendMessage = (id, msg, cb) => {
      sent.push(msg.type);
      const res =
        msg.type === 'mn:super-copy' || msg.type === 'mn:ai-panel'
          ? { ok: true }
          : { ok: !!(data.settings && data.settings.copyNoticeAck), unlocked: !!(data.settings && data.settings.copyNoticeAck) };
      if (cb) setTimeout(() => cb(res), 0);
      return Promise.resolve(res);
    };

    check('按钮写的是中性描述', doc.getElementById('unlock').textContent.includes('选中'), doc.getElementById('unlock').textContent);
    check('按钮 / 快捷键文案里没有「绕过」', !/绕过/.test(doc.body.innerHTML), '页面里还有「绕过」字样');

    // 第一次点：弹确认框 → 用户拒绝 → 不该发消息、不该写 ack
    let asked = 0;
    let askedText = '';
    doc.defaultView.confirm = (msg) => {
      asked += 1;
      askedText = String(msg);
      return false;
    };
    doc.getElementById('unlock').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('第一次点会先弹确认', asked === 1, String(asked));
    check('确认文案说明只作用于自己的浏览器', /你自己的浏览器/.test(askedText), askedText);
    check('确认文案提醒遵守网站条款', /使用条款/.test(askedText), askedText);
    check('拒绝后不发任何消息', !sent.includes('mn:toggle-unlock'), sent.join(','));
    check('拒绝后不写确认标记', !data.settings || !data.settings.copyNoticeAck, JSON.stringify(data.settings));

    // 第二次点：确认 → 写标记 + 发消息
    doc.defaultView.confirm = () => true;
    doc.getElementById('unlock').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(120);
    check('确认后写下了确认标记', !!(data.settings && data.settings.copyNoticeAck), JSON.stringify(data.settings));
    check('确认后才发 TOGGLE_UNLOCK', sent.includes('mn:toggle-unlock'), sent.join(','));

    // 第三次点：已经确认过，不再打扰
    asked = 0;
    doc.getElementById('unlock').dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('确认过之后不再重复弹窗', asked === 0, String(asked));
  }

  console.log('\n[11] AI 卡片的第三方声明与隐私政策入口');
  {
    const data = clone(SEED);
    const { doc } = await openPage('src/dashboard/dashboard.html', data);
    const ai = doc.getElementById('ai-card');
    const text = ai.textContent;
    check('卡片标题不再暗示官方', !/AI 分析（DeepSeek）/.test(text), ai.querySelector('summary').textContent.trim());
    check('卡片标题写成第三方接口', /第三方接口/.test(ai.querySelector('summary').textContent), ai.querySelector('summary').textContent);
    check('明确写了没有隶属或合作关系', /没有隶属或合作关系/.test(text), text.slice(0, 200));
    check('提醒分析结果可能出错', /可能(有误|不准确)/.test(text), text.slice(0, 200));
    check('提示 Key 只存本机', /只存在本机/.test(text), text.slice(0, 300));

    const links = [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    check('AI 卡片里有隐私政策链接', links.some((h) => /privacy\.html$/.test(h)), links.join(','));

    // 弹窗页脚也要有入口
    const data2 = clone(SEED);
    const { doc: pop } = await openPage('src/popup/popup.html', data2);
    const popLinks = [...pop.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    check('弹窗里也有隐私政策链接', popLinks.some((h) => /privacy\.html$/.test(h)), popLinks.join(','));
    check('弹窗提醒生成内容可能有误', /可能有误/.test(pop.body.textContent), pop.querySelector('footer').textContent.trim());
  }

  console.log('\n[12] 弹窗：AI 对话入口');
  {
    const data = clone(SEED);
    const { dom, doc } = await openPage('src/popup/popup.html', data);
    const btn = doc.getElementById('ai-talk');
    check('有「AI 对话选中文字」按钮', !!btn, '没有 #ai-talk');
    check('按钮文案说明了是对话', /对话/.test(btn.textContent), btn.textContent);
    const sent = [];
    let closed = false;
    dom.window.chrome.tabs.sendMessage = (id, msg, cb) => {
      sent.push(msg.type);
      if (cb) setTimeout(() => cb({ ok: true }), 0);
      return Promise.resolve({ ok: true });
    };
    dom.window.close = () => {
      closed = true;
    };
    btn.dispatchEvent(dom2Event(doc, 'click'));
    await sleep(80);
    check('点了会通知内容脚本开对话窗', sent.includes('mn:ai-talk'), sent.join(','));
    check('点完弹窗自己关掉', closed === true);
  }

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

function dom2Event(doc, type) {
  return new doc.defaultView.Event(type, { bubbles: true });
}
