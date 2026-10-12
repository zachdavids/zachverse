import { describe, expect, it } from 'vitest';
import { isPageId } from './App.tsx';

// The pages' markup is tested through render() in entry-server.test.tsx.
describe('isPageId', () => {
  it('accepts known pages only', () => {
    expect(isPageId('home')).toBe(true);
    expect(isPageId('not-found')).toBe(true);
    expect(isPageId('admin')).toBe(false);
    expect(isPageId('')).toBe(false);
    expect(isPageId('toString')).toBe(false);
    expect(isPageId(undefined)).toBe(false);
  });
});
