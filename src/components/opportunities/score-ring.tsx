import { cn } from "@/lib/utils";

/** Colour band for a priority score; the same bands everywhere a score appears. */
export function scoreTone(score: number | null): { stroke: string; text: string } {
  if (score === null) return { stroke: "var(--border)", text: "text-muted-foreground" };
  if (score >= 80) return { stroke: "var(--signal-deep)", text: "text-[var(--signal-deep)]" };
  if (score >= 60) return { stroke: "var(--signal)", text: "text-primary" };
  if (score >= 40) return { stroke: "#d97706", text: "text-amber-700" };
  return { stroke: "#94a3b8", text: "text-slate-500" };
}

/** Priority score (0-100) as a ring, filled in proportion to the score. */
export function ScoreRing({ score, size = "md", className }: { score: number | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const dims = { sm: { box: 44, stroke: 4, font: "text-sm" }, md: { box: 56, stroke: 5, font: "text-lg" }, lg: { box: 96, stroke: 7, font: "text-3xl" } }[size];
  const radius = (dims.box - dims.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = scoreTone(score);

  return (
    <div
      className={cn("relative grid shrink-0 place-items-center", className)}
      style={{ width: dims.box, height: dims.box }}
      role="img"
      aria-label={score === null ? "Not scored" : `Priority score ${score} out of 100`}
    >
      <svg width={dims.box} height={dims.box} className="-rotate-90" aria-hidden="true">
        <circle cx={dims.box / 2} cy={dims.box / 2} r={radius} fill="none" stroke="var(--muted)" strokeWidth={dims.stroke} />
        {score !== null && (
          <circle
            cx={dims.box / 2}
            cy={dims.box / 2}
            r={radius}
            fill="none"
            stroke={tone.stroke}
            strokeWidth={dims.stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - score / 100)}
          />
        )}
      </svg>
      <span className={cn("absolute font-semibold tabular-nums", dims.font, tone.text)}>{score ?? "–"}</span>
    </div>
  );
}
