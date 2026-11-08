import { useState } from 'react';
import { FormField } from '~/components/FormField.js';

interface PasswordFieldProps {
  error?: string;
}

export function PasswordField({ error }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <FormField
      id="password"
      label="Password"
      hint="Use 15–128 characters. A passphrase works well."
      error={error}
    >
      <div className="relative">
        <input
          autoComplete="new-password"
          className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 pr-20 text-ink outline-none transition placeholder:text-stone-400 focus:border-forest focus:ring-2 focus:ring-forest/15"
          id="password"
          name="password"
          required
          type={visible ? 'text' : 'password'}
          aria-describedby={['password-hint', error ? 'password-error' : undefined]
            .filter(Boolean)
            .join(' ')}
          aria-invalid={Boolean(error)}
        />
        <button
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="absolute inset-y-0 right-3 my-auto h-9 rounded-md px-2 text-sm font-semibold text-forest underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-forest"
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? 'Hide' : 'Show'}
          <span className="sr-only"> password</span>
        </button>
      </div>
    </FormField>
  );
}
