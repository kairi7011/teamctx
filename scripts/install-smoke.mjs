import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const binName = process.platform === "win32" ? "teamctx.cmd" : "teamctx";
const npmCli = process.env.npm_execpath;
const root = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "teamctx-install-smoke-"));
const packDir = join(tempRoot, "pack");
const prefixDir = join(tempRoot, "prefix");
const smokeWorkDir = join(tempRoot, "work");
let lastStdout = "";

try {
  if (npmCli === undefined || npmCli.length === 0) {
    throw new Error("npm_execpath is required; run this script through npm");
  }

  mkdirSync(packDir, { recursive: true });
  mkdirSync(smokeWorkDir, { recursive: true });

  runNpm(["pack", "--json", "--pack-destination", packDir], root);
  const packResult = JSON.parse(lastStdout);
  const tarballName = Array.isArray(packResult) ? packResult[0]?.filename : undefined;

  if (typeof tarballName !== "string" || tarballName.length === 0) {
    throw new Error("npm pack did not report a tarball filename");
  }

  const tarballPath = join(packDir, tarballName);

  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack tarball was not created: ${tarballPath}`);
  }

  runNpm(
    ["install", tarballPath, "--prefix", prefixDir, "--ignore-scripts", "--no-audit", "--no-fund"],
    root
  );

  const binPath = join(prefixDir, "node_modules", ".bin", binName);
  const cliPath = join(prefixDir, "node_modules", "teamctx", "dist", "cli", "index.js");

  if (!existsSync(binPath)) {
    throw new Error(`installed teamctx binary was not created: ${binPath}`);
  }

  if (!existsSync(cliPath)) {
    throw new Error(`installed teamctx CLI entrypoint was not created: ${cliPath}`);
  }

  run(process.execPath, [cliPath, "--help"], smokeWorkDir);
  run(process.execPath, [cliPath, "doctor"], smokeWorkDir);
  console.log("install smoke passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  run(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? result.error?.message ?? "";

  lastStdout = stdout;

  if (result.status !== 0) {
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, stdout.trim(), stderr.trim()]
        .filter((line) => line.length > 0)
        .join("\n")
    );
  }

  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }
}
