import type { ExplainItemResult } from "../audit/control.js";
import type { AuditLogEntry } from "../../schemas/audit.js";
import type { Evidence } from "../../schemas/evidence.js";
import type { NormalizedRecord } from "../../schemas/normalized-record.js";

export function formatShowRecord(result: ExplainItemResult): string {
  if (!result.found) {
    return `Context item not found: ${result.item_id}`;
  }

  const record = result.record;
  const lines = [
    `${record.id}`,
    `  kind: ${record.kind}`,
    `  state: ${record.state}`,
    `  confidence: ${formatConfidence(record)}`,
    `  text: ${record.text}`,
    ...formatOptional("valid_from", record.valid_from),
    ...formatOptional("valid_until", record.valid_until),
    ...formatOptional("invalidated_by", record.invalidated_by),
    ...formatOptional("last_verified_at", record.last_verified_at),
    `  observed_at: ${record.provenance.observed_at}`,
    `  recorded_by: ${record.provenance.recorded_by}`,
    `  session_id: ${record.provenance.session_id}`,
    ...formatList("paths", record.scope.paths),
    ...formatList("domains", record.scope.domains),
    ...formatList("symbols", record.scope.symbols),
    ...formatList("tags", record.scope.tags),
    ...formatList("supersedes", record.supersedes),
    ...formatList("conflicts_with", record.conflicts_with),
    ...formatVerification(record),
    ...formatEvidence(record.evidence),
    ...formatAudit(result.audit_entries)
  ];

  return lines.join("\n");
}

function formatConfidence(record: NormalizedRecord): string {
  if (record.confidence_score === undefined) {
    return record.confidence_level;
  }

  return `${record.confidence_level} (${record.confidence_score.toFixed(2)})`;
}

function formatOptional(label: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`  ${label}: ${value}`];
}

function formatList(label: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return [`  ${label}: ${values.join(", ")}`];
}

function formatEvidence(evidence: Evidence[]): string[] {
  if (evidence.length === 0) {
    return [];
  }

  return ["  evidence:", ...evidence.map((item) => `    - ${formatEvidenceItem(item)}`)];
}

function formatVerification(record: NormalizedRecord): string[] {
  if (record.verification === undefined) {
    return [];
  }

  const lines = [
    ...formatList("verification_commands", record.verification.commands),
    ...formatList("verification_files", record.verification.files),
    ...formatList("verification_notes", record.verification.notes)
  ];

  return lines.length > 0 ? ["  verification:", ...lines.map((line) => `  ${line}`)] : [];
}

function formatEvidenceItem(evidence: Evidence): string {
  const parts: string[] = [evidence.kind];

  if (evidence.repo !== undefined) parts.push(evidence.repo);
  if (evidence.file !== undefined) parts.push(evidence.file);
  if (evidence.lines !== undefined) parts.push(`lines ${evidence.lines[0]}-${evidence.lines[1]}`);
  if (evidence.commit !== undefined) parts.push(`commit ${evidence.commit}`);
  if (evidence.doc_role !== undefined) parts.push(`doc_role ${evidence.doc_role}`);
  if (evidence.issue !== undefined) parts.push(`issue #${evidence.issue}`);
  if (evidence.pr !== undefined) parts.push(`pr #${evidence.pr}`);
  if (evidence.url !== undefined) parts.push(evidence.url);

  return parts.join(" | ");
}

function formatAudit(entries: AuditLogEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }

  return [
    "  audit:",
    ...entries.map((entry) => {
      const parts = [entry.at, entry.action];

      if (entry.before_state !== undefined || entry.after_state !== undefined) {
        parts.push(`${entry.before_state ?? "none"} -> ${entry.after_state ?? "none"}`);
      }
      if (entry.reason !== undefined) parts.push(entry.reason);
      if (entry.run_id !== undefined) parts.push(`run ${entry.run_id}`);

      return `    - ${parts.join(" | ")}`;
    })
  ];
}
