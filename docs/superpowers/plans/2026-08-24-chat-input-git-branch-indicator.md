# Chat Input Git Branch Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右侧主区输入栏下方，模型右侧显示当前 Git 分支，并在站内切换与站外 checkout 后秒级自动更新。

**Architecture:** 复用 `/api/worktrees`，后端在现有 GET 返回中追加 `currentBranch`；`ChatWindow` 负责按活跃 cwd 拉取分支并以可见态轮询 + focus/online/visibility 触发刷新；`ChatInput` 纯展示“分支图标 + 名称”。

**Tech Stack:** Next.js App Router, React hooks, TypeScript, Node test (`*.test.mjs` source assertions)

## Global Constraints

- 不新增路由，复用 `app/api/worktrees/route.ts`。
- 非 git / detached HEAD 返回空并静默降级，不阻断聊天。
- 分支 UI 只读展示，不加入分支切换交互。
- 仅在页面可见时轮询，避免不必要开销。

---

### Task 1: 后端返回 currentBranch

**Files:**
- Modify: `app/api/worktrees/route.ts`
- Test: `app/api/worktrees/current-branch-route.test.mjs`

**Interfaces:**
- Consumes: `resolveProject(cwd)` -> `{ branch: string | null }`
- Produces: `/api/worktrees` GET JSON 新字段 `currentBranch: string | null`

- [ ] **Step 1: 写失败测试（source assertion）**
- [ ] **Step 2: 运行单测确认失败**
- [ ] **Step 3: 最小实现（追加返回字段）**
- [ ] **Step 4: 重跑单测确认通过**

### Task 2: ChatInput 增加分支标签展示

**Files:**
- Modify: `components/ChatInput.tsx`
- Test: `components/ChatInput.branch-indicator.test.mjs`

**Interfaces:**
- Consumes: `currentBranch?: string | null`
- Produces: 模型按钮右侧只读分支标签（图标 + 文本，超长省略）

- [ ] **Step 1: 写失败测试（prop + conditional render）**
- [ ] **Step 2: 运行单测确认失败**
- [ ] **Step 3: 最小实现（props + JSX）**
- [ ] **Step 4: 重跑单测确认通过**

### Task 3: ChatWindow 拉取并实时刷新分支

**Files:**
- Modify: `components/ChatWindow.tsx`
- Test: `components/ChatWindow.branch-sync.test.mjs`

**Interfaces:**
- Consumes: `session?.cwd ?? newSessionCwd`
- Produces:
  - `currentBranch` state
  - `refreshBranch(cwd)` 调用 `/api/worktrees?cwd=...`
  - `ChatInput currentBranch={currentBranch}`
  - 可见态轮询 + `visibilitychange`/`focus`/`online` 刷新

- [ ] **Step 1: 写失败测试（source assertion）**
- [ ] **Step 2: 运行单测确认失败**
- [ ] **Step 3: 最小实现（state + effect + 透传）**
- [ ] **Step 4: 重跑单测确认通过**

### Task 4: 回归验证

**Files:**
- Modify: none
- Test: targeted + existing

- [ ] **Step 1: 运行新增 3 个测试文件**
- [ ] **Step 2: 运行 `npm run lint`**
- [ ] **Step 3: 运行 `node_modules/.bin/tsc --noEmit`**
- [ ] **Step 4: 总结验证结果并准备提交说明**
