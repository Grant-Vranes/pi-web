import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { SESSION_ROW_CONTEXT_MENU_EVENT, type SessionRowContextMenuDetail } from "./session-row-context-menu";

/** True only inside the Tauri WebView; ordinary browser deployments stay intact. */
export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface DesktopTerminalResult {
  ok: boolean;
  error?: string;
}

export async function openDesktopTerminal(payload: { cwd: string; branch?: string | null }): Promise<DesktopTerminalResult> {
  return invoke<DesktopTerminalResult>("open_terminal", payload);
}

export async function confirmSessionDelete(detail: Pick<SessionRowContextMenuDetail, "id" | "name">): Promise<boolean> {
  return invoke<boolean>("confirm_delete", { id: detail.id, name: detail.name });
}

/**
 * Tauri replacement for Electron preload's session-row context-menu listener.
 * Native Tauri menu integration is added separately; this preserves the
 * deletion safety path immediately and prevents the browser context menu.
 */
export function installTauriSessionContextMenu(): () => void {
  if (!isTauriDesktop()) return () => {};

  const listener = (event: Event) => {
    const custom = event as CustomEvent<SessionRowContextMenuDetail>;
    const detail = custom.detail;
    if (!detail || typeof detail.refresh !== "function") return;
    event.preventDefault();

    void (async () => {
      const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
      const remove = async () => {
        if (!await confirmSessionDelete(detail)) return;
        const response = await fetch(`/api/sessions/${encodeURIComponent(detail.id)}`, { method: "DELETE" });
        if (response.ok) {
          detail.refresh();
          return;
        }
        const body = await response.text().catch(() => "");
        window.alert(body ? `删除失败：${response.status} ${body}` : `删除失败：HTTP ${response.status}`);
      };
      const separator = await PredefinedMenuItem.new({ item: "Separator" });
      const menu = await Menu.new({
        items: [
          { text: detail.name ? `会话：${detail.name}` : `会话：${detail.id}`, enabled: false },
          separator,
          { text: "复制会话 ID", action: () => copy(detail.id) },
          { text: "复制会话文件路径", action: () => copy(detail.path) },
          { text: "复制工作目录", action: () => copy(detail.cwd) },
          { text: "在文件管理器中显示会话文件", action: () => { void invoke("reveal_path", { path: detail.path }); } },
          separator,
          { text: "删除会话…", action: () => { void remove(); } },
        ],
      });
      await menu.popup(new PhysicalPosition(detail.clientX, detail.clientY));
    })();
  };

  window.addEventListener(SESSION_ROW_CONTEXT_MENU_EVENT, listener, true);
  return () => window.removeEventListener(SESSION_ROW_CONTEXT_MENU_EVENT, listener, true);
}
