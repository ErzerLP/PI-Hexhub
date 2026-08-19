# SCP 客户端兼容修复方案

状态：已实现并验证
调查日期：2026-08-19
适用项目：pi-Hexhub
约束：HexHub MCP 服务端闭源，本方案仅修改 pi-Hexhub 客户端

## 1. 结论

`hexhub_scp` 失败不是 SSH、SCP 权限、文件存在性、WSL 路径转换或 MCP 传输问题，而是 HexHub 5.3.9 在 Windows 上存在互相矛盾的两层本地路径校验：

1. MCP 入口只接受以 `/` 开头的 `local_path`。
2. 下游 Windows 文件传输队列要求真正的 Windows absolute path。

pi-Hexhub 修复前按公开 schema 把 WSL 路径正确转换为 `D:\...` 或 `\\wsl.localhost\...`。这些路径对 Windows 是有效绝对路径，但会在第一层被拒绝。把路径简单改成 `/D:/...` 虽可越过第一层，又会在第二层失败。

客户端可使用同时满足两层校验、并被 Windows 文件 API 正确解析的 wire encoding：

- 盘符路径：`D:\dir\file` -> `//?/D:/dir/file`
- UNC 路径：`\\server\share\dir\file` -> `//server/share/dir/file`
- WSL 原生路径经 `wslpath -w` 得到 UNC 后，使用同一 UNC encoding

该兼容形式已经通过真实上传和下载验证，不需要服务端修改。

同时发现第二个客户端缺陷：服务端成功接收 SCP 后返回 `status: "queued"`，而修复前的 `formatTransfer()` 无条件向模型报告 `completed`。修复必须同时处理路径编码和异步状态语义。

## 2. 已验证环境

- HexHub：5.3.9
- Runtime：`244-b66858a42cbc70414cdab137e91516b0`
- Backend SHA-256：`25417d4a8746af4efce4b6fd55a961ad1d4f99aded9a54e16c6f85bb7b8d1a0e`
- Backend：Windows amd64，Go 1.26.1
- Pi：WSL Linux
- MCP transport：Windows PowerShell HTTP helper
- SSH 资产：已通过 shell、文件、terminal 和 tunnel 验证

本次所谓服务端更新没有替换上述 runtime 二进制；它更新了 Redis 工具/资产可见性，但 SCP 校验实现保持不变。

## 3. 根因证据

### 3.1 pi-Hexhub 输出的是有效 Windows 路径

修复前 `createHexHubLocalPathHook()` 的实测结果：

| 输入 | 发送前转换结果 | Windows absolute |
| --- | --- | --- |
| `/mnt/d/mywork/pi/file.txt` | `D:\mywork\pi\file.txt` | 是 |
| `D:\mywork\pi\file.txt` | 原样 | 是 |
| WSL `/tmp/file.txt` | `\\wsl.localhost\Ubuntu\tmp\file.txt` | 是 |
| Windows `%TEMP%` 文件 | `C:\Users\...\Temp\file.txt` | 是 |

Windows PowerShell 的 `[IO.Path]::IsPathRooted()` 和 `[IO.File]::Exists()` 均确认测试路径有效且文件存在。

因此，错误发生在 `wslpath` 成功之后，不是 pi-Hexhub 把绝对路径变成了相对路径。

### 3.2 HexHub MCP 入口使用 POSIX 前缀规则

从当前闭源 backend 二进制中可恢复出 SCP 参数校验逻辑。其行为等价于：

```text
trim(local_path)
if empty: reject
if not startsWith("/"): reject as non-absolute
```

这精确解释了以下路径为何全部返回：

```text
local_path must be an absolute path on the local machine
```

被拒绝的路径包括：

- `D:\...`
- `D:/...`
- `C:\...`
- `\\?\C:\...`
- `\\localhost\C$\...`
- 普通 UNC 路径

### 3.3 下游传输队列使用 Windows absolute 规则

绕过 pi-Hexhub adapter，直接向 MCP 发送 `/D:/...` 和 `/tmp/...` 后，第一层校验通过，但下游返回另一条错误：

```text
localPath must be an absolute path
```

这证明调用链至少有两层校验：

| 路径 | MCP `startsWith("/")` | Windows absolute | 结果 |
| --- | --- | --- | --- |
| `D:\dir\file` | 失败 | 通过 | 第一层拒绝 |
| `/D:/dir/file` | 通过 | 失败 | 第二层拒绝 |
| `/tmp/file` | 通过 | 失败 | 第二层拒绝 |
| `//?/D:/dir/file` | 通过 | 通过 | 可传输 |
| `//server/share/file` | 通过 | 通过 | 可传输 |

