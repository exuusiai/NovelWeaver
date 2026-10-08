# NovelWeaver 服务器部署指南

把平台部署到一台服务器，让其他人通过网址访问使用。以下按「一台全新 Linux 服务器」从头写起；
每一步都给出原因，可按需跳过已具备的部分。

## 部署形态一览

```
用户浏览器 ──HTTPS──▶ Nginx（反向代理 + 静态资源）
                       │ /            → Vite 构建产物（dist/）
                       │ /api/*       → Node 服务（127.0.0.1:4300）
                       ▼
                  NovelWeaver Node 服务 ──▶ .data/novelweaver.db（SQLite）
```

单机单进程即可支撑一个小型用户群（SQLite + 本地磁盘足够几十人量级使用）。

## 1. 准备服务器

任意云厂商（阿里云/腾讯云/AWS…）的最小规格即可：**2 核 4G、40G 盘、Ubuntu 22.04+**。
开放安全组端口：`22`（SSH）、`80`（HTTP）、`443`（HTTPS）。

```bash
ssh root@你的服务器IP
apt update && apt upgrade -y
apt install -y git nginx
# 安装 Node 22（用 NodeSource）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm i -g pnpm@10
node -v   # 应显示 v22.x
```

## 2. 拉代码并构建

```bash
adduser --disabled-password --gecos '' novelweaver   # 建议用非 root 用户跑服务
su - novelweaver
git clone https://github.com/exuusiai/NovelWeaver.git ~/novelweaver
cd ~/novelweaver
pnpm install --frozen-lockfile
pnpm build          # 产出 dist/（前端）+ 服务端 tsx 运行
```

## 3. 进程守护（pm2）

```bash
npm i -g pm2
cd ~/novelweaver
# 生产模式默认只监听 127.0.0.1:4300，由 Nginx 对外代理（推荐保持）
pm2 start "pnpm start" --name novelweaver
pm2 save
pm2 startup         # 按提示执行输出的命令，实现开机自启
pm2 logs novelweaver # 看到监听日志即成功
```

> 数据全部在 `~/novelweaver/.data/novelweaver.db`。备份 = 备份这个目录：
> `tar czf backup-$(date +%F).tar.gz ~/novelweaver/.data`

## 4. Nginx 反向代理

```bash
sudo tee /etc/nginx/sites-available/novelweaver > /dev/null <<'EOF'
server {
    listen 80;
    server_name 你的域名或IP;

    client_max_body_size 150m;   # 与应用上传上限一致（大部头 PDF）

    # 前端静态资源
    root /home/novelweaver/novelweaver/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }

    # API（含 SSE 流式生成，必须关闭缓冲）
    location /api/ {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;          # SSE 必需
        proxy_cache off;
        proxy_read_timeout 600s;      # 长文分析与生成可达数分钟
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/novelweaver /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

没有域名时，把 `server_name` 写成服务器公网 IP，用户直接访问 `http://IP` 也能用。

## 5. HTTPS（有域名时强烈建议）

API Key 会在用户浏览器与本服务之间传输，必须上 HTTPS：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名     # 自动申请 Let's Encrypt 证书并改写 Nginx
```

## 6. 模型接入（两种模式选一）

| 模式 | 做法 | 适合 |
|---|---|---|
| **用户自带 Key** | 不做任何配置；用户在「设置 → 模型网关」填自己的 Base URL/模型/Key（Key 只存在服务进程内存） | 小范围朋友试用，零成本零风险 |
| **平台统一 Key** | 在服务端 `.env` 配置 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`，所有用户共用你的额度 | 正式开放；注意所有人共享你的 token 消耗 |

```bash
# 平台统一 Key 模式
cat > ~/novelweaver/.env <<'EOF'
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=sk-xxxx
AI_MODEL=deepseek-chat
EOF
pm2 restart novelweaver
```

## 7. 分享给用户

把网址发给他们即可：`https://你的域名`。使用须知（建议附在分享信息里）：

- 每个人在左侧「项目切换器」里建自己的项目，项目间数据完全隔离（但共享同一数据库与模型额度）；
- 首次使用：新建项目 → 总览页上传文稿 → 分析中心等分析完成 → 关系图/剧情板/记忆实验室；
- 浏览器关掉后服务端仍在跑，进度不丢；自动保存与历史版本每章保留 50 份。

## 8. 日常运维速查

```bash
pm2 status                  # 服务状态
pm2 logs novelweaver        # 实时日志（Ctrl+C 退出）
pm2 restart novelweaver     # 重启（更新代码后：git pull && pnpm install && pnpm build && pm2 restart）
du -sh ~/novelweaver/.data  # 数据体积
tar czf ~/backup-$(date +%F).tar.gz -C ~ novelweaver/.data   # 备份
```

## 已知边界（分享前请知晓）

- **无鉴权**：当前版本没有登录系统——拿到网址的人都能看到/编辑所有项目。给"一部分人"用之前，
  最简单的门槛是不公开传播网址；需要真正的账号体系时再立项开发（SQLite schema 已预留扩展空间）。
- **单机单进程**：SQLite 写入是单点的，几十人规模无压力，不适合公开大规模运营。
- **上传上限 150MB**：超过的文件需先拆分。
