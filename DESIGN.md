# pi-Hexhub 设计方案

> 状态：待评审，尚未开始实现。
>
> 目标目录：`/mnt/d/mywork/pi/pi-Hexhub`

## 1. 已验证事实

- 当前安装的 HexHub 版本为 `5.3.9`，MCP 服务报告为 `HexHub MCP 0.1.0`。
- 端点 `http://127.0.0.1:17321/mcp` 使用 MCP `2025-03-26` Streamable HTTP。
- 服务支持 `POST`、`GET`、`DELETE` 和 `OPTIONS`，会话通过 `Mcp-Session-Id` 管理。
- 当前服务能力只声明 `tools`，没有声明 resources、prompts 或 sampling。
- HexHub 根据当前 MCP 权限档案动态裁剪 `tools/list`。
- 当前权限档案暴露 23 个工具，覆盖 SSH、Docker、数据库、文件、隧道和交互终端。
- HexHub 还实现了 `redis_command`，但当前权限档案未暴露，因此完整已知目录为 24 个远端工具。
- 当前 23 个远端工具的原始定义序列化后约 29,181 字符，按 4 字符/token 估算约 7,296 tokens；这还不包含服务器返回的长 instructions。
- HexHub 只监听 Windows 的 `127.0.0.1:17321`。Windows 进程可访问，当前 WSL 网络不能直接访问该回环地址。

## 2. 设计目标

1. 将 HexHub MCP 能力注册成命名空间隔离的 Pi 工具，不覆盖 Pi 的 `read`、`write`、`edit` 等内置工具。
2. 对 HexHub 做领域化优化，而不是简单把 `tools/list` 原样转发给模型。
3. 首轮只暴露最少工具，按任务领域渐进加载，显著减少工具 schema 和说明 token。
4. 支持运行时通过 `/hexhub-config` 修改 MCP URL，并立即重连，不要求 `/reload` 或重启 Pi。
5. 同时支持 Pi 运行在原生 Windows 和 WSL。
6. 完整覆盖 SSH、Docker、数据库、Redis、远程文件、SCP、SSH 隧道和交互终端。
7. 保留 HexHub 服务端权限和确认机制，不把本地工具分组误当成授权边界。
8. 对结果做领域化压缩、分页和截断，减少模型上下文，同时避免敏感结果默认落盘。

## 3. 非目标

- 不修改 HexHub 服务端或其本地数据。
- 不绕过 HexHub 的 MCP 权限、用户确认或资产引用机制。
- 不自动暴露 HexHub 未来新增但未经审查的工具。
- 不把 MCP resources、prompts 或 sampling 伪装成工具；当前服务也未声明这些能力。
- 不默认把 Windows MCP 端口开放到局域网或 `0.0.0.0`。

## 4. 总体架构

```text
Pi Extension
  ├─ ConfigManager
  │    ├─ global connection config
  │    └─ trusted project behavior overrides
  ├─ HexHubRuntime
  │    ├─ generation-based connection state
  │    ├─ MCP Client + catalog epoch
  │    ├─ asset/container handle registry
  │    └─ WSL tunnel proxy registry
  ├─ TransportSelector
  │    ├─ DirectFetchTransport (Windows/normal network)
  │    └─ WindowsLoopbackFetch (WSL -> Windows localhost)
  ├─ ReviewedToolCatalog
  │    ├─ static TypeBox schemas
  │    ├─ group/risk/output policies
  │    └─ remote schema compatibility checks
  ├─ ProgressiveDisclosure
  │    ├─ hexhub_tools loader
  │    └─ additive group activation
  └─ ResultPipeline
       ├─ structuredContent first
       ├─ tool-specific formatter
       ├─ redaction
       └─ bounded head/tail/table output
```

## 5. 工具目录与分组

所有模型可见工具使用 `hexhub_` 前缀。远端工具名只保存在工具 details 和内部映射中。

