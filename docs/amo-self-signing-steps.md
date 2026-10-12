# AMO 自助签名：完整操作步骤

目标：把 `marknote-firefox.zip` 变成**签名过的 `.xpi`**，然后像正常扩展一样装进 Firefox，
**重启后还在**，不用每次去 `about:debugging` 点临时载入。

为什么必须签名：Firefox 正式版只安装带 Mozilla 签名的扩展。未签名的包会报
「此附加组件无法安装，因为它未通过验证」。签名**不改变代码**，只是 Mozilla 用它的密钥
给这个包做了个校验标记（放在包里的 `META-INF/`）。

有两条路，效果完全一样：

| | 路线 A：网页操作 | 路线 B：命令行（推荐后续使用） |
| --- | --- | --- |
| 需要 | 一个 Mozilla 账号 | 账号 + API 密钥 + node |
| 步骤 | 十几次点击 | 一条命令 |
| 适合 | 第一次、想看页面提示 | 以后每次更新 |

两条路都是 **unlisted / 自己分发（On your own）**：免费、不进人工排队、不会出现在 AMO 搜索里。

---

## 路线 A：网页操作（第一次推荐走这条）

### 0）先备份你现在的划线

点扩展图标 → **管理 / 导出** → **导出 JSON 备份**，存好这个文件。
（换安装方式时存储一般会沿用，但备份一次最稳妥；装好后可在同一页「导入 JSON 备份」恢复。）

### 1）确认要上传的文件

> `dist/marknote-firefox.zip`

这就是 AMO 要的东西，**不要解压**。它的根目录里就是 `manifest.json`。
（AMO 接受 `.zip` / `.xpi` / `.crx`，上限 200 MB，我们只有 51 KB。）

### 2）登录开发者中心

打开 <https://addons.mozilla.org/zh-CN/developers/> → 右上角 **登录**（用 Mozilla 账号，没有就注册）。

### 3）开始提交

点 **提交新附加组件**（Submit a New Add-on）。

### 4）★选分发方式：自己分发

页面上会让你二选一：

- **On this site / 在 AMO 上列出** —— ❌ 不要选这个，会进人工审核队列，还可能被要求整改
- **On your own / 自己分发** —— ✅ **选这个**

选完点 **Continue**。

### 5）上传

进入 **Upload Version** 页 → 点 **Select a file** → 选第 1 步的 `dist/marknote-firefox.zip`。

### 6）看自动校验结果

几秒后页面会给出校验结论：

- **0 errors** → 通过，继续。（我们本地已经用 addons-linter 跑过，就是 0 errors / 14 warnings）
- 只有 warnings → 可以继续，但建议看一眼，尤其是安全和隐私类的
- **有 errors** → 页面会说明原因，**没法继续**。改完源码重新跑 `tools/build.sh` 再上传

### 7）选兼容平台

勾上 **Firefox for Desktop**。（Android 可勾可不勾；Firefox for Android 装自签名扩展很麻烦，
不勾更省事。）→ **Continue**

### 8）要不要提交源码？

选 **No**。

（这一项是给「压缩、混淆、或者由别的语言编译出来的代码」用的。我们的代码是能直接读的 JS，
没有打包压缩，不需要交源码。）

→ **Continue**

### 9）等到签名完成

页面会显示 **Version Signature Pending**（签名排队中）→ 点 **Go to My Submissions**。
通常几十秒到几分钟，签好会**给你发邮件**。

> 偶尔会看到 "Pending review"。自签（unlisted）是自动签名的，出现这个提示一般不影响拿签名副本；
> 但如果最终被判定违规，扩展可能被禁用——我们没做任何违规的事，正常不会遇到。

### 10）下载签名副本

邮件里的链接，或者：**我的附加组件 / My Add-ons** → 打开 MarkNote →
最新版本卡片上点 **View All**（查看全部版本）→ 点开你刚上传的那个版本。

