import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-page px-4 py-6 font-sans text-ink sm:px-6 sm:py-10">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
        <Link className="inline-flex items-center gap-3 font-semibold text-forest" to="/">
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-full bg-forest text-sm font-bold text-white"
          >
            TX
          </span>
          <span>Tennis Xpress</span>
        </Link>
        <span className="hidden text-sm text-muted sm:block">Made for the love of tennis</span>
      </div>

      <div className="mx-auto flex min-h-[calc(100vh-7rem)] w-full max-w-5xl items-center justify-center py-10">
        {children}
      </div>
    </main>
  );
}

export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <section className="w-full max-w-110 rounded-3xl bg-card p-7 shadow-xl shadow-forest/5 sm:p-10">
      <span aria-hidden="true" className="block h-1.5 w-12 rounded-full bg-lime" />
      {children}
    </section>
  );
}
