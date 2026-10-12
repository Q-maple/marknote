/*
 * MarkNote 后台脚本测试（Node vm + 假的扩展 API）
 *
 * 跑法：node test/background.test.js
 * 验证：右键菜单建得出来、菜单和快捷键映射正确、打开侧边栏的两种路径（有 sidebarAction / 没有）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'background', 'background.js'), 'utf8');
const AI_CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'common', 'ai.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(opts = {}) {
  const created = [];
  const sent = [];
  const tabsCreated = [];
  const windowsCreated = [];
  const sidebarCalls = [];
  const clicks = [];
  const commands = [];
  const messages = [];
  const data = {};

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p,
      onInstalled: { addListener: (f) => (chrome.__installed = f) },
      onStartup: { addListener: (f) => (chrome.__startup = f) },
      onMessage: { addListener: (f) => messages.push(f) }
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: (o, cb) => {
        created.push(o);
        cb && cb();
      },
      onClicked: { addListener: (f) => clicks.push(f) }
    },
    commands: { onCommand: { addListener: (f) => commands.push(f) } },
    tabs: {
      query: (_q, cb) => {
        const list = [{ id: 42, url: 'https://example.com/', width: 1440 }];
        if (cb) return cb(list), undefined;
        return Promise.resolve(list);
      },
      sendMessage: (id, msg, cb) => {
        sent.push({ id, msg });
        if (cb) cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
      create: (o) => {
        tabsCreated.push(o);
        return Promise.resolve({ id: 99 });
      }
    },
    windows: {
      create: (o, cb) => {
        windowsCreated.push(o);
        const win = { id: 555 };
        if (cb) cb(win);
        return Promise.resolve(win);
      },
      update: (_id, _o, cb) => {
        if (cb) cb();
        return Promise.resolve();
      },
      onRemoved: { addListener() {} }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          let out;
          if (keys === null || keys === undefined) out = { ...data };
          else if (typeof keys === 'string') out = { [keys]: data[keys] };
          else if (Array.isArray(keys)) {
            out = {};
            keys.forEach((k) => (out[k] = data[k]));
          } else {
            out = {};
            Object.keys(keys).forEach((k) => (out[k] = k in data ? data[k] : keys[k]));
          }
          cb(out);
        },
        set: (o, cb) => {
          Object.assign(data, o);
          cb && cb();
        },
        remove: (k, cb) => {
          (Array.isArray(k) ? k : [k]).forEach((x) => delete data[x]);
          cb && cb();
        }
      },
      session: {
        get: (k, cb) => cb({ [k]: data[k] }),
        set: (o, cb) => {
          Object.assign(data, o);
          cb && cb();
        },
        remove: (k, cb) => cb && cb()
      }
    }
  };
  if (opts.sidebarAction) {
    chrome.sidebarAction = {
      open: (a, b) => {
        sidebarCalls.push('open');
        const cb = typeof a === 'function' ? a : b;
        if (cb) cb();
        return Promise.resolve();
      },
      isOpen: (a, b) => {
        const cb = typeof a === 'function' ? a : b;
        if (cb) cb(false);
        return Promise.resolve(false);
      }
    };
  }

  const sandbox = {
    console,
    chrome,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Date,
    Math,
    Error,
    RegExp,
    Set,
    Map,
    isFinite,
    AbortController,
    fetch: opts.fetch
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 顺序和 manifest.json 的 background.scripts 一致：先 ai.js 再 background.js
  vm.runInContext(AI_CODE, sandbox);
  vm.runInContext(CODE, sandbox);
  return { created, sent, tabsCreated, windowsCreated, sidebarCalls, clicks, commands, messages, data };
}

/** 按 chrome 的风格问后台一句（后台用 sendResponse 回）。 */
function ask(env, msg) {
  return new Promise((resolve) => {
    const handled = env.messages.some((fn) => fn(msg, {}, resolve) === true);
    if (!handled) resolve({ ok: false, error: '没人处理这条消息' });
  });
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
  console.log('\n[1] 右键菜单');
  {
    const env = boot();
    const ids = env.created.map((m) => m.id);
    check('建了 10 个菜单项', env.created.length === 10, String(env.created.length));
    check('含高亮 / 笔记 / 复制', ['mn-highlight', 'mn-note', 'mn-copy'].every((i) => ids.includes(i)), ids.join(','));
    check('含 AI 分析', ids.includes('mn-ai'), ids.join(','));
    check('含 AI 对话', ids.includes('mn-talk'), ids.join(','));
    check('菜单标题不带「绕过」类措辞', !/绕过|破解/.test(env.created.map((m) => m.title || '').join(' ')), env.created.map((m) => m.title).join(' | '));
    check('含图片标记', ids.includes('mn-image'));
    check('含侧边栏与管理页', ids.includes('mn-sidebar') && ids.includes('mn-dashboard'));
    check('选中类菜单只出现在 selection 上', env.created.find((m) => m.id === 'mn-copy').contexts.join() === 'selection');
    check('图片菜单只出现在 image 上', env.created.find((m) => m.id === 'mn-image').contexts.join() === 'image');

    console.log('\n[2] 菜单点击 → 转给内容脚本');
    const clicked = env.clicks[0];
    await clicked({ menuItemId: 'mn-highlight' }, { id: 42 });
    await clicked({ menuItemId: 'mn-image' }, { id: 42 });
    check('高亮菜单发出正确消息', env.sent.some((s) => s.id === 42 && s.msg.type === 'mn:highlight-selection'), JSON.stringify(env.sent));
    check('图片菜单发出正确消息', env.sent.some((s) => s.msg.type === 'mn:mark-image'));
  }

  console.log('\n[3] 快捷键');
  {
    const env = boot();
    const cmd = env.commands[0];
    await cmd('highlight-selection');
    await cmd('super-copy');
    await cmd('toggle-highlights');
    await cmd('ai-analyze');
    check(
      '快捷键映射到对应动作',
      env.sent.map((s) => s.msg.type).join(',') === 'mn:highlight-selection,mn:super-copy,mn:toggle-highlights,mn:ai-panel',
      env.sent.map((s) => s.msg.type).join(',')
    );
  }

  console.log('\n[4] 打开侧边栏');
  {
    const env = boot();
    const onMsg = env.messages[0];
    const reply = await new Promise((res) => onMsg({ type: 'mn:open-sidebar' }, {}, res));
    await sleep(20);
    check('没有 sidebarAction 时退回弹窗', env.windowsCreated.length === 1, JSON.stringify(env.windowsCreated));
    check('弹窗打开的是 sidecar 页面', /sidebar\.html$/.test(env.windowsCreated[0].url), env.windowsCreated[0].url);
    check('回执 ok', reply && reply.ok === true);

    console.log('\n[5] 有 sidebarAction 时（Firefox）');
    const env2 = boot({ sidebarAction: true });
    const onMsg2 = env2.messages[0];
    await new Promise((res) => onMsg2({ type: 'mn:open-sidebar' }, {}, res));
    await sleep(20);
    check('调用 sidebarAction.open', env2.sidebarCalls.length === 1, JSON.stringify(env2.sidebarCalls));
    check('没有再开弹窗', env2.windowsCreated.length === 0);
  }

  console.log('\n[6] 打开管理页');
  {
    const env = boot();
    const onMsg = env.messages[0];
    await new Promise((res) => onMsg({ type: 'mn:open-dashboard' }, {}, res));
    await sleep(20);
    check('新标签页打开管理页', env.tabsCreated.length === 1 && /dashboard\.html$/.test(env.tabsCreated[0].url), JSON.stringify(env.tabsCreated));
  }

  console.log('\n[7] AI：后台代发请求');
  {
    const calls = [];
    const fakeFetch = (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              model: 'deepseek-chat',
              choices: [
                {
                  message: {
                    content:
                      '{"highlights":[{"quote":"营收同比增长 18%","color":"pink","note":"增速"},{"quote":"毛利率 42%","color":"blue","note":"盈利"}]}'
                  }
                }
              ],
              usage: { total_tokens: 210 }
            })
          )
      });
    };
    const base = {
      settings: {
        ai: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxItems: 5 }
      },
      aiKey: 'sk-secret-abcdef'
    };

    const off = boot({ fetch: fakeFetch });
    Object.assign(off.data, { settings: { ai: { enabled: false } }, aiKey: 'sk-secret-abcdef' });
    const r1 = await ask(off, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
    check('没打开 AI 时直接拒掉', r1.ok === false && r1.code === 'disabled', JSON.stringify(r1));

    const noKey = boot({ fetch: fakeFetch });
    noKey.data.settings = { ai: { enabled: true } };
    const r2 = await ask(noKey, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
    check('没配 Key 时直接拒掉', r2.ok === false && r2.code === 'nokey', JSON.stringify(r2));

    const env = boot({ fetch: fakeFetch });
    Object.assign(env.data, JSON.parse(JSON.stringify(base)));
    const short = await ask(env, { type: 'mn:ai-chat', payload: { text: '太短' } });
    check('文字太少不浪费请求', short.ok === false && short.code === 'empty', JSON.stringify(short));
    check('确实没发出去', calls.length === 0);

    const res = await ask(env, {
      type: 'mn:ai-chat',
      payload: { text: '第二季度营收同比增长 18%，毛利率 42%。', prompt: '挑数字', title: '季报', url: 'https://example.com/q2' }
    });
    check('正常返回解析好的条目', res.ok === true && res.items.length === 2, JSON.stringify(res));
    check('颜色和批注都在', res.items[0].color === 'pink' && res.items[0].note === '增速', JSON.stringify(res.items[0]));
    check('带上了 token 用量', res.usage && res.usage.total_tokens === 210);
    check('真的发出去了一个请求', calls.length === 1);
    check('打的是 DeepSeek 的 chat/completions', calls[0].url === 'https://api.deepseek.com/chat/completions', calls[0].url);
    check('用存的 Key 做 Bearer', calls[0].init.headers.Authorization === 'Bearer sk-secret-abcdef');
    check('把选中文字塞进了请求体', calls[0].body.messages[1].content.includes('毛利率 42%'));
    check('把用户提示词也塞进去了', calls[0].body.messages[1].content.includes('挑数字'));
    check('最多处数来自设置', calls[0].body.messages[0].content.includes('最多 5 处'));
    check('密钥没有落进 settings', !JSON.stringify(env.data.settings).includes('sk-secret'), JSON.stringify(env.data.settings));
    check('密钥单独存在 aiKey', env.data.aiKey === 'sk-secret-abcdef');

    // 模型犯糊涂：返回一堆废话
    const bad = boot({
      fetch: () =>
        Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: '我觉得这篇文章写得很好' } }] })) })
    });
    Object.assign(bad.data, JSON.parse(JSON.stringify(base)));
    const r3 = await ask(bad, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
    check('模型不按格式来时给出可读的提示', r3.ok === true && r3.items.length === 0 && !!r3.warning, JSON.stringify(r3));
    check('把模型原话留一点给用户看', typeof r3.raw === 'string' && r3.raw.includes('写得很好'), JSON.stringify(r3.raw));

    // 接口报错
    const err = boot({
      fetch: () => Promise.resolve({ ok: false, status: 402, text: () => Promise.resolve(JSON.stringify({ error: { message: 'Insufficient Balance' } })) })
    });
    Object.assign(err.data, JSON.parse(JSON.stringify(base)));
    const r4 = await ask(err, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
    check('接口报错原样带回', r4.ok === false && r4.error === 'Insufficient Balance', JSON.stringify(r4));

    console.log('\n[7.5] AI 对话（悬浮窗）：只回文字、不产出划线');
    {
      const calls = [];
      const fake = (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                model: 'deepseek-chat',
                choices: [{ message: { content: '这句话说的是同比增长 18%。' } }],
                usage: { total_tokens: 88 }
              })
            )
        });
      };
      const talk = boot({ fetch: fake });
      Object.assign(talk.data, {
        settings: { ai: { enabled: true, maxChars: 12000, model: 'deepseek-chat', prompt: '别忘了我设的提示词' } },
        aiKey: 'sk-secret-abcdef'
      });

      const r = await ask(talk, {
        type: 'mn:ai-talk',
        payload: {
          quote: '第二季度营收同比增长 18%。',
          title: '季报',
          url: 'https://example.com/q2',
          history: [{ role: 'user', content: '这句什么意思？' }]
        }
      });
      check('对话请求成功', r.ok === true, JSON.stringify(r));
      check('返回的是纯文字回复', r.reply === '这句话说的是同比增长 18%。', JSON.stringify(r.reply));
      check('没有 items 字段（不产出划线结果）', r.items === undefined, JSON.stringify(Object.keys(r)));
      check('带上 token 用量', r.usage && r.usage.total_tokens === 88);
      check('只发了一个请求', calls.length === 1, String(calls.length));
      check('强制关掉 jsonMode（对话要自然语言）', calls[0].body.response_format === undefined, JSON.stringify(calls[0].body.response_format));
      check('messages 是 system + 上下文 + 历史', calls[0].body.messages.length === 3, String(calls[0].body.messages.length));
      check('上下文里带引用文字', calls[0].body.messages[1].content.includes('同比增长 18%'));
      check('system 里禁止输出 JSON', /不要输出 JSON/.test(calls[0].body.messages[0].content));
      check('最后一个问题是 user', calls[0].body.messages[2].role === 'user' && calls[0].body.messages[2].content === '这句什么意思？');

      // 多轮：历史被原样带上去
      const r2 = await ask(talk, {
        type: 'mn:ai-talk',
        payload: {
          quote: '第二季度营收同比增长 18%。',
          history: [
            { role: 'user', content: '这句什么意思？' },
            { role: 'assistant', content: '说的是增长。' },
            { role: 'user', content: '那毛利率呢？' }
          ]
        }
      });
      check('多轮对话成功', r2.ok === true);
      check('第二轮带上了前面的问答', calls[1].body.messages.length === 5, String(calls[1].body.messages.length));
      check('历史里保留了 assistant 的上一轮回答', calls[1].body.messages[3].content === '说的是增长。');

      // 没选模型 → 直接给引导，不发请求
      const noModel = boot({ fetch: fake });
      Object.assign(noModel.data, { settings: { ai: { enabled: true } }, aiKey: 'sk-secret-abcdef' });
      const r6 = await ask(noModel, { type: 'mn:ai-talk', payload: { history: [{ role: 'user', content: '在吗' }] } });
      check('没选模型时不发请求', r6.ok === false && r6.code === 'nomodel', JSON.stringify(r6));
      check('没选模型时给的是「去管理页自动拉取」的引导', /自动拉取/.test(r6.error), r6.error);
      const r7 = await ask(noModel, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
      check('分析也一样拦住', r7.ok === false && r7.code === 'nomodel', JSON.stringify(r7));
      const r8 = await ask(noModel, { type: 'mn:ai-test' });
      check('测试连接也拦住（否则会拿空模型名去撞服务端）', r8.ok === false && r8.code === 'nomodel', JSON.stringify(r8));

      // 没话说
      const empty = await ask(talk, { type: 'mn:ai-talk', payload: { quote: 'x', history: [] } });
      check('没有问题就不发请求', empty.ok === false && empty.code === 'empty', JSON.stringify(empty));
      check('确实没发出去', calls.length === 2, String(calls.length));

      // 各种没配好
      const off = boot({ fetch: fake });
      Object.assign(off.data, { settings: { ai: { enabled: false } }, aiKey: 'sk-x' });
      const r3 = await ask(off, { type: 'mn:ai-talk', payload: { history: [{ role: 'user', content: '在吗' }] } });
      check('没打开 AI 时拒掉', r3.ok === false && r3.code === 'disabled', JSON.stringify(r3));
      const noKey = boot({ fetch: fake });
      noKey.data.settings = { ai: { enabled: true } };
      const r4 = await ask(noKey, { type: 'mn:ai-talk', payload: { history: [{ role: 'user', content: '在吗' }] } });
      check('没配 Key 时拒掉', r4.ok === false && r4.code === 'nokey', JSON.stringify(r4));

      // 模型名不对 → 自动带上可用模型
      const modelErr = boot({
        fetch: (url) =>
          /\/models$/.test(url)
            ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })) })
            : Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve(JSON.stringify({ error: { message: 'The supported API model names are deepseek-flash' } })) })
      });
      Object.assign(modelErr.data, { settings: { ai: { enabled: true, model: 'deepseek-v4' } }, aiKey: 'sk-secret-abcdef' });
      const r5 = await ask(modelErr, { type: 'mn:ai-talk', payload: { history: [{ role: 'user', content: '在吗' }] } });
      check('模型名报错时带回可用模型', r5.ok === false && Array.isArray(r5.models) && r5.models[0] === 'deepseek-flash', JSON.stringify(r5));
    }

    console.log('\n[8] AI：模型名不对时把可用模型带回来');
    {
      const urls = [];
      const fake = (url, init) => {
        urls.push(url);
        if (/\/models$/.test(url)) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }))
          });
        }
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: { message: 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.' }
              })
            )
        });
      };
      const env = boot({ fetch: fake });
      Object.assign(env.data, {
        settings: { ai: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4.1-flash' } },
        aiKey: 'sk-secret-abcdef'
      });
      const r = await ask(env, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
      check('报模型错时自动去拉模型列表', urls.some((u) => /\/models$/.test(u)), urls.join(' | '));
      check('把可用模型写进错误文案', r.ok === false && /deepseek-flash/.test(r.error) && /可用/.test(r.error), JSON.stringify(r.error));
      check('模型列表也结构化带回一份', Array.isArray(r.models) && r.models.length === 2, JSON.stringify(r.models));

      // 不是模型问题就别多发一次请求
      const urls2 = [];
      const env2 = boot({
        fetch: (url) => {
          urls2.push(url);
          return Promise.resolve({ ok: false, status: 402, text: () => Promise.resolve(JSON.stringify({ error: { message: 'Insufficient Balance' } })) });
        }
      });
      Object.assign(env2.data, JSON.parse(JSON.stringify(base)));
      await ask(env2, { type: 'mn:ai-chat', payload: { text: '一段足够长的正文内容，用来触发分析流程。' } });
      check('余额不足时不会白拉一次模型列表', urls2.length === 1, urls2.join(' | '));
    }

    console.log('\n[8b] AI：拉取可用模型接口');
    {
      const env = boot({
        fetch: (url, init) =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
          })
      });
      Object.assign(env.data, JSON.parse(JSON.stringify(base)));
      const r = await ask(env, { type: 'mn:ai-models' });
      check('能拿到模型列表', r.ok === true && r.models[0] === 'deepseek-flash', JSON.stringify(r));
      const noKey = boot({ fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }) });
      const r2 = await ask(noKey, { type: 'mn:ai-models' });
      check('没 Key 时拒绝', r2.ok === false && r2.code === 'nokey', JSON.stringify(r2));
    }

    console.log('\n[9] AI：测试连接');
    const t1 = boot({ fetch: fakeFetch });
    Object.assign(t1.data, JSON.parse(JSON.stringify(base)));
    const ok1 = await ask(t1, { type: 'mn:ai-test' });
    check('通了就回 ok', ok1.ok === true && ok1.model === 'deepseek-chat', JSON.stringify(ok1));
    check('测试请求也走 chat/completions', calls[calls.length - 1].url === 'https://api.deepseek.com/chat/completions');
    check('测试请求只发一句话', calls[calls.length - 1].body.messages.length === 1);
    check(
      '测试连接不带 response_format（省得多一个「提示词里要有 json」的失败理由）',
      !('response_format' in calls[calls.length - 1].body),
      JSON.stringify(calls[calls.length - 1].body)
    );
    check('但正式分析还是要 JSON 输出', calls[0].body.response_format && calls[0].body.response_format.type === 'json_object');
    const t2 = boot({ fetch: fakeFetch });
    const ok2 = await ask(t2, { type: 'mn:ai-test' });
    check('没 Key 时测试失败', ok2.ok === false && ok2.code === 'nokey', JSON.stringify(ok2));
  }

  console.log('\n[10] Chromium 清单派生（tools/make-chrome-manifest.py）');
  {
    let manifest = null;
    try {
      const out = require('child_process').execFileSync(
        'python3',
        [path.join(__dirname, '..', 'tools', 'make-chrome-manifest.py')],
        { encoding: 'utf8' }
      );
      manifest = JSON.parse(out);
    } catch (e) {
      check('能跑 make-chrome-manifest.py', false, (e && e.message) || String(e));
    }
    if (manifest) {
      check(
        'service_worker 取的是最后一个脚本（背景页），不是排在前面的公共库',
        manifest.background.service_worker === 'src/background/background.js',
        JSON.stringify(manifest.background)
      );
      check('不再留着 Firefox 的 scripts 字段', !('scripts' in manifest.background));
      check('删掉了 sidebar_action 与 gecko 段', !('sidebar_action' in manifest) && !('browser_specific_settings' in manifest));
      check('带建议快捷键的命令不超过 4 个', Object.values(manifest.commands).filter((c) => c.suggested_key).length <= 4);
      check('AI 命令留下来了（只是可能没快捷键）', 'ai-analyze' in manifest.commands);
      check(
        '公共脚本仍然在包里（Chromium 靠 importScripts 加载）',
        fs.existsSync(path.join(__dirname, '..', 'src', 'common', 'ai.js'))
      );
    }
  }

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
