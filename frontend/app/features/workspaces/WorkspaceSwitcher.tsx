import { Form, Link } from 'react-router';
import type { WorkspaceAvailability } from '~/.server/auth/workspaces.js';

interface WorkspaceSwitcherProps {
  availability: WorkspaceAvailability;
  csrfToken: string;
  current: 'buyer' | 'seller' | 'admin';
  submitting: boolean;
}

/** Shows only destinations currently available to the signed-in account. */
export function WorkspaceSwitcher({
  availability,
  csrfToken,
  current,
  submitting,
}: WorkspaceSwitcherProps) {
  const sellerAvailable = availability.availableWorkspaces.seller;
  const adminAvailable = availability.adminEntryState !== 'unavailable';

  if (!sellerAvailable && !adminAvailable) {
    return (
      <p className="rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm font-semibold text-forest">
        Buyer workspace
      </p>
    );
  }

  const adminLabel =
    current === 'admin' || availability.adminEntryState === 'available'
      ? 'Admin workspace'
      : availability.adminMfaFactorState === 'active'
        ? 'Verify Admin'
        : availability.adminMfaFactorState === 'pending'
          ? 'Continue Admin setup'
          : 'Set up Admin';

  return (
    <nav
      aria-label="Workspace"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-stone-200 bg-white p-3"
    >
      {sellerAvailable ? (
        <Form
          action="/account"
          className="flex flex-wrap items-center gap-2"
          method="post"
          aria-busy={submitting}
        >
          <input name="csrfToken" type="hidden" value={csrfToken} />
          <button
            aria-pressed={current === 'buyer'}
            className="min-h-11 rounded-xl px-4 font-semibold text-forest outline-none focus-visible:ring-2 focus-visible:ring-forest focus-visible:ring-offset-2 aria-pressed:bg-forest aria-pressed:text-white disabled:opacity-60"
            disabled={submitting || current === 'buyer'}
            name="workspace"
            type="submit"
            value="buyer"
          >
            Buyer
          </button>
          <button
            aria-pressed={current === 'seller'}
            className="min-h-11 rounded-xl px-4 font-semibold text-forest outline-none focus-visible:ring-2 focus-visible:ring-forest focus-visible:ring-offset-2 aria-pressed:bg-forest aria-pressed:text-white disabled:opacity-60"
            disabled={submitting || current === 'seller'}
            name="workspace"
            type="submit"
            value="seller"
          >
            Seller
          </button>
        </Form>
      ) : (
        <span className="rounded-xl px-4 py-3 text-sm font-semibold text-forest">
          Buyer workspace
        </span>
      )}

      {adminAvailable ? (
        <Link
          aria-current={current === 'admin' ? 'page' : undefined}
          className="min-h-11 rounded-xl px-4 py-3 font-semibold text-forest outline-none focus-visible:ring-2 focus-visible:ring-forest focus-visible:ring-offset-2 aria-[current=page]:bg-forest aria-[current=page]:text-white"
          to="/admin"
        >
          {adminLabel}
        </Link>
      ) : null}

      <p className="sr-only" aria-live="polite" role="status">
        {submitting ? 'Switching workspace…' : ''}
      </p>
    </nav>
  );
}