| 组 | Pi 工具 | 远端工具 | 默认激活 |
| --- | --- | --- | :---: |
| bootstrap | `hexhub_tools` | 本地 loader | 是 |
| assets | `hexhub_assets` | `list_assets` | 是 |
| shell | `hexhub_shell` | `shell` | 否 |
| files-read | `hexhub_read` | `read` | 否 |
| files-write | `hexhub_write`、`hexhub_edit`、`hexhub_multi_edit`、`hexhub_delete` | 同名远端工具 | 否 |
| docker-read | `hexhub_docker_containers`、`hexhub_docker_logs` | `list_docker_containers`、`docker_container_logs` | 否 |
| docker-control | `hexhub_docker_action` | `docker_container_action` | 否 |
| database-meta | `hexhub_db_objects`、`hexhub_db_ddl` | `list_db_objects`、`db_table_ddl` | 否 |
| database-sql | `hexhub_sql` | `execute_sql` | 否 |
| redis | `hexhub_redis` | `redis_command` | 否 |
| transfer | `hexhub_scp` | `scp_transfer` | 否 |
| tunnel | `hexhub_tunnel_open`、`hexhub_tunnel_close` | `open_ssh_tunnel`、`close_ssh_tunnel` | 否 |
| terminal | `hexhub_terminal_open`、`hexhub_terminal_close`、`hexhub_terminals`、`hexhub_terminal_send`、`hexhub_terminal_key`、`hexhub_terminal_read`、`hexhub_terminal_expect` | 7 个 SSH terminal 工具 | 否 |

SSH 和 Docker 共用 `shell/read/write/edit/multi_edit`。Docker 调用额外携带容器选择；SSH 调用不携带容器参数。

## 6. 动态事实源与静态优化目录

采用“动态权限事实源 + 静态审查目录”的混合方案：

1. 本地维护 24 个已知远端工具的 TypeBox schema、短描述、输入适配器、风险等级、依赖组和输出策略。
2. 每次连接执行 `tools/list`，以服务端结果判断当前权限实际开放了哪些工具。
3. 缺少某个工具只表示当前权限未开放，不导致整个扩展连接失败。
4. 当前未开放的工具保持已注册但 inactive；执行前还会检查 catalog epoch 和远端可用性。
5. 对远端 schema 计算指纹，并与本地兼容规则比较：
   - 仅 description 变化：继续使用本地短描述。
   - 新增可选字段：记录 diagnostics，不阻塞已有适配器。
   - 必填字段、字段类型或枚举发生不兼容变化：停用该工具并在 `/hexhub-config test` 中报告。
6. HexHub 新增的未知工具不会自动暴露给模型，只在 diagnostics 中列出，审查后再加入本地目录。
7. 当前服务没有声明 `tools.listChanged`；目录在启动、配置修改、显式 reconnect 和会话失效重连时刷新。

该策略比原样动态注册更安全，也比“要求固定全集存在”更适合 HexHub 的按权限披露机制。

## 7. 资产引用优化

直接 MCP 要求模型复制长且会话相关的 `asset_ref`。扩展改为维护会话内资产注册表：

1. `hexhub_assets` 调用远端 `list_assets`，解析并缓存真实 `asset_ref`。
2. 模型只看到短资产键和可读信息，例如 `ssh:1`、`docker:2`、`db:1`，工具输入字段统一为 `asset`。
3. 执行前由扩展把短资产键解析为当前 MCP 会话的真实 `asset_ref`。
4. 若名称唯一，也允许传资产名称；名称歧义时返回紧凑候选列表，不猜测目标。
5. MCP 重连后清空旧映射，旧短键立即失效，避免把上一会话的引用发到新会话。
6. Docker 容器也建立短期注册表，统一处理远端工具中的 `container_id` 与 `container_name` 差异。
7. 工具结果和面向用户的文本不显示真实 `asset_ref`、真实 HexHub asset id 或内部路由字段。

这能减少重复 `list_assets` 调用、引用复制错误和内部标识泄漏。

## 8. 渐进式披露

### 8.1 初始工具

初始只激活：

- `hexhub_tools`
- `hexhub_assets`

其余工具全部注册但 inactive。扩展不移除 Pi 内置工具或其他扩展工具。

### 8.2 Loader 行为

`hexhub_tools` 接受自然语言 `query` 和可选显式 `groups`：

```json
{
  "query": "查看 Docker 容器最近日志"
}
```

