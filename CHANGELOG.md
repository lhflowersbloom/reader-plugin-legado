# Changelog

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
