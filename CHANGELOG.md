# Changelog

## 0.4.3 (2026-11-25)

### 修复
- **站点把移动 UA 重定向到手机版页面导致目录或搜索为空**：黑岩、若初、塔读、次元姬等站点会把默认移动 UA 重定向到 `m.` / `w.` 手机页，导致按电脑版网页编写的规则匹配为空。现在保持默认移动 UA 不变（避免四月天等排斥桌面 UA 的书源出现 403 退化），仅在目录实际解析为 0 章（避免对正常 `m.*` 书源多发请求）或搜索发生 `www → m/w` 跳转且无结果时，切换桌面 Chrome UA 重新请求；若书源自身声明了 `www.*` 域名而搜索拿到移动子域链接，重试目录时恢复为该书源声明的 `www.*` 主机名（移除盲目改写任意 `m./w. → www.` 的逻辑）。
- **目录页地址解析失败的兜底**：
  - XPath 谓词（如 `//li[span]/a`）结果为空时，改用嵌套谓词（`[.//span]`）重试一次；`text()="..."` 精确匹配为空时，改用 `normalize-space()` 重试一次。
  - `tocUrl` 没有解析出结果、目录又是 0 章时，会到详情页按“章节目录 / 查看目录 / 开始阅读 / 目录”这几个链接文字再找一次目录页。
- **`text.xxx` 选错链接**：匹配顺序改为“完全相等 > 去掉空白后相等 > 开头相同 > 包含”，同一级里取文字最短的，`text.目录` 不会再误选“查看章节目录”。
- **受限请求头被拒发与自定义空值头误删**：发送前去掉传输层受限请求头（`keep-alive`、`connection`、`host`、`content-length`、`transfer-encoding` 等）以及空值的标准浏览器头（如空 `Referer`），同时保留自定义空值头（如七猫接口参与签名的 `AUTHORIZATION: ""`、`qm-params: ""`）并消除大小写重复的请求头。修复了全本小说网拒发及 5 个七猫接口书源签名校验失败的问题。
- **`searchUrl` 脚本中 `java.put` 变量丢失与 `book.totalChapterNum` 缺失**：搜索地址脚本中写入的变量现在会完整传递到书籍元数据、目录与正文（打通七猫、福书网等跨阶段签名传递）；规则引用 `book.totalChapterNum` 时在章节引用中自动携带总章数。
- **Node 22/24（OpenSSL 3）下单 DES 加解密报错**：将 8 字节单 DES 密钥映射为等价的三重 DES（`K1=K2=K3`，`des-ede3-cbc` / `des-ede3-ecb`），无需 `--openssl-legacy-provider` 即可原生运行；同时补齐 Rhino 兼容层的 `DESKeySpec`、`DESedeKeySpec`、`SecretKeyFactory` 及 `new String(bytes, charset)`。
- **CSS 属性值没加引号**：像 `div[style=text-indent: 2em;]` 这种值里有空格或分号的写法，在选择报错或匹配为空时自动补上引号重试。
- **`bookSourceUrl` 不是网址**：有些书源用 `🐧` 或文字标签当标识，现在完整网址照常使用，仅在需要拼接相对路径且基础地址无效时给出明确报错。
- **不支持或需登录的书源在失败时给出准确提示**：章节实际获取失败或正文为空时，若章节标记了 `webView` / `webJs` 则提示“需要 WebView 渲染，插件不支持”（正常通过 HTTP 拿到正文的书源不受影响）；若配置了有效 `loginUrl` / `loginUi`（自动忽略 `"null"` 等占位符）则附加“此书源需要登录”提示。

### 测试
- 扩充 `test/unit-v043.mjs` 至 10 组离线测试（覆盖桌面 UA 按需重试、自定义空头保留、`webView`/`loginUrl` 失败提示、OpenSSL 3 单 DES 与 `DESKeySpec`、`searchUrl` 变量及 `totalChapterNum` 传递）。

## 0.4.2 (2026-11-24)

### 修复
- **含同步网络请求的脚本被 5 秒上限中途掐断**：规则脚本里调用了 `java.ajax`、`java.get(url)`、`java.post`、`java.connect` 时，运行上限从 5 秒放宽到 20 秒；只做计算的脚本仍是 5 秒。修复了群小说网（要先抓首页拿 `_token` 再搜索，抓首页就要 5–6 秒）一直“搜不到”的问题。

### 改进
- **默认单源请求超时从 7 秒改为 15 秒**，-4小说这类慢书源（搜索固定要 6.4–7.4 秒）不再超时。已经保存过 `settings.json` 的，保留原来的设置。
- **测活改用管理页的超时设置**：后台测活和定时测活都使用“单源请求超时”，不再写死 8 秒。单个书源测活要在 24 秒内做完，所以最多用 8 秒。
- **测活并发数可以设置（默认 4）**：「维护与设置」里新增“测活并发数”，测活表单和定时测活都以它为默认值（原来分别写死 8 和 6）。PO18、搜小说等书源在高并发时更容易卡住。

