# Firefox 持久化安装（重启后依然在）

`about:debugging` 的「临时载入」是**调试用**的，关掉浏览器就没了。
想让 MarkNote 像正常扩展一样长期待在 Firefox 里，只有两条路。

## 先选路线

| 路线 | 适用浏览器 | 需要账号 | 重启后还在 | 说明 |
| --- | --- | --- | --- | --- |
| **一、AMO 自助签名** | 正式版 / ESR / Beta / Dev 全部 | 要一个 Firefox 账号（免费） | ✅ | 推荐，一次 5 分钟 |
| **二、关闭签名检查** | **只有** Developer Edition / Nightly | 不要 | ✅ | 正式版里这个开关是无效的，别在正式版上试 |
| 三、继续临时载入 | 全部 | 不要 | ❌ | 每次开浏览器都要重新载入 |

为什么不能直接把 zip 拖进正式版：Firefox 正式版**只安装经过 AMO 签名的扩展**，
未签名的包会报「此附加组件无法安装，因为它未通过验证」。这跟扩展本身有没有 bug 无关。

---

## 路线一：AMO 自助签名（推荐）

> 逐步骤的完整版（含页面会出现的原文、API 密钥、命令行脚本）见
> **[amo-self-signing-steps.md](amo-self-signing-steps.md)**。下面是速览。

整条流程就是：把包传给 AMO 签个名 → 拿回签名好的 `.xpi` → 双击安装。
**免费**，而且不需要把扩展公开上架（选「自己分发 / On your own」即可）。

### 0）先备份你现在的划线（重要）

临时载入和正式安装虽然用的是同一个扩展 ID（`marknote@local.dev`），数据通常会沿用，
但换安装方式属于跨环境操作，**先备份一次最稳妥**：

> 点扩展图标 → **管理 / 导出** → **导出 JSON 备份**，存好这个文件。

真丢了也不怕：装好新版本后在同一页面点「导入 JSON 备份」即可原样恢复（含笔记和标签）。

### 1）提交

1. 用一个 Firefox 账号登录 <https://addons.mozilla.org/zh-CN/developers/>
2. 点 **提交新附加组件 / Submit a New Add-on**
3. 上传文件时选 **`dist/marknote-firefox.zip`**（**不要解压**，AMO 要的就是这个 zip）
4. 分发方式选 **「自己分发 / On your own」**（有的版本写作 *Self-Distribution*、*未列出 / unlisted*）
   —— 不要选「在 AMO 上列出」，那会进入人工审核队列
5. 等自动校验跑完（未列出的包通常几十秒）。校验结果应该是 **0 errors**；
   如果你改了源码再打包装，可以先用项目里的 `tools/build.sh` + `web-ext lint` 自检

### 2）取回签名版

回到 **我的附加组件 / My Add-ons** → 点开 MarkNote → 该版本下面会有
**下载签名版 / Download the signed add-on** 之类的链接，拿到一个 `.xpi` 文件。

（AMO 只会签文件，不会改你的代码。签名信息放在 `META-INF/` 里。）

### 3）安装

- **双击那个 `.xpi`**，或者在 Firefox 里打开它 → 弹窗点「添加」
- 或者：`about:addons` → 右上角齿轮 → **从文件安装附加组件…** → 选 `.xpi`

装完就是持久安装，可以在 `about:addons` 里看到它，重启浏览器也在。

### 4）收尾：把临时载入那条撤掉

同一个扩展 ID 同时存在「临时载入的」和「正式安装的」会互相打架
（表现为版本号对不上、改了代码像没生效）。撤掉临时的：

> `about:debugging#/runtime/this-firefox` → MarkNote 那一项 → **移除 / Remove**

然后刷新任意页面，确认划线还在（不在就导入第 0 步的 JSON 备份）。

### 5）以后升级怎么办

自助签名的包**不会自动更新**，需要重新走一遍：

1. 我把改动打好包（版本号会变，例如 1.3.1 → 1.3.2）
2. 你到 AMO 的 MarkNote 页面 → **上传新版本** → 拿到新的签名 `.xpi`
3. 直接安装上去**覆盖**即可，**数据不会丢**

> 如果你想让它能自动更新，需要在清单里配 `browser_specific_settings.gecko.update_url`
> 指向一个自己维护的 update.json，并自己托管 `.xpi`。日常自用没必要。

---

## 路线二：Developer Edition / Nightly（不想注册账号）

正式版这条路走不通，只有 **Developer Edition** 和 **Nightly** 允许关掉签名检查：

1. 下载安装 [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/)
   或 [Nightly](https://www.mozilla.org/firefox/channel/desktop/)
2. 地址栏输入 `about:config` → 接受风险提示 → 搜 `xpinstall.signatures.required` → 双击改成 **false**
3. 把 `dist/marknote-firefox.zip` **改名成 `marknote.xpi`**（就是个 zip，改后缀即可），拖进浏览器窗口 → 「添加」
4. 重启验证：`about:addons` 里还在就是持久安装了

注意：这只在这个 Developer Edition / Nightly 里生效。同一个 `.xpi` 拿到正式版上，
照样会被拒（「未通过验证」）。

---

## 路线三：不折腾签名（保持临时载入）

自己日常用、能接受每次开浏览器点两下，就继续用临时载入：

> `about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选
> `dist/firefox-unpacked/manifest.json`

## 排查对照表

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 「此附加组件无法安装，因为它未通过验证」 | 装的是未签名的包（zip 或改名的 xpi） | 走路线一，或换 Developer Edition 走路线二 |
| 「此附加组件无法安装，因为它似乎已损坏」 | 临时载入时选成了 zip | 文件选择框里要选**解压目录里的 `manifest.json`** |
| 关掉浏览器再开就没了 | 用的是临时载入 | 走路线一 |
| 改了代码却没生效 | 仍加载着旧的临时版本，或没点「重新载入」 | `about:debugging` 里点重新载入，或换正式安装 |
| `about:addons` 里版本号不是最新的 | 正式版和临时版同时存在 | 移除临时载入那一项 |
| 装好了但划线不见了 | 换安装方式时存储没沿用 | 管理页 → 导入 JSON 备份 |

## 一分钟自检清单

- [ ] `about:addons` 里能看到 MarkNote，且版本号是最新的
- [ ] **完全退出 Firefox 再打开**，它还在
- [ ] `about:debugging#/runtime/this-firefox` 的「临时扩展」列表里**没有** MarkNote
- [ ] 任意网页划一条线 → 刷新 → 划线还在
