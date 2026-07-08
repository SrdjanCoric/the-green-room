import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isNearBottom, useStickToBottom, type FollowToBottom } from './useStickToBottom';

describe('isNearBottom', () => {
  it('counts the view as at the bottom within the threshold', () => {
    expect(isNearBottom({ scrollY: 880, innerHeight: 600, scrollHeight: 1500 }, 120)).toBe(true);
    expect(isNearBottom({ scrollY: 900, innerHeight: 600, scrollHeight: 1500 }, 120)).toBe(true);
  });

  it('flips exactly at the threshold boundary', () => {
    // scrollHeight 1500, viewport 600: distance from bottom = 1500 - (scrollY + 600).
    expect(isNearBottom({ scrollY: 780, innerHeight: 600, scrollHeight: 1500 }, 120)).toBe(true);
    expect(isNearBottom({ scrollY: 779, innerHeight: 600, scrollHeight: 1500 }, 120)).toBe(false);
  });

  it('counts the view as scrolled away beyond the threshold', () => {
    expect(isNearBottom({ scrollY: 300, innerHeight: 600, scrollHeight: 1500 }, 120)).toBe(false);
  });
});

function Harness({ beat, expose }: { beat: unknown; expose: (follow: FollowToBottom) => void }) {
  expose(useStickToBottom({ beatTick: beat }));
  return <div />;
}

function setScrollHeight(height: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: height,
    configurable: true,
  });
}

function scrollWindowTo(y: number) {
  window.scrollY = y;
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

describe('useStickToBottom', () => {
  let follow: FollowToBottom;
  const expose = (fn: FollowToBottom) => {
    follow = fn;
  };

  beforeEach(() => {
    vi.mocked(window.scrollTo).mockClear();
    setScrollHeight(2000);
    window.scrollY = 2000 - window.innerHeight;
  });

  it('follows new content to the bottom instantly while engaged', () => {
    render(<Harness beat={0} expose={expose} />);
    vi.mocked(window.scrollTo).mockClear();

    act(() => follow());

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' });
  });

  it('glides smoothly on a new beat (a turn transition)', () => {
    const { rerender } = render(<Harness beat={1} expose={expose} />);
    vi.mocked(window.scrollTo).mockClear();

    rerender(<Harness beat={2} expose={expose} />);

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
  });

  it('releases when the reader scrolls up away from the bottom, and stays released', () => {
    render(<Harness beat={0} expose={expose} />);

    scrollWindowTo(200); // upward, well past the threshold
    vi.mocked(window.scrollTo).mockClear();

    act(() => follow());

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('never releases on downward scrolls, even far from a freshly grown bottom', () => {
    // The hook's own smooth glide fires downward scroll events while the page grows
    // under it (streaming report text); those must not disengage the follow.
    render(<Harness beat={0} expose={expose} />);
    setScrollHeight(3000);
    scrollWindowTo(1400); // downward (glide in flight), still >120px from the new bottom
    vi.mocked(window.scrollTo).mockClear();

    act(() => follow());

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: 'instant' });
  });

  it('re-engages once the reader returns near the bottom', () => {
    render(<Harness beat={0} expose={expose} />);

    scrollWindowTo(200); // release
    scrollWindowTo(2000 - window.innerHeight - 40); // back down, within the threshold
    vi.mocked(window.scrollTo).mockClear();

    act(() => follow());

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' });
  });
});