### 测试
- 新增 `test/unit-v042.mjs`（4 组）。

## 0.4.1 (2026-11-24)

> 没有单独发布，改动随 0.4.2 一起发布。

### 修复
- **测活把失败阶段记错了**：正文请求报错（比如 `HTTP 404`）以前被记成“目录失败”，现在按实际阶段记成“正文失败”，两类统计不再混在一起。
- **测活超时后请求还在后台跑**：现在每一步超时都会把底层的 HTTP 请求一起停掉，不再占用并发和带宽。
- **`replaceRegex` 的 `###`（只替换第一处）**：以前会把替换内容错写成 `#`，现在和 Legado 一致；也支持写成 `@js:` / `<js>` 脚本的净化规则。纯文本模式下改为对整章排好版的文字做替换（和 Legado 相同），夹在标签中间的广告文字也能清掉。
- **书源 `header` 写成 `@js:` / `<js>` 脚本时不起作用**：现在会执行脚本，用它返回的 JSON 作为请求头（缓存 10 分钟）。搜索、详情、目录、正文、图片和 `java.ajax` 都会用上。
- **`jsLib` 写成 JSON（远程库）时所有脚本都报错**：现在会忽略这种 `jsLib`，不再拖垮整个书源。
- **编码识别**：支持带引号的 `charset="gbk"` 和 UTF-8 BOM；GB2312 / GBK 网页改按 GB18030 解码，生僻字不再乱码。

### 改进
- **测活更准**：
  - 先测书名和关键词完全一样的结果（搜索结果第一条常是同名的无关书）；第一本很快就失败的话，再试第二本。
  - 第一章字太少（公告、作品相关）时，再试第二章。
  - 测活只取目录前 3 页，分页很多的书不再因为超时被误判。
- **`nextTocUrl` / `nextContentUrl` 可以返回多个网址**（和 Legado 一致），最多同时抓 4 页，顺序不变。分页上限也提高了：目录 20 → 100 页，正文 10 → 30 页。后面某一页失败时，保留已经拿到的部分，不再整本或整章失败。
- **详情页和目录页是同一个网址时复用同一次请求的结果**，少一次请求，也少一次超时的机会。
- **网络错误、超时和 502/504 自动重试**：详情、目录、正文各重试 1 次；支持 Legado 网址选项 `retry`（最多 3 次）。搜索默认不重试，速度不变。
- **脚本运行**：
  - 同一个页面的规则共用一个 JS 运行环境，`jsLib` 只加载一次，目录、列表规则里带脚本的书源明显更快。遇到脚本里套脚本，或者语法报错，会自动退回独立环境运行。
  - 新增 `cache.put/get/delete/putMemory/getFromMemory`、跨阶段保留的 `source.setVariable/getVariable`、`source.put/get`、`book.putVariable/getVariable`、`chapter` / `title`、`java.log` 的返回值、`java.hexEncodeToString`、`java.hexDecodeToByteArray`、`java.base64Decode(str, charset)`。
- **存储**：写文件时每次用不同的临时文件名，同时写同一个文件不会互相覆盖；`book-meta-cache.json`（约 1.3 MB）改成最多 10 秒写一次（原来 3 秒），搜索频繁时少写点盘。

### 测试
- 新增 `test/unit-v041.mjs`（8 组，使用内置的 fetch 桩，不需要联网）。

## 0.4.0 (2026-11-24)

### 新增
- **运行参数可在管理页设置，保存在 `settings.json`**：「维护与设置」页可以调整每批同时查询的书源数、单源搜索超时、连续失败几次触发熔断、首次和最长冷却时间，重启后不会丢。
- **宿主定时自动测活（`extensions.tasks`）**：接入 `reader-pro` 的定时任务协议（`extension.task`）。可以在管理页开启按小时间隔的后台自动测活，并可选择自动禁用失败的书源。
- **模糊换源，并按进度排序（`content.alternatives`）**：匹配时自动去掉版本标签和副标题；作者一致时允许只匹配主书名开头，同时排除续作（如“2”“第二部”“仙界篇”）；结果按匹配程度和最新章节号排序。
- **轻量 Rhino `Packages.javax.crypto` / `JavaImporter` 兼容层**：基于 Node 自带的 `crypto`，支持 `Cipher`（AES / DES / 3DES）、`SecretKeySpec`、`IvParameterSpec`、`MessageDigest`、`Base64`、`Arrays.copyOfRange` 和 `String.prototype.getBytes`。
- **补充规则和脚本能力**：支持 `source.jsLib` 公共脚本库、`+@js:` 前缀、`{{...}}` 里嵌套 `@css:` / `@XPath:` / `@Json:` 规则、`cookie.removeCookie`，以及把中文章节号转成数字的 `java.toNumChapter`。

