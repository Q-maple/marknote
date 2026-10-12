/**
 * 接线检查：清单 / 页面里到底加载了哪些脚本。
 *
 * 这一套是补一个真实的坑：`src/common/ai.js` 加进了 background.scripts，
 * 却忘了加进 content_scripts.js —— 页面里的 content.js 拿不到 MN.ai，
 * 于是无论用户怎么配置，AI 面板永远显示「还没打开，去配置」。
 * 单元测试当时全绿，因为它们用一份手写的 FILES 列表喂 jsdom，
 * 根本没看 manifest.json。所以这里改成**从清单/HTML 里读脚本列表**，
 * 再按那份列表把脚本跑起来，断言该有的模块真的在。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? '  →  ' + extra : ''));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 各个页面 HTML 里 <script src> 的顺序，解析成相对仓库根目录的路径。 */
function pageScripts(pageRel) {
  const list = [];
  const html = read(pageRel);
  const re = /<script[^>]+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    list.push(path.posix.normalize(path.posix.join(path.posix.dirname(pageRel), m[1])));
  }
  return list;
}

const PAGES = ['src/dashboard/dashboard.html', 'src/sidebar/sidebar.html', 'src/popup/popup.html'];
const CONTENT_JS = manifest.content_scripts[0].js;

console.log('[1] manifest.content_scripts 里的脚本够不够 content.js 用');
{
  check('content.js 排在最后（公共库都在它前面）', CONTENT_JS[CONTENT_JS.length - 1] === 'src/content/content.js', CONTENT_JS.join(', '));
  ['util', 'store', 'anchors', 'picker', 'ai'].forEach((mod) => {
    const want = 'src/common/' + mod + '.js';
    check('加载了 ' + want, CONTENT_JS.indexOf(want) >= 0, CONTENT_JS.join(', '));
  });
  check('ai.js 在 content.js 前面', CONTENT_JS.indexOf('src/common/ai.js') < CONTENT_JS.indexOf('src/content/content.js'));
  CONTENT_JS.forEach((rel) => {
    check('脚本真实存在：' + rel, fs.existsSync(path.join(ROOT, rel)));
  });

  // 真正把清单里列的脚本按顺序跑一遍，看 MN.ai 在不在
  const sandbox = {
    console: { warn() {}, log() {} },
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    location: { href: 'https://example.test/a', hash: '', search: '' }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  // content.js 在 init 里要用到扩展 API，这里只跑到「模块定义完成」为止：
  // 给一个最小可用的 chrome，让它别在初始化时炸掉。
  sandbox.chrome = {
    runtime: { getManifest: () => ({ version: '0' }), sendMessage: () => Promise.resolve({}), onMessage: { addListener() {} }, getURL: (p) => p, lastError: null },
    storage: {
      local: { get: (k, cb) => { const r = {}; if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); }, set: (o, cb) => { if (typeof cb === 'function') setTimeout(cb, 0); return Promise.resolve(); }, remove: (k, cb) => { if (typeof cb === 'function') setTimeout(cb, 0); return Promise.resolve(); } },
      onChanged: { addListener() {}, removeListener() {} }
    },
    tabs: { query: (q, cb) => { const r = []; if (typeof q === 'function') q(r); else if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); }, sendMessage: () => Promise.resolve(null), onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { create: () => Promise.resolve({}), update: () => Promise.resolve(), onRemoved: { addListener() {} } }
  };
  sandbox.document = {
    readyState: 'loading',
    documentElement: { appendChild() {} },
    addEventListener() {},
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [] }),
    body: { appendChild() {}, addEventListener() {} },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  vm.createContext(sandbox);
  try {
    CONTENT_JS.forEach((rel) => vm.runInContext(read(rel), sandbox, { filename: rel }));
  } catch (e) {
    check('按清单顺序能加载完所有脚本', false, (e && e.message) || String(e));
  }
  check('跑完之后内容脚本里 MN.ai 是有的', !!(sandbox.MN && sandbox.MN.ai), sandbox.MN ? Object.keys(sandbox.MN).join(', ') : '没有 MN');
  check('MN.ai 暴露了 buildMessages / parseResult', !!(sandbox.MN && sandbox.MN.ai && sandbox.MN.ai.buildMessages && sandbox.MN.ai.parseResult));
  check('MN.anchors / MN.store / MN.colorOf 也在', !!(sandbox.MN && sandbox.MN.anchors && sandbox.MN.store && sandbox.MN.colorOf));
}