根因不是单一格式错误，而是闭源服务端两层校验的交集只覆盖正斜杠形式的 Windows extended/UNC 路径。

## 4. 客户端兼容方案的实测结果

以下调用均绕过现有 adapter，仅改变发给 `scp_transfer.local_path` 的 wire value；SSH 资产、MCP 会话和远端路径保持一致。

### 4.1 上传

| 本地来源 | wire path | MCP 返回 | 远端验证 |
| --- | --- | --- | --- |
| `/mnt/d/.../file` | `//?/D:/.../file` | `queued` | 内容一致 |
| WSL `/tmp/file` | `//wsl.localhost/Ubuntu/tmp/file` | `queued` | 内容一致 |
| Windows drive file | `//?/D:/.../file` | `queued` | 内容一致 |

`//localhost/D$/...` 和 `//127.0.0.1/D$/...` 也成功，但依赖管理员共享，不应作为正式实现。

### 4.2 下载

| 远端来源 | 本地目标 wire path | MCP 返回 | 本地验证 |
| --- | --- | --- | --- |
| SSH `/tmp/proof.txt` | `//?/D:/.../download.txt` | `queued` | 内容一致 |
| SSH `/tmp/proof.txt` | `//wsl.localhost/Ubuntu/tmp/download.txt` | `queued` | 内容一致 |

Windows 侧也能看到两个下载结果。测试完成后，Windows、WSL 和 SSH 远端临时文件均已清理。

## 5. 修复范围

### 5.1 必须修复

1. Windows/WSL SCP `local_path` 的 HexHub wire encoding。
2. 上传源和下载目标的本地前置检查。
3. `queued` 结果不能格式化为 `completed`。
4. 上传、下载、盘符路径和 WSL UNC 的自动化测试。
5. 明确异步任务只能确认“已排队”，不能确认“已完成”。

### 5.2 不在本次范围

- 不修改或注入 HexHub 服务端。
- 不尝试反编译后打补丁。
- 不绕过 HexHub 的资产授权、覆盖确认或传输队列。
- 不使用 `C$`/`D$` 管理员共享作为正式方案。
- 不轮询未公开的内部 API。
- 不把远端 `remote_path` 做 Windows/WSL 转换。
- 不新增依赖。

## 6. 详细设计

### 6.1 分离“本地路径”和“wire path”

路径处理分为三个阶段：

1. `logicalPath`：用户或模型传给 Pi 的路径。
2. `windowsPath`：Windows 实际可访问的规范路径。
3. `wirePath`：为适配 HexHub 两层校验而编码的路径。

现有 adapter 直接把 `windowsPath` 发给服务端，缺少第三阶段。

建议在 `extensions/hexhub/platform.ts` 增加纯函数：

```ts
encodeHexHubWindowsScpPath(windowsPath: string): string
```

该函数只负责 wire encoding，不访问文件系统，不启动进程，便于穷举单测。

### 6.2 盘符路径编码

输入必须先使用 `win32.normalize()` 规范化，消除 `.`、`..` 和混合分隔符，再编码：

```text
D:\dir\file.txt -> //?/D:/dir/file.txt
c:\a b\file     -> //?/C:/a b/file
```

要求：

- 盘符转大写，便于稳定测试和日志对比。
- 只接受 `^[A-Za-z]:[\\/]`，拒绝 `C:relative`。
- 在加 `//?/` 前完成规范化；extended path 会关闭部分 Win32 自动规范化，不能先编码再处理 `..`。
- 不接受用户直接注入 `GLOBALROOT`、device namespace 或 named pipe。

### 6.3 UNC 路径编码

```text
\\wsl.localhost\Ubuntu\tmp\file
  -> //wsl.localhost/Ubuntu/tmp/file

\\server\share\dir\file
  -> //server/share/dir/file
```

要求：

- 必须包含非空 server 和 share。
- 拒绝 `\\.\pipe\...`。
- 对 `\\?\UNC\server\share\...` 先规范化为普通 UNC，再转正斜杠。
- 不把普通 UNC 转成管理员共享。
- 已是 `//server/share/...` 的合法 wire path 应保持幂等。

### 6.4 WSL 路径流程

WSL 模式继续使用当前安全调用：

```text
wslpath -w -- <absolute-posix-path>
```

保持：

- `shell: false`
- 路径只作为单独 argv 元素
- 有界 stdout/stderr
- timeout 和 AbortSignal

获得 `windowsPath` 后，再调用 `encodeHexHubWindowsScpPath()`：

- `/mnt/c`、`/mnt/d` 通常进入盘符编码分支。
- WSL ext4 路径通常进入 `wsl.localhost` UNC 分支。

### 6.5 Windows 原生流程

Windows Pi：