在那个版本页上，**右键文件链接 → 「另存为 / Save Link As」**，下载到
`marknote-firefox.xpi`（这才是签名过的包）。

### 11）安装

- **双击**那个 `.xpi`，弹窗里点 **添加**；或者
- `about:addons` → 右上角**齿轮** → **从文件安装附加组件…** → 选那个 `.xpi`

### 12）★把临时载入那条撤掉

`about:debugging#/runtime/this-firefox` → MarkNote 那一项 → **移除 / Remove**。

不撤掉的话，「临时版」和「正式版」两个同 ID 的扩展会互相打架
（典型症状：明明装了新版，行为却跟旧的一样；`about:addons` 里版本号不对）。

### 13）验证

1. `about:addons` 里能看到 MarkNote，版本号是 **1.3.1**
2. **完全退出 Firefox 再打开**，它还在
3. `about:debugging` 的「临时扩展」列表里**没有** MarkNote
4. 任意网页划一条线 → 刷新 → 划线还在

---

## 路线 B：命令行（一条命令，后续更新最省事）

### 1）申请 API 密钥

打开 <https://addons.mozilla.org/zh-CN/developers/addon/api/key/> → **Generate new credentials**，会得到两串东西：

- **JWT issuer key**：形如 `user:12345:67`
- **JWT secret**：一长串十六进制

> 密钥等同于账号权限，**别贴给别人、别提交到 git**。下面都用环境变量传，不落盘。

### 2）跑签名脚本

```bash
cd marknote
WEB_EXT_API_KEY='user:12345:67' \
WEB_EXT_API_SECRET='你的一长串secret' \
./tools/sign-firefox.sh
```

不想把密钥写进命令行（会留在 shell 历史里），就直接跑 `./tools/sign-firefox.sh`，
脚本会交互式问你，**输入不回显**。

脚本按顺序做这些事：

1. 缺 `dist/firefox-unpacked/` 就先自动打包
2. 检查 `web-ext`（没有就用 `npx` 自动拉，需要 node）
3. 本地 addons-linter 校验，**有 error 直接停**，不浪费一次往返
4. 用 `web-ext sign --channel=unlisted` 提交给 AMO 签名
5. 把签名好的 `.xpi` 下载到 `dist/signed/`

> 说明：`--channel=unlisted` 才是「自己分发」。unlisted **不需要** `--amo-metadata`
> 元数据文件（那是首次「listed 上架」才必需的）。

### 3）装

```bash
open dist/signed/*.xpi
```

然后照样做路线 A 的第 12、13 步（撤掉临时载入、重启验证）。

### 4）以后更新

改了代码 → 我把 `manifest.json` 的版本号往上加 → 重新打包 → **再跑一次同一个脚本** →

```bash
WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=... ./tools/sign-firefox.sh
```

拿到新的 `.xpi`，**直接覆盖安装**，数据不会丢（同一个扩展 ID）。

---

## 常见报错对照

| 看到什么 | 真正原因 | 怎么办 |
| --- | --- | --- |
| `Upload failed: 401` / `Unknown JWT iss` | API key 或 secret 抄错了，或者两串弄反了 | 重新复制；issuer 形如 `user:12345:67`，secret 是十六进制 |
| `409 Conflict` / "already exists" | 这个版本号已经签过了 | 改 `manifest.json` 的 `version`（例如 1.3.1 → 1.3.2）重新打包 |
| `Timeout` / `approval-timeout` | 排队久了 | 包一般已经签好了，去 AMO → 该版本 → 右键保存签名副本 |
| 网页上传后提示有 errors | 代码校验没过 | 看具体 error，改完重新打包上传；本地可先 `npx web-ext lint --source-dir dist/firefox-unpacked` |
| **「发现重复的附加组件 ID」** | 这个 ID 在 AMO 上已经存在了 | 见下面《重复 ID 怎么办》一节 |
| 「此附加组件无法安装，因为它未通过验证」 | 你装的是**没签名**的包 | 必须用 AMO 给的签名副本（第 10 步） |
| 「此附加组件无法安装，因为它似乎已损坏」 | **临时载入**时选成了 zip | 文件选择框里要选解压目录里的 `manifest.json` |
| 装好重启就没了 | 你走的是临时载入 | 走本文的签名流程 |
| 装了新版但行为跟旧版一样 | 旧的临时版还在，遮住了正式版 | `about:debugging` 里移除临时版 |
| 装好了但划线不见了 | 换安装方式时存储没沿用 | 管理页 → 导入 JSON 备份 |

