import { describe, expect, it } from 'vitest';
import { isPageId, pageIds } from './App.tsx';
import { pages } from './content/index.ts';

// The pages' markup is tested through render() in entry-server.test.tsx.
describe('isPageId', () => {
  it('accepts known pages only', () => {
    expect(isPageId('home')).toBe(true);
    expect(isPageId('resume')).toBe(true);
    expect(isPageId('not-found')).toBe(true);
    expect(isPageId('admin')).toBe(false);
    expect(isPageId('')).toBe(false);
    expect(isPageId('toString')).toBe(false);
    expect(isPageId(undefined)).toBe(false);
  });

  it('knows every page in the content table, in its order', () => {
    expect(pageIds).toEqual(pages.map((page) => page.id));
  });
});
