# Changelog

## 0.4.2 (2026-11-24)

### 修复
- **含同步网络请求的脚本被 5 秒上限强行中止**：`searchUrl` 等规则里调用 `java.ajax` / `java.get(url)` / `java.post` / `java.connect` 的脚本上限由 5 秒放宽到 20 秒（纯计算脚本仍为 5 秒）。修复群小说网（先取首页 `_token` 再搜索，首页需 5–6 秒）始终“未搜到”的问题。

### 改进
- **默认单源请求超时 7 秒 → 15 秒**：覆盖 -4小说（搜索稳定 6.4–7.4 秒）等慢源；已保存过 `settings.json` 的实例保留原值。
- **测活不再写死超时**：后台测活与定时测活使用管理页的“单源请求超时”；单源测活受 24 秒操作时限约束，最多 8 秒。
- **测活并发可配置（默认 4）**：「维护与设置」新增“测活并发数”，测活表单与定时测活均以此为默认值（原为 8 / 6）；PO18、搜小说等源在高并发下更易卡顿。

### 测试
- 新增 `test/unit-v042.mjs`。

## 0.4.1 (2026-11-24)

### 修复
- **测活阶段归因错误**：正文请求报错（如 `HTTP 404`）此前被记为“目录失败”，现按实际阶段记为“正文失败”，`目录失败 / 正文失败` 统计不再混淆。
- **测活超时后请求仍在后台运行**：各步骤超时现在会中止底层 HTTP 请求，不再占用并发与带宽。
- **`replaceRegex` 的 `###`（仅替换首个）语法**：此前会把替换内容误写成 `#`；现与 Legado 一致，并支持 `@js:` / `<js>` 形式的净化规则。纯文本模式下改为对整章格式化后的文本执行（与 Legado 相同），跨标签的广告文字也能清除。
- **书源 `header` 为 `@js:` / `<js>` 脚本时不生效**：现执行脚本得到请求头 JSON（缓存 10 分钟），搜索、详情、目录、正文、图片与 `java.ajax` 均生效。
- **`jsLib` 为 JSON（远程库映射）时所有脚本报错**：现忽略此类 `jsLib`，不再拖垮整个书源。
- **编码识别**：支持 `charset="gbk"` 带引号写法与 UTF-8 BOM；GB2312 / GBK 页面按 GB18030 解码，生僻字不再乱码。

### 改进
- **测活更准**：优先检测书名与关键词完全一致的结果（第一条常是同名无关书），首本失败且耗时较短时再试第二本；第一章过短（公告 / 作品相关）时再试第二章；测活只取目录前 3 页，长分页目录不再因超时误判。
- **`nextTocUrl` / `nextContentUrl` 支持返回多个 URL**（与 Legado 一致，最多 4 页并发抓取、保持顺序）；目录分页上限 20 → 100 页，正文分页上限 10 → 30 页；后续分页失败时保留已获取部分，不再整本 / 整章失败。
- **详情页与目录页同一 URL 时复用响应**，少一次请求、少一次超时机会。
- **网络错误、超时与 502/504 自动重试**：详情、目录、正文各重试 1 次；支持 Legado URL 选项 `retry`（上限 3）。搜索默认不重试，保持速度。
- **脚本运行时**：同一页面的规则共用一个 JS 上下文，`jsLib` 只编译一次（目录 / 列表规则含脚本时明显更快；嵌套调用与语法异常自动回退到独立上下文）；新增 `cache.put/get/delete/putMemory/getFromMemory`、跨阶段持久的 `source.setVariable/getVariable`、`source.put/get`、`book.putVariable/getVariable`、`chapter` / `title`、`java.log` 返回值、`java.hexEncodeToString`、`java.hexDecodeToByteArray`、`java.base64Decode(str, charset)`。
- **存储**：原子写入改用唯一临时文件名，避免并发写同一文件互相覆盖；`book-meta-cache.json`（约 1.3MB）写盘防抖 3s → 10s，减少搜索高峰时的磁盘写入。

### 测试
- 新增 `test/unit-v041.mjs`（8 组，使用内置 fetch 桩，无需联网）。

## 0.4.0 (2026-11-24)

### 新增
- **管理页运行参数配置（`settings.json` 持久化）**：「维护与设置」页可配置每批并发查源数、单源搜索超时、连续失败触发熔断次数、首次/最长冷却时间，重启不丢失。
- **宿主定时自动测活（`extensions.tasks`）**：接入 `reader-pro` 的定时任务协议（`extension.task`），可在管理页开启按小时间隔后台自动测活及可选自动禁用失败书源。
- **模糊换源与进度排序（`content.alternatives`）**：支持自动剔除版本标签与副标题匹配，作者匹配时允许主书名前缀匹配并自动拦截续作后缀（如“2/第二部/仙界篇”等），按匹配度与最新章节号优先排序。
- **轻量 Rhino `Packages.javax.crypto` / `JavaImporter` 兼容垫片**：基于 Node 原生 `crypto` 兼容 `Cipher`（AES/DES/3DES）、`SecretKeySpec`、`IvParameterSpec`、`MessageDigest`、`Base64`、`Arrays.copyOfRange` 与 `String.prototype.getBytes`。
- **补充规则与脚本能力**：支持 `source.jsLib` 公共脚本库、`+@js:` 全量模式前缀、`{{...}}` 内嵌 `@css:` / `@XPath:` / `@Json:` 规则、`cookie.removeCookie` 及 `java.toNumChapter` 中文章节号转数字。

