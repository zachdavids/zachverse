import { pages, profile } from '../content/index.ts';

/** Links to the site's pages, other than the home page and the 404 page, as a row of buttons. */
export function SiteLinks() {
  return (
    <nav aria-label="Site">
      <ul className="links">
        {pages.map((page) =>
          page.path === null || page.path === '/' ? null : (
            <li key={page.id}>
              <a href={page.path}>{page.label}</a>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

/** Zach's profiles and email, as a row of buttons; rel="me" ties the profiles to this site. */
export function ContactLinks() {
  return (
    <nav aria-label="Contact">
      <ul className="links">
        {profile.links.map((link) => (
          <li key={link.id}>
            <a href={link.href} rel={link.href.startsWith('https:') ? 'me' : undefined}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