本地关键词/领域路由只负责选择已审查分组，不调用额外模型：

- SSH 命令 -> `shell`
- 远程文件读取 -> `files-read`
- 远程文件修改 -> `files-read` + `files-write`
- Docker 查看 -> `docker-read`
- Docker 容器内命令/文件 -> `docker-read` + 对应 shell/file 组
- Docker 控制 -> `docker-read` + `docker-control`
- 数据库结构 -> `database-meta`
- SQL -> `database-meta` + `database-sql`
- Redis -> `redis`
- 文件传输 -> `transfer`
- 端口转发 -> `tunnel`
- 交互 SSH -> `terminal`

激活只做 additive merge，便于 Pi 使用原生 deferred tool loading；不支持原生 deferred loading 的模型会在下一轮收到当前完整 active set。

### 8.3 上下文目标

- 直接 MCP 基线：当前 23 工具约 7,296 schema tokens，另有长 instructions。
- 扩展目标：初始两个工具定义控制在约 600 tokens 以内。
- 初始工具 schema 目标降低至少 90%。
- 单一领域加载后尽量控制在 1,500 tokens 内；交互终端等大组按需才加载。
- 不把服务器完整 instructions 注入每轮系统提示，只保留简短全局规则，并把领域规则放入对应工具描述。

实际实现后用序列化 schema 长度做回归测试，不只依赖人工估算。

## 9. 输入适配优化

- `hexhub_assets.pattern` 默认 `""`，模型无需每次显式传空字符串。
- `asset` 自动转换为真实 `asset_ref`。
- Docker `container` 自动转换为远端要求的 `container_id` 或 `container_name`。
- 文件工具保持“先读后改”的约束；远端文件修改按 `asset + container + path` 串行排队，避免并发覆盖。
- `hexhub_read` 增加 Pi 侧 `offset`/`limit`，在结果进入模型前按行裁剪。
- `hexhub_docker_logs` 提供合理的默认 tail 行数，并允许本地二次过滤。
- `hexhub_terminal_expect` 保留 HexHub 的 idle/match/timeout 语义，但缩短常用参数描述。
- SQL 的 `db`、`schema` 不做危险猜测；缺失时返回缓存中的可选范围和下一步调用建议。
- Redis 仍由 HexHub 服务端根据命令和权限区分读写，扩展不自行实现不完整的 Redis 命令解析器。

## 10. 结果压缩策略

| 类型 | 模型可见结果 |
| --- | --- |
| 资产 | 紧凑表格，只含短键、类型、名称、主机/路径/数据库类型等可读字段 |
| Shell | 命令摘要、exit code、stdout/stderr；默认保留末尾，避免日志前部挤占上下文 |
| 文件读取 | 带行窗口标记的文本；支持 `offset`/`limit` 后续读取 |
| 文件修改 | 修改摘要和目标，不重复完整文件内容 |
| Docker 容器 | 名称、镜像、状态、健康状态的紧凑列表 |
| Docker 日志 | tail 优先，保留时间戳/过滤信息和截断状态 |
| DB metadata/DDL | 紧凑对象列表或 DDL；去掉重复包装 JSON |
| SQL 结果 | 列名 + 有界行表格 + 行数/截断信息；不重复 structuredContent 与 text fallback |
| Redis | 按标量、列表、键值或游标结果紧凑格式化 |
| 交互终端 | 只返回选定窗口、匹配原因、是否 timeout/idle/user-intervened |
| 隧道 | 返回 Pi 实际可访问的地址；原始 Windows 端口只放内部 details |

统一遵守 Pi 的 50 KiB/2000 行上限，但各工具使用更小的领域预算。默认不把 SQL、Redis、终端或 shell 的完整截断输出写入临时文件；需要继续时优先缩小查询、分页或 tail。确需 artifact 的工具必须使用私有权限、脱敏提示和显式策略。

## 11. MCP 客户端与恢复

