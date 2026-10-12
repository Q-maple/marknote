/*
 * MarkNote 锚点模块测试（Node + jsdom）
 *
 * 运行：
 *   npm i jsdom                 # 或者用系统里任意一份 jsdom
 *   node test/anchors.test.js
 *
 * 覆盖：序列化 / 还原、页面插入内容后自动找回、跨节点划线、包装与还原高亮。
 */
const fs = require('fs');
const path = require('path');
const loadJsdom = require('./_jsdom');
let JSDOM;
try {
  ({ JSDOM } = loadJsdom() || {});
} catch (_e) {
  console.error('需要 jsdom：先执行 `npm i jsdom`（或设置 NODE_PATH 指向已安装位置）');
  process.exit(2);
}

const SRC = ['src/common/util.js', 'src/common/anchors.js'].map((p) =>
  fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
);

function boot(html, url = 'https://example.com/post') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only'
  });
  SRC.forEach((code) => dom.window.eval(code));
  return dom;
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.error('  ✗ ' + name + (extra ? '  →  ' + extra : ''));
  }
}

/** 用一段文字定位到 Range 的小工具 */
function rangeOfText(win, needle) {
  const { document } = win;
  const spans = win.MN.anchors.textNodes(document.body);
  const vt = win.MN.anchors.virtualTextFrom(spans);
  const i = vt.indexOf(needle);
  if (i < 0) throw new Error('测试数据里找不到：' + needle);
  return win.MN.anchors.rangeFromVirtual(spans, i, i + needle.length);
}

console.log('\n[1] 基本序列化与还原');
{
  const dom = boot('<p>第一段普通文字。</p><p>这里有 <b>加粗的重点</b> 和后面的内容。</p>');
  const { window } = dom;
  const range = rangeOfText(window, '加粗的重点');
  const anchor = window.MN.anchors.serializeRange(range, window.document.body);
  check('序列化成功', !!anchor);
  check('exact 正确', anchor.exact === '加粗的重点', anchor && anchor.exact);
  check('prefix/suffix 有上下文', anchor.prefix.includes('有 ') && anchor.suffix.includes(' 和'), JSON.stringify(anchor));
  const back = window.MN.anchors.resolveAnchor(anchor, window.document.body);
  check('还原成功', !!back);
  check('还原文本一致', back && back.toString() === '加粗的重点', back && back.toString());
}

console.log('\n[2] 页面上下插入内容后仍能找回');
{
  const dom = boot('<p>第一段。</p><p>目标句子在这里。</p>');
  const { window } = dom;
  const anchor = window.MN.anchors.serializeRange(rangeOfText(window, '目标句子在这里'), window.document.body);
  const p = window.document.createElement('p');
  p.textContent = '上面新插入的一大段广告文字，会把所有偏移量整体推后。';
  window.document.body.insertBefore(p, window.document.body.firstChild);
  const back = window.MN.anchors.resolveAnchor(anchor, window.document.body);
  check('偏移量变了也能找回', !!back && back.toString() === '目标句子在这里', back && back.toString());
}

console.log('\n[3] 重复文本：挑离原位最近的那处');
{
  const dom = boot('<p>重复的句子</p><p>中间隔开</p><p>重复的句子</p><p>结尾</p>');
  const { window } = dom;
  const spans = window.MN.anchors.textNodes(window.document.body);
  const vt = window.MN.anchors.virtualTextFrom(spans);
  const second = vt.lastIndexOf('重复的句子');
  const anchor = window.MN.anchors.serializeRange(
    window.MN.anchors.rangeFromVirtual(spans, second, second + 5),
    window.document.body
  );
  check('选中第二处', anchor.startV === second, String(anchor.startV) + ' vs ' + second);
  const back = window.MN.anchors.resolveAnchor(anchor, window.document.body);
  check('还原到第二处', back && back.startContainer.parentNode.textContent === '重复的句子' && back.startContainer.parentNode === window.document.body.children[2]);
}

