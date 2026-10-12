/*
 * MarkNote 内容脚本集成测试（Node + jsdom + 假的扩展 API）
 *
 * 跑法：node test/content.test.js
 * 验证：选中文字 → 工具条 → 点颜色 → 生成高亮并落盘 → 重新打开页面仍能恢复 →
 *       点高亮弹批注框 → 写笔记保存 → 删除 → 通过消息接口读写。
 */
const loadJsdom = require('./_jsdom');
const fs = require('fs');
const path = require('path');
let JSDOM;
try {
  ({ JSDOM } = loadJsdom() || {});
} catch (_e) {
  console.error('需要 jsdom：先执行 `npm i jsdom`');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const FILES = [
  'src/common/util.js',
  'src/common/store.js',
  'src/common/anchors.js',
  'src/common/picker.js',
  'src/common/ai.js',
  'src/content/content.js'
].map((p) => fs.readFileSync(path.join(ROOT, p), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到条件成立（机器忙的时候固定 sleep 会抖）。 */
async function until(fn, ms = 1500) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = !!fn();
    } catch (_e) {
      ok = false;
    }
    if (ok || Date.now() - t0 > ms) return ok;
    await sleep(20);
  }
}

/** 一套会跨「页面重载」保留数据的假扩展环境 */
function makeEnv(shared, env) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const onChanged = { listeners: [] };
  const onMessage = { listeners: [] };
  const api = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          onMessage.listeners.push(fn);
          env.onMessage.push(fn);
        }
      },
      sendMessage(msg, cb) {
        // 测试里可以塞一个 env.onSendMessage 来假装后台（AI 请求就是走这条路）
        const handler = env.onSendMessage;
        const out = typeof handler === 'function' ? handler(msg) : undefined;
        if (out && typeof out.then === 'function') {
          if (typeof cb === 'function') out.then((r) => cb(r), () => cb(undefined));
          return out;
        }
        if (typeof cb === 'function') setTimeout(() => cb(out), 0);
        return Promise.resolve(out);
      },
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'moz-extension://test/' + p
    },
    storage: {
      local: {
        get(keys, cb) {
          const data = clone(shared.data);
          let out;
          if (keys === null || keys === undefined) out = data;
          else if (typeof keys === 'string') out = keys in data ? { [keys]: data[keys] } : {};
          else if (Array.isArray(keys)) {
            out = {};
            keys.forEach((k) => k in data && (out[k] = data[k]));
          } else {
            out = {};
            Object.keys(keys).forEach((k) => (out[k] = k in data ? data[k] : keys[k]));
          }
          setTimeout(() => cb(out), 0);
        },
        set(obj, cb) {
          Object.assign(shared.data, clone(obj));
          setTimeout(() => {
            const changes = {};
            Object.keys(obj).forEach((k) => (changes[k] = { newValue: clone(obj[k]) }));
            onChanged.listeners.forEach((f) => f(changes, 'local'));
            cb && cb();
          }, 0);
        },
        remove(keys, cb) {
          const changes = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            changes[k] = { oldValue: clone(shared.data[k]) };
            delete shared.data[k];
          });
          setTimeout(() => {
            onChanged.listeners.forEach((f) => f(changes, 'local'));
            cb && cb();
          }, 0);
        }
      },
      onChanged: {
        addListener(fn) {
          onChanged.listeners.push(fn);
        },
        removeListener() {}
      }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(null)
    },
    contextMenus: { removeAll: (cb) => cb && cb(), create: (_o, cb) => cb && cb(), onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } }
  };
  return api;
}

function bootPage(html, shared) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://example.com/article',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  dom.__env = { onMessage: [] };
  dom.window.chrome = makeEnv(shared, dom.__env);
  FILES.forEach((code) => dom.window.eval(code));
  return dom;
}

