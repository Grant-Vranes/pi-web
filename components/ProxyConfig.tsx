"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ProxyProtocol } from "@/lib/proxy-settings";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailStack,
  ConfigFooter,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSwitch,
} from "./SettingsUi";

export interface ProxyConfigState {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  passwordSet: boolean;
  testUrl: string;
  noProxy: string[];
}

interface ProxyTestState {
  phase: "idle" | "testing" | "success" | "error";
  message?: string;
  latencyMs?: number;
}

interface ProxySaveState {
  phase: "idle" | "saving" | "success" | "error";
  message?: string;
}

const inputStyle: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="config-field" style={{ marginBottom: 12, ...style }}>
      <span className="config-field-label" style={{ display: "block", marginBottom: 4, fontSize: 12, color: "var(--text-muted)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function TextInput({
  value, onChange, placeholder, mono, type = "text", autoComplete = "off", style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  autoComplete?: string;
  style?: React.CSSProperties;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit", ...style }}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isProxyProtocol(value: string): value is ProxyProtocol {
  return value === "http" || value === "https" || value === "socks5";
}

export function ProxyConfig({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<ProxyConfigState>({
    enabled: false,
    protocol: "http",
    host: "",
    port: "",
    username: "",
    password: "",
    passwordSet: false,
    testUrl: "",
    noProxy: [],
  });
  const [loading, setLoading] = useState(true);
  const [testState, setTestState] = useState<ProxyTestState>({ phase: "idle" });
  const [saveState, setSaveState] = useState<ProxySaveState>({ phase: "idle" });

  const setField = useCallback(<K extends keyof ProxyConfigState>(key: K, value: ProxyConfigState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
    setSaveState({ phase: "idle" });
    setTestState({ phase: "idle" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/proxy")
      .then(async (response) => {
        const data = await response.json() as ProxyConfigState & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setState({
          enabled: data.enabled,
          protocol: data.protocol,
          host: data.host ?? "",
          port: data.port ? String(data.port) : "",
          username: data.username ?? "",
          password: "",
          passwordSet: data.passwordSet,
          testUrl: data.testUrl ?? "",
          noProxy: data.noProxy ?? [],
        });
      })
      .catch((cause) => {
        if (!cancelled) setSaveState({ phase: "error", message: errorMessage(cause) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const buildPayload = useCallback(() => {
    const payload: Record<string, unknown> = {
      enabled: state.enabled,
      protocol: state.protocol,
      host: state.host.trim(),
      port: Number(state.port),
      username: state.username.trim() || undefined,
      // Only send a password when the user typed one; otherwise keep stored.
      ...(state.password ? { password: state.password } : {}),
      ...(state.testUrl.trim() ? { testUrl: state.testUrl.trim() } : {}),
      ...(state.noProxy.length > 0 ? { noProxy: state.noProxy } : {}),
    };
    return payload;
  }, [state]);

  const hasBasics = state.host.trim().length > 0 && Number(state.port) > 0 && Number(state.port) <= 65535;

  const handleTest = useCallback(async () => {
    if (!hasBasics) {
      setTestState({ phase: "error", message: t("settings.proxy.incomplete") });
      return;
    }
    setTestState({ phase: "testing" });
    try {
      const response = await fetch("/api/proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await response.json() as { ok?: boolean; latencyMs?: number; error?: string };
      if (!response.ok || data.ok === false) {
        setTestState({ phase: "error", message: data.error ?? t("settings.proxy.testFailed"), latencyMs: data.latencyMs });
      } else {
        setTestState({ phase: "success", message: t("settings.proxy.testSuccess"), latencyMs: data.latencyMs });
      }
    } catch (cause) {
      setTestState({ phase: "error", message: errorMessage(cause) });
    }
  }, [buildPayload, hasBasics, t]);

  const handleSave = useCallback(async () => {
    if (!hasBasics) {
      setSaveState({ phase: "error", message: t("settings.proxy.incomplete") });
      return;
    }
    setSaveState({ phase: "saving" });
    try {
      const response = await fetch("/api/proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await response.json() as { ok?: boolean; error?: string; config?: ProxyConfigState };
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (data.config) {
        setState((prev) => ({
          ...prev,
          enabled: data.config!.enabled,
          passwordSet: data.config!.passwordSet,
          password: "",
        }));
      }
      setSaveState({ phase: "success", message: t("settings.proxy.savedRestart") });
    } catch (cause) {
      setSaveState({ phase: "error", message: errorMessage(cause) });
    }
  }, [buildPayload, hasBasics, t]);

  const handleDisable = useCallback(async () => {
    setSaveState({ phase: "saving" });
    try {
      const response = await fetch("/api/proxy", { method: "DELETE" });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
      setState((prev) => ({ ...prev, enabled: false, passwordSet: false, password: "" }));
      setSaveState({ phase: "success", message: t("settings.proxy.disabledRestart") });
    } catch (cause) {
      setSaveState({ phase: "error", message: errorMessage(cause) });
    }
  }, [t]);

  const statusNode =
    saveState.phase === "error" ? <span style={{ color: "#f87171" }}>{saveState.message}</span>
    : saveState.phase === "success" ? <span style={{ color: "#4ade80" }}>{saveState.message}</span>
    : undefined;

  return (
    <ConfigPanelShell embedded={embedded} title={t("settings.proxy.title")} subtitle="~/.pi/agent/proxy.json" closeLabel={t("i18n.close")} onClose={onClose}>
      <ConfigDetail style={{ padding: 16, gap: 4 }}>
        <ConfigDetailStack className="is-fill">
          {loading ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <ConfigSwitch
                  checked={state.enabled}
                  label={t("settings.proxy.enabled")}
                  onChange={(enabled) => setField("enabled", enabled)}
                />
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("settings.proxy.enabledLabel")}</span>
              </div>

              <ConfigSectionTitle>{t("settings.proxy.connection")}</ConfigSectionTitle>

              <Field label={t("settings.proxy.protocol")}>
                <select
                  value={state.protocol}
                  onChange={(e) => isProxyProtocol(e.target.value) && setField("protocol", e.target.value)}
                  style={{ ...inputStyle, width: "100%" }}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </Field>

              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label={t("settings.proxy.host")}>
                    <TextInput
                      value={state.host}
                      onChange={(v) => setField("host", v)}
                      placeholder="proxy.example.com"
                      mono
                    />
                  </Field>
                </div>
                <div style={{ width: 120 }}>
                  <Field label={t("settings.proxy.port")}>
                    <TextInput
                      value={state.port}
                      onChange={(v) => setField("port", v.replace(/[^0-9]/g, ""))}
                      placeholder="8080"
                      mono
                    />
                  </Field>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label={t("settings.proxy.username")}>
                    <TextInput
                      value={state.username}
                      onChange={(v) => setField("username", v)}
                      autoComplete="off"
                      placeholder={t("settings.proxy.usernamePlaceholder")}
                    />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label={t("settings.proxy.password")}>
                    <TextInput
                      type="password"
                      value={state.password}
                      onChange={(v) => setField("password", v)}
                      autoComplete="new-password"
                      placeholder={state.passwordSet ? t("settings.proxy.passwordKept") : t("settings.proxy.passwordPlaceholder")}
                    />
                  </Field>
                </div>
              </div>

              <Field label={t("settings.proxy.testUrl")}>
                <TextInput
                  value={state.testUrl}
                  onChange={(v) => setField("testUrl", v)}
                  placeholder="https://api.taotoken.net/coding/v1"
                  mono
                />
              </Field>

              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <ConfigButton variant="secondary" onClick={() => void handleTest()} disabled={testState.phase === "testing" || !hasBasics}>
                  {t("settings.proxy.test")}
                </ConfigButton>
                <span style={{ marginLeft: 10, fontSize: 12, color: "var(--text-muted)" }}>
                  {testState.phase === "testing" ? t("settings.proxy.testing") : (
                    testState.phase === "success" ? (
                      <span style={{ color: "#4ade80" }}>
                        ✓ {testState.message} {testState.latencyMs !== undefined ? `(${testState.latencyMs} ms)` : ""}
                      </span>
                    ) : testState.phase === "error" ? (
                      <span style={{ color: "#f87171" }}>✗ {testState.message}</span>
                    ) : null
                  )}
                </span>
              </div>

              <ConfigSectionTitle>{t("settings.proxy.howItWorksTitle")}</ConfigSectionTitle>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
                {t("settings.proxy.howItWorks")}
              </p>
            </>
          )}
        </ConfigDetailStack>
      </ConfigDetail>

      <ConfigFooter status={statusNode}>
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>}
        <ConfigButton variant="danger" onClick={() => void handleDisable()} disabled={saveState.phase === "saving"}>
          {t("settings.proxy.disable")}
        </ConfigButton>
        <ConfigButton
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saveState.phase === "saving" || !hasBasics}
          className={saveState.phase === "success" ? "is-success" : undefined}
        >
          {saveState.phase === "saving" ? t("i18n.saving") : t("settings.proxy.save")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}