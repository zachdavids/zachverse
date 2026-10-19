// Who Zach is, as the pages introduce him. Only add facts Zach has confirmed: the name, title, employer, and links on
// 2026-10-11, and the summary, worded from his résumé (resume.ts), on 2026-10-18.
const title = 'Senior Software Engineer';
const employer = 'Amazon';

export const profile = {
  name: 'Zach Davids',
  title,
  employer,
  role: `${title} at ${employer}`,
  // The home page's two lines, which name both employers.
  summary: [
    'I build embedded C++ systems, device-platform software, and AWS services for Kindle e-readers.',
    'Before Amazon, I was a gameplay programmer at Rockstar Games.',
  ],
  links: [
    { id: 'github', label: 'GitHub', href: 'https://github.com/zachdavids' },
    { id: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/in/zacharydavids/' },
    { id: 'email', label: 'Email', href: 'mailto:zach@zachdavids.com' },
  ],
} as const;
