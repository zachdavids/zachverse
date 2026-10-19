import { profile } from './profile.ts';

export const site = {
  // The site's name in link previews (og:site_name), as the pages give it; Zachverse is the project's name, which the
  // pages don't show.
  name: profile.name,
  origin: 'https://zachdavids.com',
  // The picture link previews show for every page: public/og-image.png, at its own size.
  image: {
    path: '/og-image.png',
    width: 1200,
    height: 630,
    alt: `${profile.name}, ${profile.role}`,
  },
} as const;

/**
 * One prerendered page: the address it is served at, or null for the 404 page, which every missing address gets; the
 * file in dist/ that address maps to, as infra/functions/viewer-request.js maps paths; the short name links to it use;
 * and its title and meta description, which search results and link previews show.
 */
export interface Page {
  /** Stable: the hydrated page's data-page value, so never reused for another page. */
  id: string;
  path: string | null;
  file: string;
  label: string;
  title: string;
  description: string;
}

/** Every page, in the order the prerender writes them; the app, prerender, sitemap, and checks all read this table. */
export const pages = [
  {
    id: 'home',
    path: '/',
    file: 'index.html',
    label: 'Home',
    title: `${profile.name} — ${profile.role}`,
    // The title names the role, so the description is the two lines that name both employers.
    description: profile.summary.join(' '),
  },
  {
    id: 'resume',
    path: '/resume/',
    file: 'resume/index.html',
    label: 'Résumé',
    title: `Résumé — ${profile.name}`,
    description: `${profile.name}'s résumé: work on Kindle and Amazon Kids at Amazon since 2020 and at Rockstar Games before that, with skills and education.`,
  },
  {
    id: 'not-found',
    path: null,
    file: '404.html',
    label: 'Page not found',
    title: `Page not found — ${profile.name}`,
    description: "There's nothing at this address.",
  },
] as const satisfies readonly Page[];

export type PageId = (typeof pages)[number]['id'];
