# opencode serve 4096 运维手册

> 面向：需要自己动手查看、启动、重启、清理 `http://127.0.0.1:4096` 的使用者。
> 目标：不依赖 AI，照着本文的复制粘贴块就能完成全部操作。
> 环境：Windows + PowerShell 5.1（文末附 Linux / macOS 等价命令）。

---

## 0. 先搞清它是什么

`4096` 不是一个"网页服务"，而是 **opencode 的 headless 服务端**（`opencode serve`）。它同时是：

- 看板 **唤醒管线**投递消息的入口（watch 通过 `POST /session/{id}/prompt_async` 把指令送进会话）
- Web 面板「选择会话」下拉框的数据源（`GET /session`）
- TUI 与外部程序共享会话存储的 HTTP 接口

```
浏览器 ──► 看板 47825（Docker 容器）
                │  wakeChannel = http://host.docker.internal:4096
                ▼
        opencode serve 4096  ◄── watch（宿主，127.0.0.1:4096）
                ▲
                │ 共享存储（~/.local/share/opencode/）
        TUI 进程（你正在打字的窗口，没有 --port 参数）
```

**关键区分**

| 对象 | 特征 | 能不能杀 |
|---|---|---|
| `opencode serve --port 4096 …` | 命令行含 `serve --port 4096` | ✅ 本文的操作对象 |
| TUI（`opencode` 无参数） | 命令行**没有** `serve` | ❌ 杀了会丢掉正在对话的窗口（记录还在，但要重新 attach） |
| 看板容器 / Docker 端口代理（47825） | 进程名 `com.docker.backend` / `docker-proxy` | ❌ 与 4096 无关，别误伤 |

---

## 1. 30 秒速查

```powershell
# ① 看状态（一行）
Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $o=$_.OwningProcess; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$o"; "PID $o | $($p.Name) | $($p.CreationDate) | $($p.CommandLine)" }

# ② 真·健康检查
Invoke-RestMethod http://127.0.0.1:4096/global/health

# ③ 启动（后台 + 日志）——exe 路径见 §3.1，换成你自己机器上的
$exe="D:\App\fnm\node-versions\v22.22.2\installation\node_modules\opencode-ai\bin\opencode.exe"
$logs="$env:LOCALAPPDATA\taskboard\logs"
Start-Process $exe -ArgumentList "serve","--port","4096","--hostname","0.0.0.0" -WindowStyle Hidden -RedirectStandardOutput "$logs\serve-4096.log" -RedirectStandardError "$logs\serve-4096.err.log"

# ④ 停止（连子进程）
$owner=(Get-NetTCPConnection -LocalPort 4096 -State Listen).OwningProcess; taskkill /PID $owner /T /F
```

---

## 2. 状态查询

### 2.1 端口有没有人监听

```powershell
Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

期望输出（示例）：

```
LocalAddress LocalPort State    OwningProcess
------------ --------- -----    -------------
0.0.0.0           4096 Listen           22296
```

- `0.0.0.0` = 监听所有网卡（Docker 容器能访问，局域网也能访问）
- `127.0.0.1` = 只监听本机
- **没有输出** = 4096 没在跑

等价的经典写法（任何 Windows 都能用）：

```powershell
netstat -ano | findstr ":4096"
```

> 注意区分 `LISTENING` 与 `ESTABLISHED`/`CLOSE_WAIT`/`FIN_WAIT_2`：
> 只有 **LISTENING** 才代表"端口被占用"；其余都是连接残留，几秒到几分钟会自己消失。

### 2.2 是哪个进程占的

```powershell
$owner = (Get-NetTCPConnection -LocalPort 4096 -State Listen).OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$owner" |
  Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine | Format-List
```

判断依据（很重要）：

| CommandLine 里包含 | 是什么 | 处理 |
|---|---|---|
| `serve --port 4096` | 本文目标 | 可以按 §5 停止 / 重启 |
| 什么都没有（只有 `opencode.exe`） | TUI | **别杀** |
| 别的程序（node/java/…） | 端口撞车 | 换端口或停对方 |

### 2.3 真正的健康检查（⚠️ 最容易误判的一步）

```powershell
Invoke-RestMethod http://127.0.0.1:4096/global/health
```

正常输出：

```
healthy version
------- -------
   True 1.19.3
