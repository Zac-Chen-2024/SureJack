# SureJack 部署手册

> 阶段 2 Part B 的实际部署记录，供重装/迁移复现。
> 部署日期：2026-07-18。域名：`surejack.zacchen.win` → `130.245.136.191`（Cloudflare DNS only）。

## 架构

```
公网 ──HTTPS──► nginx（:443，Let's Encrypt 证书）──反代──► SureJack 后端（127.0.0.1:8809，systemd）
                  │
                  └─ HTTP :80 强制 301 跳 HTTPS
```

**同机共存**：另有生产站 `plus.drziangchen.uk`（Python/uvicorn :8808，走 Cloudflare 橙色云代理）。SureJack 用独立 nginx server block + 独立端口，两者互不影响。

## 前置条件（已具备）

- Node 24：`/root/.nvm/versions/node/v24.18.0/bin/node`（nvm 装，已是默认）
- ffmpeg + libass + fonts-noto-cjk + catdoc（阶段 0 装）
- nginx 1.18.0（系统自带，注意：`http2` 用老式 `listen 443 ssl http2` 写法）
- 443 入站已验证可达（阶段 0 Spike 4）

## 部署步骤

### 1. 密钥与配置（不入库）

```bash
# COOKIE_SECRET（丢了 = 所有人被登出）
openssl rand -hex 32   # 写进 /root/SureJack/.env 的 COOKIE_SECRET=

# 真白名单
cat > /root/SureJack/config/whitelist.json <<'EOF'
["陈梓昂", "黄诗婕"]
EOF
```

`.env` 和 `config/whitelist.json` 都已 gitignore，绝不提交。

### 2. systemd 服务

```bash
sudo cp deploy/surejack.service /etc/systemd/system/surejack.service
sudo systemctl daemon-reload
sudo systemctl enable --now surejack
sudo systemctl status surejack           # 应 active
curl -s localhost:8809/api/health         # {"status":"ok"}
```

### 3. nginx（先 HTTP 供签证书）

```bash
sudo mkdir -p /var/www/certbot
sudo cp deploy/nginx-surejack-http.conf /etc/nginx/sites-available/surejack.conf
sudo ln -sf /etc/nginx/sites-available/surejack.conf /etc/nginx/sites-enabled/surejack.conf
sudo nginx -t                             # 必须通过才 reload
sudo systemctl reload nginx               # reload 不断连接，plus 不掉线
# 验证：curl http://surejack.zacchen.win/api/health → 200
# 🔒 每次动 nginx 后必查 plus：curl -H "Host: plus.drziangchen.uk" http://127.0.0.1/api/health → 200
```

### 4. HTTPS 证书（certbot）

**⚠️ 坑：apt 版 certbot 与系统 pyOpenSSL 21.0.0 不兼容**（`X509_V_FLAG_NOTIFY_POLICY` 报错）。**必须用 snap 版**：

```bash
sudo apt-get remove -y certbot            # 卸掉坏的
sudo snap install --classic certbot       # 官方推荐，自带依赖
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot certonly --webroot -w /var/www/certbot \
  -d surejack.zacchen.win \
  --non-interactive --agree-tos -m zacchen2024@gmail.com
# 证书：/etc/letsencrypt/live/surejack.zacchen.win/{fullchain,privkey}.pem
# 自动续期已由 certbot 配好（snap 的 certbot.timer）
```

### 5. nginx 升级到 HTTPS

```bash
sudo cp deploy/nginx-surejack.conf /etc/nginx/sites-available/surejack.conf
sudo nginx -t && sudo systemctl reload nginx
# 验证：
#   https://surejack.zacchen.win/api/health → 200（HTTP/2，证书有效）
#   http:// → 301 跳 HTTPS
```

### 6. 🔴 关闭抢注窗口（上线关键安全步骤）

**服务上线后立刻**给两人各设密码——在任何人能访问登录页之前占掉密码：

```bash
cd /root/SureJack && source ~/.nvm/nvm.sh
npm run reset-password -- --name 陈梓昂    # 交互输入密码，不进 shell 历史
npm run reset-password -- --name 黄诗婕
```

设完后，登录页对这两人显示"输入密码"而非"设置密码"——抢注窗口关闭。

> **⚠️ 当前状态（2026-07-18）：两人都尚未设密码，抢注窗口开着。**
> 项目所有者已评估并**接受**这个风险：这是个人小项目，真被抢注了用
> `reset-password` CLI 即可拿回（首登 IP 也会记录下抢注者）。
> 这不是疏漏，是有意识的取舍。

## 运维

- **看日志**：`journalctl -u surejack -f`
- **重启后端**：`sudo systemctl restart surejack`
- **改后端代码后**：`git pull && sudo systemctl restart surejack`（tsx 直接跑 TS，无需构建）
- **改前端代码后**：`cd web && npm run build && sudo systemctl restart surejack`
  （前端构建到 public/，由后端同域托管；不需要动 nginx）
- **忘记密码/被抢注**：`npm run reset-password -- --name <姓名>`
- **证书续期**：自动。手动测试续期：`sudo certbot renew --dry-run`
- **备份**：打包 `/root/SureJack/{data,config/whitelist.json,.env}`——数据库、白名单、密钥全在这。

## 端口/文件总览

| 项 | 值 |
|---|---|
| 后端端口 | 127.0.0.1:8809（不直接对外） |
| systemd 单元 | `/etc/systemd/system/surejack.service` |
| nginx 配置 | `/etc/nginx/sites-available/surejack.conf` |
| 证书 | `/etc/letsencrypt/live/surejack.zacchen.win/` |
| 数据 | `/root/SureJack/data/`（auth.db + 每用户 app.db） |
| 密钥 | `/root/SureJack/.env`（COOKIE_SECRET、Azure key） |
| 白名单 | `/root/SureJack/config/whitelist.json` |
