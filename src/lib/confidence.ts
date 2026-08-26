import type {
  ConfidenceEvidence,
  ConfidenceResult,
  GraftToolStatus,
} from "./types";

interface WeightedEvidence {
  key: keyof Omit<ConfidenceEvidence, "overrideScore">;
  weight: number;
  positive: string;
  negative: string;
}

const WEIGHTS: WeightedEvidence[] = [
  {
    key: "accessibleName",
    weight: 20,
    positive: "Accessible name found",
    negative: "No accessible name",
  },
  {
    key: "stableSelector",
    weight: 15,
    positive: "Stable selector resolves uniquely",
    negative: "Selector is not stable",
  },
  {
    key: "unambiguousRecipe",
    weight: 15,
    positive: "Structure matches an unambiguous recipe",
    negative: "Recipe requires semantic inference",
  },
  {
    key: "fullyTypedInputs",
    weight: 10,
    positive: "Every input maps to a typed parameter",
    negative: "One or more inputs require guessing",
  },
  {
    key: "positionalSelector",
    weight: -25,
    positive: "Selector depends on document position",
    negative: "Selector does not depend on document position",
  },
  {
    key: "classNameInference",
    weight: -20,
    positive: "Purpose inferred from class names",
    negative: "Purpose comes from page semantics",
  },
  {
    key: "ambiguousRepeat",
    weight: -20,
    positive: "Repeated region has no distinguishing key",
    negative: "Repeated rows have distinguishing content",
  },
  {
    key: "nameCollision",
    weight: -15,
    positive: "Normalized name collided with another tool",
    negative: "Normalized name is unique",
  },
];

function evidenceDetail(value: string | boolean, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function statusForConfidence(score: number): Exclude<GraftToolStatus, "published"> {
  if (score >= 70) return "auto";
  if (score >= 40) return "held";
  return "rejected";
}

export function scoreConfidence(evidence: ConfidenceEvidence): ConfidenceResult {
  let score = evidence.overrideScore ?? 50;
  const reasons: string[] = [];

  if (evidence.overrideScore !== undefined) {
    reasons.push(`Score fixed at ${evidence.overrideScore} for this deterministic recipe`);
  }

  for (const item of WEIGHTS) {
    const value = evidence[item.key];
    if (!value) continue;
    score += item.weight;
    const sign = item.weight > 0 ? "+" : "";
    reasons.push(
      `${sign}${item.weight}: ${evidenceDetail(value, item.weight > 0 ? item.positive : item.positive)}`,
    );
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clamped, reasons, status: statusForConfidence(clamped) };
}

export function applyCollisionPenalty(result: ConfidenceResult, detail: string): ConfidenceResult {
  const score = Math.max(0, result.score - 15);
  return {
    score,
    status: statusForConfidence(score),
    reasons: [...result.reasons, `-15: ${detail}`],
  };
}
