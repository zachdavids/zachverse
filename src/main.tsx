import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { App, isPageId } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// The prerender step records which page it rendered so hydration matches it.
const page = isPageId(root.dataset.page) ? root.dataset.page : 'home';
const app = (
  <StrictMode>
    <App page={page} />
  </StrictMode>
);

// `npm run dev` serves the template unrendered, so there is nothing to hydrate.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
