/** 侧边栏会话“按天分组”的折叠状态持久化。 */

const STORAGE_KEY = "pi-web:session-day-collapse";
/** 标记默认折叠规则是否已应用过一次，避免每次加载都把“非今天”的分组折叠。 */
const SEEDED_KEY = "pi-web:session-day-collapse-seeded";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 读取已折叠的日期分组 key 集合。
 * @param storage 可注入的存储实现（测试用）
 */
export function loadCollapsedDayGroups(storage: StorageLike | null = getBrowserStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

/**
 * 写入已折叠的日期分组 key 集合。始终写入数组形式（包括空数组），
 * 以便与“从未初始化”区分开，保证用户手动展开后不会被默认规则覆盖。
 * @param collapsed 当前折叠的 dateKey 集合
 * @param storage 可注入的存储实现（测试用）
 */
export function saveCollapsedDayGroups(
  collapsed: Set<string>,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // 持久化为尽力而为，隐私模式/配额耗尽不应影响侧边栏。
  }
}

/**
 * 是否已经应用过默认折叠规则。首次加载时为 false，应用后置 true。
 * @param storage 可注入的存储实现（测试用）
 */
export function hasCollapseBeenSeeded(storage: StorageLike | null = getBrowserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SEEDED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 标记默认折叠规则已应用。
 * @param storage 可注入的存储实现（测试用）
 */
export function markCollapseSeeded(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SEEDED_KEY, "1");
  } catch {
    // ignore
  }
}
