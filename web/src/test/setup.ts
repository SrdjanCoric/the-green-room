import '@testing-library/jest-dom/vitest';

import { vi } from 'vitest';

// jsdom has no layout engine and does not implement programmatic scrolling; the
// screens scroll the window, so give the calls somewhere harmless to land. Tests
// that care about scrolling spy on `window.scrollTo` and assert the calls.
Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
