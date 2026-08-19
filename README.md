# pi-Hexhub

> 基于 HexHub 原生 MCP 的 Pi 专用优化层：保留 HexHub 服务端能力、权限和确认机制，同时解决直接 MCP 桥接的上下文开销、资产标识暴露、结果噪声及 Windows/WSL 可达性问题。

`pi-Hexhub` 直接使用 HexHub 提供的 Streamable HTTP MCP endpoint，不复制、不替换也不修改 HexHub 后端。扩展通过官方 MCP SDK 调用原始工具，在 Pi 客户端侧增加经过审查的 schema、输入适配、渐进式披露、结果处理和跨平台 transport。

它不是把 `tools/list` 原样注册到 Pi。基于 HexHub `5.3.9` 的实测，当前权限下原始 MCP 一次暴露 23 项工具，完整定义共 **29,181 字符，约 7,296 tokens**。`pi-Hexhub` 初始只向模型暴露 `hexhub_tools` 和 `hexhub_assets`，定义共 **704 字符，约 176 tokens**，初始工具上下文减少 **97.59%**；其余能力按任务动态加载。

## 相比直接 MCP 桥接的优化

| 维度 | 直接桥接原始 MCP | pi-Hexhub 优化 |
| --- | --- | --- |
| 工具上下文 | 一次注入当前 23 项完整 schema，约 7,296 tokens | 初始 2 项、约 176 tokens，按 SSH、文件、Docker、数据库等任务逐组激活 |
| 工具目录 | `tools/list` 返回什么就暴露什么，新工具可能未经客户端审查直接进入模型上下文 | 本地审查 24 项已知工具；服务端目录只决定权限与兼容性，未知工具仅报告、不自动开放 |
| 权限变化 | 通常只在连接时读取目录，运行中容易保留已撤销工具 | 重连和目录刷新后重新计算 active set；权限撤销、工具消失或 schema 不兼容会立即停用对应工具 |
| 资产选择 | 模型直接处理不透明 `asset_ref`、容器内部 ID 和路由字段 | `list_assets` 结果转成会话级短资产键和容器键；调用前在本地解析，内部标识不进入模型 schema |
| HexHub 领域适配 | 模型需要自行理解每项原始 schema 和资产类型差异 | 针对 SSH、远程文件、Docker、数据库、Redis、SCP、tunnel 和交互终端提供固定分组、简化参数和输入校验 |
| 文件修改 | 原始写工具可被直接调用 | `write/edit/multi_edit/delete` 要求同一连接代内先读取同一目标，并按资产、容器和路径串行执行 |
| 工具结果 | 原始 JSON、日志、SQL 行和终端输出可能重复、过长或泄露内部字段 | 按领域选择 head/tail、表格化和分页窗口，实施单工具预算、50 KiB/2000 行总上限及深度脱敏 |
| Windows/WSL | WSL 通常无法直连仅监听 Windows `127.0.0.1` 的 HexHub MCP 和 SSH tunnel | 自动使用流式 PowerShell `HttpClient` helper；SCP 路径经安全 `wslpath` 转换；Windows tunnel 映射为 WSL 本地 bridge |
| MCP 生命周期 | 通用桥常缺少针对 HexHub session 的恢复和运行时重配置 | single-flight 连接、generation 隔离、失效 session 单次恢复、取消传播、运行时 `/hexhub-config` 重连和有界关闭 |
| 安全边界 | 项目配置可能改变 endpoint 或把凭据发送到其他地址 | URL/token 仅允许全局配置；受信项目只能配置初始工具组；远端必须 HTTPS，凭据不进入命令参数或诊断输出 |

这些优化全部位于 Pi 扩展侧。最终工具执行、资产授权、Docker 控制确认、非查询 SQL 确认、Redis 写命令确认等仍由 **原始 HexHub MCP 服务端**负责，扩展不会绕过或模拟 HexHub 的权限判断。

## 核心能力

- 24 项静态审查工具目录，服务端 `tools/list` 作为当前权限和 schema 兼容性的事实源；
- 渐进式工具激活，初始只暴露 `hexhub_tools` 与 `hexhub_assets`；
- 会话内短资产键与容器键，不向模型显示 `asset_ref`、内部资产 ID 或路由字段；
- SSH、远程文件、Docker、数据库、Redis、SCP、SSH tunnel 和交互终端支持；
- Windows 原生直连和 WSL 到 Windows loopback 的流式 PowerShell transport；
- 按领域压缩、截断和脱敏的工具结果；
- 运行时 `/hexhub-config` 配置、测试、重连和工具管理。

完整设计、协议基线和安全边界见 [DESIGN.md](./DESIGN.md)。

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

- 无参数：打开中文交互配置向导。开始时会汇总全部默认值和当前值，每个输入步骤也会标明当前值、默认值、留空行为与必要的安全说明；保存后立即重连。
- `show`：用中文显示当前配置、每项默认值、配置来源与连接状态。
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
