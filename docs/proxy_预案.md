# pi-web 代理(Proxy)配置预案

> 状态:三种方案如下;其中**方案 1 已实现**。当前实现通过 `git diff` 可见,
> 需重启 `npm run dev` 后,在「设置 → 代理」里填写配置;保存后重启生效,「测试连接」即时验证。

## 背景 / 问题

在公司内网环境中,pi-web 的 Next.js 服务端无法直连模型 API(如 `api.taotoken.net`),导致无法使用模型。原因:

- **Node.js 进程默认不读取 macOS/Windows 系统代理设置**(浏览器会自动继承,Node 不会)。
- pi-web 当前的全局网络层(undici `EnvHttpProxyAgent`)只在进程启动时(`instrumentation.ts` → `configureHttpDispatcher()`)从**环境变量**读取一次代理,且当前环境无任何代理变量。
- 模型请求(`/api/models-config/test` 等)由服务端发起,若进程无代理则裸连接被内网拦截。

目标:在**设置界面提供代理配置**,用户填写代理类型(/地址/端口/用户名/密码),系统**持久化存储**,支持**测试连接**,**重启后生效**。

### 关键网络层事实(调研结论)

- 网络层在 `lib/http-dispatcher.ts`,使用 undici 的 `EnvHttpProxyAgent`,在 `instrumentation.ts`(Next.js server 启动钩子)调用 `configureHttpDispatcher()` 安装**进程级全局 dispatcher**。
- undici 8.10 的 `ProxyAgent` 支持 Basic Auth:
  - 代理 URI 中带 `user:pass@`(如 `http://user:pass@host:port`),undici 自动生成 `Proxy-Authorization: Basic ...` 头(见 `node_modules/undici/lib/dispatcher/proxy-agent.js` 第 141-144 行)。
  - 或通过构造函数 `token`/旧 `auth` 选项传入。
- `EnvHttpProxyAgent` 支持 `httpProxy` / `httpsProxy` / `noProxy` 字段覆盖环境变量(见 `node_modules/undici/types/env-http-proxy-agent.d.ts`)。
- **因此方案 1 完全可以用一个「自研 ProxyAgent 工厂」,把用户配置的代理(含 username/password)编译成 `http://user:pass@host:port` URI 并传给 `EnvHttpProxyAgent` / `ProxyAgent`。**

---

## 三种实现方案

### 方案 1(推荐,已实现):进程级代理 Agent + 持久化配置

**思想**:设置页填写代理信息 → 持久化到 `~/.pi/agent/proxy.json` → 进程启动(或切换后重启)时,`configureHttpDispatcher()` 读取该文件并构建带认证的 undici `ProxyAgent` 作为全局 dispatcher。

**要点**
- 存储:新增 `lib/proxy-settings.ts`,读写 `~/.pi/agent/proxy.json`(沿用 `writePrivateFileAtomicSync` 0600 权限,凭据不外泄)。
- 网络层:改造 `lib/http-dispatcher.ts`,提供 `resolveProxyConfig()` 将用户配置编译为:
  - `ProxyAgent({ uri: "http://user:pass@host:port" })`(HTTP 代理),
  - 或 `SOCKS5ProxyAgent`(`${user}:${pass}@host:port`)(SOCKS5 代理)。
- 测试:`/api/proxy/test` 路由用该 Agent 发一个连通性请求(如 `https://api.taotoken.net` 或用户指定的测试 URL),返回成功/失败 + 延迟。
- 生效时机:**保存后点击测试即验证;正式切换需重启进程**(匹配"重启后生效"需求)。optionally 可在 instrumentation 里读取,保证重启自动生效。

**优点**
- 逻辑简单、集中,网络层唯一入口清晰。
- 支持 HTTP/HTTPS 代理与 Basic Auth(用户名/密码),契合公司网关场景。
- 配置含凭证,用 0600 私有文件存储,安全。
- 不需要动每次请求的调用链。

**缺点 / 限制**
- 生效需重启进程(除"测试"按钮是即时验证外,实际流量需重启)。
- 只作用于进程内由全局 fetcher 发出的请求;其他子进程(如 npx、命令行工具)不受管理(它们由各自的 env 决定)。

**适用**:绝大多数公司网关 / HTTP 代理 / 用户名密码认证场景。

---

### 方案 2:自定义 undici Agent,支持运行时热切换与更细认证

**思想**:在外层写一个自定义 `undici.Agent` 子类,持有一个可变的 `ProxyAgent` 引用;每次设置变更(不必重启)即替换底层 proxy 实例。甚至可通过全局 `configureHttpDispatcher()` 的改造,在运行时 `setGlobalDispatcher(...)` 重新安装。

**要点**
- 在 `lib/http-dispatcher.ts` 增加 `updateHttpDispatcherProxy(config)` API,内部重建 `ProxyAgent` 并 `setGlobalDispatcher`。
- 前端保存后调用该 API 立即热切换到新代理(无需重启)。
- 负责对每种 proxy 类型(HTTP / HTTPS / SOCKS4 / SOCKS5)构建对应 Agent,支持 NTLM/Kerberos 等进阶认证(需要额外依赖,如 `httpntlm`)。

**优点**
- 切换即时生效,无需重启。
- 认证方式最全(Basic / NTLM / Kerberos / Bearer)。

**缺点 / 限制**
- 实现复杂,需处理请求在途连接、连接池清理、并发安全。
- NTLM/Kerberos 需引入外部依赖,增大体积与维护成本。
- 与 undici 版本强耦合,升级风险高。

**适用**:对"即时切换"有强需求,或代理认证要求较复杂(公司 NTLM 域账号)的场景。

---

### 方案 3:全链路代理注入(环境变量 + 所有子进程)

