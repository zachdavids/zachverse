import { caseStudy } from './case-study.ts';
import { howBuilt } from './how-built.ts';
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
 * What a page's structured data says it is: a page about Zach, or an article by him, with its headline (schema.org's
 * ProfilePage and Article).
 */
export type Schema = { type: 'ProfilePage' } | { type: 'Article'; headline: string };

/**
 * One prerendered page: the address it is served at, or null for the 404 page, which every missing address gets; the
 * file in dist/ that address maps to, as infra/functions/viewer-request.js maps paths; the short name links to it use;
 * its title and meta description, which search results and link previews show; and, for a page with an address, what
 * its structured data says it is.
 */
export type Page = {
  /** Stable: the hydrated page's data-page value, so never reused for another page. */
  id: string;
  file: string;
  label: string;
  title: string;
  description: string;
} & ({ path: string; schema: Schema } | { path: null; schema: null });

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
    schema: { type: 'ProfilePage' },
  },
  {
    id: 'resume',
    path: '/resume/',
    file: 'resume/index.html',
    label: 'Résumé',
    title: `Résumé — ${profile.name}`,
    description: `${profile.name}'s résumé: work on Kindle and Amazon Kids at Amazon since 2020 and at Rockstar Games before that, with skills and education.`,
    schema: { type: 'ProfilePage' },
  },
  {
    id: 'kindle-feature-gating',
    path: '/work/kindle-feature-gating/',
    file: 'work/kindle-feature-gating/index.html',
    label: 'Case study',
    title: `${caseStudy.title} — ${profile.name}`,
    description: caseStudy.description,
    schema: { type: 'Article', headline: caseStudy.title },
  },
  {
    id: 'how-this-site-is-built',
    path: '/how-this-site-is-built/',
    file: 'how-this-site-is-built/index.html',
    label: 'How this site is built',
    title: `${howBuilt.title} — ${profile.name}`,
    description: howBuilt.description,
    schema: { type: 'Article', headline: howBuilt.title },
  },
  {
    id: 'not-found',
    path: null,
    file: '404.html',
    label: 'Page not found',
    title: `Page not found — ${profile.name}`,
    description: "There's nothing at this address.",
    schema: null,
  },
] as const satisfies readonly Page[];

export type PageId = (typeof pages)[number]['id'];