console.log('\n[4] 跨节点划线 + 包装 / 还原');
{
  const dom = boot('<p>前半段<em>强调部分</em>后半段尾巴。</p>');
  const { window } = dom;
  const doc = window.document;
  const anchor = window.MN.anchors.serializeRange(rangeOfText(window, '段强调部分后'), doc.body);
  const ann = { id: 'a1', color: 'yellow' };
  const spans = window.MN.anchors.textNodes(doc.body);
  const vt = window.MN.anchors.virtualTextFrom(spans);
  const bounds = window.MN.anchors.resolveVirtual(anchor, spans, vt);
  const marks = window.MN.anchors.wrapVirtualRange(spans, bounds[0], bounds[1], ann, { light: '#ffe066', dark: '#8a6d00' });
  check('跨节点拆成了多个 mark', marks.length === 3, 'marks=' + marks.length);
  const allMarked = [...doc.querySelectorAll('mark.mn-hl')].map((m) => m.textContent).join('');
  check('标黄的文字 = 选中的文字', allMarked === '段强调部分后', allMarked);
  check('虚拟文本没变', window.MN.anchors.virtualTextFrom(window.MN.anchors.textNodes(doc.body)).includes('前半段强调部分后半段尾巴。'));
  const again = window.MN.anchors.resolveAnchor(anchor, doc.body);
  check('高亮之后还能再次定位', !!again && again.toString() === '段强调部分后', again && again.toString());
  window.MN.anchors.unwrapAnnotation('a1', doc.body);
  check('还原后没有 mark', doc.querySelectorAll('mark.mn-hl').length === 0);
  check('还原后文字完整', doc.body.textContent === '前半段强调部分后半段尾巴。', doc.body.textContent);
}

console.log('\n[5] 跳过脚本 / 输入框 / 可编辑区域');
{
  const dom = boot('<p>正文一</p><script>var x = "正文一";</script><textarea>正文一</textarea><p>正文二</p>');
  const { window } = dom;
  const vt = window.MN.anchors.virtualTextFrom(window.MN.anchors.textNodes(window.document.body));
  check('script 不计入虚拟文本', vt === '正文一正文二', JSON.stringify(vt));
}

console.log('\n[6] 同一段文字被整段包住时不重复包装');
{
  const dom = boot('<p>独立的一句话</p>');
  const { window } = dom;
  const doc = window.document;
  const anchor = window.MN.anchors.serializeRange(rangeOfText(window, '独立的一句话'), doc.body);
  const ann = { id: 'b1', color: 'green' };
  let spans = window.MN.anchors.textNodes(doc.body);
  let b = window.MN.anchors.resolveVirtual(anchor, spans, window.MN.anchors.virtualTextFrom(spans));
  window.MN.anchors.wrapVirtualRange(spans, b[0], b[1], ann, null);
  window.MN.anchors.unwrapAll(doc.body);
  doc.querySelector('p').appendChild(doc.createTextNode('尾部补充'));
  const anchor2 = window.MN.anchors.serializeRange(
    (() => {
      const s = window.MN.anchors.textNodes(doc.body);
      const v = window.MN.anchors.virtualTextFrom(s);
      const i = v.indexOf('独立的一句话');
      return window.MN.anchors.rangeFromVirtual(s, i, i + 6);
    })(),
    doc.body
  );
  spans = window.MN.anchors.textNodes(doc.body);
  b = window.MN.anchors.resolveVirtual(anchor2, spans, window.MN.anchors.virtualTextFrom(spans));
  const marks = window.MN.anchors.wrapVirtualRange(spans, b[0], b[1], { id: 'c1', color: 'blue' }, null);
  check('文字追加后仍能精确包住选中的 6 个字', marks.map((m) => m.textContent).join('') === '独立的一句话', marks.map((m) => m.textContent).join(''));
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