**思想**:不只管 Next.js 服务端 fetch,而是把代理配置同步导出为进程环境变量(`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`),并：
1. 在 `configureHttpDispatcher()` 里 `process.env` 注入代理,让 `EnvHttpProxyAgent` 自动读取;
2. 一并注入给所有通过服务端 spawn 的子进程(npx、git、终端工具),让它们在各自环境里也能走代理。

**要点**
- 存储与方案 1 相同(proxy.json)。
- `instrumentation.ts` / `configureHttpDispatcher()` 里把用户配置写入 `process.env.*_PROXY`。
- 在 spawn 子进程处(如 `lib/npx.ts`、各 tool runner)合并一份代理 env。
- 由于 Node 环境变量 is process-wide,方案 3 是"最彻底"的,连插件安装、技能搜索、git 操作都能走代理。

**优点**
- 覆盖最广:一切经 Node 的流量都走代理。
- 实现相对直接(只写 env + 读 env)。

**缺点 / 限制**
- `process.env` 是全局可变状态,多代理/多租户场景下易串扰。
- 子进程代理的注入点分散,需逐一 patch,易遗漏。
- 不解决"运行时热切换"(环境变量重启才重新读取)。

**适用**:希望"代理全局生效、包括所有子工具",且不介意切换需重启的场景。

---

## 方案 1 详细设计(已实现)

### 1. 数据模型(`lib/proxy-settings.ts`)

```ts
export interface ProxyConfig {
  enabled: boolean;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
  // 可选:按主机走代理的白名单,留空则全局走代理
  noProxy?: string[];
}
```

- 存储路径:`~/.pi/agent/proxy.json`(通过 `getAgentDir()` 解析)。
- 文件不含明文比环境更安全,0600 权限。
- 提供 `readProxyConfig()` / `writeProxyConfig()` / `resolveProxyUri(config)`。

### 2. 网络层(`lib/http-dispatcher.ts` 改造)

```ts
export function configureHttpDispatcher(opts?: {
  proxyConfig?: ProxyConfig;      // 可传入用户代理配置
}) {
  // 1. 若配置了代理,构造带认证 ProxyAgent 作为全局 dispatcher
  // 2. 否则维持原有 EnvHttpProxyAgent 行为(读取环境变量)
}
```

- HTTP/HTTPS 代理:构造 `undici.ProxyAgent({ uri: "http://user:pass@host:port" })`。
- SOCKS5 代理:构造 `undici.Socks5ProxyAgent("socks5://user:pass@host:port")`。注意:undici 的 `Socks5ProxyAgent` 只接受 `socks5://`/`socks://` 协议(不接受 `socks5h://`),且它原生把目标 hostname 发给代理做**远程 DNS**(等效 socks5h),无需额外处理。亦可用选项 `username`/`password` 传认证。
- 在 `instrumentation.ts` 里调用时读取 proxy.json 并传入 → **重启自动生效**。

### 3. API 路由

- `app/api/proxy/route.ts`
  - `GET`:读取当前配置返回(密码用掩码/不回传明文,只回 `passwordSet: boolean`)。
  - `PUT`:校验并保存配置;可选 `apply` 参数立即调用 `updateHttpDispatcherProxy`(方案 2 的能力,方案 1 至少保存)。
  - `DELETE`:清空禁用代理。
- `app/api/proxy/test/route.ts`
  - `POST`:用用户填写的代理(未保存也允许)发一个连通性请求,返回 `{ ok, latencyMs, status, error }`。实现类似 `models-config/test`,但用代理 Agent。测试目标默认 `https://api.taotoken.net`(可配置字段 `testUrl`)。

### 4. 前端(`components/ProxyConfig.tsx` + `SettingsPanel`)

- 在 `SettingsSection` 新增 `"proxy"`(非项目级,像 general/models)。
- 表单字段:
  - 启用开关 `enabled`
  - 代理类型下拉 `protocol`(http / https / socks5)
  - `host` 地址、`port` 端口
  - `username` / `password`(SecretTextInput,掩码,沿用 ModelsConfig 的 `SecretTextInput`)
  - `testUrl`(可选,默认模型网关)
  - 按钮:`保存`、`测试连接`、`禁用`
- 测试结果显示:成功(✓ 延迟 xx ms)或失败(错误信息)。
- 保存后提示"重启后生效"。

### 5. 安全考虑

- 密码存于 0600 私有文件,GET 不回传明文。
- `proxy.json` 属用户凭证,不纳入版本控制。
- URLAuth 构造时对 username/password 做 `encodeURIComponent` 防止特殊字符破坏。
- 测试路由同样受 `isApiRequestAllowed` 保护(沿用 request-security)。

### 6. i18n

在三份 locale(`en.ts` / `zh-CN.ts` / `zh-TW.ts`)新增 `settings.proxy.*` 与 `i18n.proxy*` 文案。

---

## 参考实现文件清单

| 类别 | 文件 |
|------|------|
| 存储 | `lib/proxy-settings.ts`(新增) |
| 网络层 | `lib/http-dispatcher.ts`(改造) |
| 启动 | `instrumentation.ts`(读取配置传入) |
| 路由 | `app/api/proxy/route.ts`、`app/api/proxy/test/route.ts`(新增) |
| 前端 | `components/ProxyConfig.tsx`(新增)、`components/SettingsPanel.tsx`(挂载)、`components/SettingsUi.tsx`(复用表单组件)、`lib/settings-navigation.ts`(新增 section) |
| 类型 | `lib/api-types.ts`(新增 ProxyConfig / ProxyTest 类型) |
| i18n | `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` |
| 文档 | `docs/proxy_预案.md`(本文件) |