import type { ComponentType } from 'react';
import { pages, type PageId } from './content/index.ts';
import { Home } from './pages/Home.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Resume } from './pages/Resume.tsx';

export type { PageId };

export const pageIds: readonly PageId[] = pages.map((page) => page.id);

export function isPageId(value: unknown): value is PageId {
  return pageIds.includes(value as PageId);
}

const views: Record<PageId, ComponentType> = { home: Home, resume: Resume, 'not-found': NotFound };

export function App({ page }: { page: PageId }) {
  const View = views[page];
  return <View />;
}
