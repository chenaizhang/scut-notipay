# scut-notipay

用于查询华南理工大学广州国际校区和大学城校区宿舍余额，并按配置发送余额通知。

系统提供两种互相独立的运行方式：独立模式只绑定一个校园网账号，通过飞书 Webhook 机器人发送通知；提供服务模式通过 NapCat 提供 QQ 命令交互，并可绑定多个校园网账号。部署前请选择其中一种模式。

## 独立模式

独立模式适合只需要自己使用的场景。支持自由选择日报，周报，月报以及余额报警四种类型通知。要求：在校园网内的电脑或服务器。

### 功能

- 每四小时查询并记录一次余额，查询本身不发送通知。
- 查询时间围绕 `00:00`、`04:00`、`08:00`、`12:00`、`16:00`、`20:00`，支持随机偏移。
- 支持每日余额通知、低余额提醒、周报和月报，可分别启用或关闭。
- 周报和月报中折线图使用飞书卡片 JSON 2.0 原生折线图，无需申请图片上传权限。
- 暂仅支持飞书群自定义机器人 Webhook。

### 配置

复制配置文件：

```bash
cp config.example.json config.json
```

将 `config.json` 配置为：

```json
{
  "mode": "standalone",
  "encryptionKey": "不可泄露且不可更换的长随机字符串",
  "billingRetryCount": 3,
  "standalone": {
    "id": "default",
    "cardId": "校园卡账号",
    "password": "校园卡密码",
    "campus": "GZIC",
    "name": "宿舍余额",
    "fetchInterval": "4h",
    "fetchJitterMinutes": 10,
    "notification": {
      "enabledNotifications": ["daily", "lowBalance", "weeklyReport", "monthlyReport"],
      "hour": 8,
      "threshold": null,
      "thresholds": {
        "water": 20,
        "electric": 15
      },
      "reports": {
        "weekly": { "dayOfWeek": 1, "hour": 8, "minute": 5 },
        "monthly": { "dayOfMonth": 1, "hour": 8, "minute": 10 }
      },
      "lines": "ew",
      "channel": {
        "type": "feishu",
        "name": "默认通知",
        "webhookUrl": "飞书机器人 Webhook 地址",
        "secret": "可选的签名密钥"
      }
    }
  }
}
```

主要字段：

- `campus`：国际校区使用 `GZIC`，大学城校区使用 `DXC`。
- `encryptionKey`：用于加密敏感信息。可用 `openssl rand -base64 48` 生成，投入使用后不要修改。
- `fetchInterval`：独立模式建议保持为 `4h`。
- `fetchJitterMinutes`：为固定查询时隙增加偏移。设置为 `10` 时，每次在整点前后 1 至 10 分钟查询，不会恰好在整点访问。
- `enabledNotifications`：只保留需要启用的通知类型；设置为 `[]` 可关闭所有通知。
- `thresholds.water`、`thresholds.electric`：低余额阈值，设置为 `null` 表示不检查该项目。
- `threshold`：旧版统一阈值的兼容字段；配置了分项阈值时优先使用 `thresholds`。
- `lines`：独立模式固定使用 `ew`，分别表示电费和水费。
- `channel.type`：独立模式只支持 `feishu`。
- `channel.secret`：飞书机器人开启“签名校验”时填写；未开启时使用空字符串。

### 通知逻辑

`enabledNotifications` 支持以下值：

- `daily`：每天在 `notification.hour` 指定的整点读取最近一次采集结果并发送日报，不会额外查询校园卡网站。
- `lowBalance`：一次采集完成后，电费或水费首次降到阈值时发送提醒。余额充值恢复后，再次跌破阈值会重新提醒。
- `weeklyReport`：在 `reports.weekly` 指定的时间，统计此前完整七天。
- `monthlyReport`：在 `reports.monthly` 指定的时间，统计上一个完整自然月。

### Docker 部署

需要安装 Docker Engine 和 Docker Compose。完成 `config.json` 后启动服务：

```bash
docker compose up -d --build
docker compose logs -f scut-notipay
```

检查运行状态：

```bash
docker compose ps
```

更新代码后重新构建：

```bash
docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

数据库存储在命名卷 `scut-notipay-data` 中，执行 `docker compose down` 不会删除数据。不要使用 `docker compose down -v`，除非确定要删除账号、账单历史和通知状态。

### 代理

如需通过代理访问校园卡网站，在 `docker-compose.yml` 的 `environment` 中添加相应变量：

```yaml
environment:
  TZ: Asia/Shanghai
  DATA_PATH: /app/data/data.db
  HTTP_PROXY: http://user:pass@proxy.example.com:8080
  HTTPS_PROXY: http://user:pass@proxy.example.com:8080
  # SOCKS5_PROXY: socks5://user:pass@proxy.example.com:1080
