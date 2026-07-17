import '@testing-library/jest-dom/vitest';

import { vi } from 'vitest';

// Node 26 exposes an optional global localStorage whose unconfigured getter can
// shadow jsdom's storage. Keep browser tests deterministic on every supported Node.
if (!window.localStorage) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

// jsdom has no layout engine and does not implement programmatic scrolling; the
// screens scroll the window, so give the calls somewhere harmless to land. Tests
// that care about scrolling spy on `window.scrollTo` and assert the calls.
Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
