/*
 * MarkNote 颜色工具测试（纯 Node，不需要 jsdom）
 *
 * 跑法：node test/color.test.js
 * 覆盖：颜色解析 / 归一化、RGB↔HSV 往返、明暗推导、
 *       自定义色板（去重、清理、和内置色共存）、colorOf 的各种输入。
 */
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'src/common/util.js'), 'utf8');
// 间接 eval → 在全局作用域执行，util.js 会把 MN 挂到 globalThis 上
(0, eval)(code);
const MN = globalThis.MN;

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] 颜色解析');
{
  check('#rrggbb', eq(MN.parseColor('#3b5bdb'), { r: 59, g: 91, b: 219 }), JSON.stringify(MN.parseColor('#3b5bdb')));
  check('#RGB 简写', eq(MN.parseColor('#fff'), { r: 255, g: 255, b: 255 }));
  check('大写也认', eq(MN.parseColor('#AABBCC'), { r: 170, g: 187, b: 204 }));
  check('rgb()', eq(MN.parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3 }));
  check('rgba() 忽略透明度', eq(MN.parseColor('rgba(10,20,30,0.4)'), { r: 10, g: 20, b: 30 }));
  check('空格分隔', eq(MN.parseColor('10 20 30'), { r: 10, g: 20, b: 30 }));
  check('逗号分隔（不带函数名）', eq(MN.parseColor('10,20,30'), { r: 10, g: 20, b: 30 }));
  check('百分比', eq(MN.parseColor('rgb(100%, 0%, 50%)'), { r: 255, g: 0, b: 128 }), JSON.stringify(MN.parseColor('rgb(100%, 0%, 50%)')));
  check('{r,g,b} 对象', eq(MN.parseColor({ r: 5, g: 6, b: 7 }), { r: 5, g: 6, b: 7 }));
  check('超范围会被夹住', eq(MN.parseColor('rgb(300, -20, 12)'), { r: 255, g: 0, b: 12 }));
  check('内置色 id 不是颜色', MN.parseColor('yellow') === null);
  check('空值', MN.parseColor('') === null && MN.parseColor(null) === null && MN.parseColor(undefined) === null);
  check('乱七八糟的字符串', MN.parseColor('#xyz') === null && MN.parseColor('blue') === null);
}

console.log('\n[2] 归一化与十六进制');
{
  check('toHex 补零', MN.toHex({ r: 10, g: 0, b: 255 }) === '#0a00ff', MN.toHex({ r: 10, g: 0, b: 255 }));
  check('normalizeHex 认 rgb()', MN.normalizeHex('rgb(59,91,219)') === '#3b5bdb');
  check('normalizeHex 认 #fff', MN.normalizeHex('#fff') === '#ffffff');
  check('normalizeHex 认不出来给 null', MN.normalizeHex('yellow') === null && MN.normalizeHex('') === null);
  check('小写输出', MN.normalizeHex('#AABBCC') === '#aabbcc');
}

console.log('\n[3] RGB ↔ HSV 往返');
{
  const samples = ['#ffe066', '#a9f0a0', '#a5d8ff', '#ffc9de', '#d0bfff', '#000000', '#ffffff', '#3b5bdb', '#0a9396'];
  const bad = samples.filter((hex) => MN.toHex(MN.hsvToRgb(MN.rgbToHsv(MN.parseColor(hex)))) !== hex);
  check('往返不掉精度', bad.length === 0, bad.join(','));
  check('红色 h=0', Math.round(MN.rgbToHsv({ r: 255, g: 0, b: 0 }).h) === 0);
  check('绿色 h=120', Math.round(MN.rgbToHsv({ r: 0, g: 255, b: 0 }).h) === 120);
  check('蓝色 h=240', Math.round(MN.rgbToHsv({ r: 0, g: 0, b: 255 }).h) === 240);
  check('黑色 v=0', MN.rgbToHsv({ r: 0, g: 0, b: 0 }).v === 0);
  check('白色 s=0', MN.rgbToHsv({ r: 255, g: 255, b: 255 }).s === 0);
  check('h 超过 360 也能转', MN.toHex(MN.hsvToRgb({ h: 480, s: 1, v: 1 })) === '#00ff00', MN.toHex(MN.hsvToRgb({ h: 480, s: 1, v: 1 })));
}

