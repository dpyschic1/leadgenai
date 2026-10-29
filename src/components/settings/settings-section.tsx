import type { ReactNode } from "react";

/** A settings block: heading and explanation on the left, the controls on the right. */
export function SettingsSection({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="grid gap-6 border-t pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-12">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-xl border bg-card">
        <div className="p-6">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t px-6 py-4">{footer}</div>}
      </div>
    </section>
  );
}
