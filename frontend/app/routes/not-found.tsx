import { data, Link } from 'react-router';

export function loader() {
  return data(null, { status: 404 });
}

export default function NotFound() {
  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">404</p>
        <h1>Page not found.</h1>
        <p className="intro">We couldn’t find the page you requested.</p>
        <Link className="text-link" to="/">
          Return home
        </Link>
      </section>
    </main>
  );
}
