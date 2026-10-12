/*
 * MarkNote AI 模块测试（纯 Node，不需要 jsdom）
 *
 * 跑法：node test/ai.test.js
 * 覆盖：配置归一化、接口地址拼接、密钥打码、提示词拼装、
 *       模型返回的各种脏格式解析（代码块 / 前后有解释 / 别名 / 重复 / 坏颜色）、
 *       发请求时的请求体与错误路径（401、超时、没有 key）。
 */
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'src/common/ai.js'), 'utf8');
(0, eval)(code);
const ai = globalThis.MN.ai;

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

console.log('\n[1] 配置归一化');
{
  const d = ai.normalizeConfig(null);
  check('默认关着', d.enabled === false);
  check('默认走 DeepSeek 官方地址', d.baseUrl === 'https://api.deepseek.com', d.baseUrl);
  check('默认不写死模型（留空 = 还没选，等保存 Key 时自动拉取）', d.model === '', JSON.stringify(d.model));
  check('填了就原样保留', ai.normalizeConfig({ model: 'hunyuan-turbos-latest' }).model === 'hunyuan-turbos-latest');
  check('只填空格等于没填', ai.normalizeConfig({ model: '   ' }).model === '', JSON.stringify(ai.normalizeConfig({ model: '   ' }).model));
  check('有「没选模型」的引导文案', typeof ai.NO_MODEL_HINT === 'string' && /自动拉取/.test(ai.NO_MODEL_HINT));
  check('末尾斜杠会被去掉', ai.normalizeConfig({ baseUrl: 'https://api.deepseek.com/v1/' }).baseUrl === 'https://api.deepseek.com/v1');
  check('中间的空格也去掉', ai.normalizeConfig({ baseUrl: ' https://api.deepseek.com ' }).baseUrl === 'https://api.deepseek.com');
  check('不是 http(s) 就退回默认', ai.normalizeConfig({ baseUrl: 'javascript:alert(1)' }).baseUrl === 'https://api.deepseek.com');
  check('空 baseUrl 退回默认', ai.normalizeConfig({ baseUrl: '' }).baseUrl === 'https://api.deepseek.com');
  check('最多处数夹在 1~30', ai.normalizeConfig({ maxItems: 999 }).maxItems === 30 && ai.normalizeConfig({ maxItems: 0 }).maxItems === 1);
  check('坏数字退回默认', ai.normalizeConfig({ maxItems: 'abc' }).maxItems === 10);
  check('temperature 夹在 0~1.5', ai.normalizeConfig({ temperature: 9 }).temperature === 1.5);
  check('默认带 jsonMode', ai.normalizeConfig({}).jsonMode === true);
  check('jsonMode 可以关掉', ai.normalizeConfig({ jsonMode: false }).jsonMode === false);
  check('prompt 去首尾空白', ai.normalizeConfig({ prompt: '  只要结论  ' }).prompt === '只要结论');
  check('未知的 defaultScope 归为 selection', ai.normalizeConfig({ defaultScope: 'hack' }).defaultScope === 'selection');
  check('没有密钥字段', !('apiKey' in d) && !('key' in d));
}

