import { useCallback, useEffect, useRef } from 'react';

/** How close to the bottom (px) still counts as "at the bottom". */
const NEAR_BOTTOM_PX = 120;

/** The page-scroll metrics the follow decision reads. */
export interface ScrollMetrics {
  scrollY: number;
  innerHeight: number;
  scrollHeight: number;
}

/** Whether the view sits within `threshold` px of the page bottom. */
export function isNearBottom(metrics: ScrollMetrics, threshold: number = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - (metrics.scrollY + metrics.innerHeight) <= threshold;
}

/** Scroll the page to whatever its bottom is right now, if following is engaged. */
export type FollowToBottom = (behavior?: 'instant' | 'smooth') => void;

/**
 * Keep the window pinned to the bottom of the page while the conversation grows,
 * chat-style. Following is on by default; the returned `follow` callback scrolls to
 * the current bottom whenever new content lands (call it from reveal ticks or content
 * effects — it is stable and causes no re-renders). A change of `beatTick` (a scene
 * beat: a new turn, a submitted answer) follows with a smooth glide instead.
 *
 * Release is intent-based, not position-based: only an *upward* scroll away from the
 * bottom disengages following — so the glide's own downward scroll events can never
 * release it — and scrolling back to within the threshold re-engages it.
 */
export function useStickToBottom({ beatTick }: { beatTick: unknown }): FollowToBottom {
  // Engagement is a ref, not state: it must never re-render the screen, and the
  // scroll listener updates it at scroll frequency.
  const engaged = useRef(true);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const movedUp = y < lastY.current;
      lastY.current = y;
      const near = isNearBottom({
        scrollY: y,
        innerHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
      });
      if (movedUp) {
        // Scrolling up to reread releases the follow (once past the threshold).
        engaged.current = near;
      } else if (near) {
        // Scrolling back down to the bottom re-engages it.
        engaged.current = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const follow = useCallback<FollowToBottom>((behavior = 'instant') => {
    if (engaged.current) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
    }
  }, []);

  useEffect(() => {
    follow('smooth');
  }, [beatTick, follow]);

  return follow;
}
