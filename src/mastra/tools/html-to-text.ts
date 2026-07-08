/** Strip HTML to readable text: drop scripts/styles, turn block ends into newlines. */
export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutNoise
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\b[^>]*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const lowered = entity.toLowerCase();
    const named = NAMED_ENTITIES[lowered];
    if (named !== undefined) return named;
    if (lowered.startsWith('#x')) {
      return fromCodePoint(Number.parseInt(entity.slice(2), 16), whole);
    }
    if (lowered.startsWith('#')) {
      return fromCodePoint(Number.parseInt(entity.slice(1), 10), whole);
    }
    return whole;
  });
}

/** `String.fromCodePoint`, but leaves an out-of-range code point (`> 0x10FFFF`) untouched. */
function fromCodePoint(code: number, fallback: string): string {
  // Out of the Unicode range throws RangeError; a malformed posting must not crash the run.
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}
