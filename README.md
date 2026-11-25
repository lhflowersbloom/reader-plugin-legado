# reader-plugin-legado

让 [`hectorqin/reader`](https://github.com/hectorqin/reader) 的新版 **reader-pro** 能直接使用 **Legado（阅读 3.0）的 `.json` 书源**。

## 能做什么

- **搜书、看书**：用导入的 Legado 书源搜索，查看详情、目录和正文，并检查更新。
- **发现页**：浏览书源自带的分类和书单。
- **一键换源**：阅读时在其他书源里找同一本书，自动排除续作，按章节进度排序。
- **漫画和带图正文**：支持漫画书源，正文里的图片可以直接显示。
- **自动避开坏书源**：好用、速度快的书源排在前面；连续失败的书源会自动暂停一段时间。
- **安全与稳定性**：书源脚本做进程加固；重定向会保存每一跳的 Cookie；超大响应会流式中止并报错，不会拖垮插件。
- **测活**：一键检测每个书源能不能从搜索一直走到正文，可以自动禁用失败的书源，也可以设成定时检测。
- **管理页**：导入（订阅链接或粘贴 JSON）、筛选、批量启用 / 禁用 / 删除书源，调整超时和并发等参数。
- **兼容大部分 Legado 规则**：CSS、JSONPath、XPath、正则、`@js:` / `<js>` 脚本，以及常用的 `java.*` 接口和加解密功能。

书源、Cookie、测活记录和设置都保存在插件数据目录里，重启容器、升级插件都不会丢。

## 安装 / 升级

1. 从 [Releases](https://github.com/lhflowersbloom/reader-plugin-legado/releases) 下载最新的 `reader-plugin-legado-<版本>.tgz`（也可以在项目目录执行 `npm install` 后 `npm pack` 自己打包）。
2. 在 reader-pro 管理员后台的「插件管理」上传这个文件，勾选信任安装；升级时选择替换。
3. 第一次安装时，在「书源管理」里新增一个 `Legado JSON 书源` 实例。
4. 打开插件的「Legado 书源管理」页面导入书源。仓库里附带了 84 个实测可用的书源：`verified-e2e-sources.json`。

## 不支持的情况

- **需要真实浏览器的网站**：Cloudflare 验证、验证码、需要 `webView` 渲染的页面。
- **依赖 Android 原生功能的书源**：例如字体反爬（`queryTTF` / `replaceFont`）。常见的加解密已经兼容。
- **有声书书源**（`bookSourceType: 1`）。
- **特别长的目录**：超过宿主 2 MB 单条消息上限时会报错。
- **同步请求超大响应**：`java.ajax` / `java.get` 等同步调用单次文本响应约 3.75 MiB 上限，超过会返回 `SYNC_RESPONSE_TOO_LARGE`。

## 致谢

- **Claude**：参与了代码开发、问题分析和文档整理。
- **DeepSeek Harness**：在本机和软路由上跑测试、部署，逐个书源测活，并拿经典版 reader 对照，找出了插件的多处问题。
- **书源作者与维护者**：插件本身只是引擎，能搜到书、读到书，靠的是 Legado 社区的书源作者和维护者长期整理、更新书源（包括书源名里署名的一程、破冰、Haxc 等）。感谢你们的无私分享。

更新记录见 [CHANGELOG.md](CHANGELOG.md)。