console.log('\n[2] 后台脚本');
{
  const bg = manifest.background.scripts;
  check('最后一个才是入口 background.js', bg[bg.length - 1] === 'src/background/background.js', bg.join(', '));
  check('ai.js 在后台也加载了（Chrome 靠 importScripts）', bg.indexOf('src/common/ai.js') >= 0, bg.join(', '));
  const src = read('src/background/background.js');
  check('Chrome 的 service worker 用 importScripts 补公共脚本', /importScripts\([^)]*ai\.js/.test(src));
}

console.log('\n[3] 页面里引用的脚本都真的存在，且用到 MN.ai 的页面要引 ai.js');
{
  PAGES.forEach((page) => {
    const scripts = pageScripts(page);
    check(page + ' 有脚本', scripts.length > 0);
    scripts.forEach((rel) => {
      check(page + ' 引用的 ' + rel + ' 存在', fs.existsSync(path.join(ROOT, rel)));
    });
    // 只看页面**自己的**那个 js：共享模块（store / util）里碰 MN.ai 的地方都写了判空，
    // 侧边栏和弹窗就不必为了一行 normalizeConfig 去加载整个 ai.js。
    const own = scripts.filter((rel) => path.posix.dirname(rel) === path.posix.dirname(page) && /\.js$/.test(rel));
    check(page + ' 能找到自己的脚本', own.length === 1, own.join(', '));
    const usesAi = own.some((rel) => /MN\.ai\.[A-Za-z]/.test(read(rel)));
    if (usesAi) {
      check(page + ' 用到了 MN.ai，所以引了 ai.js', scripts.indexOf('src/common/ai.js') >= 0, scripts.join(', '));
    } else {
      check(page + ' 没直接用 MN.ai（不需要 ai.js）', scripts.indexOf('src/common/ai.js') < 0, scripts.join(', '));
    }
    check(page + ' 引了 util.js（颜色/设置默认值在这）', scripts.indexOf('src/common/util.js') >= 0, scripts.join(', '));
    check(page + ' 引了 store.js', scripts.indexOf('src/common/store.js') >= 0, scripts.join(', '));
  });
}

console.log('\n[3b] 不加载 ai.js 的页面，别在共享模块里炸掉');
{
  const store = read('src/common/store.js');
  const touches = /MN\.ai/.test(store);
  check('store.js 碰 MN.ai 时写了判空（侧边栏 / 弹窗不加载 ai.js）', !touches || /MN\.ai \?/.test(store));
  check('util.js 不直接依赖 ai.js', !/MN\.ai\.[A-Za-z]/.test(read('src/common/util.js')));
}

