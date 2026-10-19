import { ContactLinks, SiteLinks } from '../components/Links.tsx';
import { profile, site } from '../content/index.ts';

/** Who Zach is, in one card: his name, role, and both employers, then the site's pages and his contact links. */
export function Home() {
  return (
    <main className="card">
      <p className="eyebrow">{site.name}</p>
      <h1>{profile.name}</h1>
      <p className="role">{profile.role}</p>
      {profile.summary.map((line) => (
        <p className="summary" key={line}>
          {line}
        </p>
      ))}
      <SiteLinks />
      <ContactLinks />
    </main>
  );
}
