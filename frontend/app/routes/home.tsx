import type { Route } from './+types/home';
import { ApiRequestError, requestJson } from '../.server/api-client.js';
import { Link } from 'react-router';

interface HealthResponseData {
  status: 'ok';
}

interface HomeLoaderData {
  backendStatus: 'available' | 'unavailable';
}

function isHealthResponseData(value: unknown): value is HealthResponseData {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'ok';
}

export async function loader({ request }: Route.LoaderArgs): Promise<HomeLoaderData> {
  try {
    await requestJson('/health', {
      validateData: isHealthResponseData,
      signal: request.signal,
    });

    return { backendStatus: 'available' };
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }

    if (error instanceof ApiRequestError) {
      if (error.kind === 'cancelled') {
        throw error;
      }

      return { backendStatus: 'unavailable' };
    }

    throw error;
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main className="page">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Tennis Xpress home">
          <span className="brand-mark" aria-hidden="true">
            TX
          </span>
          <span>Tennis Xpress</span>
        </a>
        <span className="header-note">Made for the love of tennis</span>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">YOUR GAME, YOUR PACE</p>
        <h1 id="hero-title">A fresh start for your tennis journey.</h1>
        <p className="intro">
          Tennis Xpress is getting ready to bring the tennis community together. We’re glad you’re
          here.
        </p>
        <Link className="text-link" to="/register">
          Create your account
        </Link>
        <p className="backend-status" role="status">
          Backend {loaderData.backendStatus}
        </p>
        <p className="location">Launching in Yaoundé, Cameroon</p>
      </section>

      <footer className="site-footer">
        <span>Tennis Xpress</span>
        <span>Play your way.</span>
      </footer>
    </main>
  );
}
