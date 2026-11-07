# Breeze

沿用原站的 HTML、CSS、字体、图标、背景与首页交互，静态发布目录为 `dist`，无需构建。

- 个人主页、博客、文件中转页面和剪切板页面在 Sites 提供。
- 文件中转、剪切板、OpenClaw、Muse2API、CPA 链接直接打开 `https://breeze.qzz.io` 对应页面。
- 音乐由浏览器按需直接从原站加载，不经过 Sites 后端代理。
- 日期与时钟沿用原站逻辑，采用访问者浏览器的时间。
- 图片与联系方式来自原站的公开静态资源；不包含后端代码、运行数据或凭据。
- 正式域名由 Cloudflare Worker 按路径分流：静态页面取自 Sites；接口、媒体、管理服务直达既有 Tunnel。保留原站的 DNS、Nginx、Tunnel 和所有代码，静态页面取源失败时回退原站。

本地预览：`python -m http.server 8765 --bind 127.0.0.1 --directory dist`
