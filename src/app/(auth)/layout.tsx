import { OpportunityPreview } from "@/components/auth/opportunity-preview";
import { Logo } from "@/components/brand/logo";

/** Concentric signal arcs radiating from the panel's bottom-right corner (the brand mark, enlarged). */
function PanelArcs() {
  return (
    <svg
      viewBox="0 0 800 800"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute -right-40 -bottom-40 h-[900px] w-[900px] text-white"
    >
      {[160, 280, 400, 520, 640, 760].map((radius, index) => (
        <circle
          key={radius}
          cx="800"
          cy="800"
          r={radius}
          stroke="currentColor"
          strokeWidth="1.5"
          opacity={0.16 - index * 0.022}
        />
      ))}
    </svg>
  );
}

/** Fits the viewport exactly on desktop, so the page itself never scrolls. */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-screen lg:h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:overflow-hidden">
      <div className="flex flex-col px-6 py-8 sm:px-12 lg:overflow-y-auto">
        <Logo />
        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>

      <aside className="relative hidden overflow-hidden bg-[var(--signal-deep)] text-white lg:flex">
        <PanelArcs />
        <div className="relative mx-auto flex w-full max-w-lg flex-col justify-center gap-10 px-10 py-10">
          <div>
            <h2 className="text-3xl leading-tight font-semibold text-white xl:text-[2.125rem]">
              Find the companies already showing you why they need you.
            </h2>
            <p className="mt-4 text-white/75 [@media(max-height:820px)]:hidden">
              LeadGenAI turns hiring posts, requests and company news into ranked opportunities, with
              the evidence attached.
            </p>
          </div>

          <OpportunityPreview />
        </div>
      </aside>
    </div>
  );
}
