# reader-plugin-legado

适用于 [`hectorqin/reader`](https://github.com/hectorqin/reader)（`reader-pro`）的 **Legado（阅读 3.0）`.json` 书源引擎插件**（Node.js / `apiVersion: 1`）。

## 功能特性

- **原生接入 `reader-pro` 插件协议**：流式分批搜索（`search`）、**发现页（`browse`）**、**一键模糊换源（`content.alternatives`）**、书籍详情（`detail`）、章节目录（`acquire.chapters` / `content.manifest`）、章节正文（`content.resource`）、追更检测（`content.update`）及**定时任务（`extensions.tasks`）**。
- **慢源降权与可配置熔断**：按历史成功率与平均耗时排序搜索顺序；连续失败达到阈值（默认 3 次）自动暂停（默认 10 分钟起，指数退避，最长 6 小时），参数均可在管理页调整。
- **持久化**：Cookie（支持 `Domain` / `Expires` / `Max-Age`）、搜索元数据缓存（LRU 5000 条）、书源健康状态、插件运行参数均保存在插件数据目录，容器重启后不丢失。
- **Legado 规则引擎**：
  - CSS 选择器（`class.` / `id.` / `tag.` / `text.` / `@` 链式语法及索引切片）、JSONPath（`$.` / `@Json:`）、XPath（`//` / `@XPath:`）及正则替换（`##pattern##replacement`）。
  - `@js:` / `<js>...</js>` 脚本管道、`source.jsLib`、`+@js:`、`{{...}}` 模板、`@put` / `@get` 变量传递、`org.jsoup.Jsoup` 垫片、轻量 Rhino `JavaImporter` / `Packages.javax.crypto` 垫片及常用 `java.*` / `cookie.*` API。
  - GBK/GB2312 自动转码、多行 URL 配置、Cloudflare/403 拦截识别及 Cookie 会话保持（脚本内 `java.ajax` 与主请求共享同一 Cookie）。
- **图文模式**：支持漫画书源（`bookSourceType: 2`）及手动/自动识别图文模式，正文保留图片（单章最多 32 张，单张 ≤1.45MB）。
- **内置管理页面（`Legado 书源管理`）**：
  - 书源列表：分页（每页 50 条）、按关键词 / 状态筛选、勾选后批量启用 / 禁用 / 删除 / 重置熔断；每条书源可单独启用禁用、立即测活、切换图文模式、删除。
  - 测活：后台全链路检测（搜索 → 详情 → 目录 → 第一章正文），可设置关键词、范围、并发数，可在完成后自动禁用失败源，或一键禁用 / 删除失败源。“未搜到”不算失败。
  - 导入：订阅 URL 或粘贴 JSON，按 `bookSourceUrl` 去重，重新导入时保留你设置的启用/禁用与图文模式状态。
  - 维护与设置：配置并发数、超时、熔断阈值、定时自动测活，查看 / 清除持久化的 Cookie。

## 安装 / 升级

1. 在项目目录执行 `npm install --registry=https://registry.npmmirror.com` 后 `npm pack`，得到 `reader-plugin-legado-0.4.2.tgz`（或从 Releases 下载）。
2. 在 `reader-pro` 管理员后台「插件管理」上传 `.tgz` 并勾选信任安装（升级时选择替换）。已导入的书源保存在插件数据目录，升级不会丢失。
3. 首次安装时在「书源管理」中新增 `Legado JSON 书源` 实例。
4. 打开插件的 **`Legado 书源管理`** 页面导入书源 JSON（仓库内附带 84 条实测全链路可用书源 `verified-e2e-sources.json`）。

## 数据文件（插件数据目录）

| 文件 | 内容 |
| :--- | :--- |
| `legado-sources.json` | 已导入的书源 |
| `source-health.json` | 每个书源的成功/失败统计、熔断状态、最近一次测活结果 |
| `cookies.json` | 持久化 Cookie |
| `book-meta-cache.json` | 搜索 / 详情元数据缓存 |
| `settings.json` | 搜索并发、超时、熔断阈值与定时测活配置 |

## 已知限制

- 依赖复杂 Android/JVM 反射类（已兼容常见 `Packages.javax.crypto` / `Base64` / `MessageDigest`，其余原生类不支持）、`webView` 浏览器渲染、验证码或 Cloudflare 质询的书源无法在无头 Node 环境运行。
- 有声书源（`bookSourceType: 1`）不受支持。
- 宿主单条消息上限 2MB：超长目录会先省略章节原始链接，仍超限时报错。
