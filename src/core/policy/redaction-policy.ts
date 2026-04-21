import type { Evidence } from "../../schemas/evidence.js";
import type { RawObservation } from "../../schemas/observation.js";

export type SensitiveFindingSeverity = "block" | "warn";

export type SensitiveFindingKind =
  | "api_key"
  | "bearer_token"
  | "private_key"
  | "env_file"
  | "high_entropy"
  | "email"
  | "phone"
  | "internal_url";

export type SensitiveFinding = {
  severity: SensitiveFindingSeverity;
  kind: SensitiveFindingKind;
  field: string;
  excerpt: string;
};

export type SensitiveContentReport = {
  status: "allowed" | "blocked";
  findings: SensitiveFinding[];
};

const SECRET_PATTERNS: Array<{
  kind: SensitiveFindingKind;
  severity: SensitiveFindingSeverity;
  pattern: RegExp;
}> = [
  {
    kind: "private_key",
    severity: "block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i
  },
  {
    kind: "bearer_token",
    severity: "block",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i
  },
  {
    kind: "api_key",
    severity: "block",
    pattern: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i
  },
  {
    kind: "env_file",
    severity: "block",
    pattern: /(^|[/\\])\.env(?:$|[./\\])/i
  },
  {
    kind: "email",
    severity: "warn",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  },
  {
    kind: "phone",
    severity: "warn",
    pattern: /\b\+?\d[\d ().-]{8,}\d\b/
  },
  {
    kind: "internal_url",
    severity: "warn",
    pattern:
      /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|[A-Za-z0-9.-]+\.(?:local|internal|corp|lan|intra))\S*/i
  }
];

export function scanRawObservation(observation: RawObservation): SensitiveContentReport {
  const findings: SensitiveFinding[] = [];

  for (const field of rawObservationFields(observation)) {
    findings.push(...scanTextForSensitiveContent(field.value, field.name));
  }

  return {
    status: findings.some((finding) => finding.severity === "block") ? "blocked" : "allowed",
    findings
  };
}

export function scanTextForSensitiveContent(text: string, field = "text"): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];

  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) {
      findings.push({
        severity: rule.severity,
        kind: rule.kind,
        field,
        excerpt: redactedExcerpt(rule.kind)
      });
    }
  }

  if (containsHighEntropyToken(text)) {
    findings.push({
      severity: "block",
      kind: "high_entropy",
      field,
      excerpt: redactedExcerpt("high_entropy")
    });
  }

  return dedupeFindings(findings);
}

function rawObservationFields(observation: RawObservation): Array<{ name: string; value: string }> {
  const fields: Array<{ name: string; value: string }> = [
    { name: "text", value: observation.text },
    { name: "event_id", value: observation.event_id },
    { name: "session_id", value: observation.session_id },
    { name: "recorded_by", value: observation.recorded_by }
  ];

  observation.evidence.forEach((evidence, index) => {
    fields.push(...evidenceFields(evidence, `evidence[${index}]`));
  });

  return fields;
}

function evidenceFields(
  evidence: Evidence,
  prefix: string
): Array<{ name: string; value: string }> {
  const fields: Array<{ name: string; value: string }> = [];

  for (const key of ["repo", "commit", "file", "url"] as const) {
    const value = evidence[key];

    if (typeof value === "string") {
      fields.push({ name: `${prefix}.${key}`, value });
    }
  }

  return fields;
}

function containsHighEntropyToken(text: string): boolean {
  const matches = text.match(/[A-Za-z0-9_+/=-]{40,}/g) ?? [];

  return matches.some((value) => !isLikelyCommitSha(value) && shannonEntropy(value) >= 4.5);
}

function isLikelyCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();

  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;

    return entropy - probability * Math.log2(probability);
  }, 0);
}

function dedupeFindings(findings: SensitiveFinding[]): SensitiveFinding[] {
  const seen = new Set<string>();
  const deduped: SensitiveFinding[] = [];

  for (const finding of findings) {
    const key = `${finding.severity}:${finding.kind}:${finding.field}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(finding);
    }
  }

  return deduped;
}

function redactedExcerpt(kind: SensitiveFindingKind): string {
  return `[redacted:${kind}]`;
}
