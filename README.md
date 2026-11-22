# reader-plugin-legado

适用于 [`hectorqin/reader`](https://github.com/hectorqin/reader)（`reader-pro`）的 **Legado（阅读 3.0）`.json` 书源引擎插件**（Node.js / `apiVersion: 1`）。

## 功能特性

- **原生接入 `reader-pro` 插件协议**：支持流式分批搜索（`search`）、书籍详情（`detail`）、章节目录（`acquire.chapters` / `content.manifest`）、章节正文（`content.resource`）及追更检测（`content.update`）。
- **Legado 规则引擎**：
  - 支持 CSS 选择器（含 `class.` / `id.` / `tag.` / `text.` / `@` 链式语法及索引切片）、JSONPath（`$.` / `@Json:`）、XPath（`//` / `@XPath:`）及正则替换（`##pattern##replacement`）。
  - 支持 `@js:` / `<js>...</js>` 脚本管道、`{{...}}` 模板、`@put` / `@get` 变量传递、`org.jsoup.Jsoup` 垫片及常用 `java.*` API（`ajax`、`get`、`post`、`connect`、`md5Encode`、`base64Encode/Decode`、`createSymmetricCrypto`、`timeFormat` 等）。
  - 支持 GBK/GB2312 自动转码、多行 URL 配置及 Cookie 会话保持。
- **内置管理页面（`Legado 书源管理`）**：支持通过订阅 URL 或粘贴 JSON 批量导入书源，自动过滤带 `💰` 标记的付费源。

## 安装方法

1. 从 Releases 下载 `reader-plugin-legado-0.2.0.tgz`（或自行执行 `npm pack` 打包）。
2. 在 `reader-pro` 管理员后台「插件管理」上传 `.tgz` 安装包并勾选信任安装。
3. 在「书源管理」中新增 `Legado JSON 书源` 实例。
4. 打开插件的 **`Legado 书源管理`** 页面，导入书源 JSON（仓库内附带 84 条实测全链路可用书源 `verified-e2e-sources.json`）。
