export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <div className="text-xl font-semibold">LeadGenAI</div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
