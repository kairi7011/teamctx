import { hostname } from "node:os";
import type { ContextStoreAdapter, ContextStoreFile } from "../../adapters/store/context-store.js";
import { isRecord } from "../../schemas/validation.js";

export const NORMALIZE_LEASE_PATH = "locks/normalize.json";

export type StoreLease = {
  format_version: 1;
  operation: "normalize";
  lease_id: string;
  owner: {
    tool: "teamctx";
    hostname: string;
    pid: number;
  };
  created_at: string;
  expires_at: string;
  store_revision: string | null;
};

export type StoreLeaseHandle = {
  lease: StoreLease;
  release: () => Promise<void>;
};

export type NormalizeLeaseStatus =
  | { state: "none" }
  | { state: "active" | "expired"; lease: StoreLease };

export class StoreLeaseActiveError extends Error {
  readonly lease: StoreLease;

  constructor(lease: StoreLease) {
    super(
      `normalize lease is active until ${lease.expires_at} by ${lease.owner.hostname}:${lease.owner.pid}`
    );
    this.name = "StoreLeaseActiveError";
    this.lease = lease;
  }
}

export async function acquireNormalizeLease(options: {
  store: ContextStoreAdapter;
  now?: () => Date;
  ttlMs?: number;
  leaseId?: string;
}): Promise<StoreLeaseHandle> {
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const existing = await options.store.readText(NORMALIZE_LEASE_PATH);
  const existingLease = existing ? parseLeaseFile(existing) : undefined;

  if (existingLease && Date.parse(existingLease.expires_at) > createdAt.getTime()) {
    throw new StoreLeaseActiveError(existingLease);
  }

  const lease: StoreLease = {
    format_version: 1,
    operation: "normalize",
    lease_id: options.leaseId ?? `lease-${createdAt.getTime().toString(16)}`,
    owner: {
      tool: "teamctx",
      hostname: hostname(),
      pid: process.pid
    },
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
    store_revision: await options.store.getRevision()
  };

  try {
    await options.store.writeText(NORMALIZE_LEASE_PATH, `${JSON.stringify(lease, null, 2)}\n`, {
      message: `Acquire teamctx normalize lease ${lease.lease_id}`,
      expectedRevision: existing?.revision ?? null
    });
  } catch (error) {
    if (isOptimisticWriteConflict(error)) {
      const current = await options.store.readText(NORMALIZE_LEASE_PATH);
      const currentLease = current ? parseLeaseFile(current) : undefined;

      if (currentLease) {
        throw new StoreLeaseActiveError(currentLease);
      }
    }

    throw error;
  }

  return {
    lease,
    release: () => releaseNormalizeLease(options.store, lease)
  };
}

export async function readNormalizeLeaseStatus(options: {
  store: ContextStoreAdapter;
  now?: () => Date;
}): Promise<NormalizeLeaseStatus> {
  const file = await options.store.readText(NORMALIZE_LEASE_PATH);

  if (!file) {
    return { state: "none" };
  }

  const now = options.now ?? (() => new Date());
  const lease = parseLeaseFile(file);

  return Date.parse(lease.expires_at) > now().getTime()
    ? { state: "active", lease }
    : { state: "expired", lease };
}

export function readNormalizeLeaseStatusFromContent(
  content: string | undefined,
  now: () => Date
): NormalizeLeaseStatus {
  if (content === undefined) {
    return { state: "none" };
  }

  const lease = parseLeaseContent(content);

  return Date.parse(lease.expires_at) > now().getTime()
    ? { state: "active", lease }
    : { state: "expired", lease };
}

async function releaseNormalizeLease(store: ContextStoreAdapter, lease: StoreLease): Promise<void> {
  const current = await store.readText(NORMALIZE_LEASE_PATH);

  if (!current) {
    return;
  }

  const currentLease = parseLeaseFile(current);

  if (currentLease.lease_id !== lease.lease_id) {
    return;
  }

  await store.deleteText(NORMALIZE_LEASE_PATH, {
    message: `Release teamctx normalize lease ${lease.lease_id}`,
    expectedRevision: current.revision
  });
}

function parseLeaseFile(file: ContextStoreFile): StoreLease {
  return parseLeaseContent(file.content);
}

function parseLeaseContent(content: string): StoreLease {
  const value = JSON.parse(content) as unknown;

  if (!isRecord(value)) {
    throw new Error("normalize lease file must be an object");
  }

  const owner = value.owner;

  if (!isRecord(owner)) {
    throw new Error("normalize lease owner must be an object");
  }

  return {
    format_version: requireLiteral(value.format_version, 1, "format_version"),
    operation: requireLiteral(value.operation, "normalize", "operation"),
    lease_id: requireString(value.lease_id, "lease_id"),
    owner: {
      tool: requireLiteral(owner.tool, "teamctx", "owner.tool"),
      hostname: requireString(owner.hostname, "owner.hostname"),
      pid: requireNumber(owner.pid, "owner.pid")
    },
    created_at: requireString(value.created_at, "created_at"),
    expires_at: requireString(value.expires_at, "expires_at"),
    store_revision:
      value.store_revision === null ? null : requireString(value.store_revision, "store_revision")
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`normalize lease ${field} must be a non-empty string`);
  }

  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`normalize lease ${field} must be a finite number`);
  }

  return value;
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw new Error(`normalize lease ${field} must be ${String(expected)}`);
  }

  return expected;
}

function isOptimisticWriteConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;

    if (status === 409 || status === 422) {
      return true;
    }
  }

  return error instanceof Error && error.message.toLowerCase().includes("conflict");
}
