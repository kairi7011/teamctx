import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { NORMALIZED_RECORD_FILES } from "../store/layout.js";
import {
  validateNormalizedRecord,
  type NormalizedRecord,
  type Scope
} from "../../schemas/normalized-record.js";
import type { GetContextInput, EnabledContextPayload } from "../../schemas/context-payload.js";

export type ComposedContext = Pick<
  EnabledContextPayload,
  "normalized_context" | "canonical_doc_refs" | "diagnostics"
>;

export function composeContextFromStore(
  storeRoot: string,
  input: GetContextInput = {}
): ComposedContext {
  const records = readNormalizedRecords(storeRoot);

  return composeContextFromRecords(records, input);
}

export async function composeContextFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput = {}
): Promise<ComposedContext> {
  const records = await readNormalizedRecordsFromContextStore(store);

  return composeContextFromRecords(records, input);
}

function composeContextFromRecords(
  records: NormalizedRecord[],
  input: GetContextInput
): ComposedContext {
  const activeRecords = records.filter((record) => record.state === "active");
  const scopedRecords = activeRecords.filter((record) => matchesInput(record.scope, input));

  return {
    normalized_context: {
      global: globalContext(activeRecords),
      scoped: scopedRecords.map((record) => ({
        scope: record.scope,
        content: record.text
      })),
      recent_decisions: activeRecords
        .filter((record) => record.kind === "decision")
        .map((record) => record.text),
      active_pitfalls: activeRecords
        .filter((record) => record.kind === "pitfall")
        .map((record) => record.text),
      applicable_workflows: activeRecords
        .filter((record) => record.kind === "workflow")
        .map((record) => record.text)
    },
    canonical_doc_refs: [],
    diagnostics: {
      contested_items: records
        .filter((record) => record.state === "contested")
        .map((record) => record.id),
      stale_items: records.filter((record) => record.state === "stale").map((record) => record.id),
      dropped_items: []
    }
  };
}

export function emptyComposedContext(): ComposedContext {
  return {
    normalized_context: {
      global: "",
      scoped: [],
      recent_decisions: [],
      active_pitfalls: [],
      applicable_workflows: []
    },
    canonical_doc_refs: [],
    diagnostics: {
      contested_items: [],
      stale_items: [],
      dropped_items: []
    }
  };
}

function readNormalizedRecords(storeRoot: string): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];

  for (const file of NORMALIZED_RECORD_FILES) {
    const path = join(storeRoot, "normalized", file);

    for (const line of readJsonlLines(path)) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

async function readNormalizedRecordsFromContextStore(
  store: ContextStoreAdapter
): Promise<NormalizedRecord[]> {
  const records: NormalizedRecord[] = [];

  for (const file of NORMALIZED_RECORD_FILES) {
    const storeFile = await store.readText(`normalized/${file}`);

    for (const line of jsonlLines(storeFile?.content ?? "")) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function readJsonlLines(path: string): string[] {
  try {
    return jsonlLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function jsonlLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function globalContext(records: NormalizedRecord[]): string {
  return records
    .filter(
      (record) => record.kind === "fact" || record.kind === "rule" || record.kind === "glossary"
    )
    .map((record) => record.text)
    .join("\n");
}

function matchesInput(scope: Scope, input: GetContextInput): boolean {
  const files = [...(input.target_files ?? []), ...(input.changed_files ?? [])];

  if (files.length === 0) {
    return false;
  }

  return scope.paths.some((pattern) => files.some((file) => matchesPath(pattern, file)));
}

function matchesPath(pattern: string, file: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedFile = normalizePath(file);

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -"/**".length);

    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);

    return regex.test(normalizedFile);
  }

  return normalizedFile === normalizedPattern || relative(normalizedPattern, normalizedFile) === "";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): string {
  let output = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      output += ".*";
      index += 1;
    } else if (char === "*") {
      output += "[^/]*";
    } else if (char) {
      output += escapeRegex(char);
    }
  }

  return output;
}