```

支持 `HTTP_PROXY`、`HTTPS_PROXY`、`SOCKS_PROXY` 和 `SOCKS5_PROXY`。同时配置时，SOCKS 代理优先于 HTTP 代理。修改 Compose 文件后需要重新创建容器：

```bash
docker compose up -d
```

## 提供服务模式

这一部分我没有做测试，如果需要使用可以直接访问[原项目](https://github.com/Naptie/scut-notipay)。其实飞书创建应用机器人应该也能提供服务，且更为美观，但我没啥时间做，留给后来人。
提供服务模式通过 NapCat WebSocket 接收 QQ 命令，适合为多个用户提供账号绑定、余额查询和定时通知服务。该模式暂只接入 QQ平台。

### 功能

- 在 QQ 私聊或群聊中绑定校园卡并查询余额。
- 通过命令设置查询间隔和余额通知。
- 支持电费、水费和空调费查询。
- 只通过 QQ 私聊或群聊发送通知。
- QQ 消息可以附带 PNG 趋势图。

### 配置

复制配置文件：

```bash
cp config.example.json config.json
```

将 `config.json` 的运行模式和 NapCat 配置修改为：

```json
{
  "mode": "service",
  "napcatWs": "ws://host.docker.internal:3001",
  "napcatToken": "NapCat WebSocket Token",
  "encryptionKey": "不可泄露且不可更换的长随机字符串",
  "commandNames": ["scut-notipay", "snp"],
  "billingRetryCount": 3
}
```

主要字段：

- `napcatWs`：NapCat WebSocket 地址。
- `napcatToken`：NapCat WebSocket Token。
- `encryptionKey`：用于加密校园卡密码。可用 `openssl rand -base64 48` 生成，投入使用后不要修改。
- `commandNames`：QQ 中可使用的命令前缀。

NapCat 运行在 Docker 宿主机时，Linux、macOS 和 Windows 均可使用 Compose 默认提供的宿主机映射：

```json
"napcatWs": "ws://host.docker.internal:3001"
```

NapCat 与本系统位于同一个 Compose 网络时，应改用 NapCat 的服务名：

```json
"napcatWs": "ws://napcat:3001"
```

### Docker 部署

先确认 NapCat WebSocket 已启动，并且 Token 与 `config.json` 一致，然后启动本系统：

```bash
docker compose up -d --build
docker compose logs -f scut-notipay
```

检查运行状态：

```bash
docker compose ps
```

更新代码后重新构建：

```bash
docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

数据库存储在命名卷 `scut-notipay-data` 中。不要使用 `docker compose down -v`，除非确定要删除所有已绑定账号、账单历史和通知配置。

### 通知渠道

提供服务模式只支持 QQ 通知渠道。设置一次通知后，系统会自动建立当前私聊或群聊对应的 QQ 渠道，不需要手动添加渠道。

```text
# 查看渠道
snp channel list

# 测试 QQ 渠道
snp channel test <QQ渠道ID>
```

设置通知时可以使用 `channels=` 选择一个或多个已有 QQ 渠道；省略时默认发送到执行命令的 QQ 会话：

```text
snp notify 20 10 e channels=1,2,3
```

以上命令表示每天 `20:00` 检查电费，余额低于 `10` 元时通过 QQ 渠道 `1`、`2`、`3` 发送通知。费用标识为：`e` 表示电费，`w` 表示水费，`a` 表示空调费。

已有 QQ 通知会在程序首次启动新版本时自动迁移为 QQ 渠道，无需重新设置。历史数据库中遗留的非 QQ 渠道不会被提供服务模式加载或发送。

### 代理

如需使用代理，在 `docker-compose.yml` 的 `environment` 中添加：

```yaml
environment:
  TZ: Asia/Shanghai
  DATA_PATH: /app/data/data.db
  HTTP_PROXY: http://user:pass@proxy.example.com:8080
  HTTPS_PROXY: http://user:pass@proxy.example.com:8080
  # SOCKS5_PROXY: socks5://user:pass@proxy.example.com:1080
```

支持的代理变量为 `HTTP_PROXY`、`HTTPS_PROXY`、`SOCKS_PROXY` 和 `SOCKS5_PROXY`，SOCKS 代理优先级更高。修改后重新创建容器：

```bash
docker compose up -d
```