```

**为什么不能只看 HTTP 200？**

opencode 有一个"前端兜底路由"：任何它不认识的路径都返回 **200 + HTML 首页**。所以下面这些都会显示 200，但**完全不能证明服务健康**：

| 路径 | 实际返回 | 能当健康检查吗 |
|---|---|---|
| `/global/health` | `{"healthy":true,"version":"1.19.3"}` | ✅ 唯一推荐 |
| `/config` | JSON（当前配置） | ✅ 可用 |
| `/session` | JSON（会话数组） | ✅ 可用 |
| `/doc` | JSON（OpenAPI 3.1） | ✅ 可用 |
| `/health` `/app` `/instance/health` | **HTML 首页** | ❌ 假的 200 |
| `/session/{id}/model` | **HTML 首页** | ❌ 这个路由根本不存在 |

一眼识破的方法：看 `Content-Type`。

```powershell
$r = Invoke-WebRequest http://127.0.0.1:4096/global/health -UseBasicParsing
$r.Headers['Content-Type']      # 期望 application/json
$r.Content.Substring(0,60)      # 期望 {"healthy":true...
```

### 2.4 版本

```powershell
Invoke-RestMethod http://127.0.0.1:4096/global/health | Select-Object version
```

### 2.5 日志在哪

| 日志 | 路径 | 说明 |
|---|---|---|
| serve 标准输出/错误 | `%LOCALAPPDATA%\taskboard\logs\serve-4096.log` / `.err.log` | 用 §3.2 的后台方式启动才有 |
| opencode 主日志 | `%USERPROFILE%\.local\share\opencode\log\opencode.log` | 所有会话/请求/错误都在这里；**会长到几十 MB** |
| watch 日志 | `%LOCALAPPDATA%\taskboard\logs\watch.log` / `.err.log` | 唤醒投递记录 |

```powershell
# 看最后 50 行
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 50

# 只看错误
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 500 | Select-String "level=ERROR"

