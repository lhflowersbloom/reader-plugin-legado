# reader-plugin-legado

让 [`hectorqin/reader`](https://github.com/hectorqin/reader)（**reader-pro 1.0.0+**）直接使用 **Legado（阅读 3.0）的 `.json` 书源**。

## 主要功能

- **搜索与阅读**：支持 Legado 书源搜书、详情、目录、正文、更新检查与发现页浏览。
- **一键换源**：自动匹配同名书、排除续作，并按章节进度排序。
- **漫画与图文**：支持漫画书源及正文内嵌图片显示。
- **健康度与熔断**：健康、响应快的书源优先展示；连续失败自动熔断冷却，避免拖慢搜索。
- **书源测活与管理**：内置管理页支持订阅/JSON 导入、筛选、批量操作、参数调整，以及手动/定时全链路测活。
- **规则兼容**：支持 CSS、JSONPath、XPath、正则、`@js:` / `<js>` 脚本及常用 `java.*` 加解密接口。
- **安全与稳定**：脚本进程加固、多跳重定向 Cookie 保持、超大响应流式中止，数据持久化于插件目录（升级/重启不丢失）。

## 安装与升级

> 推荐使用 **reader-pro `1.0.0` 及以上版本**（已修复局域网明文 HTTP 下搜索异常）。

1. 从 [Releases](https://github.com/lhflowersbloom/reader-plugin-legado/releases) 下载最新的 `reader-plugin-legado-<版本>.tgz`（或本地执行 `npm install && npm pack` 打包）。
2. 在 reader-pro 后台「插件管理」上传安装（勾选信任）；升级时选择替换即可。
3. 首次安装需在「书源管理」中新增 `Legado JSON 书源` 实例。
4. 打开「Legado 书源管理」导入书源（仓库附带 `verified-e2e-sources.json` 共 84 个实测可用书源）。

## 已知限制

- **浏览器级反爬**：不支持 Cloudflare 质询、图形验证码及强依赖 `webView` 渲染的页面。
- **Android 原生特性**：不支持 `queryTTF` / `replaceFont` 字体反爬等原生反射功能。
- **书源类型与体积上限**：不支持有声书（`bookSourceType: 1`）；单本目录超宿主 2 MB 消息上限会报错；`java.ajax` 等同步请求单次文本上限约 3.75 MiB。

## 致谢

- **Claude**：参与代码开发、问题分析与文档整理。
- **DeepSeek Harness**：完成多端测试、部署与经典版对照排障。
- **Legado 书源社区**：感谢各位书源作者与维护者（如一程、破冰、Haxc 等）的长期分享与维护。

完整更新记录见 [CHANGELOG.md](CHANGELOG.md)。