- 使用官方 `@modelcontextprotocol/sdk` Client 和 `StreamableHTTPClientTransport`。
- transport 注入自定义 `FetchLike`，实现 Windows/WSL 选择，不改 MCP 上层逻辑。
- 连接使用 single-flight Promise，避免并发首次调用重复 initialize。
- 每次配置变化递增 generation，旧连接、旧请求和旧资产注册表不能重新成为当前状态。
- 调用传播 Pi 的 AbortSignal，并组合工具级 timeout。
- MCP session invalid/404 只重新 initialize 并重试一次。
- 401/403、用户取消和输入错误不自动重试。
- `session_shutdown` 有界关闭 transport，发送 DELETE，并清理 WSL 代理和本地缓存。

## 12. Windows 与 WSL 适配

### 12.1 自动传输选择

配置默认 `transport: "auto"`：

1. 先尝试 Node 原生 fetch。
2. Windows 下直接访问 `127.0.0.1`。
3. WSL 下若 URL 是 Windows loopback 且直连失败，自动切换到 `WindowsLoopbackFetch`。
4. 非 loopback URL 在 Windows 和 WSL 中都使用原生 fetch。
5. `/hexhub-config test` 明确显示最终选择的传输方式，不静默降级。

### 12.2 WindowsLoopbackFetch

WSL fallback 不要求管理员权限、Windows 防火墙规则或 `netsh portproxy`：

- 扩展启动 Windows PowerShell 请求 helper。
- URL、header、body 和 token 通过 stdin 传递，不出现在进程命令行。
- helper 使用 Windows `HttpClient` 访问 Windows 的 `127.0.0.1`，把状态、headers 和 base64 body 返回给 WSL。
- 每个请求可独立取消；取消时终止对应 helper 进程。
- POST 返回的有限 JSON/SSE body 转换为标准 `Response`，继续交给官方 MCP transport。
- 当前 HexHub 未声明 list-changed 通知；WSL 模式不依赖长连接 GET，目录通过 reconnect/config/test 刷新。

### 12.3 WSL 本地路径

只有 `scp_transfer.local_path` 表示 HexHub 所在机器的本地路径，需要平台转换：

- WSL `/mnt/c/...`、`/mnt/d/...` 先通过 `wslpath -w` 转为盘符路径，再编码为 `//?/X:/...`。
- WSL Linux 文件通过 `wslpath -w` 转为 `\\wsl.localhost\<distro>\...`，再编码为 `//wsl.localhost/<distro>/...`。
- Windows Pi 使用 `path.win32.resolve`，规范化后采用同一 extended/UNC wire encoding。
- 上传前在 Windows 视角确认源文件或目录存在；下载前确认目标父目录存在。路径通过静态 PowerShell helper 的 stdin JSON 传递，不进入 argv 或脚本文本。
- 相对路径从 `ctx.cwd` 解析；支持去掉一个前导 `@`。
- 规范化必须先于 `//?/` 编码，并拒绝 drive-relative、named pipe、`GLOBALROOT`、CR/LF/NUL 等不安全路径。
- SSH/Docker 的 `file_path` 是远端路径，绝不能做 Windows/WSL 转换。
- SCP 响应中的 `queued` 只表示进入 HexHub 传输队列；仅明确 `completed` 才能报告完成。

### 12.4 WSL SSH 隧道

HexHub 的 `open_ssh_tunnel` 在 Windows `127.0.0.1` 返回动态端口，该地址在当前 WSL 网络不可达。扩展在 WSL 中建立二级 loopback bridge：

1. WSL Node 在 `127.0.0.1:0` 建立临时 TCP listener。
2. 每个 WSL 客户端连接对应一个 Windows helper，helper 连接 Windows `127.0.0.1:<HexHub port>`。
3. WSL listener 与 Windows helper 通过二进制 stdin/stdout双向转发。
4. 模型只收到 WSL 可用的 `127.0.0.1:<WSL port>`。
5. `hexhub_tunnel_close` 先关闭 WSL bridge，再关闭 HexHub tunnel。
6. session shutdown 清理全部 bridge，即使模型忘记调用 close。

该方案只监听 WSL loopback，不需要把端口暴露到局域网，也不要求管理员权限。实现阶段必须先做独立二进制透传测试；若目标环境限制 PowerShell helper，则明确报告并允许手动 transport override。

## 13. `/hexhub-config`

主命令打开交互配置向导，并支持以下子命令：

