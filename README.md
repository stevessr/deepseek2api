# deepseek2api

一个基于 Node.js 原生 HTTP 服务的 DeepSeek Web 网关，提供浏览器管理台、受控的原生接口代理，以及 OpenAI Chat Completions 兼容接口。

> 本项目不是 DeepSeek 官方 API。它依赖上游 Web 接口，接口行为可能随上游变化。请仅在获得授权的账号和环境中使用，并遵守服务条款、隐私要求与适用法律。

## 能力概览

| 模块 | 能力 |
| --- | --- |
| 管理台 | 本地用户、DeepSeek 账号、API Key、聊天会话、邀请码和系统设置 |
|| OpenAI 兼容层 | `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、流式输出、工具调用、图片输入、会话继续 |
| DeepSeek 代理层 | `/proxy/*` 白名单转发、PoW、验证码状态、token 刷新和请求上下文 |
| 多用户控制 | 账号隔离、并发/频率限制、无痕模式、共享账号轮询 |
| 本地存储 | 无外部数据库；运行时状态写入忽略提交的 `data/app.json` |
| 运行方式 | 无第三方 Node.js 运行时依赖、无构建步骤 |

## 快速开始

要求 Node.js 20.12 或更高版本。

```powershell
Copy-Item .env.example .env
npm start
```

打开 `http://127.0.0.1:3000`，注册本地用户并完成以下步骤：

1. 绑定一个已授权的 DeepSeek 账号。
2. 创建本地 API Key。
3. 使用该 Key 调用 OpenAI 兼容接口。

如需管理员功能，请先在 `.env` 中设置：

```env
APP_ADMIN_USERNAME=admin
APP_ADMIN_PASSWORD=replace-with-a-strong-password
```

最小调用示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

运行测试：

```bash
npm test
```

## 支持的模型

- `deepseek-chat`
- `deepseek-chat-search`
- `deepseek-reasoner`
- `deepseek-reasoner-search`
- `deepseek-chat-expert`
- `deepseek-reasoner-expert`
- `deepseek-vision`
- `deepseek-vision-reasoner`

搜索能力通过 `-search` 模型控制；图片输入仅支持 Vision 模型；专家模型不支持文件或图片上传。

## 文档

- [文档索引](docs/README.md)
- [快速上手](docs/getting-started.md)
- [配置参考](docs/configuration.md)
- [架构说明](docs/architecture.md)
- [API 参考](docs/api-reference.md)
- [安全与隐私](docs/security-and-privacy.md)
- [运维指南](docs/operations.md)
- [开发指南](docs/development.md)

## 项目结构

```text
deepseek2api/
├─ data/                 # 运行时状态目录；仓库只保留 .gitkeep
├─ docs/                 # 项目文档库
├─ public/               # 浏览器管理台静态资源
├─ src/
│  ├─ routes/            # 本地 API、OpenAI API 和上游代理路由
│  ├─ services/          # 认证、账号、协议、PoW、验证码和桥接逻辑
│  ├─ storage/           # JSON 状态存储
│  └─ utils/             # HTTP、隐私脱敏、SSE 和通用工具
├─ test/                 # Node.js 内置测试
├─ .env.example
└─ package.json
```

## 数据与安全提示

- `.env` 和 `data/app.json` 不会提交到 Git；当前仓库不包含现有运行数据库。
- `data/app.json` 仍可能保存上游 token、会话、验证码服务密钥和设备档案，请把它视为敏感文件。
- DeepSeek 登录名和密码默认不持久化；只有显式设置 `PERSIST_ACCOUNT_CREDENTIALS=true` 后才会保存。
- 本地 API Key 明文只在创建时返回一次，磁盘保存哈希与预览。
- 默认服务不应直接暴露到公网。生产部署前请阅读[安全与隐私](docs/security-and-privacy.md)和[运维指南](docs/operations.md)。

## License

[MIT](LICENSE)