console.log('\n[4] 明暗推导与前景色');
{
  const dark = MN.darken('#ffe066');
  check('darken 得到合法的十六进制', /^#[0-9a-f]{6}$/.test(dark), dark);
  check('darken 比原色暗', MN.rgbToHsv(MN.parseColor(dark)).v < MN.rgbToHsv(MN.parseColor('#ffe066')).v);
  check('lighten 比原色亮', MN.rgbToHsv(MN.parseColor(MN.lighten('#8a6d00'))).v > MN.rgbToHsv(MN.parseColor('#8a6d00')).v);
  check('浅底上用深字', MN.textOn('#ffe066') === '#1f2937', MN.textOn('#ffe066'));
  check('深底上用白字', MN.textOn('#1b4f8a') === '#ffffff', MN.textOn('#1b4f8a'));
}

console.log('\n[5] 自定义色板');
{
  check('默认没有自定义色', MN.customColors().length === 0);
  check('allColors 默认就是 5 个内置色', MN.allColors().length === 5);

  MN.setCustomColors(['#3b5bdb', '#0a9396']);
  check('加进去两个', MN.customColors().length === 2, JSON.stringify(MN.customColors().map((c) => c.id)));
  check('allColors 变成 7 个', MN.allColors().length === 7);
  const rec = MN.colorOf('#3b5bdb');
  check('colorOf 能拿到自定义色记录', rec && rec.id === '#3b5bdb' && rec.custom === true);
  check('自定义色带配色标签', rec.label === '#3b5bdb' && rec.light === '#3b5bdb');
  check('自定义色有暗色变体', /^#[0-9a-f]{6}$/.test(rec.dark) && rec.dark !== rec.light, rec.dark);

  MN.setCustomColors(['#3b5bdb', '#3b5bdb', '#ABC', 'nope', null, '#0a9396', '#0a9396']);
  check('重复 / 非法值被丢掉', eq(MN.customColors().map((c) => c.id), ['#3b5bdb', '#aabbcc', '#0a9396']),
    JSON.stringify(MN.customColors().map((c) => c.id)));

  MN.setCustomColors(['#3b5bdb']);
  check('同一个颜色再设一次不会消失', MN.customColors().length === 1 && MN.colorOf('#3b5bdb').custom === true);
  check('被移除的颜色不再占位', MN.colorOf('#0a9396').custom === true && MN.colorOf('#0a9396').id === '#0a9396',
    '（colorOf 仍然能按字面量还原，只是不在色板里）');
  check('色板里确实没有它了', MN.customColors().some((c) => c.id === '#0a9396') === false);

  MN.setCustomColors([]);
  check('清空后回到 5 个', MN.allColors().length === 5);

  const added = MN.addCustomColor('rgb(10, 147, 150)');
  check('addCustomColor 返回归一化结果', added === '#0a9396', added);
  check('addCustomColor 只加一次', MN.addCustomColor('#0a9396') === '#0a9396' && MN.customColors().length === 1);
  check('非法颜色加不进去', MN.addCustomColor('nope') === null && MN.customColors().length === 1);
  check('removeCustomColor', MN.removeCustomColor('#0a9396') === '#0a9396' && MN.customColors().length === 0);
  check('移除不存在的也不报错', MN.removeCustomColor('#0a9396') === null);
}

console.log('\n[6] colorOf 的兜底');
{
  check('内置色', MN.colorOf('green').id === 'green' && MN.colorOf('green').light === '#a9f0a0');
  check('内置色不受自定义色影响', MN.colorOf('purple').label === '紫');
  MN.setCustomColors(['#3b5bdb']);
  check('自定义色', MN.colorOf('#3b5bdb').custom === true);
  check('色板里没有的十六进制也能还原', MN.colorOf('#123456').light === '#123456' && MN.colorOf('#123456').custom === true);
  check('大写十六进制', MN.colorOf('#ABCDEF').light === '#abcdef', MN.colorOf('#ABCDEF').light);
  check('认不出来 → 兜底黄色', MN.colorOf('不存在的颜色').id === 'yellow');
  check('undefined → 兜底黄色', MN.colorOf(undefined).id === 'yellow' && MN.colorOf(null).id === 'yellow');
  MN.setCustomColors([]);
}

console.log('\n[7] 设置默认值');
{
  check('DEFAULT_SETTINGS 里有 customColors', eq(MN.DEFAULT_SETTINGS.customColors, []));
  check('默认颜色还是 yellow', MN.DEFAULT_SETTINGS.defaultColor === 'yellow');
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
