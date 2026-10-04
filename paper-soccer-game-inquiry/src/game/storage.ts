/* ============================================================
 * PAPER SOCCER — crash-proof web storage (client-only)
 * Direct window.localStorage access THROWS in private/incognito modes,
 * embedded iframes with blocked cookies, and full-quota states. A single
 * unguarded call inside a module constructor (see sound.ts) used to take
 * down the whole page — the game would simply never launch. Every read
 * and write below degrades silently instead.
 * ============================================================ */

function store(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function storageGet(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, blocked cookies, quota) — the game
    // keeps working, it just cannot persist this particular setting.
  }
}

export function storageRemove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // ignore — see storageSet
  }
}

export function storageGetJSON<T>(key: string): T | null {
  try {
    const raw = storageGet(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function storageSetJSON(key: string, value: unknown): void {
  try {
    storageSet(key, JSON.stringify(value));
  } catch {
    // ignore — see storageSet
  }
}
