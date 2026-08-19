import { createHash } from "node:crypto";

import {
  HEXHUB_SPEC_BY_REMOTE_NAME,
  HEXHUB_TOOL_SPECS,
  type HexHubToolSpec,
} from "./catalog.js";
import type {
  HexHubCatalogSnapshot,
  RemoteToolDefinition,
} from "./contracts.js";

export type HexHubCompatibilityStatus =
  | "available"
  | "unavailable"
  | "incompatible";

export interface HexHubToolCompatibility {
  readonly spec: HexHubToolSpec;
  readonly status: HexHubCompatibilityStatus;
  readonly reason?: string;
  readonly optionalRemoteFields: readonly string[];
}

export interface HexHubCatalogDiagnostics {
  readonly epoch: number;
  readonly fingerprint: string;
  readonly tools: ReadonlyMap<string, HexHubToolCompatibility>;
  readonly unavailable: readonly string[];
  readonly incompatible: ReadonlyMap<string, string>;
  readonly unknown: readonly string[];
  readonly diagnostics: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function fingerprintHexHubCatalog(
  tools: readonly RemoteToolDefinition[],
): string {
  const sorted = [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(sorted)))
    .digest("hex")
    .slice(0, 20);
}

function sameStringSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right))
    return left === undefined && right === undefined;
  if (
    !left.every((item) => typeof item === "string") ||
    !right.every((item) => typeof item === "string")
  )
    return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameEnum(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return (
    left.length === right.length &&
    left.every((item, index) => Object.is(item, right[index]))
  );
}

function schemaType(value: Record<string, unknown>): unknown {
  return value.type;
}

interface SchemaComparison {
  errors: string[];
  optionalFields: string[];
}

function compareSchema(
  expectedValue: unknown,
  actualValue: unknown,
  path: string,
  comparison: SchemaComparison,
): void {
  const expected = asRecord(expectedValue);
  const actual = asRecord(actualValue);
  if (!expected || !actual) {
    if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue))
      comparison.errors.push(`${path} shape changed`);
    return;
  }

  if (
    JSON.stringify(schemaType(expected)) !== JSON.stringify(schemaType(actual))
  ) {
    comparison.errors.push(`${path}.type changed`);
    return;
  }
  if (!sameEnum(expected.enum, actual.enum))
    comparison.errors.push(`${path}.enum changed`);
  if (expected.additionalProperties !== actual.additionalProperties) {
    comparison.errors.push(`${path}.additionalProperties changed`);
  }
  if (!sameStringSet(expected.required, actual.required))
    comparison.errors.push(`${path}.required changed`);

  const expectedProperties = asRecord(expected.properties);
  const actualProperties = asRecord(actual.properties);
  if (expectedProperties || actualProperties) {
    if (!expectedProperties || !actualProperties) {
      comparison.errors.push(`${path}.properties changed`);
    } else {
      for (const [key, expectedProperty] of Object.entries(
        expectedProperties,
      )) {
        if (key in actualProperties) {
          compareSchema(
            expectedProperty,
            actualProperties[key],
            `${path}.properties.${key}`,
            comparison,
          );
        } else {
          comparison.errors.push(`${path}.properties.${key} removed`);
        }
      }
      const actualRequired = new Set(
        Array.isArray(actual.required)
          ? actual.required.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
      );
      for (const key of Object.keys(actualProperties)) {
        if (!(key in expectedProperties) && !actualRequired.has(key))
          comparison.optionalFields.push(`${path}.properties.${key}`);
      }
    }
  }

  if (expected.items !== undefined || actual.items !== undefined) {
    compareSchema(expected.items, actual.items, `${path}.items`, comparison);
  }
}

export function checkHexHubToolCompatibility(
  spec: HexHubToolSpec,
  remote: RemoteToolDefinition,
): HexHubToolCompatibility {
  const comparison: SchemaComparison = { errors: [], optionalFields: [] };
  compareSchema(spec.reviewedRemoteSchema, remote.inputSchema, "$", comparison);
  if (comparison.errors.length > 0) {
    return {
      spec,
      status: "incompatible",
      reason: comparison.errors.slice(0, 4).join("; "),
      optionalRemoteFields: Object.freeze(comparison.optionalFields),
    };
  }
  return {
    spec,
    status: "available",
    optionalRemoteFields: Object.freeze(comparison.optionalFields),
  };
}

export function analyzeHexHubCatalog(
  catalog:
    | Pick<HexHubCatalogSnapshot, "epoch" | "tools">
    | readonly RemoteToolDefinition[],
  epoch = 0,
): HexHubCatalogDiagnostics {
  const snapshot = Array.isArray(catalog)
    ? undefined
    : (catalog as Pick<HexHubCatalogSnapshot, "epoch" | "tools">);
  const tools = snapshot?.tools ?? (catalog as readonly RemoteToolDefinition[]);
  const catalogEpoch = snapshot?.epoch ?? epoch;
  const remoteByName = new Map(tools.map((tool) => [tool.name, tool]));
  const statuses = new Map<string, HexHubToolCompatibility>();
  const unavailable: string[] = [];
  const incompatible = new Map<string, string>();
  const diagnostics: string[] = [];

  for (const spec of HEXHUB_TOOL_SPECS) {
    const remote = remoteByName.get(spec.remoteName);
    if (!remote) {
      unavailable.push(spec.remoteName);
      statuses.set(spec.remoteName, {
        spec,
        status: "unavailable",
        optionalRemoteFields: Object.freeze([]),
      });
      continue;
    }
    const status = checkHexHubToolCompatibility(spec, remote);
    statuses.set(spec.remoteName, status);
    if (status.status === "incompatible")
      incompatible.set(spec.remoteName, status.reason ?? "schema changed");
    if (status.optionalRemoteFields.length > 0) {
      diagnostics.push(
        `${spec.remoteName}: added optional ${status.optionalRemoteFields.join(", ")}`,
      );
    }
  }

  const unknown = tools
    .map((tool) => tool.name)
    .filter((name) => !HEXHUB_SPEC_BY_REMOTE_NAME.has(name))
    .sort();
  if (unknown.length > 0)
    diagnostics.push(
      `unknown remote tools (report only): ${unknown.join(", ")}`,
    );
  if (unavailable.length > 0)
    diagnostics.push(`unavailable: ${unavailable.join(", ")}`);
  for (const [name, reason] of incompatible)
    diagnostics.push(`incompatible ${name}: ${reason}`);

  return Object.freeze({
    epoch: catalogEpoch,
    fingerprint: fingerprintHexHubCatalog(tools),
    tools: statuses,
    unavailable: Object.freeze(unavailable),
    incompatible,
    unknown: Object.freeze(unknown),
    diagnostics: Object.freeze(diagnostics),
  });
}