| 命令 | 行为 |
| --- | --- |
| `/hexhub-config` | 打开向导 |
| `/hexhub-config show` | 显示脱敏后的生效配置和 transport |
| `/hexhub-config test` | initialize、catalog 校验、资产最小只读探测、WSL/path/tunnel prerequisites |
| `/hexhub-config reconnect` | 关闭旧会话并重新连接、刷新权限目录 |
| `/hexhub-config tools` | 显示远端开放工具、Pi 已注册/active 工具和分组 |
| `/hexhub-config reset-tools` | 恢复只激活 bootstrap + assets |
| `/hexhub-config clear` | 清理连接配置并停用 HexHub 工具 |

向导字段：

- MCP URL：允许填写根地址或完整 `/mcp` 地址；根地址自动补 `/mcp`。
- Transport：`auto`、`direct`、`windows-helper`。
- HTTP/tool timeout。
- 可选 token 来源：环境变量或全局配置；当前本机端点无需 token，但保留兼容 `Authorization`/`X-HexHub-MCP-Token` 的能力。
- 初始工具策略：默认仅 bootstrap + assets。
- 可选项目行为覆盖：默认资产、输出预算、初始组；不允许项目覆盖全局 endpoint/token。

URL 修改保存后立即：关闭旧连接 -> 递增 generation -> 清空资产/容器/隧道缓存 -> 建立新连接 -> 校验目录 -> 更新 active tools/status。无需 `/reload`。

## 14. 配置与安全边界

- 全局连接配置：`$PI_CODING_AGENT_DIR/hexhub.json`，默认 `~/.pi/agent/hexhub.json`。
- 项目行为配置：`<project>/.pi/hexhub.json`，仅在项目受信任时读取。
- endpoint 和 credential 始终属于同一全局连接配置，项目不能继承 token 后替换 endpoint。
- URL 禁止内嵌用户名/密码，移除 fragment，拒绝非 HTTP(S)。
- 默认允许 loopback HTTP；远程 HTTP 必须显式确认，远程生产地址推荐/要求 HTTPS。
- token 不接受为 slash-command 参数，不出现在通知、异常、details 或命令行。
- 配置原子写入；POSIX 下目录 `0700`、文件 `0600`，Windows 下提示 ACL 才是实际边界。
- 动态目录限制工具名字符、description 大小、schema 字节数和递归深度。
- 服务端权限是授权事实源；本地 active/inactive 只控制模型可见性。
- Docker control、SQL mutation、Redis write、远程文件删除和交互终端仍遵守 HexHub 服务端确认。Pi 侧只增加明确的高风险提示/可选二次确认，不自行绕过或替代服务端 SQL/Redis 解析。

## 15. 计划文件结构

```text
pi-Hexhub/
├─ package.json
├─ tsconfig.json
├─ README.md
├─ DESIGN.md
├─ extensions/
│  └─ hexhub/
│     ├─ index.ts
│     ├─ config.ts
│     ├─ config-ui.ts
│     ├─ catalog.ts
│     ├─ tools.ts
│     ├─ mcp-client.ts
│     ├─ transport.ts
│     ├─ windows-fetch.ts
│     ├─ wsl.ts
│     ├─ tunnel-bridge.ts
│     ├─ asset-registry.ts
│     ├─ input-adapters.ts
│     ├─ result-formatters.ts
│     ├─ result.ts
│     └─ redaction.ts
└─ test/
   ├─ mcp-client.test.ts
   ├─ catalog.test.ts
   ├─ tools.test.ts
   ├─ config.test.ts
   ├─ windows-fetch.test.ts
   ├─ wsl-paths.test.ts
   ├─ tunnel-bridge.test.ts
   ├─ result.test.ts
   └─ integration.test.ts
```

运行时依赖放在 `dependencies`；Pi 自带包和 `typebox` 放在 `peerDependencies`。包清单通过 `pi.extensions` 加载 `extensions/hexhub/index.ts`。

## 16. 测试矩阵

### 协议

- MCP initialize/initialized、JSON 和请求级 SSE。
- Session ID 获取、复用、DELETE 关闭。
- 分页 tools/list、重复 cursor、空目录、非法 schema。
- JSON-RPC error、HTTP error、session invalid 单次重试。
- AbortSignal、timeout、配置变化使旧 generation 失效。