# 日志太大时（先确认没有正在排查的问题）
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 2000 | Set-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.tail.log"
```

### 2.6 会话列表（确认存储与绑定是否正常）

```powershell
(Invoke-RestMethod http://127.0.0.1:4096/session).Count
```

看板「选择会话」下拉框就是读这个接口。返回 0 通常是存储路径不对或服务刚起。

---

## 3. 启动

### 3.1 找到 opencode 可执行文件

```powershell
# 方法一：如果 opencode 已在 PATH 里
Get-Command opencode | Select-Object Source

# 方法二：fnm 多版本安装（本机实际情况）
Get-ChildItem "D:\App\fnm\node-versions\*\installation\node_modules\opencode-ai\bin\opencode.exe" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName, LastWriteTime
```

> **坑**：fnm 的快捷方式目录（`C:\Users\<你>\AppData\Local\fnm_multishells\...`）是临时 shell 包装，用另一个终端时可能失效。做常驻服务请用**版本目录里的绝对路径**。

### 3.2 启动方式 A：后台常驻（推荐）

```powershell
$exe   = "D:\App\fnm\node-versions\v22.22.2\installation\node_modules\opencode-ai\bin\opencode.exe"
$logs  = "$env:LOCALAPPDATA\taskboard\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

Start-Process -FilePath $exe `
  -ArgumentList "serve","--port","4096","--hostname","0.0.0.0" `
  -WorkingDirectory "D:\JERRY\dsh\open-taskboard" `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$logs\serve-4096.log" `
  -RedirectStandardError  "$logs\serve-4096.err.log"

Start-Sleep -Seconds 6
Invoke-RestMethod http://127.0.0.1:4096/global/health
```

优点：关掉终端也不退出；日志落盘。缺点：要停得手动 kill（见 §5）。

> 若报 `The process cannot access the file ... because it is being used by another process`，说明**旧进程还占着日志文件** —— 先按 §5 停掉旧进程，再启动；或把 `-RedirectStandardOutput` 换成一个新文件名。

### 3.3 启动方式 B：前台（只在排查问题时用）

```powershell
& "D:\App\fnm\node-versions\v22.22.2\installation\node_modules\opencode-ai\bin\opencode.exe" serve --port 4096 --hostname 0.0.0.0
```

- 日志直接打在窗口里，**Ctrl + C** 就是优雅停止
- 关窗口 = 服务结束

### 3.4 参数说明

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port <n>` | `0`（**随机端口**） | 必须显式写 `--port 4096`，否则每次启动端口都不同，watch 会找不到 |
| `--hostname <addr>` | `127.0.0.1` | 只给本机用 → 默认即可；**Docker 容器要访问 → 必须 `0.0.0.0`** |
| `--print-logs` | false | 把日志同时打到 stderr |
| `--log-level <lvl>` | INFO | `DEBUG` / `INFO` / `WARN` / `ERROR`，排查时用 `DEBUG` |
| `--pure` | false | 不加载外部插件（排查"是不是插件搞的"时用） |
| `--cors <domain>` | 空 | 需要浏览器跨域直连时再加 |

### 3.5 ⚠️ 安全提示

`--hostname 0.0.0.0` 会让**同一局域网内的任何人都能连上**，而 opencode 默认**没有认证**。

- 只用本机（不使用 Docker 看板）→ 用默认 `127.0.0.1`
- 必须给容器用时 → 至少设置密码：

```powershell
$env:OPENCODE_SERVER_PASSWORD = "换成一个长密码"
# 然后带同样的环境变量启动 serve；客户端请求需带 Basic Auth
```

- 不要把 4096 暴露到公网；不要在公共 Wi-Fi 下开 `0.0.0.0`

### 3.6 重启（一键）

```powershell
# 停
$owner = (Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($owner) { taskkill /PID $owner /T /F }
Start-Sleep -Seconds 3

# 起
$exe  = "D:\App\fnm\node-versions\v22.22.2\installation\node_modules\opencode-ai\bin\opencode.exe"
$logs = "$env:LOCALAPPDATA\taskboard\logs"
Start-Process -FilePath $exe -ArgumentList "serve","--port","4096","--hostname","0.0.0.0" -WindowStyle Hidden -RedirectStandardOutput "$logs\serve-4096.log" -RedirectStandardError "$logs\serve-4096.err.log"
Start-Sleep -Seconds 6

Invoke-RestMethod http://127.0.0.1:4096/global/health
```

---

## 4. 停止

### 4.1 优雅停止

- 前台启动的：在那个窗口按 **Ctrl + C**
- 后台启动的：没有优雅入口，用 4.2

### 4.2 强制停止（会一并结束子进程）

```powershell
$owner = (Get-NetTCPConnection -LocalPort 4096 -State Listen).OwningProcess
taskkill /PID $owner /T /F
```

- `/T` = 连子进程树一起结束（**必须加**；否则子进程会变成孤儿继续占着资源）
- `/F` = 强制

> **不要用 `$pid` 当变量名**：`$PID` 是 PowerShell 的只读内置变量，会报 `Cannot overwrite variable PID`。本文统一用 `$owner`。

### 4.3 确认已停

```powershell
Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue
# 没有输出 = 已释放
```

### 4.4 连带影响（停之前知道会发生什么）

| 停止后 | 影响 | 恢复 |
|---|---|---|
| 看板唤醒 | `@agent` 评论投递失败，评论保持 `pending` | serve 起来后重新发评论 |
| Web 面板选会话 | 下拉框报 502 / 空列表 | serve 起来即恢复 |
| TUI | **不受影响**（独立进程、共享存储） | — |
| watch | 不退出，会持续重连 | 自动恢复 |

---

## 5. 清除端口占用（EADDRINUSE / 起不来）

### 5.1 决策树

```
启动报错 "EADDRINUSE" / 端口被占
        │
        ├─ netstat 有 LISTENING？
        │     │
        │     ├─ 否 → 不是占用问题（看是否绑错 hostname / 防火墙 / 启动参数）
        │     │
        │     └─ 是 → 记下 OwningProcess
        │            │
        │            ├─ 进程存在且是 opencode serve
        │            │     → 正常停止后重启（§4.2 → §3.2）
        │            │
        │            ├─ 进程存在但是别的程序
        │            │     → 停对方，或给自己换端口（--port 4097）
        │            │
        │            └─ 进程查不到（PID 已死）→ 僵尸 / 孤儿
        │                  → 见 §5.3
        │
        └─ netstat 只有 TIME_WAIT / CLOSE_WAIT
              → 不是占用，等 1~4 分钟自动消失，或直接重启服务即可
```

### 5.2 正常情况：找到并结束占用者

```powershell
# 1) 谁占着
$owner = (Get-NetTCPConnection -LocalPort 4096 -State Listen).OwningProcess
"占用 PID: $owner"

# 2) 它是什么
Get-CimInstance Win32_Process -Filter "ProcessId=$owner" | Select-Object ProcessId, Name, CommandLine | Format-List

# 3) 确认是 opencode serve 后再杀（连子进程）
taskkill /PID $owner /T /F
```

### 5.3 僵尸 / 孤儿：PID 已死但端口还在 LISTENING

**现象**

```powershell
$owner = (Get-NetTCPConnection -LocalPort 4096 -State Listen).OwningProcess
Get-Process -Id $owner          # 报 "找不到进程" / Cannot find a process
```

端口仍 LISTENING，但持有它的 PID 已经不存在了（父进程被强杀、子进程未回收、PID 被复用等）。

**处理顺序（从轻到重）**

```powershell
# ① 找同一 opencode 相关进程，把它们整棵树清掉
Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | Format-Table -AutoSize

# 对照：真正要保留的是 TUI（CommandLine 里没有 serve）
# 可疑的是 serve 的子孙进程（命令行可能只显示 node / esbuild / 插件进程）

# ② 逐个结束可疑进程树（把 <PID> 换成实际值）
taskkill /PID <PID> /T /F

# ③ 复查端口
Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue

# ④ 端口已空 → 重新启动
```

**如果 ①~③ 做完端口还在**：

1. 确认是不是自己看错了端口（`netstat -ano | findstr ":4096"`，注意 `:40960` 也会被 `findstr` 匹配到，看完整行）
2. 确认没有「系统保留端口」冲突：`netsh interface ipv4 show excludedportrange protocol=tcp`
3. 换一个端口先恢复业务：`--port 4097`，再找时间处理 4096
4. 最后手段：**重启机器**（这是唯一 100% 释放的方法，但请先试完上面三步）

> 实测经验（本机）：一次"PID 已死端口仍 LISTENING"是因为 serve 的两个子进程（35108 / 35308）成了孤儿。把这两个进程树 `taskkill /T /F` 后，端口立即释放，**不需要重启机器**。

### 5.4 端口临时换一个（不想折腾时）

```powershell
Start-Process $exe -ArgumentList "serve","--port","4097","--hostname","0.0.0.0" -WindowStyle Hidden
```

换端口后记得同步两处，否则唤醒链路会打到旧端口：

1. watch 的 `OPENCODE_SERVER_URL`
2. 项目 `wakeChannel`（Docker 场景写 `http://host.docker.internal:<新端口>`）

---

## 6. 故障对照表

| 症状 | 最可能原因 | 怎么确认 | 处理 |
|---|---|---|---|
| 启动报 `EADDRINUSE` | 4096 已有监听 | §2.1 | §5.2 |
| `global/health` 连不上，但 `netstat` 有 LISTENING | 僵尸/孤儿进程 | `Get-Process -Id <PID>` 失败 | §5.3 |
| 面板选会话报 **502** | 容器内访问 `127.0.0.1` | 容器里 `curl 127.0.0.1:4096` 失败 | serve 加 `--hostname 0.0.0.0`；`wakeChannel` 用 `host.docker.internal` |
| 唤醒评论一直 `pending` | watch 没跑 / 打错端口 | `Get-Content watch.log -Tail 20` | 起 watch，或改 `OPENCODE_SERVER_URL` |
| 会话列表为空 | serve 刚起 / 存储路径不同 | `GET /session` | 等待几秒；确认 `HOME`/`XDG_DATA_HOME` 一致 |
| 请求某路径返回 **200 但内容是 HTML** | 该路由不存在，命中前端兜底 | 看 `Content-Type` | 换正确路由（§2.3） |
| 端口放了但服务"像没生效" | 旧进程还在（PID 变了） | 对比 `CreationDate` | 先 §5.2 再启动 |
| 子 agent 报 `Cannot connect to API` | 模型/provider 不可用（不是 4096 的问题） | 看日志 `providerID=` | 检查插件配置里的模型 |

---

## 7. 与本项目（open-taskboard）的关系

### 7.1 三处配置必须一致

| 位置 | 键 | 本机取值 |
|---|---|---|
| 服务端 / 内嵌唤醒（容器） | `TASKBOARD_OPENCODE_URL` | `http://host.docker.internal:4096`（容器视角） |
| 外部 watch（宿主） | `--opencode` 或 `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096`（宿主） |
| serve 启动参数 | `--hostname` | `0.0.0.0`（否则容器连不上） |

改端口 / 改监听地址后：只需改仓库根目录 `.env` 的 `TASKBOARD_OPENCODE_URL`（`docker-compose.yml` 以 `${TASKBOARD_OPENCODE_URL:-…}` 直接读取）；宿主侧自启再重跑一次 `taskboard setup --opencode-url <新地址>` 刷新。

### 7.2 为什么容器要用 `host.docker.internal`

容器里的 `127.0.0.1` 指容器自己。`host.docker.internal` 才会解析到宿主。所以：

- 看板跑 Docker → `wakeChannel = http://host.docker.internal:4096`
- watch 跑宿主 → `OPENCODE_SERVER_URL = http://127.0.0.1:4096`

（宿主上 `host.docker.internal` 有时会解析到 `172.31.0.229` 而被防火墙挡住 —— 所以两侧写法不同，别图省事统一。）

### 7.3 停 4096 之后唤醒还能不能恢复

能。watch 不会退出，serve 回来后：

1. 新评论直接投递成功
2. 已 `pending` 的旧评论不会自动重投 —— **重新发一条就能再唤醒**

---

## 8. 不要做的事

| 禁止 | 原因 |
|---|---|
| `taskkill /IM opencode.exe /F`（按进程名全杀） | 会连 TUI 一起杀掉，正在进行的对话窗口消失 |
| `Stop-Process -Name opencode -Force` | 同上，且不处理子进程树 |
| 杀 47825 的 `docker-proxy` / Docker 进程 | 与 4096 无关，会连带停掉看板 |
| 用 `$pid` 作变量名 | PowerShell 保留变量，赋值直接报错 |
| 端口被占就立刻重启机器 | 九成情况杀进程树即可（§5.3） |
| 无密码 `--hostname 0.0.0.0` 且连公共网络 | 局域网内任何人都能操作你的会话 |
| 直接删除 `~/.local/share/opencode/` | 会丢全部会话历史 |

---

## 9. Linux / macOS 等价命令

```bash
# 状态
lsof -nP -iTCP:4096 -sTCP:LISTEN
# 或
ss -lntp | grep ':4096'

# 健康
curl -s http://127.0.0.1:4096/global/health

# 启动（后台）
nohup opencode serve --port 4096 --hostname 0.0.0.0 > ~/taskboard-serve-4096.log 2>&1 &

# 停止（温和 → 强制）
kill "$(lsof -t -iTCP:4096 -sTCP:LISTEN)"
kill -9 "$(lsof -t -iTCP:4096 -sTCP:LISTEN)"

# 一步释放端口（fuser）
fuser -k 4096/tcp

# 查进程详情
ps -o pid,ppid,lstart,command -p "$(lsof -t -iTCP:4096 -sTCP:LISTEN)"
```

---

## 10. 一页纸总结

```text
查：  Get-NetTCPConnection -LocalPort 4096 -State Listen   → 拿 PID
      Invoke-RestMethod http://127.0.0.1:4096/global/health → healthy=true 才算活
起：  opencode.exe serve --port 4096 --hostname 0.0.0.0
停：  taskkill /PID <PID> /T /F
清：  PID 死了端口还在 → 清孤儿进程树 → 复查 → 仍不行才重启机器
别杀：没有 serve 参数的 opencode.exe（那是你的 TUI）
```
