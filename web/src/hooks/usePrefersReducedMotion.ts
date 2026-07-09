import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user asked the OS to reduce motion. Drives the JS-side motion the CSS
 * media query can't reach — chiefly the typewriter, which stamps its lines whole when
 * this is true instead of revealing them character by character. Safe when `matchMedia`
 * is absent (older jsdom, server render): it reports no preference (motion on).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => getInitial());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const onChange = () => setReduced(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function getInitial(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}
