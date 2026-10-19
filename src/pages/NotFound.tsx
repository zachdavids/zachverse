/** What every missing address shows, with status 404: one card that links home. */
export function NotFound() {
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
