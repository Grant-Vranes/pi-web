# Chat 输入区显示 Git 分支（模型右侧）设计文档

日期：2026-08-24  
项目：pi-web  
状态：已确认（待实现）

## 1. 背景与目标

用户希望在右侧主区域的输入栏下方控制区中，模型显示的右侧展示当前 **Git 分支**，并在分支发生变化时尽快同步到 UI。

本次明确范围：
- 显示的是 Git 分支（不是会话分叉 BranchNavigator）。
- 需要同时支持：
  - 在 pi-web 内切换 worktree/会话后更新。
  - 在外部终端执行 `git checkout` 后页面自动更新。
- 展示样式：**分支图标 + 分支名**。

## 2. 现状分析

- 输入区控件位于 `components/ChatInput.tsx`。
- `ChatWindow` 负责会话数据流并将状态传给 `ChatInput`。
- 已有 `/api/worktrees` 路由和 `lib/worktree.ts`：
  - `resolveProject(cwd)` 已可解析 `branch`。
  - GET `/api/worktrees?cwd=...` 已返回项目/worktree信息，但当前未直接暴露 `currentBranch` 字段给主区使用。

## 3. 方案选择

候选方案：
1. 复用 `/api/worktrees` 并增强返回 `currentBranch`（推荐）
2. 新建 `/api/git/branch` 轻量路由
3. 通过 SSE/监听实现强实时推送

最终选择方案 1，理由：
- 最小改动，复用现有安全校验和项目解析逻辑。
- 满足“外部 checkout 后秒级更新”需求。
- 避免新增路由和长期维护负担。

## 4. 详细设计

### 4.1 API 设计

文件：`app/api/worktrees/route.ts`

在 GET 返回中新增：
- `currentBranch: string | null`

值来源：
- `resolveProject(cwd).branch`

行为约定：
- 正常分支：返回分支名（如 `main`, `feature/xxx`）
- detached HEAD 或非 git 目录：返回 `null`
- 其余字段和权限策略保持不变

### 4.2 前端数据流

文件：`components/ChatWindow.tsx`

新增本地状态：
- `currentBranch: string | null`
- （可选）`branchLoading: boolean`

新增逻辑：
- 计算当前活跃 cwd：`session?.cwd ?? newSessionCwd`
- `refreshBranch(cwd)`：请求 `/api/worktrees?cwd=...` 并更新 `currentBranch`
- 将 `currentBranch` 透传给 `ChatInput`

### 4.3 UI 展示

文件：`components/ChatInput.tsx`

新增 props：
- `currentBranch?: string | null`
- `isBranchLoading?: boolean`（如实现加载态）

展示位置：
- 输入栏下方控制区左侧，紧邻模型显示按钮右侧

展示规则：
- `currentBranch` 有值：显示「分支图标 + 分支名」
- `currentBranch` 为空：不展示（避免非 git 场景噪音）

样式约束：
- 单行展示，超长分支名使用 `ellipsis`
- 色彩与现有 `--text-muted` / `--bg-hover` 风格对齐
- 保持移动端可用，不挤压主要按钮点击区

### 4.4 “立即响应”策略

在 `ChatWindow` 中对当前 cwd 的分支进行轻量同步：

触发时机：
1. 会话或 cwd 改变时：立即刷新
2. 页面可见时：2~3 秒轮询
3. `visibilitychange` 切回可见：立即刷新
4. `focus`：立即刷新
5. `online`：立即刷新

该策略可覆盖：
- 站内切换 worktree
- 站外执行 `git checkout`

## 5. 错误处理与边界

- API 失败：静默降级为不显示分支，不阻断聊天。
- 非 git 目录：`currentBranch = null`，不显示标签。
- detached HEAD：同样不显示分支标签。
- 切换 session 期间：以最后一次请求对应 cwd 为准，避免旧请求覆盖新状态。

## 6. 测试策略

### 6.1 单元/组件测试（建议）

- `ChatInput`：
  - `currentBranch` 有值时渲染图标与文本
  - `currentBranch` 为空时不渲染

- `ChatWindow`：
  - cwd 变化触发刷新
  - 轮询仅在可见状态运行

### 6.2 手工验收

1. Git 仓库 session：看到模型右侧分支标签
2. 终端 `git checkout feature/test`：2~3 秒内 UI 更新
3. 标签页后台切换分支后回到前台：立即更新
4. 非 git cwd：不显示分支标签且无错误提示

## 7. 影响评估

- 改动范围集中在：
  - `app/api/worktrees/route.ts`
  - `components/ChatWindow.tsx`
  - `components/ChatInput.tsx`
- 不影响会话文件格式、不影响 AgentSession 生命周期。
- 对现有 worktree 管理能力为增强复用，无额外后端状态负担。

## 8. 非目标

- 本次不实现分支切换下拉/点击操作。
- 本次不新增 SSE 分支事件流。
- 本次不变更 BranchNavigator（会话内分叉）逻辑。

## 9. 实施后成功标准

- 在主区输入栏下方，模型右侧稳定显示 Git 分支（图标+名称）。
- 内外部切分支后，页面可在短时间（秒级）内自动反映变化。
- 非 git 场景无多余 UI 干扰且无错误噪声。
