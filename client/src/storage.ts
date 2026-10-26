/**
 * Web storage that never throws (private mode, blocked storage).
 * session = this tab only; persistent = survives closing the window (same browser).
 */
const area = (persistent: boolean) => (persistent ? localStorage : sessionStorage);

export const store = {
  get<T>(key: string, persistent = false): T | null {
    try {
      const raw = area(persistent).getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown, persistent = false) {
    try {
      if (value === null) area(persistent).removeItem(key);
      else area(persistent).setItem(key, JSON.stringify(value));
    } catch {
      /* in-memory only for this page */
    }
  },
};
