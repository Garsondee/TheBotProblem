/**
 * Replies cut off by their output cap (M5 pilot, 2026-11-20): a diary entry
 * keeps what was written; everything else is still refused and retried.
 */
import { describe, expect, it } from 'vitest';
import { partialStringField, salvageDiary } from '../game/schema';

describe('a reply cut off mid-string', () => {
  it('gives back the words written so far, escapes and all', () => {
    expect(partialStringField('{"diary": "I think \\"B\\" is lying,\\nand C kno', 'diary')).toBe('I think "B" is lying,\nand C kno');
    expect(partialStringField('{"diary":"caf\\u00e9 au', 'diary')).toBe('café au');
    expect(partialStringField('{"other": "x"', 'diary')).toBeNull();
    // A string that closed is returned whole.
    expect(partialStringField('{"diary": "done", "more": "x', 'diary')).toBe('done');
  });

  it('keeps a diary entry with an ellipsis where it was cut, but not a scrap', () => {
    const cut = '{"diary": "Room 2 ended with nobody out. A held the lever for six rounds while E kept asking us to wait, and I am starting to think that E,';
    expect(salvageDiary(cut)).toEqual({ diary: 'Room 2 ended with nobody out. A held the lever for six rounds while E kept asking us to wait, and I am starting to think that E …' });
    expect(salvageDiary('{"diary": "Too short')).toBeNull();
    expect(salvageDiary('not even json')).toBeNull();
  });
});
