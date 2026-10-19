// The site's content, apart from how the pages present it. The prerender, check:dist, and the browser check load it
// under plain Node, so it stays plain data: no asset, ?url, or .tsx imports (docs/phase-2-inputs.md, "Content module").
export { profile } from './profile.ts';
export { resume, type Education, type Project, type Resume, type Role, type Skill } from './resume.ts';
export { pages, site, type Page, type PageId } from './site.ts';