function select(dom, node, start, end) {
  const range = dom.window.document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
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
  const shared = { data: {} };
  const HTML = '<p id="p1">MarkNote 是一款网页划线工具，支持多颜色高亮。</p><p id="p2">第二段用来测试跨段落。</p>';

  console.log('\n[1] 选中文字 → 工具条 → 高亮');
  const dom = bootPage(HTML, shared);
  const doc = dom.window.document;
  await sleep(60);

  const textNode = doc.getElementById('p1').firstChild;
  select(dom, textNode, 0, 8); // “MarkNote”
  doc.body.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(40);

  const host = doc.getElementById('marknote-host');
  const shadow = host.shadowRoot;
  check('注入了一个 shadow host', !!host && !!shadow);
  check('选中后工具条出现', shadow.querySelector('.mn-toolbar').hidden === false);

  shadow.querySelector('.mn-dot[data-color="green"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);

  let marks = doc.querySelectorAll('mark.mn-hl');
  check('生成了高亮', marks.length === 1, 'marks=' + marks.length);
  check('高亮的文字正确', marks[0] && marks[0].textContent === 'MarkNote', marks[0] && marks[0].textContent);
  check('高亮记录了颜色', marks[0] && marks[0].dataset.color === 'green');
  const annKeys = Object.keys(shared.data).filter((k) => k.startsWith('ann:'));
  check('已写进本地存储', annKeys.length === 1, JSON.stringify(Object.keys(shared.data)));

  console.log('\n[2] 重新打开页面（模拟刷新）后自动恢复高亮');
  const dom2 = bootPage(HTML, shared);
  await sleep(80);
  const doc2 = dom2.window.document;
  const marks2 = doc2.querySelectorAll('mark.mn-hl');
  check('刷新后高亮还在', marks2.length === 1, 'marks=' + marks2.length);
  check('恢复的文字一致', marks2[0] && marks2[0].textContent === 'MarkNote', marks2[0] && marks2[0].textContent);

  console.log('\n[3] 页面内容变了，仍能靠上下文找回（不用手点）');
  const dom3 = bootPage('<p>上面插入了一段全新的开场白。</p>' + HTML, shared);
  await sleep(80);
  const marks3 = dom3.window.document.querySelectorAll('mark.mn-hl');
  check('整体位移后仍定位成功', marks3.length === 1 && marks3[0].textContent === 'MarkNote', marks3.length + ' / ' + (marks3[0] && marks3[0].textContent));

  console.log('\n[4] 点高亮 → 写笔记 / 标签 → 保存');
  const mark = doc2.querySelector('mark.mn-hl');
  mark.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const shadow2 = doc2.getElementById('marknote-host').shadowRoot;
  const pop = shadow2.querySelector('.mn-pop');
  check('批注框打开', pop.hidden === false);
  pop.querySelector('[data-role="note"]').value = '这是第一条笔记';
  pop.querySelector('[data-role="taginput"]').value = '工具/划线';
  pop.querySelector('[data-role="taginput"]').dispatchEvent(new dom2.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(20);
  pop.querySelector('[data-act="save"]').dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);

  const saved = shared.data[Object.keys(shared.data).find((k) => k.startsWith('ann:'))];
  check('笔记已保存', saved.note === '这是第一条笔记', JSON.stringify(saved && saved.note));
  check('标签已保存（多级）', Array.isArray(saved.tags) && saved.tags[0] === '工具/划线', JSON.stringify(saved.tags));

  console.log('\n[5] 消息接口：给选中内容加高亮 / 查状态 / 导出');
  const p2 = doc2.getElementById('p2').firstChild;
  select(dom2, p2, 0, 6);
  const listener = dom2.__env.onMessage[dom2.__env.onMessage.length - 1];
  const r1 = await new Promise((res) => listener({ type: dom2.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'blue' }, {}, res));
  await sleep(40);
  check('HIGHLIGHT_SELECTION 返回 ok', r1 && r1.ok === true, JSON.stringify(r1));
  check('第二条高亮已生成', doc2.querySelectorAll('mark.mn-hl').length === 2, String(doc2.querySelectorAll('mark.mn-hl').length));

  const state = await new Promise((res) => listener({ type: dom2.window.MN.MSG.PAGE_STATE }, {}, res));
  check('PAGE_STATE 报告 2 条划线', state && state.count === 2, JSON.stringify(state && state.count));
  check('PAGE_STATE 带上划线列表', state && state.annotations.length === 2);
  check('PAGE_STATE 标记没有定位失败', state && state.lost.length === 0, JSON.stringify(state && state.lost));

  // 复制辅助默认关闭：没确认过使用提示前，从任何入口都不给开
  const sr2 = () => doc2.getElementById('marknote-host').shadowRoot;
  const refuse = await new Promise((res) => listener({ type: dom2.window.MN.MSG.TOGGLE_UNLOCK }, {}, res));
  check(
    '没确认使用提示前，复制辅助不给开',
    refuse && refuse.ok === false && refuse.needAck === true,
    JSON.stringify(refuse)
  );
  check('被拒绝时不会加 html class', !doc2.documentElement.classList.contains('mn-unlock-copy'));
  check(
    '被拒绝时提示去哪确认',
    sr2().querySelector('.mn-toast').textContent.includes('允许本页选中复制'),
    sr2().querySelector('.mn-toast').textContent
  );

  const ackState = await dom2.window.MN.store.setSettings({ copyNoticeAck: true });
  check('确认状态写进设置', ackState.copyNoticeAck === true);

  const unlocked = await new Promise((res) => listener({ type: dom2.window.MN.MSG.TOGGLE_UNLOCK }, {}, res));
  check('确认之后可以开', unlocked && unlocked.ok === true && unlocked.unlocked === true, JSON.stringify(unlocked));
  check('解锁复制加了 html class', doc2.documentElement.classList.contains('mn-unlock-copy'));
  check(
    '开启时提示里带使用条款提醒',
    sr2().querySelector('.mn-toast').textContent.includes('使用条款'),
    sr2().querySelector('.mn-toast').textContent
  );
  const back = await new Promise((res) => listener({ type: dom2.window.MN.MSG.TOGGLE_UNLOCK }, {}, res));
  check('再点一次能关掉，且不再要求确认', back && back.ok === true && back.unlocked === false, JSON.stringify(back));
  check('关掉后 html class 也摘了', !doc2.documentElement.classList.contains('mn-unlock-copy'));

  const hidden = await new Promise((res) => listener({ type: dom2.window.MN.MSG.TOGGLE_HIGHLIGHTS }, {}, res));
  check('隐藏高亮生效', hidden && hidden.hidden === true);
  check('隐藏高亮加了 html class', doc2.documentElement.classList.contains('mn-hide-hl'));

  console.log('\n[6] Markdown / 纯文本导出格式');
  const bundle = dom2.window.MN.bundleToMarkdown(state.annotations.map((a) => ({ ...a, url: 'https://example.com/article', anchor: { startV: 0 } })), { template: 'quote' });
  check('导出含引用块', bundle.includes('> MarkNote'), bundle.slice(0, 80));
  check('导出含标签', bundle.includes('#工具/划线'), bundle.slice(0, 400));
  check('导出含页面标题', bundle.includes('example.com/article'));

  console.log('\n[7] 删除划线（走界面按钮：点高亮 → 删除）');
  const firstId = Object.keys(shared.data).find((k) => k.startsWith('ann:')).slice(4);
  const delMark = doc2.querySelector('mark.mn-hl');
  delMark.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const delPop = doc2.getElementById('marknote-host').shadowRoot.querySelector('.mn-pop');
  check('点高亮能打开批注框', delPop.hidden === false);
  delPop.querySelector('[data-act="delete"]').dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
  await sleep(140);
  check('存储里少了一条', Object.keys(shared.data).filter((k) => k.startsWith('ann:')).length === 1,
    String(Object.keys(shared.data).filter((k) => k.startsWith('ann:')).length));
  check('页面上只剩一个高亮', doc2.querySelectorAll('mark.mn-hl').length === 1, String(doc2.querySelectorAll('mark.mn-hl').length));
  check('删掉的那条不再是高亮', !doc2.querySelector(`mark.mn-hl[data-ann="${firstId}"]`),
    firstId);

  /* --------------------------------------------------- 回归：用户报的两个 bug */

  console.log('\n[8] 回归：取消选取后工具条必须真的消失');
  const shared8 = { data: {} };
  const dom8 = bootPage(HTML, shared8);
  const doc8 = dom8.window.document;
  await sleep(60);
  const bar8 = () => doc8.getElementById('marknote-host').shadowRoot.querySelector('.mn-toolbar');

  select(dom8, doc8.getElementById('p1').firstChild, 0, 8);
  doc8.body.dispatchEvent(new dom8.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(60);
  check('选中后工具条可见', bar8().hidden === false && bar8().style.display !== 'none',
    `hidden=${bar8().hidden} display=${bar8().style.display}`);

  // 用户"取消选取"：选区没了 → selectionchange（点击、Esc、方向键都会走到这里）
  dom8.window.getSelection().removeAllRanges();
  doc8.dispatchEvent(new dom8.window.Event('selectionchange'));
  await sleep(30);
  check('取消选取后工具条 hidden=true', bar8().hidden === true, String(bar8().hidden));
  // 关键回归：CSS 里 .mn-toolbar{display:flex} 会压掉 hidden 属性（Firefox 的 hidden 是表现属性），
  // 所以必须同时把内联 display 设成 none，否则元素在真实浏览器里依然可见。
  check('取消选取后内联 display=none（真正看不见）', bar8().style.display === 'none',
    `style.display=${JSON.stringify(bar8().style.display)}`);

  console.log('\n[9] 回归：点页面别处 → 工具条收起');
  select(dom8, doc8.getElementById('p2').firstChild, 0, 6);
  doc8.body.dispatchEvent(new dom8.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(60);
  check('再次选中后工具条又出现', bar8().hidden === false);
  dom8.window.getSelection().removeAllRanges();
  doc8.getElementById('p2').dispatchEvent(new dom8.window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('点击别处后工具条收起', bar8().hidden === true && bar8().style.display === 'none',
    `hidden=${bar8().hidden} display=${bar8().style.display}`);

  console.log('\n[10] 回归：刷新后正文才渲染出来 → 划线要能自己找回来');
  const shared10 = { data: {} };
  const annText = '目标文字';
  shared10.data['ann:late1'] = {
    id: 'late1',
    url: 'https://example.com/article',
    title: '晚渲染的页面',
    site: 'example.com',
    color: 'yellow',
    type: 'text',
    text: annText,
    note: '',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    anchor: { exact: annText, prefix: '前面的话 ', suffix: ' 后面的话', startV: 5, endV: 9, textLength: 9 }
  };
  const dom10 = bootPage('<p id="placeholder">正文还没渲染出来…</p>', shared10);
  const doc10 = dom10.window.document;
  await sleep(120);
  check('内容还没出现时先记为定位失败', doc10.querySelectorAll('mark.mn-hl').length === 0);

  // 模拟 SPA / 懒加载：900ms 后正文才进 DOM
  const late = doc10.createElement('p');
  late.textContent = '前面的话 目标文字 后面的话';
  doc10.body.appendChild(late);
  await sleep(900); // MutationObserver(500ms 防抖) + 一次重试阶梯
  check('DOM 变化后自动补上高亮', doc10.querySelectorAll('mark.mn-hl').length === 1,
    String(doc10.querySelectorAll('mark.mn-hl').length));
  check('补上的高亮就是那两个字', (doc10.querySelector('mark.mn-hl') || {}).textContent === annText,
    String((doc10.querySelector('mark.mn-hl') || {}).textContent));

  console.log('\n[11] 回归：hash 路由不能被归一化成同一个页面');
  const N = dom10.window.MN.normalizeUrl;
  check('不同 hash 路由视为不同页面', N('https://a.com/#/article/1') !== N('https://a.com/#/article/2'),
    N('https://a.com/#/article/1') + ' vs ' + N('https://a.com/#/article/2'));
  check('井号斜杠路由保留', N('https://a.com/#/article/1').includes('#/article/1'));
  check('页内锚点仍然丢弃', N('https://a.com/p#section-2') === N('https://a.com/p'), N('https://a.com/p#section-2'));
  check('跟踪参数仍然丢弃', N('https://a.com/p?utm_source=x&spm=y&id=7') === 'https://a.com/p?id=7',
    N('https://a.com/p?utm_source=x&spm=y&id=7'));

  console.log('\n[12] 回归：旧 URL 键下的划线要能迁移过来（升级不丢数据）');
  const shared12 = { data: {} };
  // 1.1.0 之前：hash 被抹平，hash 路由站点的划线都存在 https://example.com/ 下
  shared12.data['ann:old1'] = {
    id: 'old1',
    url: 'https://example.com/',
    title: '老数据',
    site: 'example.com',
    color: 'blue',
    type: 'text',
    text: 'MarkNote',
    note: '',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    anchor: { exact: 'MarkNote', prefix: '', suffix: ' 是一款', startV: 0, endV: 8, textLength: 8 }
  };
  const dom12 = new JSDOM(`<!doctype html><html><body>${HTML}</body></html>`, {
    url: 'https://example.com/#/article/1',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  dom12.__env = { onMessage: [] };
  dom12.window.chrome = makeEnv(shared12, dom12.__env);
  FILES.forEach((code) => dom12.window.eval(code));
  await sleep(160);
  check('老键的划线被认领并画了出来', dom12.window.document.querySelectorAll('mark.mn-hl').length === 1,
    String(dom12.window.document.querySelectorAll('mark.mn-hl').length));
  check('存储里的 url 已经改成新键',
    (shared12.data['ann:old1'] || {}).url === 'https://example.com/#/article/1',
    (shared12.data['ann:old1'] || {}).url);

  console.log('\n[13] 回归：老键里定位不上的划线不该被认领（防止串台）');
  const shared13 = { data: {} };
  shared13.data['ann:other'] = {
    ...shared12.data['ann:old1'],
    id: 'other',
    url: 'https://example.com/',
    text: '另一篇文章里才有的句子',
    anchor: { exact: '另一篇文章里才有的句子', prefix: '', suffix: '', startV: 0, endV: 12, textLength: 12 }
  };
  const dom13 = new JSDOM(`<!doctype html><html><body>${HTML}</body></html>`, {
    url: 'https://example.com/#/article/2',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  dom13.__env = { onMessage: [] };
  dom13.window.chrome = makeEnv(shared13, dom13.__env);
  FILES.forEach((code) => dom13.window.eval(code));
  await sleep(160);
  check('定位不上的没有被画到页面上', dom13.window.document.querySelectorAll('mark.mn-hl').length === 0,
    String(dom13.window.document.querySelectorAll('mark.mn-hl').length));
  check('定位不上的仍在老键下', (shared13.data['ann:other'] || {}).url === 'https://example.com/');

  console.log('\n[14] 回归：拖选后浏览器补发的 click 不能吃掉工具条');
  const shared14 = { data: {} };
  const dom14 = bootPage(HTML, shared14);
  const doc14 = dom14.window.document;
  await sleep(60);
  const bar14 = () => doc14.getElementById('marknote-host').shadowRoot.querySelector('.mn-toolbar');
  const side14 = () => doc14.getElementById('marknote-host').shadowRoot.querySelector('.mn-side');

  // 真实序列：mousedown → 拖动 → mouseup → click（Firefox/Chrome 都会补这个 click）
  select(dom14, doc14.getElementById('p1').firstChild, 0, 8);
  const target14 = doc14.getElementById('p1');
  target14.dispatchEvent(new dom14.window.MouseEvent('mouseup', { bubbles: true }));
  target14.dispatchEvent(new dom14.window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  check('拖选 + 补发 click 后工具条依然弹出', bar14().hidden === false && bar14().style.display !== 'none',
    `hidden=${bar14().hidden} display=${bar14().style.display}`);

  // 真正的取消选取：选区没了 + click → 收起
  dom14.window.getSelection().removeAllRanges();
  doc14.dispatchEvent(new dom14.window.Event('selectionchange'));
  target14.dispatchEvent(new dom14.window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  check('取消选取后仍然能正常收起', bar14().hidden === true && bar14().style.display === 'none',
    `hidden=${bar14().hidden} display=${bar14().style.display}`);

  console.log('\n[15] 回归：右侧小工具条必须可点击');
  // pointer-events 可继承：外层 .mn 是 none，侧栏不显式声明就整条点不动
  const cs14 = dom14.window.getComputedStyle(side14());
  check('侧栏 pointer-events=auto', cs14.pointerEvents === 'auto', cs14.pointerEvents);
  check('外层 .mn 仍是 pointer-events=none（不挡页面）', dom14.window.getComputedStyle(
    doc14.getElementById('marknote-host').shadowRoot.querySelector('.mn')).pointerEvents === 'none');
  check('工具条本身 pointer-events=auto',
    dom14.window.getComputedStyle(bar14()).pointerEvents === 'auto',
    dom14.window.getComputedStyle(bar14()).pointerEvents);
  check('侧栏默认可见（showSideBar 默认开）', side14().hidden === false);
  // 点侧栏按钮要有反应，不能是"点了没反应"
  const dotsBefore = doc14.querySelectorAll('mark.mn-hl').length;
  side14().querySelector('[data-act="eye"]').dispatchEvent(new dom14.window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('点侧栏的隐藏按钮生效', doc14.documentElement.classList.contains('mn-hide-hl'),
    String(dotsBefore));

  console.log('\n[16] 侧栏可以就地关掉');
  const shared16 = { data: {} };
  const dom16 = bootPage(HTML, shared16);
  const doc16 = dom16.window.document;
  await sleep(60);
  const side16 = () => doc16.getElementById('marknote-host').shadowRoot.querySelector('.mn-side');
  side16().querySelector('[data-act="dismiss"]').dispatchEvent(new dom16.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  check('点 ✕ 后侧栏收起', side16().hidden === true && side16().style.display === 'none',
    `hidden=${side16().hidden} display=${side16().style.display}`);
  check('设置已持久化 showSideBar=false',
    (shared16.data.settings || {}).showSideBar === false,
    JSON.stringify(shared16.data.settings));

  console.log('\n[17] 改色：弹层里点颜色立即生效（不用先按保存）');
  const shared17 = { data: {} };
  const dom17 = bootPage(HTML, shared17);
  const doc17 = dom17.window.document;
  await sleep(60);
  const sr17 = () => doc17.getElementById('marknote-host').shadowRoot;
  const sel17 = dom17.window.getSelection();
  // 真实序列：拖选 → mouseup → 浏览器补发的 click
  const drag = async (range, wait = 60) => {
    sel17.removeAllRanges();
    sel17.addRange(range);
    const t = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    t.dispatchEvent(new dom17.window.MouseEvent('mouseup', { bubbles: true }));
    t.dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
    await sleep(wait);
  };
  const r17 = doc17.createRange();
  r17.setStart(doc17.getElementById('p1').firstChild, 0);
  r17.setEnd(doc17.getElementById('p1').firstChild, 8);
  await drag(r17);
  sr17().querySelector('.mn-toolbar .mn-dot[data-color="green"]').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(90);
  const mark17 = doc17.querySelector('mark.mn-hl');
  check('先建了一条绿色划线', mark17.dataset.color === 'green', String(mark17 && mark17.dataset.color));

  mark17.dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const pop17 = sr17().querySelector('.mn-pop');
  check('点划线打开了弹层', pop17.hidden === false);
  pop17.querySelector('.mn-dot[data-color="purple"]').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  check('点颜色后页面立刻变色（不等保存）', mark17.dataset.color === 'purple',
    `data-color=${mark17.dataset.color}`);
  check('颜色已经落盘', Object.values(shared17.data).some((a) => a && a.color === 'purple'),
    JSON.stringify(Object.values(shared17.data).map((a) => a && a.color)));
  check('只改色，没有多出标注', Object.values(shared17.data).filter((a) => a && a.id).length === 1);

  console.log('\n[18] 改色：重新选中已有高亮再点颜色 → 改色，而不是叠第二条');
  sel17.removeAllRanges();
  doc17.getElementById('p2').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  check('弹层已关闭', sr17().querySelector('.mn-pop').hidden === true);
  const r18 = doc17.createRange();
  r18.selectNodeContents(doc17.querySelector('mark.mn-hl'));
  await drag(r18);
  const bar18 = sr17().querySelector('.mn-toolbar');
  check('重新选中后工具条可见', bar18.hidden === false, `hidden=${bar18.hidden}`);
  bar18.querySelector('.mn-dot[data-color="blue"]').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(140);
  check('标注数量仍然是 1（没有叠第二条）', Object.values(shared17.data).filter((a) => a && a.id).length === 1,
    String(Object.values(shared17.data).filter((a) => a && a.id).length));
  check('页面上仍然只有 1 个 mark', doc17.querySelectorAll('mark.mn-hl').length === 1,
    String(doc17.querySelectorAll('mark.mn-hl').length));
  check('颜色真的改成了 blue', doc17.querySelector('mark.mn-hl').dataset.color === 'blue',
    doc17.querySelector('mark.mn-hl').dataset.color);

  console.log('\n[19] 选中已有高亮点「笔记」→ 给同一条写笔记，不新建');
  const before19 = Object.values(shared17.data).filter((a) => a && a.id).length;
  await drag(r18);
  sr17().querySelector('.mn-toolbar [data-act="note"]').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(90);
  const pop19 = sr17().querySelector('.mn-pop');
  check('弹层打开的是同一条划线', pop19.hidden === false && pop19.querySelector('[data-role="note"]') !== null);
  pop19.querySelector('[data-role="note"]').value = '在已有高亮上补的笔记';
  pop19.querySelector('[data-act="save"]').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  check('没有多出标注', Object.values(shared17.data).filter((a) => a && a.id).length === before19,
    `${before19} → ${Object.values(shared17.data).filter((a) => a && a.id).length}`);
  check('笔记写进了那条老划线',
    Object.values(shared17.data).some((a) => a && a.note === '在已有高亮上补的笔记'));

  console.log('\n[20] 只圈中一小截时，仍然允许叠一条新划线');
  sel17.removeAllRanges();
  doc17.getElementById('p2').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const tn20 = doc17.querySelector('mark.mn-hl').firstChild; // 高亮内部的文本节点
  const r20 = doc17.createRange();
  r20.setStart(tn20, 0);
  r20.setEnd(tn20, 3); // 8 个字里只圈 3 个 → 不到一半，算"新建"
  await drag(r20);
  const bar20 = sr17().querySelector('.mn-toolbar');
  check('小范围选区也能弹出工具条', bar20.hidden === false, `hidden=${bar20.hidden}`);
  bar20.querySelector('.mn-dot[data-color="pink"]').dispatchEvent(new dom17.window.MouseEvent('click', { bubbles: true }));
  await sleep(140);
  check('允许新建（小范围选区不算“改色”）',
    Object.values(shared17.data).filter((a) => a && a.id).length === 2,
    String(Object.values(shared17.data).filter((a) => a && a.id).length));

  console.log('\n[21] 取色器：色环 + RGB 输入 → 自定义色高亮');
  {
    const shared21 = { data: {} };
    const dom21 = bootPage(HTML, shared21);
    const doc21 = dom21.window.document;
    await sleep(60);
    select(dom21, doc21.getElementById('p1').firstChild, 0, 8); // “MarkNote”
    doc21.body.dispatchEvent(new dom21.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(40);

    const sr21 = () => doc21.getElementById('marknote-host').shadowRoot;
    const bar21 = sr21().querySelector('.mn-toolbar');
    check('工具条上有自定义颜色入口', !!bar21.querySelector('[data-act="custom"]'));
    check('入口是个独立的彩色方块（不算进 5 个圆点里）', !!bar21.querySelector('.mn-dot-add[data-act="custom"]') &&
      !bar21.querySelector('[data-act="custom"]').classList.contains('mn-dot'));
    check('内置色仍然是 5 个点', bar21.querySelectorAll('.mn-dot').length === 5,
      String(bar21.querySelectorAll('.mn-dot').length));

    bar21.querySelector('[data-act="custom"]').dispatchEvent(new dom21.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const holder21 = sr21().querySelector('.mn-picker');
    const pk21 = holder21.querySelector('.mn-pk');
    check('取色器弹出来了', !!pk21 && holder21.hidden === false);
    check('有色环', !!pk21 && !!pk21.querySelector('.mn-pk-ring'));
    check('有饱和/明度方块', !!pk21 && !!pk21.querySelector('.mn-pk-sv'));
    check('有 RGB 三个输入框', !!pk21 && ['r', 'g', 'b'].every((k) => pk21.querySelector(`[data-ch="${k}"]`)));
    check('有系统取色器（color input）', !!pk21 && pk21.querySelector('[data-ch="native"]').type === 'color');

    const setCh = (k, v) => {
      const el = pk21.querySelector(`[data-ch="${k}"]`);
      el.value = String(v);
      el.dispatchEvent(new dom21.window.Event('input', { bubbles: true }));
    };
    setCh('r', 20);
    setCh('g', 120);
    setCh('b', 200);
    check('HEX 跟着 RGB 走', pk21.querySelector('[data-ch="hex"]').value === '#1478c8',
      pk21.querySelector('[data-ch="hex"]').value);

    pk21.querySelector('[data-pk="apply"]').dispatchEvent(new dom21.window.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    const mark21 = doc21.querySelector('mark.mn-hl');
    check('高亮用了刚调的颜色', mark21 && mark21.dataset.color === '#1478c8', mark21 && mark21.dataset.color);
    check('自定义色也落盘了', Object.values(shared21.data).some((a) => a && a.color === '#1478c8'),
      JSON.stringify(Object.values(shared21.data).map((a) => a && a.color)));
    check('点应用后取色器收起', holder21.hidden === true);

    // 「存为常用色」写进 settings.customColors，并出现在工具条色板上
    select(dom21, doc21.getElementById('p2').firstChild, 0, 3);
    doc21.body.dispatchEvent(new dom21.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(40);
    sr21().querySelector('.mn-toolbar [data-act="custom"]').dispatchEvent(new dom21.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const pk21b = sr21().querySelector('.mn-picker .mn-pk');
    pk21b.querySelector('[data-ch="hex"]').value = '#0a9396';
    pk21b.querySelector('[data-ch="hex"]').dispatchEvent(new dom21.window.Event('input', { bubbles: true }));
    pk21b.querySelector('[data-pk="save"]').dispatchEvent(new dom21.window.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    const saved21 = (shared21.data.settings || {}).customColors || [];
    check('存为常用色写进了设置', saved21.indexOf('#0a9396') >= 0, JSON.stringify(saved21));
    check('工具条色板上多了一个自定义色', sr21().querySelectorAll('.mn-toolbar .mn-dot').length === 6,
      String(sr21().querySelectorAll('.mn-toolbar .mn-dot').length));
    check('自定义色不重复写入', saved21.filter((c) => c === '#0a9396').length === 1, JSON.stringify(saved21));

    // 删除常用色：取色器色板里那个自定义色的右上角 ×
    sr21().querySelector('.mn-toolbar [data-act="custom"]').dispatchEvent(new dom21.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const pk21c = sr21().querySelector('.mn-picker .mn-pk');
    const sw21 = pk21c.querySelector('.mn-pk-sw[data-color="#0a9396"]');
    check('自定义色在色板里带删除钮', !!sw21 && !!sw21.querySelector('.mn-pk-sw-del'));
    check('内置色没有删除钮', !pk21c.querySelector('.mn-pk-sw[data-color="yellow"] .mn-pk-sw-del'));
    check('有删除操作提示', pk21c.querySelector('[data-role="hint"]').hidden === false);
    sw21.querySelector('.mn-pk-sw-del').dispatchEvent(new dom21.window.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    const after21 = (shared21.data.settings || {}).customColors || [];
    check('设置里删掉了', after21.indexOf('#0a9396') < 0, JSON.stringify(after21));
    check('色板里也删掉了', !pk21c.querySelector('.mn-pk-sw[data-color="#0a9396"]'));
    check('工具条回到 5 个色点', sr21().querySelectorAll('.mn-toolbar .mn-dot').length === 5,
      String(sr21().querySelectorAll('.mn-toolbar .mn-dot').length));
    check('删掉常用色不会动到已经划好的线',
      Object.values(shared21.data).some((a) => a && a.color === '#0a9396'),
      JSON.stringify(Object.values(shared21.data).map((a) => a && a.color)));
    check('取色器还开着（删色不该把它关掉）', sr21().querySelector('.mn-picker').hidden === false);
  }

  console.log('\n[22] AI 分析：选中文字 → 模型给片段 → 勾选后写成划线');
  {
    const shared22 = {
      data: {
        settings: {
          defaultColor: 'yellow',
          ai: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxItems: 6, prompt: '' }
        }
      }
    };
    const HTML22 =
      '<p id="a1">MarkNote 是一款网页划线工具，支持多颜色高亮与批注。</p>' +
      '<p id="a2">所有数据都保存在本机浏览器里，不上传服务器。</p>';
    const dom22 = bootPage(HTML22, shared22);
    const doc22 = dom22.window.document;
    await sleep(60);

    const sr22 = () => doc22.getElementById('marknote-host').shadowRoot;
    const sentAi = [];
    dom22.__env.onSendMessage = (msg) => {
      sentAi.push(msg);
      if (msg.type !== 'mn:ai-chat') return { ok: false, error: '不是这条' };
      return {
        ok: true,
        model: 'deepseek-chat',
        usage: { total_tokens: 321 },
        items: [
          { quote: 'MarkNote 是一款网页划线工具', color: 'yellow', note: '一句话说清是什么', reason: '定义' },
          { quote: '所有数据都保存在本机浏览器里', color: 'green', note: '隐私卖点', reason: '' },
          { quote: '这句话页面上根本没有出现过', color: 'blue', note: '找不到的', reason: '' }
        ]
      };
    };

    const aiCfg = (shared22.data.settings || {}).ai;
    check('测试环境里 AI 是开着的', !!aiCfg && aiCfg.enabled === true);

    // 没选中文字时打开面板 → 默认转成「整页正文」
    sr22().querySelector('.mn-side [data-act="ai"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    check('侧栏上的 ✦ 能打开 AI 面板', sr22().querySelector('.mn-ai').hidden === false);
    check('有半透明遮罩', sr22().querySelector('.mn-ai-mask').hidden === false);
    check('没选区时默认分析整页', sr22().querySelector('.mn-ai-scope [data-scope="page"]').dataset.on === '1');
    sr22().querySelector('.mn-ai [data-ai="close"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    check('点 ✕ 能关掉', sr22().querySelector('.mn-ai').hidden === true && sr22().querySelector('.mn-ai-mask').hidden === true);

    // 选中一段文字再打开
    select(dom22, doc22.getElementById('a1').firstChild, 0, 16);
    doc22.body.dispatchEvent(new dom22.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(40);
    const bar22 = sr22().querySelector('.mn-toolbar');
    check('工具条上有 AI 入口', !!bar22.querySelector('[data-act="ai"]'));
    bar22.querySelector('[data-act="ai"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const panel22 = sr22().querySelector('.mn-ai');
    check('面板打开时工具条收起', bar22.hidden === true);
    check('默认按选中文字分析', panel22.querySelector('.mn-ai-scope [data-scope="selection"]').dataset.on === '1');
    check('有提示词输入框', !!panel22.querySelector('[data-ai-input="prompt"]'));
    check('提示词预填了默认文案', (panel22.querySelector('[data-ai-input="prompt"]').placeholder || '').includes('批注'));
    check('有开始分析按钮', !!panel22.querySelector('[data-ai="run"]'));

    // 写一条自己的提示词，然后分析
    const promptBox = panel22.querySelector('[data-ai-input="prompt"]');
    promptBox.value = '只挑和隐私有关的那句';
    promptBox.dispatchEvent(new dom22.window.Event('input', { bubbles: true }));
    panel22.querySelector('[data-ai="run"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);

    check('真的往后合发了一条 AI 请求', sentAi.filter((m) => m.type === 'mn:ai-chat').length === 1,
      JSON.stringify(sentAi.map((m) => m.type)));
    const payload22 = sentAi.find((m) => m.type === 'mn:ai-chat').payload;
    check('把选中的文字发过去了', payload22.text === 'MarkNote 是一款网页划线', payload22.text);
    check('把用户写的提示词也发过去了', payload22.prompt === '只挑和隐私有关的那句', payload22.prompt);
    check('告诉后台这是选中文字范围', payload22.scope === 'selection', payload22.scope);
    check('带上了页面地址（标题没设置就是空）', payload22.url === 'https://example.com/article' && 'title' in payload22, JSON.stringify(payload22));

    const items22 = panel22.querySelectorAll('.mn-ai-item');
    check('三条结果都列出来了', items22.length === 3, String(items22.length));
    check('每条都有勾选框', panel22.querySelectorAll('[data-ai-input="pick"]').length === 3);
    check('每条都有颜色点', panel22.querySelectorAll('.mn-ai-dot').length === 3);
    check('批注填在输入框里', panel22.querySelector('[data-ai-input="note"][data-i="0"]').value === '一句话说清是什么');
    check('页面上有的两条默认勾上', panel22.querySelector('[data-ai-input="pick"][data-i="0"]').checked === true &&
      panel22.querySelector('[data-ai-input="pick"][data-i="1"]').checked === true);
    check('页面上找不到的那条标出来且禁选', panel22.querySelector('[data-ai-input="pick"][data-i="2"]').disabled === true &&
      !!panel22.querySelectorAll('.mn-ai-item')[2].querySelector('.mn-ai-badge'));
    check('状态里报了 token 用量', (panel22.querySelector('.mn-ai-status').textContent || '').includes('321'),
      panel22.querySelector('.mn-ai-status').textContent);

    // 取消勾选第二条 → 计数跟着变
    const cb1 = panel22.querySelector('[data-ai-input="pick"][data-i="1"]');
    cb1.checked = false;
    cb1.dispatchEvent(new dom22.window.Event('input', { bubbles: true }));
    check('取消勾选后计数变了', panel22.querySelector('[data-role="pick-count"]').textContent.includes('1 / 3'),
      panel22.querySelector('[data-role="pick-count"]').textContent);

    // 改一下批注，再写入
    const note0 = panel22.querySelector('[data-ai-input="note"][data-i="0"]');
    note0.value = '我改过的批注';
    note0.dispatchEvent(new dom22.window.Event('input', { bubbles: true }));

    panel22.querySelector('[data-ai="apply"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(150);

    const marks22 = doc22.querySelectorAll('mark.mn-hl');
    check('写入后页面上出现了高亮', marks22.length === 1, 'marks=' + marks22.length);
    check('写的是选中的那句', marks22[0] && marks22[0].textContent === 'MarkNote 是一款网页划线工具', marks22[0] && marks22[0].textContent);
    check('颜色用了模型给的颜色', marks22[0] && marks22[0].dataset.color === 'yellow', marks22[0] && marks22[0].dataset.color);
    const aiAnn = Object.values(shared22.data).find((a) => a && a.source === 'ai');
    check('落盘时标了 source: ai', !!aiAnn, JSON.stringify(Object.values(shared22.data).map((a) => a && a.source)));
    check('批注用的是我改过的版本', aiAnn && aiAnn.note === '我改过的批注', aiAnn && aiAnn.note);
    check('被取消勾选的那条没有写进去', !doc22.body.textContent.includes('所有数据都保存在本机浏览器里') ||
      doc22.querySelectorAll('mark.mn-hl').length === 1);
    check('找不到原文的那条没写进去', !Object.values(shared22.data).some((a) => a && a.text === '这句话页面上根本没有出现过'));
    check('写入后面板自动关闭', sr22().querySelector('.mn-ai').hidden === true);
    check('提示条报告了结果', (sr22().querySelector('.mn-toast').textContent || '').includes('AI 写入 1 条'),
      sr22().querySelector('.mn-toast').textContent);

    // 再来一次：同样的片段应该被识别成重复（这次从侧栏打开，不依赖选区）
    sr22().querySelector('.mn-side [data-act="ai"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    sr22().querySelector('.mn-ai [data-ai="run"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    const cb22b = sr22().querySelector('.mn-ai [data-ai-input="pick"][data-i="1"]');
    if (cb22b && !cb22b.disabled) {
      cb22b.checked = false;
      cb22b.dispatchEvent(new dom22.window.Event('input', { bubbles: true }));
    }
    sr22().querySelector('.mn-ai [data-ai="apply"]').dispatchEvent(new dom22.window.MouseEvent('click', { bubbles: true }));
    await sleep(150);
    check('重复的片段不会再划一遍', doc22.querySelectorAll('mark.mn-hl').length === 1,
      'marks=' + doc22.querySelectorAll('mark.mn-hl').length);
    check('提示条说明跳过了几条', (sr22().querySelector('.mn-toast').textContent || '').includes('跳过重复'),
      sr22().querySelector('.mn-toast').textContent);
  }

  console.log('\n[22b] AI 分析：接口报错时说清楚 + 给个去管理页的按钮');
  {
    const shared22b = {
      data: {
        settings: {
          defaultColor: 'yellow',
          ai: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4.1-flash', maxItems: 6 }
        }
      }
    };
    const dom22b = bootPage(HTML, shared22b);
    const doc22b = dom22b.window.document;
    await sleep(60);
    const sr22b = () => doc22b.getElementById('marknote-host').shadowRoot;
    let asked = [];
    dom22b.__env.onSendMessage = (msg) => {
      asked.push(msg.type);
      return {
        ok: false,
        code: 'http',
        error:
          'The supported API model names are deepseek-flash, deepseek-v4-pro（这个接口可用的模型：deepseek-flash、deepseek-v4-pro —— 到管理页「AI 分析」里把模型改成其中一个）',
        models: ['deepseek-flash', 'deepseek-v4-pro']
      };
    };

    select(dom22b, doc22b.getElementById('p1').firstChild, 0, 20);
    doc22b.body.dispatchEvent(new dom22b.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(40);
    sr22b().querySelector('.mn-toolbar [data-act="ai"]').dispatchEvent(new dom22b.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    sr22b().querySelector('.mn-ai [data-ai="run"]').dispatchEvent(new dom22b.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);

    const panel22b = sr22b().querySelector('.mn-ai');
    check('面板里原样显示服务端的报错', panel22b.textContent.includes('supported API model names'),
      panel22b.textContent.slice(0, 80));
    check('长报错单独放一块，不挤在状态行里', !!panel22b.querySelector('.mn-ai-err'),
      String(!!panel22b.querySelector('.mn-ai-err')));
    check('状态行只说「失败」', panel22b.querySelector('.mn-ai-status').textContent === '分析失败',
      panel22b.querySelector('.mn-ai-status').textContent);
    check('报错里带着可用模型', panel22b.textContent.includes('deepseek-v4-pro'));
    check('报错时状态标红', panel22b.querySelector('.mn-ai-status').classList.contains('error'));
    check('报错时给「去管理页」按钮', !!panel22b.querySelector('[data-ai="setup"]'));
    check('报错时没有结果列表', panel22b.querySelectorAll('.mn-ai-item').length === 0);
    panel22b.querySelector('[data-ai="setup"]').dispatchEvent(new dom22b.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    check('点「去管理页」会请求打开管理页', asked.indexOf('mn:open-dashboard') >= 0, JSON.stringify(asked));
  }

  console.log('\n[23] AI 分析：没配置 / 没打开时的引导');
  {
    const shared23 = { data: { settings: { defaultColor: 'yellow', ai: { enabled: false } } } };
    const dom23 = bootPage(HTML, shared23);
    const doc23 = dom23.window.document;
    await sleep(60);
    const sr23 = () => doc23.getElementById('marknote-host').shadowRoot;
    let asked = false;
    dom23.__env.onSendMessage = () => {
      asked = true;
      return { ok: false, code: 'disabled', error: '还没有在管理页打开 AI 分析' };
    };

    sr23().querySelector('.mn-side [data-act="ai"]').dispatchEvent(new dom23.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const panel23 = sr23().querySelector('.mn-ai');
    check('没打开时也给个面板', panel23.hidden === false);
    check('说清楚为什么不能用', (panel23.textContent || '').includes('还没打开'));
    check('有去管理页的按钮', !!panel23.querySelector('[data-ai="setup"]'));
    check('没有开始分析按钮（省得白点）', !panel23.querySelector('[data-ai="run"]'));
    check('这时还没发任何请求', asked === false);

    panel23.querySelector('[data-ai="setup"]').dispatchEvent(new dom23.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    check('点「去管理页设置」会请求打开管理页', asked === true);
  }

  console.log('\n[24] 高亮序号：按位置 / 按创建时间');
  {
    // 故意「从后往前」划线：先划第二段，再划第一段。
    // 这样「按位置」和「按创建时间」得到的序号是反的，能真正验证排序规则。
    const shared24 = { data: {} };
    const html24 =
      '<p id="p1">第一段用来放前面的高亮文字。</p>' +
      '<p id="p2">第二段用来放后面的高亮文字。</p>' +
      '<p id="p3">前<b>粗体</b>后</p>';
    const dom24 = bootPage(html24, shared24);
    const doc24 = dom24.window.document;
    await sleep(60);
    const sr24 = () => doc24.getElementById('marknote-host').shadowRoot;
    const list24 = dom24.__env.onMessage[dom24.__env.onMessage.length - 1];
    const ask24 = (msg) => new Promise((res) => list24(msg, {}, res));

    // 先划 p2，再划 p1
    select(dom24, doc24.getElementById('p2').firstChild, 0, 6);
    await ask24({ type: dom24.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'yellow' });
    await sleep(30);
    select(dom24, doc24.getElementById('p1').firstChild, 0, 6);
    await ask24({ type: dom24.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'green' });
    await sleep(40);

    const marks24 = () => [...doc24.querySelectorAll('mark.mn-hl')];
    check('先划出了两块高亮', marks24().length === 2, String(marks24().length));
    check('默认不显示序号', marks24().every((m) => !m.dataset.idx), marks24().map((m) => m.dataset.idx).join(','));

    const on = await ask24({ type: dom24.window.MN.MSG.TOGGLE_INDEX });
    await sleep(30);
    check('TOGGLE_INDEX 返回 ok', on && on.ok === true && on.showIndex === true, JSON.stringify(on));
    const numbered = marks24();
    check('开了序号后两块都有编号', numbered.every((m) => m.dataset.idx), numbered.map((m) => m.dataset.idx).join(','));
    check('按页面位置排：上边那块是 1 号', numbered[0].dataset.idx === '1', numbered.map((m) => m.dataset.idx).join(','));
    check('按页面位置排：下边那块是 2 号', numbered[1].dataset.idx === '2', numbered.map((m) => m.dataset.idx).join(','));
    check('开序号没往正文里插节点（文本节点不变）',
      doc24.getElementById('p1').textContent === '第一段用来放前面的高亮文字。',
      doc24.getElementById('p1').textContent);

    const st24 = await ask24({ type: dom24.window.MN.MSG.PAGE_STATE });
    check('PAGE_STATE 带上 showIndex', st24 && st24.showIndex === true, JSON.stringify(st24 && st24.showIndex));
    check('PAGE_STATE 里带上了 startV（侧栏要按同样规则编号）',
      st24 && st24.annotations.every((a) => typeof a.startV === 'number' || a.startV === null),
      JSON.stringify(st24 && st24.annotations.map((a) => a.startV)));

    const off = await ask24({ type: dom24.window.MN.MSG.TOGGLE_INDEX });
    await sleep(30);
    check('再点一次就关掉', off && off.showIndex === false, JSON.stringify(off));
    check('关掉后编号被摘掉', marks24().every((m) => !m.dataset.idx));

    // 换个排序方式（新开一个页面读设置，等价于在管理页里改完再回来）
    shared24.data.settings = { showIndex: true, indexMode: 'order' };
    const dom24b = bootPage(html24, shared24);
    const doc24b = dom24b.window.document;
    await until(() => {
      const m = [...doc24b.querySelectorAll('mark.mn-hl')];
      return m.length === 2 && m.every((x) => x.dataset.idx);
    });
    const marks24b = [...doc24b.querySelectorAll('mark.mn-hl')];
    check('换页后仍然显示序号', marks24b.length === 2 && marks24b.every((m) => m.dataset.idx), marks24b.map((m) => m.dataset.idx).join(','));
    const firstCreated = shared24.data['ann:' + Object.keys(shared24.data).filter((k) => k.startsWith('ann:'))[0]];
    check('按创建时间排：先划的那块是 1 号',
      marks24b[1].dataset.idx === '1' && marks24b[0].dataset.idx === '2',
      marks24b.map((m) => m.dataset.idx).join(',') + ' | first=' + (firstCreated && firstCreated.text));
  }

  console.log('\n[24b] 跨行内标签的高亮只编号一次');
  {
    const shared24c = { data: { settings: { showIndex: true, indexMode: 'position' } } };
    const dom24c = bootPage('<p id="p3">前<b>粗体</b>后</p>', shared24c);
    const doc24c = dom24c.window.document;
    await sleep(60);
    const list24c = dom24c.__env.onMessage[dom24c.__env.onMessage.length - 1];
    // 从「前」一直选到「后」，中间跨过 <b>粗体</b>，定位引擎会拆成好几个 mark
    const p3 = doc24c.getElementById('p3');
    const range = doc24c.createRange();
    range.setStart(p3.firstChild, 0);
    range.setEnd(p3.lastChild, 1);
    const sel = dom24c.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await new Promise((res) => list24c({ type: dom24c.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'blue' }, {}, res));
    await until(() => {
      const m = [...doc24c.querySelectorAll('mark.mn-hl')];
      return m.length >= 2 && m.every((x) => x.dataset.idx || x.dataset.idxCont);
    });
    const parts = [...doc24c.querySelectorAll('mark.mn-hl')];
    const numbered = parts.filter((m) => m.dataset.idx);
    const cont = parts.filter((m) => m.dataset.idxCont);
    check('跨标签被拆成多段', parts.length >= 2, 'parts=' + parts.length);
    check('只有第一段带序号', numbered.length === 1 && numbered[0].dataset.idx === '1',
      parts.map((m) => m.dataset.idx || (m.dataset.idxCont ? 'cont' : '-')).join(','));
    check('其余段落只标了「续」不再带号', cont.length === parts.length - 1,
      parts.map((m) => m.dataset.idx || (m.dataset.idxCont ? 'cont' : '-')).join(','));
  }

  console.log('\n[25] 一键清空本页 + 撤销');
  {
    const shared25 = { data: {} };
    const dom25 = bootPage('<p id="p1">清空测试第一段划线文字。</p><p id="p2">清空测试第二段划线文字。</p>', shared25);
    const doc25 = dom25.window.document;
    await sleep(60);
    const list25 = dom25.__env.onMessage[dom25.__env.onMessage.length - 1];
    const ask25 = (msg) => new Promise((res) => list25(msg, {}, res));
    const sr25 = () => doc25.getElementById('marknote-host').shadowRoot;
    const annKeys25 = () => Object.keys(shared25.data).filter((k) => k.startsWith('ann:'));

    // 空页面先清一次
    const empty = await ask25({ type: dom25.window.MN.MSG.CLEAR_PAGE });
    await sleep(20);
    check('空页面清空返回 cleared=0', empty && empty.ok === true && empty.cleared === 0, JSON.stringify(empty));
    check('空页面给个提示', sr25().querySelector('.mn-toast').textContent.includes('还没有划线'),
      sr25().querySelector('.mn-toast').textContent);

    select(dom25, doc25.getElementById('p1').firstChild, 0, 8);
    await ask25({ type: dom25.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'yellow' });
    await sleep(30);
    select(dom25, doc25.getElementById('p2').firstChild, 0, 8);
    await ask25({ type: dom25.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'green' });
    await sleep(40);
    check('先有两条划线', annKeys25().length === 2 && doc25.querySelectorAll('mark.mn-hl').length === 2,
      annKeys25().length + '/' + doc25.querySelectorAll('mark.mn-hl').length);

    const cleared = await ask25({ type: dom25.window.MN.MSG.CLEAR_PAGE });
    await sleep(60);
    check('CLEAR_PAGE 报告清掉几条', cleared && cleared.ok === true && cleared.cleared === 2, JSON.stringify(cleared));
    check('存储里一条不剩', annKeys25().length === 0, annKeys25().join(','));
    check('页面上的高亮也没了', doc25.querySelectorAll('mark.mn-hl').length === 0);
    const toast25 = sr25().querySelector('.mn-toast');
    check('提示条说明清了几条', toast25.textContent.includes('已清空本页 2 条'), toast25.textContent);
    check('提示条带「撤销」按钮', !!toast25.querySelector('.mn-toast-act') && toast25.querySelector('.mn-toast-act').textContent === '撤销',
      toast25.innerHTML);
    check('带按钮的提示条可以点（不是 pointer-events:none）', toast25.classList.contains('has-act'));

    toast25.querySelector('.mn-toast-act').dispatchEvent(new dom25.window.MouseEvent('click', { bubbles: true }));
    await until(() => Object.keys(shared25.data).filter((k) => k.startsWith('ann:')).length === 2 && doc25.querySelectorAll('mark.mn-hl').length === 2);
    await sleep(30);
    check('撤销后数据回来了', annKeys25().length === 2, annKeys25().join(','));
    check('撤销后高亮也回到页面', doc25.querySelectorAll('mark.mn-hl').length === 2,
      String(doc25.querySelectorAll('mark.mn-hl').length));
    check('撤销后提示条报恢复了几条', sr25().querySelector('.mn-toast').textContent.includes('已恢复 2 条'),
      sr25().querySelector('.mn-toast').textContent);
    check('恢复的划线还是原来的文字',
      [...doc25.querySelectorAll('mark.mn-hl')].map((m) => m.textContent).join('|') === '清空测试第一段划|清空测试第二段划',
      [...doc25.querySelectorAll('mark.mn-hl')].map((m) => m.textContent).join('|'));
  }

  console.log('\n[26] 序号设置的归一化');
  {
    const w = dom.window.MN;
    check('normalizeIndexMode 认 order', w.normalizeIndexMode('order') === 'order');
    check('normalizeIndexMode 认 position', w.normalizeIndexMode('position') === 'position');
    check('normalizeIndexMode 认不出来回落到 position', w.normalizeIndexMode('whatever') === 'position');
    check('normalizeIndexMode 空值也回落', w.normalizeIndexMode(undefined) === 'position' && w.normalizeIndexMode(null) === 'position');
    check('默认设置里序号是关的', w.DEFAULT_SETTINGS.showIndex === false);
    check('默认排序是按位置', w.DEFAULT_SETTINGS.indexMode === 'position');

    const shared26 = { data: {} };
    const dom26 = bootPage('<p id="p1">设置归一化测试用的一段文字。</p>', shared26);
    await sleep(60);
    const st = dom26.window.MN.store;
    await st.setSettings({ indexMode: 'nonsense', showIndex: 'yes' });
    const s1 = await st.getSettings();
    check('setSettings 把乱写的 indexMode 掰成 position', s1.indexMode === 'position', s1.indexMode);
    check('setSettings 把 showIndex 掰成布尔', s1.showIndex === true, JSON.stringify(s1.showIndex));
    // 直接往存储里塞脏值，读的时候也得兜住
    shared26.data.settings = { indexMode: 123, showIndex: 0, markdownTemplate: 'weird' };
    const s2 = await st.getSettings();
    check('读设置时也兜脏值：indexMode', s2.indexMode === 'position', String(s2.indexMode));
    check('读设置时也兜脏值：showIndex', s2.showIndex === false, String(s2.showIndex));
    check('读设置时也兜脏值：markdownTemplate', s2.markdownTemplate === 'quote', String(s2.markdownTemplate));
  }

  console.log('\n[27] 复制辅助：侧栏按钮也守同一道门');
  {
    const shared27 = { data: {} };
    const dom27 = bootPage('<p id="p1">复制辅助测试用的一段文字。</p>', shared27);
    const doc27 = dom27.window.document;
    await sleep(60);
    const sr27 = () => doc27.getElementById('marknote-host').shadowRoot;
    const unlockBtn = () => sr27().querySelector('.mn-side-btn[data-act="unlock"]');

    check('侧栏里有这个按钮', !!unlockBtn());
    check('按钮上写的是中性描述', /选中|复制/.test(unlockBtn().title) && !/绕过/.test(unlockBtn().title), unlockBtn().title);
    check('默认是关着的', unlockBtn().dataset.on === '0');

    unlockBtn().dispatchEvent(new dom27.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    check('没确认前点它也不生效', !doc27.documentElement.classList.contains('mn-unlock-copy'));
    check('而是提示去弹窗里确认',
      sr27().querySelector('.mn-toast').textContent.includes('允许本页选中复制'),
      sr27().querySelector('.mn-toast').textContent);
    check('按钮状态没变', unlockBtn().dataset.on === '0');

    await dom27.window.MN.store.setSettings({ copyNoticeAck: true });
    unlockBtn().dispatchEvent(new dom27.window.MouseEvent('click', { bubbles: true }));
    await until(() => doc27.documentElement.classList.contains('mn-unlock-copy'));
    check('确认之后点它才生效', doc27.documentElement.classList.contains('mn-unlock-copy'));
    check('按钮标成开启状态', unlockBtn().dataset.on === '1');
  }

  console.log('\n[28] AI 对话悬浮窗：多轮聊天、不产生划线、关窗即清空');
  {
    const shared28 = { data: { settings: { ai: { enabled: true, model: 'deepseek-chat' } } } };
    const HTML28 =
      '<p id="p1">第一段：第二季度营收同比增长 18%，毛利率 42%。</p>' +
      '<p id="p2">第二段：随便写点别的内容，用来确认没有新划线。</p>';
    const dom28 = bootPage(HTML28, shared28);
    const doc28 = dom28.window.document;
    await sleep(60);
    const sr28 = () => doc28.getElementById('marknote-host').shadowRoot;
    const talkEl = () => sr28().querySelector('.mn-talk');

    // 假后台：记下收到的每一条对话请求，回一段可读文字（注意：绝不返回 items）
    const seen = [];
    dom28.__env.onSendMessage = (msg) => {
      if (msg.type === 'mn:ai-talk') {
        seen.push(JSON.parse(JSON.stringify(msg.payload)));
        return Promise.resolve({ ok: true, reply: '第 ' + seen.length + ' 轮的回复：增长说的是同比。', model: 'deepseek-chat' });
      }
      return undefined;
    };

    check('一开始没有对话窗内容', talkEl().textContent.trim() === '', talkEl().textContent);

    // 1) 选中文字 → 工具条上的「对话」
    const p1 = doc28.getElementById('p1').firstChild;
    select(dom28, p1, 4, 24);
    doc28.body.dispatchEvent(new dom28.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(40);
    const talkBtn = sr28().querySelector('.mn-toolbar [data-act="talk"]');
    check('工具条上有「对话」按钮', !!talkBtn, sr28().querySelector('.mn-toolbar').innerHTML.slice(0, 200));
    talkBtn.dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('对话窗打开了', talkEl().hidden === false);
    check('窗口里显示引用的那段文字', talkEl().querySelector('.mn-talk-chip').textContent.includes('第二季度营收'), talkEl().querySelector('.mn-talk-chip').textContent);
    check('窗口里说明了不会产生划线', talkEl().textContent.includes('不会产生任何划线'), talkEl().textContent.slice(0, 200));
    const talkModelBtn = talkEl().querySelector('.mn-model-btn');
    check('标题栏上有可点的模型按钮', !!talkModelBtn && talkModelBtn.textContent.includes('deepseek-chat'),
      talkModelBtn ? talkModelBtn.textContent : '没有 .mn-model-btn');
    check('还没有发过请求', seen.length === 0);
    // jsdom 没有真实布局，这里只能验证「兜底位置」和拖动这条链路没断
    check('窗口被放到了视口里（兜底位置）', /^\d+px$/.test(talkEl().style.left) && /^\d+px$/.test(talkEl().style.top), talkEl().style.left + ',' + talkEl().style.top);
    const head28 = talkEl().querySelector('.mn-talk-head');
    head28.dispatchEvent(new dom28.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 300, clientY: 80 }));
    doc28.dispatchEvent(new dom28.window.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 120 }));
    doc28.dispatchEvent(new dom28.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(20);
    check('按住标题栏可以拖动窗口', talkEl().style.left !== '' && talkEl().style.top !== '', talkEl().style.left + ',' + talkEl().style.top);
    check('拖完窗口还开着', talkEl().hidden === false);
    check('拖动不会产生划线', doc28.querySelectorAll('mark.mn-hl').length === 0);

    // 2) 发第一轮
    const input = talkEl().querySelector('[data-talk-input="q"]');
    input.value = '这句话什么意思？';
    input.dispatchEvent(new dom28.window.Event('input', { bubbles: true }));
    talkEl().querySelector('[data-talk="send"]').dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await until(() => talkEl().querySelectorAll('.mn-talk-msg.assistant:not(.pending)').length === 1);
    const msgs1 = [...talkEl().querySelectorAll('.mn-talk-msg:not(.pending)')];
    check('第一轮发了出去', seen.length === 1, String(seen.length));
    check('请求里带上了引用的文字', seen[0].quote.includes('第二季度营收'), seen[0].quote);
    check('请求里带上了页面地址', String(seen[0].url).includes('example.com'), seen[0].url);
    check('历史里是这一条问题', seen[0].history.length === 1 && seen[0].history[0].content === '这句话什么意思？', JSON.stringify(seen[0].history));
    check('窗口里出现一问一答两条', msgs1.length === 2, String(msgs1.length));
    check('问题气泡是 user', msgs1[0].classList.contains('user'));
    check('回答气泡是 assistant 且显示模型原话', msgs1[1].classList.contains('assistant') && msgs1[1].textContent.includes('第 1 轮的回复'), msgs1[1].textContent);
    check('发完清空了输入框', talkEl().querySelector('[data-talk-input="q"]').value === '');

    // 3) 关键：不产生任何划线
    check('页面上没有新增任何高亮', doc28.querySelectorAll('mark.mn-hl').length === 0, String(doc28.querySelectorAll('mark.mn-hl').length));
    check('存储里没有新增任何划线', Object.keys(shared28.data).filter((k) => k.startsWith('ann:')).length === 0, Object.keys(shared28.data).join(','));
    check('对话框里没有「写入划线」这类按钮', ![...talkEl().querySelectorAll('button')].some((b) => /写入|应用|落库/.test(b.textContent)), talkEl().innerHTML.slice(0, 200));
    check('对话窗口没有 analysis 的 items 列表', !talkEl().querySelector('.mn-ai-item'));

    // 4) 第二轮：历史要带上前面的一问一答
    const input2 = talkEl().querySelector('[data-talk-input="q"]');
    input2.value = '那毛利率呢？';
    input2.dispatchEvent(new dom28.window.Event('input', { bubbles: true }));
    talkEl().querySelector('[data-talk="send"]').dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await until(() => talkEl().querySelectorAll('.mn-talk-msg.assistant:not(.pending)').length === 2);
    check('第二轮也发了出去', seen.length === 2, String(seen.length));
    check('第二轮的历史是三条（问、答、问）', seen[1].history.length === 3, JSON.stringify(seen[1].history.map((m) => m.role)));
    check('历史里带上了上一轮的回答', seen[1].history[1].role === 'assistant' && seen[1].history[1].content.includes('第 1 轮的回复'), JSON.stringify(seen[1].history));
    check('两轮之后仍然没有划线', doc28.querySelectorAll('mark.mn-hl').length === 0 && Object.keys(shared28.data).filter((k) => k.startsWith('ann:')).length === 0);
    check('窗口里累计四条消息', talkEl().querySelectorAll('.mn-talk-msg:not(.pending)').length === 4, String(talkEl().querySelectorAll('.mn-talk-msg:not(.pending)').length));

    // 5) 清空（窗口不关）
    talkEl().querySelector('[data-talk="clear"]').dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('清空后消息没了', talkEl().querySelectorAll('.mn-talk-msg:not(.pending)').length === 0);
    check('清空后窗口还开着', talkEl().hidden === false);

    // 6) 关窗 = 丢掉对话
    talkEl().querySelector('[data-talk="close"]').dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('关掉后窗口隐藏', talkEl().hidden === true);
    check('关掉后内容被清空', talkEl().textContent.trim() === '', talkEl().textContent);
    // 重新打开：引用同一段文字，也必须是全新的对话
    sr28().querySelector('.mn-toolbar [data-act="talk"]').dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('重新打开是空对话', talkEl().querySelectorAll('.mn-talk-msg:not(.pending)').length === 0);
    check('重新打开仍带着引用文字', talkEl().querySelector('.mn-talk-chip').textContent.includes('第二季度营收'));
    talkEl().querySelector('[data-talk="close"]').dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);

    // 7) 「已有高亮 → AI 对话」这个入口：引用的是那条划线的原文
    const listener28 = dom28.__env.onMessage[dom28.__env.onMessage.length - 1];
    await new Promise((res) => listener28({ type: dom28.window.MN.MSG.HIGHLIGHT_SELECTION, color: 'yellow' }, {}, res));
    await sleep(40);
    check('先划出一条高亮（作为对话入口的前提）', doc28.querySelectorAll('mark.mn-hl').length === 1);
    const mark28 = doc28.querySelector('mark.mn-hl');
    mark28.dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const popTalk = sr28().querySelector('.mn-pop [data-act="talk"]');
    check('高亮弹层里有「AI 对话」', !!popTalk && popTalk.textContent.includes('AI 对话'), sr28().querySelector('.mn-pop').innerHTML.slice(0, 200));
    popTalk.dispatchEvent(new dom28.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('从高亮进来时引用的是划线原文', talkEl().querySelector('.mn-talk-chip').textContent.includes(mark28.textContent.trim()), talkEl().querySelector('.mn-talk-chip').textContent);
    check('从高亮进来也没有新增划线', doc28.querySelectorAll('mark.mn-hl').length === 1, String(doc28.querySelectorAll('mark.mn-hl').length));

    // 8) 消息接口（右键菜单 / 弹窗走这条）
    const viaMsg = await new Promise((res) =>
      listener28({ type: dom28.window.MN.MSG.AI_TALK }, {}, res)
    );
    await sleep(30);
    check('AI_TALK 消息能打开对话窗', viaMsg && viaMsg.ok === true, JSON.stringify(viaMsg));
    check('AI_TALK 回执里带上是否可用', viaMsg && viaMsg.ready === true, JSON.stringify(viaMsg));
    check('用消息打开时引用当前选区/无引用也不报错', talkEl().hidden === false);

    // 9) Esc 关闭
    talkEl().dispatchEvent(
      new dom28.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await sleep(30);
    check('Esc 能关掉对话窗', talkEl().hidden === true);
  }

  console.log('\n[29] AI 对话：没配置时只给引导，不发请求');
  {
    const shared29 = { data: {} }; // 默认 ai.enabled = false
    const dom29 = bootPage('<p id="p1">没配置 AI 时的一段文字。</p>', shared29);
    const doc29 = dom29.window.document;
    await sleep(60);
    const sr29 = () => doc29.getElementById('marknote-host').shadowRoot;
    let asked = 0;
    dom29.__env.onSendMessage = (msg) => {
      if (msg.type === 'mn:ai-talk') asked += 1;
      return undefined;
    };
    const listener29 = dom29.__env.onMessage[dom29.__env.onMessage.length - 1];
    await new Promise((res) => listener29({ type: dom29.window.MN.MSG.AI_TALK }, {}, res));
    await sleep(30);
    const win = sr29().querySelector('.mn-talk');
    check('窗口打开了', win.hidden === false);
    check('显示的是「去配置」引导', /AI 还没打开/.test(win.textContent), win.textContent.slice(0, 120));
    check('引导里说了对话会发什么、不会划线', /不会写进划线/.test(win.textContent), win.textContent.slice(0, 300));
    check('没有输入框（不让白打字）', !win.querySelector('[data-talk-input="q"]'));
    check('有去管理页的按钮', !!win.querySelector('[data-talk="setup"]'));
    check('一个字都没发出去', asked === 0, String(asked));
  }

  console.log('\n[30] 页面内切换模型（AI 分析面板 / 对话悬浮窗共用）');
  {
    const shared30 = {
      data: {
        settings: {
          ai: { enabled: true, model: 'deepseek-chat', prompt: '我的提示词', maxItems: 6, maxChars: 9000 }
        }
      }
    };
    const dom30 = bootPage('<p id="p1">切换模型测试用的一段文字，够长了吧。</p>', shared30);
    const doc30 = dom30.window.document;
    await sleep(60);
    const sr30 = () => doc30.getElementById('marknote-host').shadowRoot;
    const menu30 = () => sr30().querySelector('.mn-models');
    const panelModel30 = () => sr30().querySelector('.mn-ai .mn-model-btn');
    const asked = [];
    dom30.__env.onSendMessage = (msg) => {
      asked.push(msg.type);
      if (msg.type === 'mn:ai-models') {
        return Promise.resolve({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'] });
      }
      if (msg.type === 'mn:ai-chat' || msg.type === 'mn:ai-talk') {
        return Promise.resolve({ ok: true, reply: '好', items: [] });
      }
      return undefined;
    };
    const listener30 = dom30.__env.onMessage[dom30.__env.onMessage.length - 1];

    await new Promise((res) => listener30({ type: dom30.window.MN.MSG.AI_PANEL, scope: 'selection' }, {}, res));
    await sleep(40);
    check('分析面板标题栏上有模型按钮', !!panelModel30() && panelModel30().textContent.includes('deepseek-chat'),
      panelModel30() ? panelModel30().textContent : '没有按钮');
    check('一开始菜单是收着的', menu30().hidden === true);

    // 点开菜单 → 自动拉一次列表
    panelModel30().dispatchEvent(new dom30.window.MouseEvent('click', { bubbles: true }));
    await until(() => menu30().querySelectorAll('.mn-model-item').length === 3);
    check('菜单里列出了拉到的三个模型', menu30().querySelectorAll('.mn-model-item').length === 3,
      String(menu30().querySelectorAll('.mn-model-item').length));
    check('发的是拉模型的消息', asked.includes('mn:ai-models'), asked.join(','));
    check('当前模型被标成选中', menu30().querySelector('.mn-model-item[data-on="1"]').dataset.model === 'deepseek-chat',
      menu30().querySelector('.mn-model-item[data-on="1"]').textContent);
    check('菜单里说明了来源与生效方式', /来自/.test(menu30().textContent) && /保存为本机默认/.test(menu30().textContent),
      menu30().textContent.slice(-80));
    check('菜单在视口里（jsdom 里至少给了定位样式）', /^\d+px$/.test(menu30().style.left), menu30().style.left);

    // 选第二个 → 落盘 + 两个面板都跟着换
    const before = asked.filter((t) => t === 'mn:ai-models').length;
    menu30().querySelector('.mn-model-item[data-model="deepseek-reasoner"]').dispatchEvent(new dom30.window.MouseEvent('click', { bubbles: true }));
    await until(() => !!(shared30.data.settings.ai && shared30.data.settings.ai.model === 'deepseek-reasoner'));
    await sleep(40);
    check('选中的模型写进了设置', shared30.data.settings.ai.model === 'deepseek-reasoner', JSON.stringify(shared30.data.settings.ai.model));
    check('其它 AI 设置没被冲掉（enabled / prompt / maxItems）',
      shared30.data.settings.ai.enabled === true &&
        shared30.data.settings.ai.prompt === '我的提示词' &&
        shared30.data.settings.ai.maxItems === 6,
      JSON.stringify(shared30.data.settings.ai));
    check('选完菜单自己关上', menu30().hidden === true);
    check('面板上的模型名换成了新的', panelModel30().textContent.includes('deepseek-reasoner'), panelModel30().textContent);
    check('提示条告诉用户切换成功', sr30().querySelector('.mn-toast').textContent.includes('deepseek-reasoner'),
      sr30().querySelector('.mn-toast').textContent);
    check('切模型不会产生任何划线', doc30.querySelectorAll('mark.mn-hl').length === 0);

    // 对话悬浮窗：同一个菜单，且命中缓存不再重复拉
    await new Promise((res) => listener30({ type: dom30.window.MN.MSG.AI_TALK, quote: '切换模型测试用的一段文字' }, {}, res));
    await sleep(40);
    const talkModelBtn = sr30().querySelector('.mn-talk .mn-model-btn');
    check('对话窗标题栏也能切模型', !!talkModelBtn && talkModelBtn.textContent.includes('deepseek-reasoner'),
      talkModelBtn ? talkModelBtn.textContent : '没有按钮');
    talkModelBtn.dispatchEvent(new dom30.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    check('对话窗里的菜单也列了三个', menu30().querySelectorAll('.mn-model-item').length === 3);
    check('五分钟内复用缓存，不重复拉取', asked.filter((t) => t === 'mn:ai-models').length === before, asked.join(','));

    // 重新拉取按钮：强制刷新
    menu30().querySelector('[data-model-act="reload"]').dispatchEvent(new dom30.window.MouseEvent('click', { bubbles: true }));
    await until(() => asked.filter((t) => t === 'mn:ai-models').length === before + 1);
    check('点「重新拉取」会真的再问一次', asked.filter((t) => t === 'mn:ai-models').length === before + 1, asked.join(','));

    // Esc 只收菜单，不关窗口
    menu30().dispatchEvent(new dom30.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(30);
    check('Esc 收起了菜单', menu30().hidden === true);
    check('Esc 之后对话窗还开着', sr30().querySelector('.mn-talk').hidden === false);

    // 点面板里的别处也会收起菜单（不用先点 Esc）
    sr30().querySelector('.mn-talk .mn-model-btn').dispatchEvent(new dom30.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('先把菜单打开', menu30().hidden === false);
    sr30().querySelector('.mn-talk').dispatchEvent(new dom30.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    check('点别处会收起菜单', menu30().hidden === true);
  }

  console.log('\n[31] 模型菜单：没配 Key 时给出路，而不是空白');
  {
    const shared31 = { data: { settings: { ai: { enabled: true, model: '' } } } };
    const dom31 = bootPage('<p id="p1">没有 Key 的时候的一段文字。</p>', shared31);
    const doc31 = dom31.window.document;
    await sleep(60);
    const sr31 = () => doc31.getElementById('marknote-host').shadowRoot;
    let asked31 = 0;
    dom31.__env.onSendMessage = (msg) => {
      if (msg.type === 'mn:ai-models') {
        asked31 += 1;
        return Promise.resolve({ ok: false, code: 'nokey', error: '还没有配置 API Key' });
      }
      return undefined;
    };
    const listener31 = dom31.__env.onMessage[dom31.__env.onMessage.length - 1];
    await new Promise((res) => listener31({ type: dom31.window.MN.MSG.AI_TALK }, {}, res));
    await sleep(40);
    check('没选模型时按钮显示占位文案', sr31().querySelector('.mn-talk .mn-model-btn').textContent.includes('选模型'),
      sr31().querySelector('.mn-talk .mn-model-btn').textContent);
    sr31().querySelector('.mn-talk .mn-model-btn').dispatchEvent(new dom31.window.MouseEvent('click', { bubbles: true }));
    await until(() => sr31().querySelector('.mn-models .mn-ai-err'));
    const menu31 = sr31().querySelector('.mn-models');
    check('菜单里显示了后台给的错误', /还没有配置 API Key/.test(menu31.textContent), menu31.textContent.slice(0, 120));
    check('并指路去管理页', !!menu31.querySelector('[data-model-act="setup"]'), menu31.innerHTML.slice(0, 200));
    check('确实问过一次', asked31 === 1, String(asked31));
  }

  console.log('\n[32] AI 对话：预填默认提示词，一打字就让位');
  {
    const DEFAULT_Q = '帮我解释这段文字的意思，并指出其中的重点。';
    const shared32 = {
      data: { settings: { ai: { enabled: true, model: 'deepseek-chat' } } }
    };
    const dom32 = bootPage('<p id="p1">预填提示词测试用的这一段文字，够长了。</p>', shared32);
    const doc32 = dom32.window.document;
    await sleep(60);
    const sr32 = () => doc32.getElementById('marknote-host').shadowRoot;
    const talk32 = () => sr32().querySelector('.mn-talk');
    const box32 = () => talk32().querySelector('[data-talk-input="q"]');
    const sent32 = [];
    dom32.__env.onSendMessage = (msg) => {
      if (msg.type === 'mn:ai-talk') {
        sent32.push(JSON.parse(JSON.stringify(msg.payload)));
        return Promise.resolve({ ok: true, reply: '第 ' + sent32.length + ' 轮回答' });
      }
      return undefined;
    };
    const listener32 = dom32.__env.onMessage[dom32.__env.onMessage.length - 1];
    const openTalk32 = async (quote) => {
      await new Promise((res) => listener32({ type: dom32.window.MN.MSG.AI_TALK, quote: quote || '预填提示词测试用的这一段文字' }, {}, res));
      await sleep(40);
    };
    const type32 = (v) => {
      box32().value = v;
      box32().dispatchEvent(new dom32.window.Event('input', { bubbles: true }));
    };

    // 1) 打开就预填一句默认提示词
    await openTalk32();
    check('打开对话窗就预填了默认提示词', box32().value === DEFAULT_Q, JSON.stringify(box32().value));
    check('预填的内容整段被选中（一敲键盘就是替换）',
      box32().selectionStart === 0 && box32().selectionEnd === DEFAULT_Q.length,
      box32().selectionStart + ',' + box32().selectionEnd);
    check('提示语说明了可以直接发送', /直接发送/.test(talk32().querySelector('.mn-talk-tip').textContent),
      talk32().querySelector('.mn-talk-tip').textContent);

    // 2) 什么也不动，直接点发送 → 发出去的就是那句默认提示词
    talk32().querySelector('[data-talk="send"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await until(() => sent32.length === 1 && talk32().querySelectorAll('.mn-talk-msg.assistant:not(.pending)').length === 1);
    check('没输入就发送 = 按默认提示词问', sent32[0].history[0].content === DEFAULT_Q, JSON.stringify(sent32[0].history));
    check('发完之后输入框清空、也不再预填', box32().value === '', JSON.stringify(box32().value));
    check('发完之后提示语换成普通说明', !/让位/.test(talk32().querySelector('.mn-talk-tip').textContent),
      talk32().querySelector('.mn-talk-tip').textContent);

    // 3) 新开一轮对话：在末尾接着打字 → 默认提示词让位，只留用户写的
    talk32().querySelector('[data-talk="close"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    await openTalk32();
    check('重新打开又预填了', box32().value === DEFAULT_Q);
    type32(DEFAULT_Q + '另外它和上一段有什么关系？');
    check('在末尾接着写：只留下自己写的部分', box32().value === '另外它和上一段有什么关系？', JSON.stringify(box32().value));
    check('光标落在末尾', box32().selectionStart === box32().value.length, String(box32().selectionStart));

    // 4) 全选替换 / 插在中间，也只留用户写的那部分
    talk32().querySelector('[data-talk="close"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    await openTalk32();
    type32('换成我自己的问题');
    check('全选替换：只剩新写的', box32().value === '换成我自己的问题', JSON.stringify(box32().value));
    talk32().querySelector('[data-talk="close"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    await openTalk32();
    type32(DEFAULT_Q.slice(0, 6) + '为什么' + DEFAULT_Q.slice(6));
    check('插在中间：也只留插进去的那几个字', box32().value === '为什么', JSON.stringify(box32().value));

    // 5) 自己写的就原样发送（这是新对话的第一轮）
    talk32().querySelector('[data-talk="send"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await until(() => sent32.length === 2 && talk32().querySelectorAll('.mn-talk-msg.assistant:not(.pending)').length === 1);
    check('用户写的问题原样发出去', sent32[1].history[sent32[1].history.length - 1].content === '为什么',
      JSON.stringify(sent32[1].history));
    check('新对话第一轮只带这一条', sent32[1].history.length === 1, JSON.stringify(sent32[1].history.map((m) => m.role)));

    // 5b) 同一个对话里再问一轮 → 历史带上前面的一问一答
    type32('那再展开讲讲');
    talk32().querySelector('[data-talk="send"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await until(() => sent32.length === 3 && talk32().querySelectorAll('.mn-talk-msg.assistant:not(.pending)').length === 2);
    check('同一对话第二轮带上了前面的问答', sent32[2].history.length === 3, JSON.stringify(sent32[2].history.map((m) => m.role)));
    check('第二轮最后一条是新问题', sent32[2].history[2].content === '那再展开讲讲', JSON.stringify(sent32[2].history));

    // 6) 已经聊过之后，框空了再点发送不会又发一遍默认提示词
    talk32().querySelector('[data-talk="send"]').dispatchEvent(new dom32.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    check('框空着再点发送不会重复发默认提示词', sent32.length === 3, String(sent32.length));
  }

  console.log('\n[33] AI 对话：管理页自定义的默认提示词会被用上');
  {
    // 注意：自定义值要在页面前就写进存储——内容脚本是启动时读一次设置的
    const shared33 = {
      data: {
        settings: { ai: { enabled: true, model: 'deepseek-chat', chatPrompt: '自定义的默认问法：这段在说什么？' } }
      }
    };
    const dom33 = bootPage('<p id="p1">自定义默认提示词用的文字。</p>', shared33);
    const doc33 = dom33.window.document;
    await sleep(60);
    const sr33 = () => doc33.getElementById('marknote-host').shadowRoot;
    const sent33 = [];
    dom33.__env.onSendMessage = (msg) => {
      if (msg.type === 'mn:ai-talk') {
        sent33.push(JSON.parse(JSON.stringify(msg.payload)));
        return Promise.resolve({ ok: true, reply: '好' });
      }
      return undefined;
    };
    const listener33 = dom33.__env.onMessage[dom33.__env.onMessage.length - 1];
    await new Promise((res) => listener33({ type: dom33.window.MN.MSG.AI_TALK, quote: '自定义默认提示词用的文字' }, {}, res));
    await sleep(40);
    const box33 = sr33().querySelector('.mn-talk [data-talk-input="q"]');
    check('预填用的是管理页里那段', box33.value === '自定义的默认问法：这段在说什么？', JSON.stringify(box33.value));
    sr33().querySelector('.mn-talk [data-talk="send"]').dispatchEvent(new dom33.window.MouseEvent('click', { bubbles: true }));
    await until(() => sent33.length === 1);
    check('不动它发送 → 发出去的就是自定义那句', sent33[0].history[0].content === '自定义的默认问法：这段在说什么？',
      JSON.stringify(sent33[0].history));
  }

  console.log('\n[34] 回归：连不上后台 / 页面时的报错要翻成中文，别甩英文原文');
  {
    const dom34 = bootPage(HTML, { data: { settings: { defaultColor: 'yellow' } } });
    await sleep(40);
    const T = dom34.window.MN.sendErrorText;
    // 这就是浏览器在「对面没有监听者」时给的原话，用户看到的也是它
    const CHROME_ERR = 'Could not establish connection. Receiving end does not exist.';

    const toBg = T(new Error(CHROME_ERR));
    check('连不上后台 → 说人话并教刷新', /刷新页面/.test(toBg) && !/Receiving end/.test(toBg), toBg);

    const toTab = T(CHROME_ERR, 'tab');
    check('页面没注入内容脚本 → 指向「页面还没加载 MarkNote」', /还没有加载 MarkNote/.test(toTab) && !/Receiving end/.test(toTab), toTab);

    const invalidated = T({ message: 'Extension context invalidated.' });
    check('上下文失效 → 说插件被重新加载过', /重新加载过/.test(invalidated) && !/invalidated/.test(invalidated), invalidated);

    check('不认识的报错原样带出来，不吞掉', T(new Error('HTTP 401')) === 'HTTP 401', T(new Error('HTTP 401')));
    check('空报错有兜底文案', T('') === '未知错误', T(''));
  }

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