1. 绝对路径先 `win32.normalize()`。
2. 相对路径先基于 `ctx.cwd` 使用 `win32.resolve()`。
3. 编码为 extended/UNC wire path。

不要把 `//?/` 路径传回模型；它仅存在于内部远端参数。

### 6.6 非 Windows 平台

Linux/macOS direct transport 保持现有 POSIX 路径，不应用 Windows encoding。

若未来支持远程 Windows HexHub endpoint，必须明确 `local_path` 是 HexHub 所在机器上的路径，不是 Pi 客户端文件。当前修复不声称跨机器上传本地文件。

## 7. 本地前置检查

HexHub 返回 `queued` 后没有公开任务状态查询工具，因此本地前置检查很重要，否则路径可被接受但任务可能后台失败。

建议增加 `probeWindowsScpPath()`：

### 上传

- Windows 视角确认源文件或目录存在。
- 确认路径类型是普通文件或目录。
- 拒绝 device、pipe 和无效 namespace。

### 下载

- Windows 视角确认目标父目录存在。
- 目标已存在时保留 HexHub 的 `overwrite`/确认语义，不在客户端绕过。
- 不通过创建探测文件来测试写权限，避免额外副作用。

### 实现安全要求

- 使用现有 `spawnPowerShellScript()` 模式。
- PowerShell 脚本为静态常量。
- 原始路径通过 stdin JSON 传递，不插入脚本文本，不进入命令行。
- `-LiteralPath` 访问路径。
- stdout 只返回固定结构，例如 `{ exists, kind, parentExists }`。
- stderr、stdout、执行时间均有界。
- 支持 AbortSignal。
- 错误信息不输出 token、asset_ref 或未经截断的 PowerShell stderr。

为保持可测试性，`HexHubLocalPathOptions` 增加可注入 probe；单测不启动真实 PowerShell。

## 8. 修正传输结果语义

修复前实现：

```ts
function formatTransfer(prepared): string {
  return `SCP ... completed ...`;
}
```

服务端真实成功响应是：

```json
{
  "task_id": "...",
  "direction": "upload",
  "status": "queued"
}
```

因此应改为读取 sanitized payload：

| 服务端状态 | 模型输出语义 |
| --- | --- |
| `queued` | 已加入 HexHub 传输队列，尚未确认完成 |
| `running` | 正在传输，尚未确认完成 |
| `completed` | 仅此时可报告完成 |
| `failed` | 报告失败，但不暴露内部资产信息 |
| 未知/缺失 | HexHub 已接受请求，完成状态未知 |

当前 MCP 没有 transfer task status 工具。客户端不得自行把等待若干秒等同于完成，也不得调用未公开内部接口。

建议保留可用于 HexHub UI 排查的 task ID，但先经过长度和字符集校验；若产品安全策略认为 task ID 属于内部标识，则仅保留在 tool details，不进入正文。

## 9. 文件修改计划

预计修改：

- `extensions/hexhub/platform.ts`
  - 增加纯 wire encoder。
  - Windows/WSL local path hook 在规范化后调用 encoder。
- `extensions/hexhub/powershell.ts` 或新建 `extensions/hexhub/windows-path-probe.ts`
  - 增加 stdin 驱动的 Windows 路径前置检查。
- `extensions/hexhub/result-formatters.ts`
  - 根据服务端 payload 输出 queued/running/completed/failed。
- `test/platform.test.ts`
  - 路径编码矩阵、幂等、非法 namespace、取消和注入安全。
- `test/input-adapters.test.ts`
  - 确认 wire path 只应用于 `scp_transfer.local_path`。
- `test/result-formatters.test.ts`
  - queued 不得出现 completed。
- `test/tool-controller.test.ts`
  - 端到端确认发给 MCP 的参数是 compat wire path。
- `README.md`、`DESIGN.md`
  - 实现验证后再更新，不在方案评审阶段提前宣称已修复。

优先将 PowerShell probe 放入独立文件，避免继续增加 `platform.ts` 的进程管理复杂度。

## 10. 自动化测试矩阵

### 10.1 纯路径编码

至少覆盖：

- `C:\file`
- 小写盘符
- 含空格路径
- 含非 ASCII 路径
- 混合 `/` 和 `\`
- `.`、`..`
- 盘符根目录
- 普通 UNC
- WSL `wsl.localhost` UNC
- extended drive 输入的幂等处理
- extended UNC 输入
- `C:relative` 拒绝
- `\\.\pipe` 拒绝
- `GLOBALROOT` 拒绝
- 空 server/share 拒绝
- CR/LF/NUL 拒绝

### 10.2 平台 hook

- WSL `/mnt/d` -> `wslpath` -> `//?/D:/...`
- WSL ext4 -> `wslpath` -> `//wsl.localhost/...`
- Windows relative path -> resolve -> encode
- 非 Windows POSIX 路径保持不变
- `remote_path` 永远不转换
- `@` 前缀只剥离一次
- abort/timeout 正确终止子进程
- 路径不进入 PowerShell命令行或脚本文本

