interface AlertProps {
  children: string;
}

export function Alert({ children }: AlertProps) {
  return (
    <div
      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-900"
      role="alert"
    >
      {children}
    </div>
  );
}
