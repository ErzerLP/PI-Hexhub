# pi-Hexhub

`pi-Hexhub` 是面向 [Pi](https://github.com/badlogic/pi-mono) 的 HexHub MCP 扩展。它不是原样转发 MCP 目录，而是针对 HexHub 的资产、权限和 Windows/WSL 运行方式提供：

- 24 项静态审查工具目录，服务端 `tools/list` 只作为当前权限和兼容性事实源；
- 渐进式工具激活，初始只暴露 `hexhub_tools` 与 `hexhub_assets`；
- 会话内短资产键与容器键，不向模型显示 `asset_ref`、内部资产 ID 或路由字段；
- SSH、远程文件、Docker、数据库、Redis、SCP、SSH tunnel 和交互终端支持；
- Windows 原生直连和 WSL 到 Windows loopback 的流式 PowerShell transport；
- 按领域压缩、截断和脱敏的工具结果；
- 运行时 `/hexhub-config` 配置、测试、重连和工具管理。

完整设计与安全边界见 [DESIGN.md](./DESIGN.md)。

## 要求

- Node.js `>=22.19.0`
- Pi `0.84.2` 兼容 API
- HexHub `5.3.9` 或兼容的 Streamable HTTP MCP 服务
- WSL 模式需要 Windows PowerShell 可通过 `powershell.exe` 调用

## 安装

本地开发目录：

```bash
pi install /mnt/d/mywork/pi/pi-Hexhub
```

也可以直接加载扩展：

```bash
cd /mnt/d/mywork/pi/pi-Hexhub
pi -e ./extensions/hexhub/index.ts
```

安装或更新后重启 Pi。默认连接地址为：

```text
http://127.0.0.1:17321/mcp
```

## 快速开始

1. 启动 HexHub，并在 HexHub 中启用所需 MCP 权限。
2. 启动 Pi。扩展会自动连接默认地址。
3. 调用 `hexhub_assets` 获取当前可用资产的短键。
4. 需要某个领域时调用 `hexhub_tools`，例如：

```json
{
  "query": "查看 Docker 容器最近日志"
}
```

也可以显式加载组：

```json
{
  "groups": ["docker-read"]
}
```

组激活只做 additive merge，不会移除 Pi 内置工具或其他扩展工具。服务端撤销权限或 schema 变得不兼容时，对应 HexHub 工具会从 active set 中移除。

## 配置命令

```text
/hexhub-config
/hexhub-config show
/hexhub-config test
/hexhub-config reconnect
/hexhub-config tools
/hexhub-config reset-tools
/hexhub-config clear
```

- 无参数：交互修改 URL、transport、timeout、认证和初始工具组，保存后立即重连。
- `show`：显示脱敏后的生效配置与连接状态。
- `test`：使用独立临时 MCP session 执行 initialize、`tools/list` 和一次只读 `list_assets` 探测，不影响当前 session。
- `reconnect`：重建 MCP session、刷新目录并撤销失效工具。
- `tools`：显示 active、unavailable、incompatible 和 report-only unknown 工具。
- `reset-tools`：恢复 bootstrap、assets 和配置中的初始组。
- `clear`：删除全局连接配置并禁用当前 session 的 HexHub 工具；受信项目的行为配置不会被删除。

URL 和 token 不接受 slash-command 参数，避免进入命令历史。明文 token 保存需要交互确认；优先使用环境变量认证。

## 配置文件

全局连接配置位于：

```text
~/.pi/agent/hexhub.json
```

设置 `PI_CODING_AGENT_DIR` 时使用 `$PI_CODING_AGENT_DIR/hexhub.json`。示例：

```json
{
  "version": 1,
  "url": "http://127.0.0.1:17321/mcp",
  "transport": "auto",
  "timeoutMs": 30000,
  "auth": {
    "type": "env",
    "env": "HEXHUB_TOKEN",
    "header": "authorization"
  },
  "initialGroups": []
}
```

认证也支持：

```json
{ "type": "none" }
```

以及 HexHub token header：

```json
{
  "type": "env",
  "env": "HEXHUB_TOKEN",
  "header": "x-hexhub-token"
}
```

受信项目可以使用 `.pi/hexhub.json` 覆盖行为配置：

```json
{
  "version": 1,
  "initialGroups": ["database-meta"]
}
```

项目配置不能覆盖 URL、transport、timeout 或认证。该限制防止项目将全局凭据转发到攻击者控制的地址。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `HEXHUB_MCP_URL` | MCP URL；兼容 `HEXHUB_URL` |
| `HEXHUB_TRANSPORT` | `auto`、`direct` 或 `windows-helper` |
| `HEXHUB_TIMEOUT_MS` | 请求和工具超时 |
| `HEXHUB_TOKEN` | 默认 token 环境变量 |
| `HEXHUB_TOKEN_ENV` | 指定另一个保存 token 的环境变量名 |
| `HEXHUB_AUTH_HEADER` | `authorization` 或 `x-hexhub-token` |
| `HEXHUB_INITIAL_GROUPS` | 逗号分隔的初始组 |

已保存的全局配置覆盖环境变量中的对应默认值。

## 工具组

初始工具：

| Pi 工具 | 作用 |
| --- | --- |
| `hexhub_tools` | 本地语义路由与渐进式组激活 |
| `hexhub_assets` | 列出资产并生成会话内短键 |

按需组：

| 组 | 工具 |
| --- | --- |
| `shell` | `hexhub_shell` |
| `files-read` | `hexhub_read` |
| `files-write` | `hexhub_write`、`hexhub_edit`、`hexhub_multi_edit`、`hexhub_delete` |
| `docker-read` | `hexhub_docker_containers`、`hexhub_docker_logs` |
| `docker-control` | `hexhub_docker_action` |
| `database-meta` | `hexhub_db_objects`、`hexhub_db_ddl` |
| `database-sql` | `hexhub_sql` |
| `redis` | `hexhub_redis` |
| `transfer` | `hexhub_scp` |
| `tunnel` | `hexhub_tunnel_open`、`hexhub_tunnel_close` |
| `terminal` | `hexhub_terminals` 及 open/close/send/key/read/expect 工具 |

某项权限未开启时，该工具保持已注册但 inactive，不会导致整个连接失败。HexHub 新增的未知工具只在诊断中报告，审查前不会自动暴露。

## Windows 与 WSL

`transport: "auto"` 的选择规则：

- Windows 原生和普通网络端点使用 direct fetch；
- WSL 访问 Windows `localhost`/loopback 时使用 PowerShell `HttpClient` helper；
- 非 loopback 的 HTTP URL 被拒绝，远端地址必须使用 HTTPS。

PowerShell helper 支持 POST、GET SSE、DELETE、流式响应和取消。URL、headers、token 与 body 通过 stdin 传递，不进入命令行参数。

`hexhub_scp` 在 WSL 中只转换 `local_path`：WSL 路径通过 `wslpath -w -- <path>` 转成 Windows 路径，远端路径保持不变。

HexHub 创建的 SSH tunnel 监听 Windows loopback。扩展在 WSL 中创建 `127.0.0.1` 本地桥，并通过按连接启动的 PowerShell 二进制 relay 转发到 Windows 端口。模型只看到 Pi 实际可访问的 WSL 地址。

## 安全与结果处理

- HTTP 默认仅允许 loopback；远端连接要求 HTTPS。
- URL credential 被拒绝；token、session、`asset_ref` 和内部 ID 会从错误与结果中脱敏。
- 文件写入、编辑和删除要求同一 session 中先读取同一目标，并按资产、容器和路径串行执行。
- Docker 控制、非查询 SQL、Redis 写命令等最终确认仍由 HexHub 服务端权限和确认卡负责。
- SQL、Redis、shell 和终端的截断输出不会自动写入 artifact，避免把敏感数据持久化。
- 所有结果受 50 KiB/2000 行总上限和更小的领域预算约束。

## 开发验证

```bash
npm install
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

测试覆盖配置边界、MCP session 恢复、24 项目录兼容性、短资产键、输入适配、结果预算、渐进激活、Windows/WSL fetch、tunnel relay 和完整 Pi 生命周期。

Pi 原生 loader 检查：

```bash
node --input-type=module - <<'NODE'
import { discoverAndLoadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const result = await discoverAndLoadExtensions(["./extensions/hexhub/index.ts"], process.cwd());
const extension = result.extensions[0];
console.log({ errors: result.errors, tools: extension?.tools.size, commands: extension?.commands.size });
NODE
```

预期为 0 个加载错误、25 个工具和 1 个命令。

## License

MIT
