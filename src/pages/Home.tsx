import { ContactLinks, SiteLinks } from '../components/Links.tsx';
import { profile } from '../content/index.ts';

/**
 * Who Zach is, in one card: his name, role, and both employers, then the site's pages and his contact links, in one
 * row of buttons that wraps where it runs out of room.
 */
export function Home() {
  return (
    <main className="card">
      <h1>{profile.name}</h1>
      <p className="role">{profile.role}</p>
      {profile.summary.map((line) => (
        <p className="summary" key={line}>
          {line}
        </p>
      ))}
      <div className="actions">
        <SiteLinks />
        <ContactLinks />
      </div>
    </main>
  );
}
