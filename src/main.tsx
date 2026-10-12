import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { App, isPageId } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// The prerender step records which page it rendered so hydration matches it.
const page = isPageId(root.dataset.page) ? root.dataset.page : 'home';

hydrateRoot(
  root,
  <StrictMode>
    <App page={page} />
  </StrictMode>,
);
