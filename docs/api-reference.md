# API 参考

## 认证方式

| 接口族 | 认证 |
| --- | --- |
| 公共 `/api/*` | 无认证或可选会话 |
| 私有/管理员 `/api/*` | `ds_reverse_session` HttpOnly Cookie |
| `/proxy/*` | 同一会话 Cookie，可选 `x-proxy-account-id` |
| `/v1/*`、`/models` | `Authorization: Bearer <本地 API Key>` |

错误统一以 JSON 返回：

```json
{ "error": "错误描述" }
```

## OpenAI 兼容接口

### `GET /v1/models`

兼容别名：`GET /models`。返回当前支持的模型列表。

### `POST /v1/chat/completions`

支持：

- `messages`
- `model`，省略时使用 `deepseek-chat`
- `stream: true | false`
- `tools` 与 `tool_choice`，但对应 API Key 必须开启工具调用
- messages 中的 `image_url` 内容块
- `ref_file_ids` 原生文件引用

限制：

- `web_search_options` 不受支持；使用带 `-search` 后缀的模型。
- 图片输入只允许 `deepseek-vision` 或 `deepseek-vision-reasoner`。
- Expert 模型不允许文件或图片上传。
- 工具调用由 prompt 与输出解析适配，不代表所有 OpenAI 工具调用边界行为都完全一致。
- 当前未实现 Embeddings、Audio 或 Files API。

### `POST /v1/responses`（Responses API 兼容）

将 OpenAI Responses API 请求转换为内部 chat 流程，并映射回 Responses 输出格式。支持流式（SSE）与非流式。

请求体支持：

- `input`：字符串，或 `{role, content}` / `{type: "function_call_output"}` 数组
- `instructions`：作为首条 system 消息前置
- `model`
- `tools` 与 `tool_choice`（受 API Key 工具开关约束）
- `stream: true | false`

非流式示例：

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "解释快速排序"
  }'
```

### 会话前缀匹配继续（continue）

响应会返回一个 `response_id` 字段，用于后续继续：

- **显式继续**：请求体携带 `previous_response_id`（Responses API）或 `continue_from`（Chat Completions），即可在同一 DeepSeek 会话上调用 `/chat/continue` 延伸上次回复。
- **前缀匹配自动继续**：若请求的开头用户消息与之前响应的尾部前缀匹配，将自动复用到对应会话继续生成，无需显式指定。
- 会话注册为进程内临时状态，30 分钟自动过期，按 owner 隔离；无痕（incognito）模式下不注册。单次请求的继续会使用原 account 以保证会话有效。

非流式示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "stream": false,
    "messages": [{"role": "user", "content": "解释快速排序"}]
  }'
```

Vision 示例：

```json
{
  "model": "deepseek-vision",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "描述图片" },
        { "type": "image_url", "image_url": { "url": "https://example.com/image.png" } }
      ]
    }
  ]
}
```

## 公共本地接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/me` | 返回匿名状态或当前会话完整载荷 |
| `GET` | `/api/discovery` | 返回代理白名单与协议清单 |
| `GET` | `/api/protocol` | 返回上游版本、路由分组和风控策略 |
| `POST` | `/api/auth/login` | 管理员或本地用户登录 |
| `POST` | `/api/auth/register` | 注册本地用户，可受邀请码策略限制 |
| `POST` | `/api/auth/logout` | 删除当前会话并清除 Cookie |

## 私有本地接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/request-logs?limit=100` | 当前用户请求日志；管理员可见全部 |
| `GET` | `/api/accounts` | 可见 DeepSeek 账号列表 |
| `POST` | `/api/accounts` | 使用 `username`、`password` 和可选设备档案绑定账号 |
| `DELETE` | `/api/accounts/:id` | 删除范围内账号 |
| `POST` | `/api/accounts/:id/captcha/resolve` | 提交手动验证码结果 |
| `POST` | `/api/accounts/:id/captcha/retry` | 强制再次自动处理验证码 |
| `POST` | `/api/accounts/:id/captcha/clear` | 清除验证码状态 |
| `POST` | `/api/incognito` | 管理员更新全局无痕；用户更新自己的无痕 |
| `POST` | `/api/chain-of-thought-override` | 更新当前用户实验开关 |
| `GET` | `/api/api-keys` | 列出当前所有者的 API Key 元数据 |
| `POST` | `/api/api-keys` | 创建 API Key；明文只在响应中返回一次 |
| `PATCH` | `/api/api-keys/:id` | 更新工具调用开关 |
| `DELETE` | `/api/api-keys/:id` | 删除 API Key |

创建 API Key 的请求体示例：

```json
{
  "accountId": "ACCOUNT_ID",
  "label": "local-client",
  "toolCallsEnabled": false
}
```

`plainKey` 可选；不提供时服务端生成高熵 `dsr_...` Key。

## 管理员接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/admin/registration` | 更新 `inviteRequired` |
| `POST` | `/api/admin/shared-account-mode` | 开关共享账号轮询 |
| `POST` | `/api/admin/system-settings` | 更新验证码和全局实验设置 |
| `POST` | `/api/admin/invites` | 批量创建邀请码 |
| `POST` | `/api/admin/invites/batch-delete` | 批量删除邀请码 |
| `DELETE` | `/api/admin/invites/:id` | 删除单个邀请码 |
| `POST` | `/api/admin/users/batch-delete` | 批量删除用户及其关联状态 |
| `POST` | `/api/admin/users/batch-disable` | 批量启用或禁用用户 |
| `PATCH` | `/api/admin/users/:id` | 更新禁用状态、并发和频率限制 |
| `DELETE` | `/api/admin/users/:id` | 删除用户及其关联状态 |

共享账号模式要求先开启全局无痕、至少存在一个可用 DeepSeek 账号，并要求创建 Key 的用户自己也已绑定可用账号。

## DeepSeek 原生代理

调用形式为 `/proxy/<上游路径>`。服务端把路径映射到 `/api/<DEEPSEEK_API_VERSION>/<上游路径>`，并只允许以下分组：

| 分组 | 路径 |
| --- | --- |
| Chat | `/chat/completion`、`/chat/continue`、`/chat/create_pow_challenge`、`/chat/edit_message`、`/chat/history_messages`、`/chat/message_feedback`、`/chat/regenerate`、`/chat/resume_stream`、`/chat/stop_stream` |
| Session | `/chat_session/create`、`/chat_session/delete`、`/chat_session/delete_all`、`/chat_session/fetch_page`、`/chat_session/update_pinned`、`/chat_session/update_title` |
| Client | `/client/settings`、`/client/settings/report`、`/client/span`、`/client/wechat_js_sdk_signature` |
| File / Index | `/file/fetch_files`、`/file/fork_file_task`、`/file/preview`、`/file/upload_file`、`/index/prepare`、`/index/query` |
| Share | `/share/content`、`/share/create`、`/share/delete`、`/share/fork`、`/share/list` |
| User | `/users/current`、`/users/logout_all_sessions`、`/users/set_birthday`、`/users/settings`、`/users/update_settings` |
| Export | `/download_export_history`、`/export_all` |

用 `x-proxy-account-id` 指定当前会话可见账号；省略时使用第一个可见账号。代理拒绝白名单外路径，也不会把上游 `set-cookie` 和 hop-by-hop 响应头返回给浏览器。
