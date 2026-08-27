# AI 创建 Worktree 后自动续接会话设计文档

日期：2026-08-27  
项目：pi-web  
状态：已确认（待实施）

## 1. 背景与目标

用户希望 AI 在会话中创建 Git worktree 后，Pi Web 自动将后续对话迁移到该 worktree；当该 worktree 的工作完成、变更合并回主分支且该 worktree 被移除后，对话自动续接回主 checkout。

目标是让以下三项始终保持一致：

- 输入栏下方的 worktree / 分支控件；
- Explorer 的浏览根目录；
- 下一轮 AI 命令实际使用的 cwd。

本功能不在单个正在运行的 AgentSession 中原地修改 cwd。Pi 会话的 cwd、资源加载和运行时状态在创建后绑定；原地修改会导致 UI 与 Agent 实际目录、会话文件和权限边界不一致。

## 2. 方案选择

### 候选方案

1. **自动创建续接会话（采用）**：在安全结算点将当前可见对话分支复制为关联的新会话，并在目标 worktree cwd 启动它。
2. **原会话原地迁移 cwd**：表面上保留相同会话 id，但与 Pi 的会话生命周期冲突，风险高。
3. **仅更新分支控件，要求用户新建会话**：实现简单，但不能满足后续命令实际在新 worktree 执行的目标。

### 决策

采用方案 1。迁移后会产生新的底层 session 文件和 id，但界面自动切换，且会话历史和关联关系保留。旧会话保持不变，可从侧边栏回溯。

## 3. 自动切换时机与目标判定

### 3.1 安全结算点

每轮 AI run 开始时，客户端记录当前项目的 worktree 拓扑快照。每轮 run 结算后，重新读取 `/api/worktrees` 并比较快照与最新数据。

不会在工具调用或流式输出期间迁移。创建 worktree 的那一轮命令继续在旧 cwd 执行；从迁移完成后的**下一条用户消息**开始，AI 才在新 cwd 运行。

迁移仅在以下条件同时成立时进行：

- AI 触发的当前 run 已结算；
- 没有排队的 follow-up / steering 消息；
- 目标路径存在且通过既有文件访问允许规则；
- 当前 session 可安全复制，且没有另一个迁移正在进行。

### 3.2 创建 worktree 后的迁移

若同一轮 AI run 前后相比，当前项目恰好新增一个有效 worktree，则将该 worktree 作为目标 cwd，创建续接会话并自动打开。

若新增多个 worktree，或无法唯一判定目标，不自动猜测；只刷新 worktree 下拉列表。用户可以手动选择或继续当前会话。

普通页面轮询、焦点恢复、以及用户在外部终端创建 worktree 只更新 worktree UI，不触发会话迁移。只有 run 期间记录到的拓扑变化可以触发自动切换。

### 3.3 合并和清理后回主分支

若当前 session 所在 worktree 在本轮 AI run 后已被移除或其路径不存在，客户端请求服务器重新解析项目，并将目标设为主 checkout。

“已合并”本身不是可可靠观察的切换事件：AI 可能仍需解决冲突、运行验证或保留 worktree。因此只有当前 worktree 被移除才自动回主分支。仅执行 `git merge` 而未移除 worktree 时维持当前 cwd。

## 4. 会话续接设计

### 4.1 服务端迁移接口

增加受保护的会话迁移操作，输入来源 session id、当前可见 leaf id 和目标 cwd。服务端负责：

1. 验证来源 session、目标 cwd 和访问权限；
2. 读取来源 session 当前可见分支；
3. 在目标 cwd 的 session 目录创建新的 session；
4. 复制所需的历史分支内容，使新 session 可继续获得完整对话上下文；
5. 写入关联元数据，供会话树显示迁移来源；
6. 使用来源会话的有效模型、thinking level 和工具选择启动目标 AgentSession；
7. 返回目标 session 的摘要和 id。

迁移绝不重写来源 session 文件。若任一步失败，来源会话继续可用。

### 4.2 客户端迁移协调器

`ChatWindow`（或独立、可测试的 hook）持有每轮 run 的 worktree 快照，负责在结算时判定是否续接。成功后通过现有 `onOpenSession` / AppShell 导航流打开目标 session，使聊天、Explorer 和底部 worktree 控件同步到相同 cwd。

迁移状态应防止重复请求和来自旧 run 的延迟响应覆盖当前选择。切换完成后，在目标会话显示非阻塞提示，例如：

- `已续接到 worktree：feature/foo`
- `当前 worktree 已移除；已续接到主 checkout：main`

## 5. UI 与错误处理

- 迁移期间底部 worktree 控件显示忙碌/不可重复触发状态；当前聊天内容仍可阅读。
- 成功时自动切换到目标 session，不要求用户刷新页面或重新选择分支。
- 请求失败、目录失效、历史复制失败或目标 session 无法启动时：保留原 session 与 cwd，仅刷新 worktree 列表，并显示可操作的错误提示。
- 非 Git cwd、detached HEAD、删除后无法解析主项目等情况不自动迁移且不阻断聊天。

## 6. 测试策略

### 服务端

- 迁移后的 session 使用目标 cwd，来源 session 保持不变。
- 当前可见分支历史、关联元数据、模型、thinking level 和工具选择均正确继承。
- 非法 session、非法 cwd、不存在目录和复制失败被安全拒绝。

### 纯判定逻辑

- 一轮内唯一新增 worktree 会产生迁移目标。
- 多个新增 worktree 不产生迁移目标。
- 当前路径被移除时产生主 checkout 目标。
- 无拓扑变化、非 AI run 轮询及过期 run 结果不产生迁移。

### 客户端集成

- 只在 prompt 结算且队列为空后请求迁移。
- 迁移成功会自动打开目标 session，并使底部分支控件反映目标 checkout。
- 迁移失败不会改变当前聊天和 cwd。

### 回归验证

运行新增目标测试、`npm run lint` 与 `node_modules/.bin/tsc --noEmit`。手工验证：AI 创建一个 worktree，下一条消息在该 worktree 执行；AI 合并、移除当前 worktree 后，下一条消息在主 checkout 执行。

## 7. 非目标

- 不在同一条正在执行的 prompt 中途变更 cwd。
- 不根据单独的 `git merge` 命令自动离开当前 worktree。
- 不改变手动 worktree 切换的既有行为。
- 不为用户在外部终端创建的 worktree 自动迁移聊天。
