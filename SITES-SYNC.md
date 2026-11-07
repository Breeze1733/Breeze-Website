# Breeze 网站代码与发布

此仓库的根目录保存原本地服务器网站及后端源码；`sites-frontend/` 保存 Sites 使用的独立静态前端源代码，其 `dist/` 是发布目录。两者目前并不完全相同，请分别维护，勿以复制覆盖来合并。

变更后先检查 Git 状态并提交到本仓库。修改后端时在本地服务器审查并手动部署；修改 Sites 前端时需将 `sites-frontend/` 的内容同步至此 Sites 项目的源仓库，再通过 Sites 保存版本并手动发布。仅向 GitHub 推送不会自动更新 Sites。站点的 project_id 保存在 `sites-frontend/.openai/hosting.json`，不要替换；不要提交密码、令牌、上传文件、数据库或运行时数据。

生产网站使用 Cloudflare Worker 对页面和接口分流，本地服务器的已有代码、配置及数据应在部署前保留并备份。
