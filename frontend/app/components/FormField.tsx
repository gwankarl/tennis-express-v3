import type { ReactNode } from 'react';

interface FormFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function FormField({ id, label, hint, error, children }: FormFieldProps) {
  const describedBy = [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold text-ink" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-sm leading-5 text-muted" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="text-sm leading-5 text-red-800" id={`${id}-error`}>
          {error}
        </p>
      )}
      {describedBy.length > 0 && <span className="sr-only">{describedBy}</span>}
    </div>
  );
}
