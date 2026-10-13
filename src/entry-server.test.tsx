import { describe, expect, it } from 'vitest';
import { render } from './entry-server.tsx';

// The exact markup prerendered into each page's #root. Every part is load
// bearing: styles.css targets the classes, hydration must reproduce it, and it
// is all a visitor sees before the bundle loads.
describe('render', () => {
  it('renders the home page as one card with the profile details and contact links', () => {
    expect(render('home')).toBe(
      '<main class="card">' +
        '<p class="eyebrow">Zachverse</p>' +
        '<h1>Zach Davids</h1>' +
        '<p class="role">Senior Software Engineer at Amazon</p>' +
        '<p class="status">Interactive portfolio coming soon.</p>' +
        '<nav aria-label="Contact"><ul class="links">' +
        '<li><a href="https://github.com/zachdavids" rel="me">GitHub</a></li>' +
        '<li><a href="https://www.linkedin.com/in/zacharydavids/" rel="me">LinkedIn</a></li>' +
        '<li><a href="mailto:zach@zachdavids.com">Email</a></li>' +
        '</ul></nav>' +
        '</main>',
    );
  });

  it('renders the 404 page as one card that only links home', () => {
    expect(render('not-found')).toBe(
      '<main class="card">' +
        '<p class="eyebrow">404</p>' +
        '<h1>Page not found</h1>' +
        '<p class="status">There&#x27;s nothing at this address.</p>' +
        '<p><a href="/">Go to the home page</a></p>' +
        '</main>',
    );
  });
});