### 修复
- **`@xmldom/xmldom` 0.9.x 下 XPath 规则全部悄悄返回空**：改用新版的 `onError` 参数；转成 XML 之前先去掉 `<script>`、`<style>`、`DOCTYPE` 和默认命名空间，避免脚本里的 `<`、`&` 打断 XML 解析。
- **`@js:` / `<js>` 里的 `{{...}}` 和 `@get:{...}` 没有先替换，导致语法错误**：修复了七猫、淘小说等书源的脚本签名拼接。
- **`book.kind` / `book.wordCount` 没在搜索、详情、目录之间传下去**：修复了 `QQ浏览器[api]` 等依赖 `{{book.kind}}` 的接口书源。
- **`text.xxx.0` 的序号没拆出来，还会匹配到 `<html>`、`<style>` 这些外层节点**：现在优先匹配元素自己的文字（`ownText`）。
- **HTTP 403 / Cloudflare 拦截被误判成“没搜到”**：搜索遇到 401 / 403 / 429 / 5xx 或 Cloudflare 拦截页时正常报错，并计入熔断；目录和正文遇到 `>= 400` 的响应直接报错。
- **图文模式 `<img src="url,{JSON}">` 的网址被引号截断**：已修复，并支持 `<amp-img>`；规则里直接输出 `<img src=...>` 的文本书源会自动启用图文模式（实测漫客栈等漫画源图片下载正常）。
- **安装包补上文档**：`package.json` 的 `files` 加入 `CHANGELOG.md` 和 `README.md`；修复同步请求工作线程继承命令行 `execArgv` 参数导致的报错。

## 0.3.0 (2026-11-23)

### 新增
- **一键换源（`content.alternatives`）**：在其他已启用的书源里按书名匹配（忽略空格、标点，以及“精校”“全本”等后缀）；有作者信息时同时核对作者，自动排除当前书源。
- **发现页（`browse`）**：第一层列出所有配置了 `exploreUrl` 的书源 → 分类（支持 `标题::网址` 文本、JSON 数组、`@js:` / `<js>` 返回值）→ 书籍列表（优先用 `ruleExplore`，没有就用 `ruleSearch`；支持 `{{page}}` 翻页）。
- **慢源降权与熔断**：记录每个书源的成功、失败次数和平均耗时；搜索时健康、速度快的书源排在前面；连续失败 3 次暂停 10 分钟，之后按指数退避延长，最长 6 小时。一次搜索按固定计划分批进行，排序变化不会导致漏查或重复查询。
- **管理页改为多个标签页**：
  - 书源列表分页（每页 50 条，不再只显示前 100 条），可按关键词和状态筛选（启用 / 禁用 / 测活失败 / 未搜到 / 通过 / 熔断中 / 未测活）。
  - 单个书源操作：启用 / 禁用、立即测活、重置熔断、切换图文模式、删除。
  - 勾选后批量操作：启用、禁用、删除、重置熔断。
  - 后台并发测活（完整走一遍搜索到正文），可以中途停止，可自动禁用失败的书源，也可一键禁用或删除失败的书源。
  - 维护页：查看、清除 Cookie。
- **图文模式（实验）**：正文里的图片以 `reader-res:` 资源的形式交给宿主显示；导入时可以选择同时导入漫画书源。
- **新增 `java.*` 兼容接口**：`aesDecodeToString`、`aesBase64DecodeToString`、`aesEncodeToString`、`aesEncodeToBase64String`、`desDecodeToString`、`desBase64DecodeToString`、`desEncodeToBase64String`、`tripleDESDecodeStr`、`tripleDESEncodeBase64Str`、`digestHex`、`digestBase64Str`、`HMacHex`、`HMacBase64`、`randomUUID`、`base64DecodeToByteArray`、`strToBytes`、`bytesToStr`、`utf8ToGbk`、`htmlFormat`、`getWebViewUA`、`ajaxAll`；以及 `cookie.setCookie` / `cookie.replaceCookie`。

### 改进
- **Cookie 保存到 `cookies.json`**（延迟合并写入，写入时整体替换文件），支持 `Domain`、`Expires`、`Max-Age`（包括用 1970 年表示删除的写法）。
- **脚本里的同步请求（`java.ajax` 等）和主线程共用同一份 Cookie**（以前工作线程里的 Cookie 和主线程互不相通）。
- **`bookMetaCache` 改为保存到磁盘的 LRU 缓存**，重启后，还没加入书架的搜索结果也能直接打开详情。
- **重新导入书源时保留用户设置的启用 / 禁用状态**。
- **书源列表读写加了内存缓存和写锁**，避免同时操作时互相覆盖。
- **目录超过宿主 2 MB 消息上限前自动瘦身**；图片大小限制为转成 base64 后也不超过消息上限。
- **章节 ID 去重**，避免目录里出现重复 ID 被宿主拒收。

### 兼容性
- 原有的纯文本书源行为不变：只有手动切换成图文模式的书源或漫画源，正文才会以 HTML 输出。
- 已经在书架上的书不受模式切换影响（正文类型在章节引用里固定下来了）。