### 10.3 前置检查

- upload 文件存在
- upload 目录存在
- upload 不存在立即失败，不排队
- download 父目录存在
- download 父目录不存在立即失败
- PowerShell 不可用、超时、异常输出均有界
- probe 结果不包含本地用户名、token 或 asset_ref

### 10.4 结果格式化

- queued -> “已排队，未确认完成”
- running -> “进行中”
- completed -> “完成”
- failed -> “失败”
- 未知状态 -> “已接受，状态未知”
- asset_ref/asset_id 深度脱敏
- task ID 长度和字符限制

### 10.5 实机 gated smoke

不放入默认 `npm test`，由显式环境变量启用：

1. WSL `/mnt/d` 小文件上传并校验远端内容。
2. WSL ext4 小文件上传并校验远端内容。
3. 下载到 `/mnt/d` 并校验内容。
4. 下载到 WSL ext4 并校验内容。
5. 带空格文件名。
6. 小目录传输。
7. overwrite false 冲突路径。
8. 全部临时文件、终端和任务痕迹清理。

## 11. 验收标准

实现完成必须同时满足：

1. 正常调用 `hexhub_scp`，用户可继续传入 WSL/Windows 常规路径，不需要知道 `//?/`。
2. `/mnt/c`、`/mnt/d`、WSL ext4、Windows 原生 drive path 均可上传。
3. 下载到挂载盘和 WSL ext4 均可成功。
4. MCP wire 中 drive path 为 `//?/X:/...`，UNC 为 `//server/share/...`。
5. `remote_path` 字节级保持不变。
6. queued 响应绝不显示 completed。
7. 不使用管理员共享。
8. 不把路径、token 或 body 放进 PowerShell argv。
9. 不降低 HexHub 的权限和覆盖确认。
10. TypeScript、全部单测、Pi native loader、Lens/LSP、敏感信息扫描通过。
11. 实机 smoke 验证内容一致并完成清理。

## 12. 实施顺序

1. 添加纯 `encodeHexHubWindowsScpPath()` 和单测。
2. 接入 Windows/WSL local path hook。
3. 添加 Windows 视角 preflight 和注入测试。
4. 修复 transfer result formatter。
5. 增加 adapter/controller/result 回归测试。
6. 运行完整项目验证。
7. 在安装副本临时应用并 `/reload`。
8. 运行四条实机上传/下载 smoke。
9. 更新 README/DESIGN。
10. 经用户确认后提交；推送需要单独明确授权。

## 13. 风险与控制

### extended path 规范化

`//?/` 会改变 Win32 的规范化行为。必须在编码前消除 `.`/`..`，不能直接给未经规范化的用户输入添加前缀。

### 设备路径

extended namespace 可访问设备对象。只允许由客户端从普通 drive absolute path 构造，拒绝 `GLOBALROOT`、pipe、volume GUID 等用户提供的 namespace。

### UNC 权限

WSL UNC 依赖 HexHub backend 与当前桌面用户具有同一 WSL 文件共享访问权限。前置检查必须在 Windows 视角验证。不得回退到管理员共享。

### 异步完成状态

queued 只表示进入队列。没有公开 status 工具前，只能诚实报告未确认完成。禁止通过固定 sleep 猜测完成。

### 重复提交

一旦服务端返回 queued，不自动重试；否则可能创建重复传输任务。只有在进入队列前的确定性参数/HTTP错误才允许用户显式重试。

## 14. 回滚方案

该修复不修改配置格式、资产句柄或 MCP schema。若出现回归：

1. 回退 local path hook 中 encoder 调用。
2. 保留 queued 结果语义修复，因为它独立且更正确。
3. `hexhub_scp` 暂时标为不可用或返回明确兼容性错误。
4. 其他 23 个工具不受影响。

不需要配置迁移或清理持久化状态。

## 15. 最终建议

采用客户端自动 wire encoding，不增加用户配置开关。该 encoding 本身是有效 Windows extended/UNC 路径，即使未来服务端修正第一层校验，仍应被下游 Windows 文件 API 接受。

实现时优先保证：

1. 路径规范化和 namespace 安全。
2. WSL/Windows 双向传输。
3. queued 不误报 completed。
4. 失败发生在排队前时给出可操作错误。

本方案已按上述设计完成客户端实现，并通过自动化测试、Pi native loader、Windows preflight、正式 `hexhub_scp` 挂载盘双向传输和 WSL 原生路径双向传输验证。
