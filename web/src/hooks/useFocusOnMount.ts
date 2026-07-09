import { useEffect, useRef } from 'react';

/**
 * Move keyboard focus to an element when the screen it heads mounts, so a screen-reader
 * user lands on the new scene's heading after a route or phase transition instead of
 * being stranded where the old screen left the focus. Attach the returned ref to a
 * heading given `tabIndex={-1}` so it can receive programmatic focus.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