### 修复
- **修复 `@xmldom/xmldom` 0.9.x 下 XPath 规则全部静默返回空的问题**：改用新版 `onError` 构造参数，并在序列化 XML 前移除 `<script>` / `<style>` / `DOCTYPE` / 默认命名空间，避免脚本内 `<` / `&` 中断 XML 解析。
- **修复 `@js:` / `<js>` 内嵌 `{{...}}` 与 `@get:{...}` 模板未预插值导致语法错误的问题**（修复七猫、淘小说等脚本签名拼接）。
- **修复 `book.kind` / `book.wordCount` 未在搜索、详情、目录间传递的问题**（修复 `QQ浏览器[api]` 等依赖 `{{book.kind}}` 的接口书源）。
- **修复 `text.xxx.0` 索引未拆解与匹配到 `<html>`/`<style>` 外层节点的问题**（优先匹配自身文本节点 `ownText`）。
- **修复 HTTP 403 / Cloudflare 拦截被误判为“未搜到”（正常源）的问题**：搜索遇到 401/403/429/5xx 或 Cloudflare 拦截页均正常报错并纳入熔断统计；目录与正文对 `>= 400` 响应报错。
- **修复图文模式 `<img src="url,{JSON}">` 属性引号截断问题**，支持 `<amp-img>`，并对规则显式输出 `<img src=...>` 的伪装文本源自动启用图文模式（实测漫客栈等漫画源图片拉取正常）。
- **安装包补齐文档**：`package.json` 的 `files` 加入 `CHANGELOG.md` 与 `README.md`；修复 `sync-fetch` 工作线程继承 CLI `execArgv` 报错。

## 0.3.0 (2026-11-23)

### 新增
- `content.alternatives`：阅读界面一键换源。在其他已启用书源中按书名（忽略空格、标点、“精校/全本”等后缀）匹配，有作者信息时同时校验作者，自动排除当前书源。
- `browse`：发现页。根目录列出所有配置了 `exploreUrl` 的书源 → 分类（支持 `标题::URL` 文本、JSON 数组、`@js:` / `<js>` 返回值）→ 书籍列表（优先 `ruleExplore`，否则回退 `ruleSearch`，支持 `{{page}}` 翻页）。
- 慢源降权与熔断：记录每个书源的成功/失败次数与平均耗时；搜索时健康、快速的源优先；连续失败 3 次暂停 10 分钟，之后指数退避，最长 6 小时。搜索游标固定在一次搜索计划上，排序变化不会导致漏源或重复。
- 管理页重做为多标签页：
  - 书源列表分页（每页 50 条，不再限制前 100 条）、关键词和状态筛选（启用/禁用/测活失败/未搜到/通过/熔断中/未测活）。
  - 单条书源操作：启用/禁用、立即测活、重置熔断、切换图文模式、删除。
  - 勾选批量操作：启用、禁用、删除、重置熔断。
  - 后台并发测活（全链路），支持停止、自动禁用失败源、一键禁用/删除失败源。
  - 维护页：查看/清除 Cookie。
- 图文模式（实验）：正文中的图片以 `reader-res:` 资源形式交给宿主嵌入；导入时可选择导入漫画书源。
- `java.*` 垫片新增：`aesDecodeToString`、`aesBase64DecodeToString`、`aesEncodeToString`、`aesEncodeToBase64String`、`desDecodeToString`、`desBase64DecodeToString`、`desEncodeToBase64String`、`tripleDESDecodeStr`、`tripleDESEncodeBase64Str`、`digestHex`、`digestBase64Str`、`HMacHex`、`HMacBase64`、`randomUUID`、`base64DecodeToByteArray`、`strToBytes`、`bytesToStr`、`utf8ToGbk`、`htmlFormat`、`getWebViewUA`、`ajaxAll`；`cookie.setCookie` / `cookie.replaceCookie`。

### 改进
- Cookie Jar 持久化到 `cookies.json`（防抖写入、原子替换），支持 `Domain`、`Expires`、`Max-Age`（含 1970 删除标记）。
- 脚本内同步请求（`java.ajax` 等）与主线程共享同一个 Cookie Jar（此前工作线程里的 Cookie 互不相通）。
- `bookMetaCache` 改为持久化 LRU，重启后未加书架的搜索结果仍可直接打开详情。
- 重新导入书源时保留用户的启用/禁用状态。
- 书源列表读写增加内存缓存与写锁，避免并发操作互相覆盖。
- 目录超过宿主 2MB 消息上限前自动瘦身；图片大小限制在 base64 后不超过消息上限。
- 章节 ID 去重，避免目录中出现重复 ID 导致宿主拒收。

### 兼容性
- 旧版纯文本书源行为不变：只有手动切换为图文模式或漫画源才会以 HTML 输出正文。
- 已在书架上的书籍不受模式切换影响（正文类型固定在章节引用里）。
