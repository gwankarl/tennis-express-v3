import type { ButtonHTMLAttributes } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-forest px-5 py-3 font-semibold text-white transition hover:bg-forest/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      {...props}
    />
  );
}
