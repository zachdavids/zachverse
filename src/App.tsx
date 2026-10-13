import { profile } from './content.ts';

export const pageIds = ['home', 'not-found'] as const;
export type PageId = (typeof pageIds)[number];

export function isPageId(value: unknown): value is PageId {
  return pageIds.includes(value as PageId);
}

export function App({ page }: { page: PageId }) {
  return page === 'home' ? <Home /> : <NotFound />;
}

function Home() {
  return (
    <main className="card">
      <p className="eyebrow">Zachverse</p>
      <h1>{profile.name}</h1>
      <p className="role">{profile.role}</p>
      <p className="status">{profile.status}</p>
      <nav aria-label="Contact">
        <ul className="links">
          {profile.links.map((link) => (
            <li key={link.label}>
              <a href={link.href} rel={link.href.startsWith('https:') ? 'me' : undefined}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

function NotFound() {
  return (
    <main className="card">
      <p className="eyebrow">404</p>
      <h1>Page not found</h1>
      <p className="status">There's nothing at this address.</p>
      <p>
        <a href="/">Go to the home page</a>
      </p>
    </main>
  );
}