console.log('\n[2] 接口地址拼接');
{
  check('默认 → /chat/completions', ai.endpoint('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions');
  check('带 /v1 也认', ai.endpoint('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
  check('已经写全路径就不动', ai.endpoint('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1/chat/completions');
  check('末尾斜杠不重复', ai.endpoint('http://localhost:11434/v1/') === 'http://localhost:11434/v1/chat/completions');
  check('模型列表地址', ai.modelsEndpoint('https://api.deepseek.com') === 'https://api.deepseek.com/models');
  check('模型列表也不重复 /v1', ai.modelsEndpoint('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1/models');
  check('填了全路径时退回上一级', ai.modelsEndpoint('https://api.deepseek.com/chat/completions') === 'https://api.deepseek.com/models');
  check('已经是 /models 就不动', ai.modelsEndpoint('https://x.test/models') === 'https://x.test/models');
}

console.log('\n[2b] 认模型名 & 解析 /models 返回');
{
  check('官方形状', eq(ai.parseModels({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), ['deepseek-chat', 'deepseek-reasoner']));
  check('裸数组', eq(ai.parseModels(['a', 'b']), ['a', 'b']));
  check('对象数组用 model 字段', eq(ai.parseModels({ data: [{ model: 'x' }] }), ['x']));
  check('用 name 字段', eq(ai.parseModels({ models: [{ name: 'y' }] }), ['y']));
  check('去重且保序', eq(ai.parseModels(['b', 'a', 'b']), ['b', 'a']));
  check('不认识的结构给空数组', eq(ai.parseModels({ foo: 1 }), []));
  check('空值不崩', eq(ai.parseModels(null), []));

  check('认「supported API model names are」', ai.looksLikeModelError('The supported API model names are deepseek-flash, deepseek-v4-pro'));
  check('认 unknown model', ai.looksLikeModelError('Error: unknown model gpt-9'));
  check('认中文「模型不存在」', ai.looksLikeModelError('模型不存在'));
  check('不误判普通的 401', !ai.looksLikeModelError('Authentication Fails, Your api key is invalid'));
  check('不误判余额不足', !ai.looksLikeModelError('Insufficient Balance'));
  check(
    '模型名提示文案带上了「去哪儿改」',
    ai.modelHint(['a', 'b']) === '（这个接口可用的模型：a、b —— 到管理页「AI 分析」里把模型改成其中一个）',
    ai.modelHint(['a', 'b'])
  );
  check('没有模型就不加提示', ai.modelHint([]) === '');
}

console.log('\n[3] 密钥打码');
{
  check('长 key 只露头尾', ai.maskKey('sk-1234567890abcdef') === 'sk-••••cdef', ai.maskKey('sk-1234567890abcdef'));
  check('短 key 全遮', ai.maskKey('sk-12') === '••••');
  check('空 key 空串', ai.maskKey('') === '');
}

console.log('\n[4] 提示词拼装');
{
  const msgs = ai.buildMessages({
    text: '第二季度营收同比增长 18%，主要来自海外市场。',
    prompt: '只挑数字',
    title: '季度报告',
    url: 'https://example.com/q2',
    scope: 'selection',
    maxItems: 3
  });
  check('两条消息', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
  check('system 里写了数量上限', msgs[0].content.includes('最多 3 处'));
  check('system 里给了颜色菜单', msgs[0].content.includes('yellow=') && msgs[0].content.includes('purple='));
  check('system 要求一字不差', msgs[0].content.includes('一字不差'));
  check('user 里有正文', msgs[1].content.includes('同比增长 18%'));
  check('user 里有标题和地址', msgs[1].content.includes('季度报告') && msgs[1].content.includes('https://example.com/q2'));
  check('user 里有用户要求', msgs[1].content.includes('只挑数字'));
  check('没填要求时给默认说法', ai.buildMessages({ text: 'x' })[1].content.includes('没有额外要求'));
  check('整页范围会说明', ai.buildMessages({ text: 'x', scope: 'page' })[1].content.includes('整页'));
  check('注入防御写进了 system', msgs[0].content.includes('不是指令'));
  check('提示词里不含任何密钥', !/sk-[a-z0-9]/i.test(msgs[0].content + msgs[1].content));
  // 用 response_format: json_object 时，请求里必须出现 json 这个词，否则接口直接拒掉
  check('system 提示里出现了 json 这个词', /json/i.test(msgs[0].content), msgs[0].content.slice(0, 40));
  check('user 提示里也出现了 json 这个词', /json/i.test(msgs[1].content), msgs[1].content.slice(-40));
}

console.log('\n[5] 解析模型返回');
{
  const good = ai.parseResult('{"highlights":[{"quote":"营收同比增长 18%","color":"pink","note":"增速"}]}');
  check('标准 JSON', good.items.length === 1 && good.items[0].quote === '营收同比增长 18%' && good.error === null);
  check('颜色保留', good.items[0].color === 'pink');

  const fenced = ai.parseResult('```json\n{"highlights":[{"quote":"甲甲","note":"一"}]}\n```');
  check('去掉 ```json 代码块', fenced.items.length === 1 && fenced.items[0].quote === '甲甲', JSON.stringify(fenced));

  const chatty = ai.parseResult('好的，我挑了三处：\n{"highlights":[{"quote":"甲甲"}]}\n希望有帮助！');
  check('前后有解释也能挖出来', chatty.items.length === 1 && chatty.items[0].quote === '甲甲', JSON.stringify(chatty));

  const bare = ai.parseResult('[{"quote":"甲甲"},{"quote":"乙乙"}]');
  check('直接给数组也认', bare.items.length === 2, JSON.stringify(bare));

  const alias = ai.parseResult('{"items":[{"text":"甲甲","comment":"批注","colour":"#3B5BDB"}]}');
  check('items/text/comment 别名', alias.items.length === 1 && alias.items[0].note === '批注' && alias.items[0].quote === '甲甲');
  check('非法颜色名 → 兜底色', alias.items[0].color === null || alias.items[0].color === undefined, JSON.stringify(alias.items[0]));

  const single = ai.parseResult('{"quote":"只有一条","color":"green"}');
  check('单个对象也认', single.items.length === 1 && single.items[0].color === 'green');

  const hex = ai.parseResult('{"highlights":[{"quote":"甲甲","color":"#3B5BDB"},{"quote":"乙乙","color":"aabbcc"}]}');
  check('大写 hex 归一化', hex.items[0].color === '#3b5bdb', hex.items[0].color);
  check('缺 # 的 hex 补上', hex.items[1].color === '#aabbcc', hex.items[1].color);

  const fallback = ai.parseResult('{"highlights":[{"quote":"甲甲","color":"chartreuse"}]}', { fallbackColor: 'blue' });
  check('认不出的颜色用兜底色', fallback.items[0].color === 'blue', fallback.items[0].color);

  const dup = ai.parseResult('{"highlights":[{"quote":"同一句话"},{"quote":" 同一句话 "},{"quote":"同一 句话"}]}');
  check('按内容去重（空白不敏感）', dup.items.length === 2, JSON.stringify(dup.items.map((i) => i.quote)));

  const junk = ai.parseResult('{"highlights":[{"quote":""},{"quote":"a"},{"note":"没有 quote"},null,"正常的一句话"]}');
  check('丢掉空/太短的片段，字符串也收', junk.items.length === 1 && junk.items[0].quote === '正常的一句话', JSON.stringify(junk.items));

  const cap = ai.parseResult({ highlights: Array.from({ length: 20 }, (_, i) => ({ quote: '第 ' + i + ' 句话' })) }, { maxItems: 3 });
  check('超过上限会截断', cap.items.length === 3, String(cap.items.length));

  const long = ai.parseResult('{"highlights":[{"quote":"' + 'x'.repeat(500) + '"}]}');
  check('超长片段直接丢掉', long.items.length === 0 && !!long.error);

  check('空内容报错', ai.parseResult('').error === '模型返回了空内容');
  check('纯文字报错', !!ai.parseResult('我不知道该怎么回答').error);
  check('坏 JSON 报错', !!ai.parseResult('{"highlights":[').error);
  check('没有 highlights 字段报错', !!ai.parseResult('{"foo":1}').error);
  check('报错时 items 是空数组', eq(ai.parseResult('nope').items, []));

  const noteCap = ai.parseResult({ highlights: [{ quote: '甲甲', note: 'x'.repeat(900) }] });
  check('批注过长会截断', noteCap.items[0].note.length === 500, String(noteCap.items[0].note.length));
}

console.log('\n[6] 发请求');
(async function () {
  const seen = [];
  const fakeFetch = (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        model: 'deepseek-chat',
        choices: [{ message: { content: '{"highlights":[]}' } }],
        usage: { total_tokens: 123 }
      }))
    });
  };
  const ok = await ai.chat({
    apiKey: 'sk-test-123456',
    config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', jsonMode: true },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: fakeFetch
  });
  check('成功时返回内容', ok.ok && ok.content === '{"highlights":[]}', JSON.stringify(ok));
  check('带上 token 用量', ok.usage.total_tokens === 123);
  check('地址拼对了', seen[0].url === 'https://api.deepseek.com/chat/completions', seen[0].url);
  check('带 Authorization 头', seen[0].init.headers.Authorization === 'Bearer sk-test-123456');
  check('POST + JSON', seen[0].init.method === 'POST' && seen[0].init.headers['Content-Type'] === 'application/json');
  check('要求 JSON 输出', eq(seen[0].body.response_format, { type: 'json_object' }));
  check('不是流式', seen[0].body.stream === false);
  check('模型名带上了', seen[0].body.model === 'deepseek-chat');

  const off = await ai.chat({
    apiKey: 'sk-test-123456',
    config: { jsonMode: false },
    messages: [],
    fetchImpl: fakeFetch
  });
  check('关掉 jsonMode 就不发 response_format', off.ok && !('response_format' in seen[1].body), JSON.stringify(seen[1].body));

  const unauthorized = await ai.chat({
    apiKey: 'sk-bad',
    config: {},
    messages: [],
    fetchImpl: () => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }))
    })
  });
  check('401 时把服务端的原话带回来', !unauthorized.ok && /invalid/i.test(unauthorized.error), JSON.stringify(unauthorized));
  check('401 带上状态码', unauthorized.status === 401);

  const plainError = await ai.chat({
    apiKey: 'sk-bad',
    config: {},
    messages: [],
    fetchImpl: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('gateway boom') })
  });
  check('非 JSON 错误响应也能读', !plainError.ok && plainError.error === 'gateway boom', JSON.stringify(plainError));

  const noKey = await ai.chat({ apiKey: '', config: {}, messages: [], fetchImpl: fakeFetch });
  check('没 key 直接失败，不发请求', !noKey.ok && noKey.error.includes('API Key'), JSON.stringify(noKey));

  const boom = await ai.chat({
    apiKey: 'sk-test',
    config: {},
    messages: [],
    fetchImpl: () => Promise.reject(new Error('NetworkError when attempting to fetch resource.'))
  });
  check('网络异常转成错误文案', !boom.ok && boom.error.includes('NetworkError'), JSON.stringify(boom));

  const aborted = await ai.chat({
    apiKey: 'sk-test',
    config: {},
    messages: [],
    fetchImpl: () => {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      return Promise.reject(e);
    }
  });
  check('中断说成超时', !aborted.ok && aborted.error.includes('超时'), JSON.stringify(aborted));

  const empty = await ai.chat({
    apiKey: 'sk-test',
    config: {},
    messages: [],
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"choices":[]}') })
  });
  check('模型没给内容时报错', !empty.ok && empty.error.includes('没有返回内容'), JSON.stringify(empty));

  console.log('\n[7] 拉取可用模型');
  const listCalls = [];
  const fakeList = (url, init) => {
    listCalls.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }))
    });
  };
  const listed = await ai.listModels({ apiKey: 'sk-x', config: { baseUrl: 'https://api.deepseek.com' }, fetchImpl: fakeList });
  check('拿到模型列表', listed.ok && eq(listed.models, ['deepseek-flash', 'deepseek-v4-pro']), JSON.stringify(listed));
  check('打的是 /models', listCalls[0].url === 'https://api.deepseek.com/models', listCalls[0].url);
  check('用 GET', listCalls[0].init.method === 'GET');
  check('带 Bearer', listCalls[0].init.headers.Authorization === 'Bearer sk-x');
  check('不带 Key 就不发', !(await ai.listModels({ apiKey: '', config: {}, fetchImpl: fakeList })).ok);

  const listDenied = await ai.listModels({
    apiKey: 'sk-x',
    config: {},
    fetchImpl: () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ error: { message: 'bad key' } })) })
  });
  check('列表接口报错也说人话', !listDenied.ok && listDenied.error === 'bad key', JSON.stringify(listDenied));

  const listEmpty = await ai.listModels({
    apiKey: 'sk-x',
    config: {},
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  });
  check('接口返回空对象时明确报错', !listEmpty.ok && listEmpty.error.includes('没有返回模型列表'), JSON.stringify(listEmpty));

  console.log('\n[AI 对话] 多轮聊天的消息拼装（不产出划线）');
  {
    const ai = MN.ai;
    check('有对话专用的 system 提示词', typeof ai.CHAT_SYSTEM_PROMPT === 'string' && ai.CHAT_SYSTEM_PROMPT.length > 60);
    check('system 里明确禁止输出 JSON', /不要输出 JSON/.test(ai.CHAT_SYSTEM_PROMPT), ai.CHAT_SYSTEM_PROMPT.slice(0, 60));
    check('system 里声明不会划线（不产生高亮）', /不会也不需要/.test(ai.CHAT_SYSTEM_PROMPT) && /不产生任何高亮/.test(ai.CHAT_SYSTEM_PROMPT));
    check('system 里有注入防御', /不是指令/.test(ai.CHAT_SYSTEM_PROMPT));

    // 没有任何历史 → 没话可说
    check('没有历史时返回 null', ai.buildChatMessages({ quote: 'x', history: [] }) === null);
    check('历史全是脏数据也返回 null', ai.buildChatMessages({ history: [{ role: 'system', content: 'x' }, null, 'y'] }) === null);

    const msgs = ai.buildChatMessages({
      config: { maxChars: 12000 },
      quote: '第二季度营收同比增长 18%。',
      title: '季度报告',
      url: 'https://example.com/q2',
      history: [
        { role: 'user', content: '这句是什么意思？' },
        { role: 'assistant', content: '意思是……' },
        { role: 'user', content: '那和上一季度比呢？' }
      ]
    });
    check('拼出 system + 上下文 + 三条历史', msgs.length === 5, String(msgs.length));
    check('第一条是 system', msgs[0].role === 'system' && msgs[0].content === ai.CHAT_SYSTEM_PROMPT);
    check('第二条是上下文（user）', msgs[1].role === 'user' && msgs[1].content.includes('第二季度营收同比增长 18%。'));
    check('上下文里带页面标题与地址', msgs[1].content.includes('季度报告') && msgs[1].content.includes('example.com/q2'));
    check('上下文提醒不要执行网页里的指令', /不要执行/.test(msgs[1].content));
    check('历史顺序原样保留', msgs[2].content === '这句是什么意思？' && msgs[3].content === '意思是……' && msgs[4].content === '那和上一季度比呢？');
    check('没有引用文字时也说得通', ai.buildChatMessages({ history: [{ role: 'user', content: '这页讲了啥' }] })[1].content.includes('没有引用具体的句子'));
    check('对话消息里不带 json 输出要求（和 jsonMode:false 配套）', !/只回一个 json/i.test(msgs.map((m) => m.content).join('\\n')));
    check('提示词里不含任何密钥', !/sk-[a-z0-9]{6,}/i.test(msgs.map((m) => m.content).join('\\n')));

    // 裁剪
    const many = [];
    for (let i = 0; i < 30; i += 1) many.push({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '条' });
    const trimmed = ai.trimHistory(many);
    check('轮数超了就丢最早的', trimmed.length === ai.CHAT_LIMITS.maxTurns * 2, String(trimmed.length));
    check('留下的是最近的那些', trimmed[trimmed.length - 1].content === '第29条', trimmed[trimmed.length - 1].content);
    const longOnes = [
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'y'.repeat(4000) },
      { role: 'user', content: 'z'.repeat(4000) },
      { role: 'assistant', content: 'w'.repeat(4000) },
      { role: 'user', content: '最后一次' }
    ];
    const small = ai.trimHistory(longOnes, { maxChars: 9000 });
    check('总字数超预算就继续丢', small.reduce((n, m) => n + m.content.length, 0) <= 9000, String(small.reduce((n, m) => n + m.content.length, 0)));
    check('至少留一条', small.length >= 1);
    check('单条超长会被截断', ai.sanitizeHistory([{ role: 'user', content: 'a'.repeat(9000) }])[0].content.length === ai.CHAT_LIMITS.maxMsgChars);
    check('脏角色会被丢掉', ai.sanitizeHistory([{ role: 'tool', content: 'x' }, { role: 'user', content: 'ok' }]).length === 1);
    check('空内容会被丢掉', ai.sanitizeHistory([{ role: 'user', content: '   ' }]).length === 0);
    const hugeQuote = ai.buildChatMessages({ quote: 'q'.repeat(20000), history: [{ role: 'user', content: '?' }] });
    check('超长引用会被截断', hugeQuote[1].content.length < 7000, String(hugeQuote[1].content.length));
  }

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
