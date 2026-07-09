/**
 * Write to storage, swallowing a failure (a full quota, or Safari private mode, where
 * `setItem` throws). These writes ride the stream/phase hot path and hydration path;
 * losing one only makes state non-durable across a reload — never a reason to kill a
 * healthy live stream or crash a render. Returns whether the write landed.
 */
export function safeSetItem(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
