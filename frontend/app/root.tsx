import type { ReactNode } from 'react';
import { loadFrontendConfig } from './.server/env.js';
import { Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useNavigation } from 'react-router';
import './styles/global.css';

export function loader() {
  loadFrontendConfig();
  return null;
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <title>Tennis Xpress</title>
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const navigation = useNavigation();

  return (
    <>
      {navigation.state !== 'idle' && (
        <div className="navigation-pending" role="status" aria-live="polite" aria-atomic="true">
          Loading page…
        </div>
      )}
      <Outlet />
    </>
  );
}

export function ErrorBoundary() {
  return (
    <Layout>
      <main className="page">
        <section className="hero" role="alert">
          <p className="eyebrow">TENNIS XPRESS</p>
          <h1>Something went wrong.</h1>
          <p className="intro">We couldn’t load this page. Please try again or return home.</p>
          <Link className="text-link" to="/">
            Return home
          </Link>
        </section>
      </main>
    </Layout>
  );
}
