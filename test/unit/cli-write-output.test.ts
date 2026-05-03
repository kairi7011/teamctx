import assert from "node:assert/strict";
import test from "node:test";
import {
  formatInitStoreResult,
  formatInvalidateResult,
  formatRecordObservationsReport,
  prepareRecordObservationInputs
} from "../../src/cli/index.js";

test("formatInitStoreResult renders the standard summary without root", () => {
  assert.equal(
    formatInitStoreResult({
      store: "github.com/team/context/contexts/service",
      localStore: false,
      createdFiles: ["a.json", "b.json"],
      existingFiles: ["c.json"]
    }),
    [
      "Initialized context store:",
      "  store: github.com/team/context/contexts/service",
      "  local_store: false",
      "  created_files: 2",
      "  existing_files: 1"
    ].join("\n")
  );
});

test("formatInitStoreResult includes the root line when present", () => {
  const formatted = formatInitStoreResult({
    store: "C:/work/service/.teamctx",
    localStore: true,
    root: "C:/work/service",
    createdFiles: [],
    existingFiles: []
  });

  const lines = formatted.split("\n");
  assert.equal(lines[0], "Initialized context store:");
  assert.equal(lines[1], "  store: C:/work/service/.teamctx");
  assert.equal(lines[2], "  local_store: true");
  assert.equal(lines[3], "  root: C:/work/service");
  assert.equal(lines[4], "  created_files: 0");
  assert.equal(lines[5], "  existing_files: 0");
});

test("formatInvalidateResult renders item id and state transition", () => {
  assert.equal(
    formatInvalidateResult({
      item_id: "rule-auth-order",
      before_state: "active",
      after_state: "archived"
    }),
    [
      "Invalidated context item:",
      "  item_id: rule-auth-order",
      "  before_state: active",
      "  after_state: archived"
    ].join("\n")
  );
});

test("formatRecordObservationsReport renders header, entries, findings, and total count", () => {
  const formatted = formatRecordObservationsReport("verified", [
    {
      index: 1,
      result: {
        recorded: true,
        path: "C:/store/raw/verified/event-1.json",
        relative_path: "raw/verified/event-1.json",
        findings: []
      }
    },
    {
      index: 2,
      result: {
        recorded: true,
        path: "C:/store/raw/verified/event-2.json",
        relative_path: "raw/verified/event-2.json",
        findings: [
          {
            severity: "warn",
            kind: "pii_email",
            field: "evidence[0].file",
            excerpt: "user@example.com"
          }
        ]
      }
    }
  ]);

  const lines = formatted.split("\n");
  assert.equal(lines[0], "Recorded verified raw observations:");
  assert.equal(lines[1], "  - 1: raw/verified/event-1.json");
  assert.equal(lines[2], "  - 2: raw/verified/event-2.json");
  assert.equal(lines[3], "      warn: pii_email in evidence[0].file user@example.com");
  assert.equal(lines[4], "  count: 2");
});

test("formatRecordObservationsReport supports candidate trust and a custom totalCount override", () => {
  const formatted = formatRecordObservationsReport(
    "candidate",
    [
      {
        index: 1,
        result: {
          recorded: true,
          path: "C:/store/raw/candidate/event-1.json",
          relative_path: "raw/candidate/event-1.json",
          findings: []
        }
      }
    ],
    5
  );

  const lines = formatted.split("\n");
  assert.equal(lines[0], "Recorded candidate raw observations:");
  assert.equal(lines[1], "  - 1: raw/candidate/event-1.json");
  assert.equal(lines[2], "  count: 5");
});

test("prepareRecordObservationInputs validates every batch item before writes", () => {
  assert.throws(
    () =>
      prepareRecordObservationInputs(
        [
          recordInput(),
          recordInput({
            evidence: [
              {
                kind: "docs",
                repo: "github.com/team/service",
                file: "README.md",
                lines: [1, 2],
                doc_role: "invalid"
              }
            ]
          })
        ],
        "verified"
      ),
    /docs evidence doc_role is invalid/
  );
});

test("prepareRecordObservationInputs materializes defaults for stable batch writes", () => {
  const prepared = prepareRecordObservationInputs([recordInput()], "verified");

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.index, 1);
  assert.equal(prepared[0]?.input.observation.trust, "verified");
  assert.equal(prepared[0]?.input.observation.kind, "fact");
  assert.equal(typeof prepared[0]?.input.observation.event_id, "string");
  assert.equal(typeof prepared[0]?.input.observation.session_id, "string");
});

function recordInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "fact",
    text: "Context capture should validate the entire batch before writing.",
    source_type: "inferred_from_code",
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/index.ts",
        lines: [1, 2]
      }
    ],
    ...overrides
  };
}