### 动态权限与目录

- SSH-only、Docker-only、DB-only、Redis-only、组合权限。
- 缺少工具不影响其他领域。
- 工具撤权后 inactive，旧调用被 catalog epoch 拒绝。
- description 变化与 schema 不兼容变化分别处理。
- 未知工具只报告，不自动暴露。

### 渐进披露

- 初始只有两个 HexHub 工具 active。
- loader 按 query/group 只增加目标组且幂等。
- 不移除 Pi/其他扩展工具。
- reset/clear/reconnect 正确收缩自身 active 集。
- 序列化 schema token 预算回归测试。

### 领域能力

- SSH shell、读写改删、SCP、隧道、交互终端完整链路。
- Docker 列表、日志、控制以及容器内 shell/file。
- 数据库对象、DDL、查询和需确认的 SQL mutation。
- Redis 读命令、写命令、权限拒绝和大结果。
- 所有结果格式化、structuredContent 优先、截断和脱敏。

### Windows/WSL

- Windows direct fetch。
- WSL direct 可用时不启 helper。
- WSL loopback fallback 的 POST/DELETE、header/body、取消和 timeout。
- token 不出现在 helper 命令行。
- `/mnt/<drive>`、WSL UNC、相对路径、前导 `@` 转换。
- WSL tunnel bridge 双向二进制、多连接、close 和 shutdown 清理。

### 安全

- 项目配置不能覆盖 endpoint/token。
- URL credential 拒绝、远程 HTTP 显式确认。
- token 从错误、结果和 details 中脱敏。
- 远端 mutation 排队，无同目标并发覆盖。
- 敏感大结果默认不落盘。

## 17. 验收标准

1. `npm run check`、Pi Jiti loader 验证和 `npm pack --dry-run` 全部通过。
2. Windows Pi 可通过 `/hexhub-config` 配置并调用全部已授权领域。
3. WSL Pi 在 HexHub 仅监听 Windows loopback 时无需管理员配置即可连接。
4. WSL 的 SCP 本地路径和 SSH tunnel 返回地址可直接被 WSL 进程使用。
5. 当前权限变化不会导致整个扩展失效；未授权工具不会出现在 active set。
6. 初始 HexHub 工具定义相对当前直接 MCP 基线至少减少 90%。
7. 所有 24 个已知远端工具都有静态 schema、适配器、风险策略、结果策略和测试。
8. URL 在 Pi 运行时修改后立即生效，无需重启或 reload。
9. 不覆盖 Pi 内置工具，不泄漏真实 asset_ref/token，不把未知工具自动暴露给模型。

## 18. 实施阶段

1. **协议与目录基线**：建立 package、mock MCP、静态目录、schema 兼容检查和 token 基准。
2. **连接与配置**：官方 SDK client、generation 状态机、`/hexhub-config`、重连和状态。
3. **渐进工具层**：loader、分组、资产注册表、所有输入适配器。
4. **领域结果层**：SSH/Docker/DB/Redis/terminal 格式化和安全截断。
5. **Windows/WSL**：WindowsLoopbackFetch、路径转换、WSL tunnel bridge。
6. **集成验证**：Windows + WSL 真实 HexHub smoke tests、token 预算、Jiti loader、pack 检查。

每一阶段测试通过后再进入下一阶段；不会把 WSL 适配留到发布后补做。

## 19. 开发前需要确认

1. **Redis 权限**：当前 `tools/list` 没有暴露 `redis_command`。实现 Redis 静态 schema 和真实集成测试时，需要临时在 HexHub MCP 权限档案中开启 Redis 工具，测试后可恢复原权限。
2. **未知新工具策略**：本方案默认“只报告、不自动暴露”，待人工审查后随扩展升级加入。
3. **WSL 策略**：本方案默认内置 PowerShell loopback helper 和 WSL 本地 tunnel bridge，不要求用户执行管理员级 `netsh` 或开放防火墙端口。
4. **配置边界**：本方案默认 URL/token 只允许全局配置，项目仅覆盖行为参数。

以上四项确认后再开始写实现代码。