console.log('\n[4] 清单版本 / 包内容一致性');
{
  check('版本号是 x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
  const changelog = read('CHANGELOG.md');
  check(
    'CHANGELOG 里有当前版本 ' + manifest.version,
    changelog.indexOf('## ' + manifest.version) >= 0,
    changelog.split('\n').filter((l) => l.startsWith('## ')).slice(0, 3).join(' | ')
  );
  check('README 里也写着当前版本', read('README.md').indexOf(manifest.version) >= 0);
  check('扩展 id 没被改过', manifest.browser_specific_settings.gecko.id === 'marknote-23a68dfb@local.dev');

  // ---- 合规相关：上架前必须一直在，别被删掉 ----
  console.log('\n[合规] 隐私政策与中性文案');
  const privacyMd = read('PRIVACY.md');
  const privacyHtml = read('privacy.html');
  check('仓库根目录有 PRIVACY.md（会随包分发）', privacyMd.length > 500, String(privacyMd.length));
  check('包里有 privacy.html（扩展内可离线查看）', privacyHtml.length > 500, String(privacyHtml.length));
  [privacyMd, privacyHtml].forEach((text, i) => {
    const who = i === 0 ? 'PRIVACY.md' : 'privacy.html';
    check(who + ' 写明不收集数据', /不收集/.test(text), who);
    check(who + ' 写明数据存在本机 / 卸载即清空', /storage\.local/.test(text) && /卸载/.test(text), who);
    check(who + ' 写明只有 AI 会联网且默认关闭', /AI/.test(text) && /默认关闭/.test(text), who);
    check(who + ' 写明 Key 只存本机、不进导出', /只存/.test(text) && /导出/.test(text), who);
    check(who + ' 有第三方商标免责声明', /没有隶属|无隶属|Not affiliated/.test(text), who);
    check(who + ' 有 AI 生成内容免责', /第三方模型生成|third-party model/.test(text), who);
    check(who + ' 提到复制辅助只作用于自己的浏览器', /你自己的浏览器|your own browser/.test(text), who);
  });

  check(
    '隐私政策里的版本号和清单一致',
    privacyMd.indexOf(manifest.version) >= 0 && privacyHtml.indexOf(manifest.version) >= 0,
    '清单 ' + manifest.version
  );

  // 页面里的隐私政策链接必须指向真实存在的文件
  ['src/popup/popup.html', 'src/dashboard/dashboard.html'].forEach((rel) => {
    const html = read(rel);
    const m = html.match(/href="([^"]*privacy\.html)"/);
    check(rel + ' 里有隐私政策链接', !!m, '没找到指向 privacy.html 的链接');
    if (m) {
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), m[1]);
      check(rel + ' 的隐私政策链接指向存在的文件', fs.existsSync(target), target);
    }
  });

  // 促销式的「绕过 / 破解」措辞不许再出现在清单和页面里（历史记录 CHANGELOG 除外）
  const promo = /绕过复制|破解复制|绕过限制|强制复制/;
  check('manifest.json 里没有「绕过」类措辞', !promo.test(read('manifest.json')));
  ['src/popup/popup.html', 'src/dashboard/dashboard.html', 'src/content/content.js', 'src/popup/popup.js', 'src/sidebar/sidebar.js'].forEach((rel) => {
    check(rel + ' 里没有「绕过」类措辞', !promo.test(read(rel)));
  });
  const utilSandbox = { console: { warn() {}, log() {} }, Math, Date, JSON, setTimeout, clearTimeout };
  utilSandbox.globalThis = utilSandbox;
  utilSandbox.window = utilSandbox;
  utilSandbox.document = { documentElement: { classList: { contains: () => false } }, addEventListener() {} };
  utilSandbox.navigator = { clipboard: {} };
  vm.createContext(utilSandbox);
  vm.runInContext(read('src/common/util.js'), utilSandbox, { filename: 'src/common/util.js' });
  const defaults = (utilSandbox.MN && utilSandbox.MN.DEFAULT_SETTINGS) || {};
  check('复制辅助默认关闭（没把确认标记默认设成 true）', defaults.copyNoticeAck === false, JSON.stringify(defaults.copyNoticeAck));

  // 打包结果里也得有这两份东西（dist 存在时才查）
  const unpacked = path.join(ROOT, 'dist', 'firefox-unpacked');
  if (fs.existsSync(unpacked)) {
    check('打好的包里带 PRIVACY.md', fs.existsSync(path.join(unpacked, 'PRIVACY.md')));
    check('打好的包里带 privacy.html', fs.existsSync(path.join(unpacked, 'privacy.html')));
  }
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