## 重复 ID 怎么办

AMO 报「您的附加组件验证失败，有 1 个错误。发现重复的附加组件 ID」时，
**不要**反复重新提交同一个包 —— 每次都只会得到同一个错误。先分清是哪种情况：

**情况一（最常见）：这个包是你自己之前提交过的。**
在 <https://addons.mozilla.org/zh-CN/developers/addons> 里能看到 MarkNote —— 那说明
"新建附加组件"这条路已经走过了，ID 被你自己占了。正确做法是**给它加一个新版本**：

> 我的附加组件 → 点开 MarkNote → **上传新版本 / Upload New Version** → 选同一个 zip

这也意味着你**可能已经有一个签名好的版本了**：翻到该包的版本页，
右键文件链接「另存为」，直接就能装。对照版本号是不是 `1.3.1` 即可。

**情况二：列表里根本没有它（典型：你把它删掉了）。**
AMO 在**提交那一刻**就占住这个 ID，跟有没有公开上架无关；而且
**删除附加组件是不可逆的，ID 不会释放**。Mozilla 官方在论坛里的原话：

> Each ID can only be associated with a single add-on. If you delete an add-on,
> it's can no longer be used. This is irreversible.
> —— [Request to reuse deleted Add-on ID](https://discourse.mozilla.org/t/request-to-reuse-deleted-add-on-id-duplicate-id-issue/147167)

还有一条容易踩的：**没走完的草稿提交同样占着 ID**（"AMO reserves the ID at the moment of
submission, not when it goes public"，见
[My first addon says "Duplicate add-on ID found"](https://discourse.mozilla.org/t/my-first-addon-says-duplicate-add-on-id-found/148807)）。
所以下次再遇到这个报错，先去开发者中心的列表里翻一翻有没有半途的提交，
有就打开它「上传新版本」，别新建。

确认没有的话，只能换 ID：

```bash
./tools/set-id.sh marknote-$(openssl rand -hex 4)@local.dev
```

（后缀保留 `local.dev` 是因为这个域名已经证明能通过 AMO 的格式校验；真正起唯一作用的是
`@` 前面那串随机字符，它保证不会再撞。）

脚本会改掉清单里的 `browser_specific_settings.gecko.id`、校验清单仍然合法、并重新打包。
然后回到第 3 步重新提交。

> ⚠️ ID 一变，Firefox 就认为这是**另一个扩展**，旧版存的划线不会自动跟过来。
> 换之前先在旧版里「管理 / 导出 → 导出 JSON 备份」，装好新版再「导入 JSON 备份」。
>
> 顺便提醒：**同一份 ID 是这台扩展的身份**，定下来之后就不要再改了——它决定了
> 存储归属和后续能不能"上传新版本"覆盖升级。

## 自检清单

- [ ] 上传的是 `dist/marknote-firefox.zip`（不是解压目录，也不是 chrome 那个包）
- [ ] 分发方式选的是 **On your own / 自己分发**
- [ ] 兼容平台勾了 **Firefox for Desktop**
- [ ] 「需要提交源码」选的 **No**
- [ ] 拿到的是**签名副本**（右键另存为下载的 `.xpi`）
- [ ] 装完后 `about:debugging` 里已经没有临时载入的 MarkNote
- [ ] 完全退出 Firefox 再打开，`about:addons` 里版本号是最新的
