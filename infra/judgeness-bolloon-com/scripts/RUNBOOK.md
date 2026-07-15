# Runbook — judgeness.bolloon.com 部署

> 反攻期主用. 防御期只用本地 `54188/hearth` 回环冒烟.

## 前置

- 一台 Ubuntu 22.04+ VPS (1 vCPU / 1GB RAM 起; 推荐 Hetzner CX22)
- 一个可管理 DNS 的域名 (Route53 / Cloudflare / Namecheap)
- 一个 email (Let's Encrypt 注册)

## 一次性 setup

### 1. 域名

```
judgeness.bolloon.com       A     <server-ip>
www.judgeness.bolloon.com   CNAME judgeness.bolloon.com
```

(bolloon.com 是已注册的; judgeness 是新子域. A 记录 TTL 300.)

### 2. 服务器

```bash
# ssh root@<server-ip>
apt update && apt -y upgrade
apt -y install nodejs npm caddy sqlite3 jq curl
# bolloon-agent 用户
useradd -m -s /bin/bash bolloon
mkdir -p /opt/bolloon-agent /var/lib/bolloon
chown -R bolloon:bolloon /opt/bolloon-agent /var/lib/bolloon
```

### 3. 安装 bolloon

```bash
su - bolloon
cd /opt/bolloon-agent
npm install -g @bolloon/bolloon-agent@latest
ln -sf $(which bolloon) /usr/local/bin/bolloon
bolloon --version  # sanity
```

### 4. 部署代码

```bash
# 复制 systemd service
cp infra/judgeness-bolloon-com/systemd/bolloon-hearth.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bolloon-hearth

# 复制 Caddyfile
cp infra/judgeness-bolloon-com/caddy/Caddyfile /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

### 5. 验证

```bash
# 本地回环
curl -s http://127.0.0.1:54188/api/hearth | jq

# 公网 (Caddy 自动申请证书)
sleep 20  # 等 ACME
curl -s https://judgeness.bolloon.com/api/hearth | jq
```

期望:
```json
{
  "ok": true,
  "service": "judgeness-hearth",
  "version": "0.3.x-jd-1",
  "descriptionCount": 0,
  ...
}
```

### 6. 监控

```bash
# crontab -e (root)
*/5 * * * * /opt/bolloon-agent/infra/judgeness-bolloon-com/scripts/health-check.sh | logger -t judgeness-health
```

接入 alertmanager (可选):

```bash
apt -y install prometheus-alertmanager
# /etc/prometheus/rules/judgeness.yml
# 见 infra/judgeness-bolloon-com/scripts/prometheus-rules.yml (待补)
```

## 故障

| 症状 | 排查 |
|:-----|:-----|
| 502 Bad Gateway | `systemctl status bolloon-hearth` 看是否存活; `journalctl -u bolloon-hearth -n 100` |
| 证书失败 | `caddy logs --since 1h`; DNS 解析? 80 端口是否被防火墙挡? |
| 401/403 | 检查 visibility.yaml 与 allowlist.yaml (本机 `/var/lib/bolloon/judgeness/`) |
| 慢 | `curl -w "%{time_total}" https://judgeness.bolloon.com/api/hearth` 看延迟 |
| 磁盘满 | `du -sh /var/lib/bolloon/*` 看 hearth-cache 是否爆 |

## 备份

```bash
# 每日 rsync 到 backup bucket
0 3 * * * rsync -a /var/lib/bolloon/judgeness/ s3://backup/judgeness-$(date +\%F)/
```

## 回滚

```bash
# 旧版本回滚
cd /opt/bolloon-agent
git checkout v0.3.0
npm ci
npm run build:all
systemctl restart bolloon-hearth
```
