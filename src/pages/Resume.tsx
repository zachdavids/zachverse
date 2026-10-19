import { ContactLinks } from '../components/Links.tsx';
import { profile, resume } from '../content/index.ts';

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="bullets">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** The résumé, in the order Zach's résumé gives it, in one card that links home and to his contact links. */
export function Resume() {
  return (
    <main className="card">
      <nav aria-label="Site" className="eyebrow">
        <a href="/">{profile.name}</a>
      </nav>
      <h1>Résumé</h1>
      <p className="role">{resume.headline}</p>
      <ContactLinks />
      <section>
        <h2>Profile Summary</h2>
        <Bullets items={resume.summary} />
      </section>
      <section>
        <h2>Technical Skills</h2>
        <dl className="skills">
          {resume.skills.map((skill) => (
            <div key={skill.id}>
              <dt>{skill.name}</dt>
              <dd>{skill.items}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h2>Work Experience</h2>
        {resume.experience.map((role) => (
          <article key={role.id}>
            <h3>{role.title}</h3>
            <p className="meta">{`${role.employer} · ${role.dates}`}</p>
            <Bullets items={role.highlights} />
            {role.projects.map((project) => (
              <section key={project.id}>
                <h4>{project.name}</h4>
                <Bullets items={project.highlights} />
              </section>
            ))}
          </article>
        ))}
      </section>
      <section>
        <h2>Education</h2>
        {resume.education.map((degree) => (
          <article key={degree.id}>
            <h3>{degree.degree}</h3>
            <p className="meta">{`${degree.school} · ${degree.date}`}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
