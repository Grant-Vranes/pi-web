// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ipcRenderer } = require("electron");

const CONTEXT_MENU_CHANNEL = "pi-web:show-session-row-contextmenu";
const CONFIRM_DELETE_CHANNEL = "pi-web:confirm-delete-session";
const CONTEXT_MENU_EVENT = "pi-web:session-row-contextmenu";

window.addEventListener(CONTEXT_MENU_EVENT, (event) => {
  const detail = event && event.detail;
  if (!detail || typeof detail.refresh !== "function") {
    return;
  }

  event.preventDefault();

  void (async () => {
    const action = await ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, {
      id: detail.id,
      path: detail.path,
      cwd: detail.cwd,
      name: detail.name,
      clientX: detail.clientX,
      clientY: detail.clientY,
    });

    if (action !== "delete") {
      return;
    }

    const confirmed = await ipcRenderer.invoke(CONFIRM_DELETE_CHANNEL, {
      id: detail.id,
      name: detail.name,
    });
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/sessions/${encodeURIComponent(detail.id)}`, {
      method: "DELETE",
    });

    if (response.ok) {
      detail.refresh();
      return;
    }

    const body = await response.text().catch(() => "");
    const message = body ? `删除失败：${response.status} ${body}` : `删除失败：HTTP ${response.status}`;
    window.alert(message);
  })();
}, true);
