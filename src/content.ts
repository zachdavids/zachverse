// Public profile details shown on the placeholder. Only add facts Zach has
// confirmed; the role and links below were confirmed on 2026-10-11.
export const profile = {
  name: 'Zach Davids',
  role: 'Senior Software Engineer at Amazon',
  status: 'Interactive portfolio coming soon.',
  links: [
    { label: 'GitHub', href: 'https://github.com/zachdavids' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/zacharydavids/' },
    { label: 'Email', href: 'mailto:zach@zachdavids.com' },
  ],
} as const;

export const site = {
  origin: 'https://zachdavids.com',
  title: 'Zachverse — Zach Davids',
  notFoundTitle: 'Page not found — Zachverse',
  // The meta description, which search results and link previews show.
  description: `${profile.name}, ${profile.role}. ${profile.status}`,
} as const;
