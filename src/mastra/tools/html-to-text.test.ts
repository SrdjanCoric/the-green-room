import { describe, expect, it } from 'vitest';

import { htmlToText } from './html-to-text';

describe('htmlToText', () => {
  it('turns block ends and every <br> form into line breaks', () => {
    const text = htmlToText(
      '<p>First paragraph.</p><div>Requirements:<br>5 years<br/>TypeScript<br class="wrap">Node</div>',
    );

    expect(text).toBe('First paragraph.\nRequirements:\n5 years\nTypeScript\nNode');
  });

  it('drops scripts, styles, and comments rather than rendering them', () => {
    const text = htmlToText(
      '<style>.x{color:red}</style><script>alert(1)</script><!-- hidden -->Visible text',
    );

    expect(text).toBe('Visible text');
  });
});
