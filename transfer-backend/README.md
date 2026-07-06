# 文件中转站后端

这是文件中转站单独拆出来的后端，和现有 moments 后端分离。

## 启动

```bash
cd transfer-backend
npm install
npm start
```

默认监听 `3001` 端口。

## nginx 代理示例

需要把前端请求转到这个独立后端，并把上传后的静态文件也映射到它：

```nginx
location /transfer-api/ {
    proxy_pass http://127.0.0.1:3001/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /uploads/ {
    proxy_pass http://127.0.0.1:3001/uploads/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

如果你还想兼容旧的 `/api/uploads/` 地址，也可以再加一条：

```nginx
location /api/uploads/ {
    proxy_pass http://127.0.0.1:3001/api/uploads/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
