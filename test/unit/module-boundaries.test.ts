import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("core modules do not import cli or mcp modules", () => {
  const violations = importViolations(join("src", "core"), ["src/cli", "src/mcp"]);

  assert.deepEqual(violations, []);
});

test("schema modules do not import cli mcp core or adapters modules", () => {
  const violations = importViolations(join("src", "schemas"), [
    "src/cli",
    "src/mcp",
    "src/core",
    "src/adapters"
  ]);

  assert.deepEqual(violations, []);
});

function importViolations(root: string, forbiddenPrefixes: string[]): string[] {
  const violations: string[] = [];

  for (const path of sourceFiles(root)) {
    const content = readFileSync(path, "utf8");

    for (const specifier of importSpecifiers(content)) {
      if (!specifier.startsWith(".")) {
        continue;
      }

      const resolved = normalizePath(join(path, "..", specifier));

      for (const prefix of forbiddenPrefixes) {
        if (resolved === prefix || resolved.startsWith(`${prefix}/`)) {
          violations.push(`${normalizePath(path)} imports ${specifier}`);
        }
      }
    }
  }

  return violations.sort();
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const importPattern = /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;

  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1];

    if (specifier !== undefined) {
      specs.push(specifier.replace(/\.js$/, ""));
    }
  }

  return specs;
}

function normalizePath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}
