# macOS Dock 运行状态呼吸灯设计

## 目标

当 Pi Web Desktop 至少有一个 agent session 正在运行时，在 macOS Dock 应用图标的徽标位置显示绿色呼吸灯效果；运行结束后清除徽标。Windows、Linux 以及现有菜单栏托盘图标行为保持不变。

## 当前行为

`desktop/main.cjs` 已经通过统一的 `setRunningIndicator(isRunning)` 处理运行状态：

- macOS 使用 `app.dock.setBadge("●")` 显示静态徽标。
- 菜单栏托盘图标使用两个 PNG 帧，每 600ms 切换一次实现呼吸效果。
- 运行状态来自现有的 `/api/agent/running` 轮询。

## 方案

继续使用 macOS 原生 Dock badge，不替换 Dock 主图标。新增 Dock badge 帧状态，与托盘动画共用 600ms 节奏：

- 活跃状态的两个帧分别使用明暗不同的绿色圆点字符或等价的 Unicode 圆点表示。
- 动画开始时立即设置第一帧，然后按现有 `RUNNING_TRAY_FRAME_MS` 定时切换。
- agent 停止时清理 Dock badge，并停止现有运行状态动画。
- macOS Dock badge 更新只在 macOS 分支执行，Windows taskbar overlay、Linux launcher badge 和托盘 tooltip 不变。
- 若 Dock badge 的字符颜色由 macOS 统一渲染，接受系统渲染差异；不通过替换应用主图标规避该限制。

为避免重复计时器，扩展现有的运行指示器动画生命周期，使托盘帧和 Dock badge 帧在同一次定时器回调中同步更新。停止时统一清理定时器并恢复无徽标状态。

## 测试

更新 `desktop/main.test.mjs`，验证：

1. macOS 分支仍调用 `app.dock.setBadge`。
2. 运行状态启动和停止时分别设置/清理 Dock badge。
3. Dock badge 帧与现有 600ms 动画定时器同步更新。
4. 非 macOS 的 taskbar overlay 和 Linux badge 逻辑保持存在。

运行桌面相关 Node 测试，并执行 TypeScript 检查；不运行 `next build`。
