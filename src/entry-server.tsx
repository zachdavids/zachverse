import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App, type PageId } from './App.tsx';

export function render(page: PageId): string {
  return renderToString(
    <StrictMode>
      <App page={page} />
    </StrictMode>,
  );
}
