# scut-notipay

基于 Node.js 与 node-napcat-ts 的应用程序，用于查询并提醒华南理工大学广州国际校区与大学城校区的宿舍缴费事项。

## 配置

程序支持两种运行模式：无需 QQ 机器人的独立模式，以及兼容原有命令交互的 QQ 模式。

### 独立模式（推荐）

复制示例配置后，将 `mode` 保持为 `standalone`，并填写 `standalone` 中的校园卡与通知配置：

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
    "fetchInterval": "1d",
    "notification": {
      "hour": 8,
      "threshold": null,
      "lines": "ewa",
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

`campus` 可填国际校区 `GZIC` 或大学城校区 `DXC`；通知渠道 `type` 可填 `feishu` 或 `dingtalk`。`threshold` 为 `null` 时每天定时发送，设为数字时仅在所选余额低于该值时发送。`lines` 使用 `e`、`w`、`a` 分别表示电费、水费和空调费。

### QQ 模式

将 `mode` 改为 `qq`，并配置：

```json
{
  "mode": "qq",
  "napcatWs": "ws://127.0.0.1:3001",
  "napcatToken": "your_napcat_token",
  "encryptionKey": "your_encryption_key",
  "commandNames": ["scut-notipay", "snp"],
  "billingRetryCount": 3
}
```

`encryptionKey` 用于加密校园卡密码和通知渠道密钥。投入使用后不要修改，否则已有加密数据将无法解密。

## Docker 部署

要求安装 Docker Engine 和 Docker Compose。先创建运行配置：

```bash
cp config.example.json config.json
```

QQ 模式下至少设置以下内容；独立模式不需要 NapCat：

- `napcatToken`：NapCat WebSocket Token。
- `encryptionKey`：不可泄露、不可随意更换的长随机字符串，可用 `openssl rand -base64 48` 生成。
- `napcatWs`：NapCat WebSocket 地址。

如果 NapCat 运行在 Docker 宿主机，Linux、macOS 和 Windows 均可使用 Compose 文件默认提供的宿主机映射：

```json
"napcatWs": "ws://host.docker.internal:3001"
```

如果 NapCat 也运行在同一个 Compose 网络中，应改用它的服务名，例如：

```json
"napcatWs": "ws://napcat:3001"
```

启动并查看日志：

```bash
docker compose up -d --build
docker compose logs -f scut-notipay
```

停止服务：

```bash
docker compose down
```

数据库存储在命名卷 `scut-notipay-data` 中，执行 `docker compose down` 不会删除数据。不要使用 `docker compose down -v`，除非确定要删除所有账号、账单历史和通知配置。

更新代码后重新构建：

```bash
docker compose up -d --build
```

如需使用代理，可在 `docker-compose.yml` 的 `environment` 中加入 `HTTP_PROXY`、`HTTPS_PROXY`、`SOCKS_PROXY` 或 `SOCKS5_PROXY`。

## 代理配置

如果需要通过代理访问网络，可以设置以下环境变量：

### HTTP/HTTPS 代理

```bash
# 支持基本认证的代理格式
export HTTP_PROXY=http://username:password@proxy-host:port
# 或
export HTTPS_PROXY=http://username:password@proxy-host:port
```

**HTTP 代理 URL 格式示例：**

- 无认证：`http://proxy.example.com:8080`
- 基本认证：`http://user:pass@proxy.example.com:8080`

### SOCKS5 代理

```bash
# 支持基本认证的 SOCKS5 代理格式
export SOCKS_PROXY=socks5://username:password@proxy-host:port
# 或
export SOCKS5_PROXY=socks5://username:password@proxy-host:port
```

**SOCKS5 代理 URL 格式示例：**

- 无认证：`socks5://proxy.example.com:1080`
- 基本认证：`socks5://user:pass@proxy.example.com:1080`

**注意：** SOCKS 代理优先级高于 HTTP 代理。如果同时设置了两种代理，将使用 SOCKS 代理。

应用程序将自动检测并使用配置的代理进行所有 HTTP/HTTPS 请求。

## 通知渠道

系统支持 QQ、飞书和钉钉通知。QQ 通过 NapCat 发送；飞书和钉钉使用群自定义机器人 Webhook。飞书、钉钉渠道配置包含密钥，只能在 QQ 私聊中管理。

钉钉机器人如果启用了“自定义关键词”安全设置，请确保关键词能被通知标题“宿舍余额提醒”或测试标题“SCUT Notipay 渠道测试”命中；也可以使用加签方式并在添加渠道时提供 `secret`。

```text
# 查看渠道（设置一次 QQ 通知后会自动建立当前会话的 QQ 渠道）
snp channel list

# 添加飞书或钉钉渠道；未开启加签时省略最后的 secret
snp channel add feishu 宿舍飞书群 https://open.feishu.cn/open-apis/bot/v2/hook/xxx [secret]
snp channel add dingtalk 宿舍钉钉群 https://oapi.dingtalk.com/robot/send?access_token=xxx [secret]

# 发送测试消息、删除非 QQ 渠道
snp channel test <渠道ID>
snp channel delete <渠道ID>
```

设置通知时用 `channels=` 选择一个或多个渠道；省略时默认发送到执行命令的 QQ 会话：

```text
snp notify 20 10 e channels=1,2,3
```

以上命令表示每天 20:00 在电费低于 10 元时，通过渠道 1、2、3 发送通知。飞书和钉钉目前发送余额摘要卡片/Markdown；QQ 同时发送趋势图。

已有 QQ 通知会在程序首次启动新版本时自动迁移为 QQ 渠道，无需重新设置。Webhook 和签名 Secret 使用 `encryptionKey` 加密存储，请勿在群聊中发送这些配置。
