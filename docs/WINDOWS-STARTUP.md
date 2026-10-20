# Windows 启动与故障排查

本文适用于 Windows 10/11 的本地开发环境。项目服务使用 Node.js 启动，不需要管理员权限，不会自动终止未知进程。

## 1. 环境要求

- Node.js **22.5.0 或更高版本**
- pnpm **9 或更高版本**
- 首次安装依赖时需要网络连接

在 PowerShell 或 CMD 中确认：

~~~powershell
node --version
pnpm --version
~~~

如果 pnpm 不存在，可按本机 Node.js 安装方式启用 Corepack，或按照 pnpm 官方安装文档安装。安装后重新打开终端。

## 2. 启动

双击仓库根目录的 start.bat。脚本会：

1. 定位仓库根目录，不依赖当前终端所在目录。
2. 检查 Node.js 和 pnpm 版本。
3. 检查 node_modules；首次运行时询问是否执行 pnpm install。
4. 检查 server 和 web 构建产物；缺失时执行 pnpm build。
5. 检查默认端口 47824。若端口上已有健康的 Taskboard，会复用现有服务；若端口被其他程序占用，会报告冲突，不会杀进程。
6. 直接启动 apps/server/dist/server.js，将标准输出和错误写入日志文件。
7. 轮询 /api/openapi.json，只有 API 返回有效 OpenAPI 文档才判定服务健康。
8. 服务就绪后打开浏览器。

首次安装依赖可能需要数分钟。安装或构建失败时，脚本会显示错误；不要反复点击启动，先查看错误信息与日志。

## 3. 管理命令

在仓库根目录运行：

~~~powershell
# 启动（就绪后打开浏览器）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action start

# 启动但不自动打开浏览器
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action start -NoBrowser

# 查看服务健康状态、PID 与端口监听
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action status

# 停止本脚本启动且身份校验通过的服务
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action stop

# 重启
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action restart

# 查看最近 100 行 stdout/stderr
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action logs
~~~

## 4. 端口与地址

默认访问地址为 http://127.0.0.1:47824。可在启动前设置环境变量：

~~~powershell
$env:TASKBOARD_PORT = '47826'
$env:TASKBOARD_HOST = '127.0.0.1'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action start
~~~

TASKBOARD_PORT 必须是 1–65535 的数字。脚本只负责启动与检查，不会自动修改防火墙或开放 LAN 访问。除非你清楚认证与网络暴露风险，不要把 TASKBOARD_HOST 改为 0.0.0.0。

## 5. 场景处理策略

| 场景 | 脚本行为 | 建议处理 |
|---|---|---|
| 首次启动，没有依赖 | 询问是否执行 pnpm install | 确认网络可用后输入 Y |
| Node.js 缺失或版本低 | 中止启动并给出要求 | 安装 Node.js ≥22.5.0，重开终端 |
| pnpm 缺失或版本低 | 中止启动并给出要求 | 安装/启用 pnpm ≥9 |
| 构建产物缺失 | 执行 pnpm build | 若失败，先查看终端错误 |
| Taskboard 已经健康运行 | 复用现有服务，不重复启动 | 浏览器会打开现有服务地址 |
| 端口被其他程序占用 | 显示占用 PID/命令行并中止 | 手动确认冲突进程；或改用空闲端口 |
| 服务启动后立即退出 | 展示 stdout/stderr 日志 | 根据日志修复配置、构建或数据库问题 |
| 健康检查超时 | 保留进程供诊断，不自动杀进程 | 执行 -Action logs 和 -Action status |
| PID 文件过期或 PID 被复用 | 身份校验失败，不终止该 PID | 人工检查后再清理 .taskboard-runtime/server.json |
| 连续点击启动 | 端口健康检查优先，避免重复启动 | 不要在安装/构建期间重复启动 |
| 停止时找不到受管进程 | 不杀未知进程 | 手动检查 PID 文件与进程命令行 |
| OpenCode 没启动或不可达 | Taskboard 本身仍可启动 | 检查 OpenCode 地址/会话配置；这是独立依赖 |
| 浏览器没自动打开 | 服务仍可能正常运行 | 手动访问终端显示的地址 |

## 6. 日志与运行状态

运行时文件保存在仓库根目录的 .taskboard-runtime/：

- server.json：PID、进程创建时间、入口文件和启动时间，用于校验进程身份
- server.out.log：标准输出
- server.err.log：标准错误

该目录已加入 Git 忽略列表，不应提交到仓库。日志可能包含本机路径或错误详情，分享前请先检查是否有敏感信息。

## 7. 安全边界与已知限制

- 停止命令只会终止 PID、进程命令行和创建时间都与记录匹配的服务进程；不会按端口号或进程名盲杀。
- 若端口冲突，脚本不会自动终止占用者。
- 健康检查使用现有的公开 GET /api/openapi.json 路由，不要求新增服务端 API。
- 此启动器不负责守护进程自动重启、开机自启或后台升级。它适合本机手动启动；若需要长期运行，可另行配置 Windows 服务管理器。
- 该启动器尚未在真实 Windows 主机上执行验证。合并前应在 Windows PowerShell 下完成首次安装、重复启动、端口冲突、停止/重启、启动失败和路径含空格等场景测试。
