# .excalidraw 文件查看与编辑 — 设计文档

日期:2026-09-10
状态:已确认

## 目标

pi-web 文件浏览器支持 `.excalidraw` 文件(Excalidraw 场景 JSON)的查看与编辑:

- **查看模式**:只读渲染 Excalidraw 画布(无编辑工具栏)。
- **编辑模式**:完整交互画布,保存写回原文件。

用户已确认:方案 A(嵌入官方 `@excalidraw/excalidraw` 组件)+ A2(查看/编辑双模式,手动保存)。

## 依赖

- 新增 `@excalidraw/excalidraw`(运行时依赖)。
- 仅在 `ExcalidrawViewer` 内通过 `next/dynamic` + `ssr: false` 懒加载;不进主 bundle,打开 `.excalidraw` 文件时才下载。
- 组件加载期间显示 loading 占位。

## 类型判断

- `lib/file-types.ts` 新增 `isExcalidrawPath(filePath)`(扩展名为 `excalidraw`)。
- `FileViewer` 分发顺序中,在 `isDocumentPreviewPath` 之后、`TextFileViewer` 之前优先分发到 `ExcalidrawViewer`。

## 新组件 `components/ExcalidrawViewer.tsx`

### 头部

复用现有查看器(ImageViewer 等)的头部样式:

- 相对路径(相对 `cwd`)、文件大小、live 监听指示灯(live/static)、下载按钮(`DownloadLink` 同款)。
- 右侧操作按钮:查看模式显示"编辑";编辑模式显示"保存"(含保存中状态)与"退出编辑"。

### 查看模式

- `<Excalidraw viewModeEnabled />` 只读渲染,隐藏编辑工具栏。
- 主题跟随 `useTheme` 的明暗模式(传入 Excalidraw 的 `theme` prop)。

### 编辑模式

- 点"编辑"进入完整交互画布。
- "保存"将场景写回文件;保存中禁用按钮。
- 退出编辑时若有未保存改动,`window.confirm` 确认丢弃(与文本查看器 `confirmDiscard` 行为一致)。

### 写回格式

- 解析磁盘上的原 JSON;只替换 `elements`、`appState`、`files` 三个顶层键:
  - `elements` / `files`:来自 Excalidraw 编辑器当前场景。
  - `appState`:仅挑取 Excalidraw 场景文件所需的视图字段(如 `viewBackgroundColor`、`gridSize`),不带运行时 UI 状态。
- 保留其余顶层键(其他工具写入的自定义元数据不丢失)。
- `JSON.stringify`(2 空格缩进)后写回。

### 保存与冲突

- 复用现有 `/api/files` write 接口:`{ content, baseMtimeMs }`。
- 磁盘 mtime 变化时返回 409 → 显示冲突提示,用户可选择覆盖(`force`,与文本查看器一致)或放弃。
- 保存成功后以响应中的 `mtimeMs` 更新基线。

### 文件监听

- 复用现有 `watch` SSE + `meta` 同步模式(同 ImageViewer 实现):
  - 非编辑状态:磁盘变更自动刷新画布内容。
  - 编辑状态:不覆盖正在编辑的内容,仅更新头部大小显示。

### 加载与错误

- 通过 `/api/files read` 获取内容,`JSON.parse` 失败或场景结构缺失时显示错误信息,并提供"以文本方式打开"的回退(渲染 `TextFileViewer`)。

## 杂项

- `components/FileIcons.tsx` 为 `.excalidraw` 增加图标(Excalidraw 官方 logo)。
- i18n 新增文案键(编辑、保存、退出确认、冲突提示、解析失败回退等),补齐中英文。

## 不做的事

- 不自动保存。
- 不为 `.excalidraw` 增加 tab 级草稿持久化(`FileViewerState.draft` 仍只用于文本文件);切换标签页丢弃未保存改动,退出编辑前有确认兜底。
- 不新增任何 API 端点。

## 测试

- `lib/file-types`:`isExcalidrawPath` 单测。
- `components/ExcalidrawViewer` 组件测试(mock `@excalidraw/excalidraw` 与 fetch):
  - 查看/编辑模式切换。
  - 保存调用携带 `baseMtimeMs`,成功后更新基线。
  - 409 冲突提示与 force 覆盖。
  - JSON 解析失败回退到文本查看器入口。
