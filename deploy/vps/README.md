# leo-status VPS 中转（relay）部署说明

VPS：`ssh sh`（`<VPS_IP>`，root）。本目录是**仓库源文件**，VPS 上的运行副本在
`/opt/leo-status/`。

拓扑（详见 `leo-status/CONTRACT-V2.md` §1）：

```
设备 → https://dsh.agencyarche.com/leo-status/api/*
     → Caddy 容器 co-align-v2-caddy-1（handle_path 去掉 /leo-status 前缀）
     → 宿主 172.18.0.1:18888（forward.py，systemd: leo-status-relay）
     → 127.0.0.1:18899（SSH 反向隧道，由本机 DSH 的 leo-status 插件建立）
     → 本机 127.0.0.1:8790（hub 服务）
```

VPS **不存 todo、不解析 HTTP**，只做字节转发。本机关机/隧道断开时链路自然失败，
远端设备显示本地缓存。

## 文件

| 文件 | 作用 |
|---|---|
| `forward.py` | python3 asyncio TCP 转发：`172.18.0.1:18888` → `127.0.0.1:18899`。只绑 docker 网关地址，不绑 `0.0.0.0`。 |
| `leo-status-relay.service` | systemd unit，`Restart=always` / `RestartSec=3`，`enable --now` 自启。 |
| `configure-edge.py` | 幂等给 Caddyfile 的 `dsh.agencyarche.com` 块插入 `handle_path /leo-status/*`；备份 → validate → 失败回滚 → 成功才 restart Caddy。 |
| `README.md` | 本文件。 |

## 首次部署

```bash
# 1. 同步源文件（在工作区仓库根目录执行）
scp leo-status/deploy/vps/{forward.py,configure-edge.py,leo-status-relay.service,README.md} \
    sh:/opt/leo-status/

# 2. 在 VPS 上安装
ssh sh '
  set -e
  cd /opt/leo-status
  # scp 在 Windows 上可能带 CRLF；python 脚本先去掉
  sed -i "s/\r$//" forward.py configure-edge.py
  chmod 755 forward.py configure-edge.py
  /usr/bin/python3 -m py_compile forward.py configure-edge.py

  install -m 644 leo-status-relay.service /etc/systemd/system/leo-status-relay.service
  systemctl daemon-reload
  systemctl enable --now leo-status-relay

  /usr/bin/python3 /opt/leo-status/configure-edge.py
'

# 3. 本机（hub 侧）启动插件后建立 ssh -R 18899 隧道，链路才完整
```

`configure-edge.py` 支持两个辅助开关：

- `--dry-run`：只打印要插入的内容，不写文件。
- `--no-restart`：写入并 validate，但不重启 Caddy（下次重启 Caddy 才生效）。

## 验收（VPS 上执行）

```bash
systemctl is-active leo-status-relay          # active
ss -lnt | grep 18888                          # 172.18.0.1:18888
# 隧道未建立时应为 000（连接被重置/空响应），证明不是本地应答：
curl -s -o /dev/null -w '%{http_code}\n' http://172.18.0.1:18888/api/health
# Caddy 容器到转发器连通（应为连接类错误/空响应，而不是 403）：
docker exec co-align-v2-caddy-1 wget -qO- --timeout=3 http://172.18.0.1:18888/api/health
# 原站不受影响（未登录 401）：
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.agencyarche.com/center/devices
# 公网入口（hub 未起时 502/503 属预期）：
curl -sk -o /dev/null -w '%{http_code}\n' https://dsh.agencyarche.com/leo-status/api/health
```

从本机执行最后一条即可验证公网链路。

## 更新 forward.py / unit

```bash
scp leo-status/deploy/vps/forward.py sh:/opt/leo-status/forward.py
ssh sh 'sed -i "s/\r$//" /opt/leo-status/forward.py && systemctl restart leo-status-relay && systemctl is-active leo-status-relay'
```

改 unit：

```bash
scp leo-status/deploy/vps/leo-status-relay.service sh:/etc/systemd/system/leo-status-relay.service
ssh sh 'systemctl daemon-reload && systemctl restart leo-status-relay && systemctl is-active leo-status-relay'
```

## 回滚

1. **只回滚 Caddy 路由**：用最新备份覆盖 Caddyfile，然后重启 Caddy。

   ```bash
   ssh sh '
     ls -1t /opt/leo-status/Caddyfile.before-* | head -1
     cp "$(ls -1t /opt/leo-status/Caddyfile.before-* | head -1)" \
        /home/co-align/releases/854f9d14332a68b50fca3ddc74c501409ffea3de/deploy/vps/Caddyfile
     docker exec co-align-v2-caddy-1 caddy validate --config /etc/caddy/Caddyfile \
       && docker restart co-align-v2-caddy-1
   '
   ```

   注意：**用 `cp` 覆盖、不要用 mv/rename**——容器里 `/etc/caddy/Caddyfile` 是单文件
   bind mount，换 inode 后容器仍读旧文件。

2. **停用中转**：

   ```bash
   ssh sh 'systemctl disable --now leo-status-relay'
   ```

3. **彻底清理**（确认不再需要后）：先回滚 Caddyfile 并重启 Caddy，再
   `rm -rf /opt/leo-status /etc/systemd/system/leo-status-relay.service && systemctl daemon-reload`。

## ⚠️ co-align 重新部署会覆盖 Caddyfile

`co-align` 每次发版都会把 release 目录里的 `deploy/vps/Caddyfile` 重新挂载/替换，
其中**不含** `dsh.agencyarche.com` 的 `/leo-status` 路由（同样也可能丢掉 dsh-center
的 site）。所以：

- co-align 重新部署后，`https://dsh.agencyarche.com/leo-status/*` 会 404/走错后端。
- 需要**重跑 `configure-edge.py`**（脚本幂等，会自动重新找 Caddyfile 挂载路径、备份、
  校验、重启）：

  ```bash
  ssh sh '/usr/bin/python3 /opt/leo-status/configure-edge.py'
  ```

- 如果 dsh-center 整个 site 块都丢了，先跑 `/root/dsh-center/configure-center-edge.py`
  （会补回 site 与本路由？不会——它只补 dsh-center site），再跑本脚本；本脚本在找不到
  `dsh.agencyarche.com {` 块时会明确报错退出，不会瞎猜。
- 每次 co-align 部署后都执行一次验收里的 `curl https://dsh.agencyarche.com/leo-status/api/health`。

## 排障

| 现象 | 检查 |
|---|---|
| `18888` 没监听 | `systemctl status leo-status-relay`、`journalctl -u leo-status-relay -n 50 --no-pager`；是否有进程占用 18888。 |
| 公网 `502/503` | 属正常：SSH 反向隧道（18899）未建立。确认本机插件 hub 模式已启动、`ss -lnt | grep 18899`（VPS 侧）。 |
| 公网 `404` | Caddyfile 里没有 `/leo-status` 路由（多半 co-align 重新部署过），重跑 `configure-edge.py`。 |
| 公网 `403` | 请求被别的 Caddy site 抢先匹配（检查是否有其它站点块包含该域名）。 |
| 改了 Caddyfile 但没生效 | 必须先 `caddy validate` 再 `docker restart co-align-v2-caddy-1`；`--no-restart` 只是写盘。 |
