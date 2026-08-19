import type { HexHubToolSpec } from "./catalog.js";
import type {
  HexHubAssetRegistry,
  ResolvedHexHubAsset,
  ResolvedHexHubContainer,
} from "./asset-registry.js";

export const DEFAULT_DOCKER_LOG_TAIL = 200;
export const DEFAULT_FILE_OFFSET = 1;
export const DEFAULT_FILE_LIMIT = 400;
export const MAX_FILE_LIMIT = 2_000;

export interface HexHubFileWindow {
  readonly offset: number;
  readonly limit: number;
}

export interface HexHubPreparedInput {
  readonly remoteArgs: Record<string, unknown>;
  readonly resultOptions?: {
    readonly fileWindow?: HexHubFileWindow;
  };
  readonly internal: {
    readonly asset?: ResolvedHexHubAsset;
    readonly container?: ResolvedHexHubContainer;
    readonly fileKey?: string;
  };
}

export interface HexHubLocalPathContext {
  readonly cwd: string;
  readonly direction: "upload" | "download";
  readonly signal?: AbortSignal;
}

export type HexHubLocalPathHook = (
  path: string,
  context: HexHubLocalPathContext,
) => string | Promise<string>;

export interface PrepareHexHubInputContext {
  readonly spec: HexHubToolSpec;
  readonly params: Readonly<Record<string, unknown>>;
  readonly registry: HexHubAssetRegistry;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly localPath?: HexHubLocalPathHook;
  readonly evidence?: HexHubFileReadEvidence;
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number | undefined,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum}${maximum === undefined ? "" : ` to ${maximum}`}.`,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required.`);
  return value;
}

function fileKey(
  asset: ResolvedHexHubAsset,
  container: ResolvedHexHubContainer | undefined,
  path: unknown,
): string {
  return `${asset.handle}\0${container?.handle ?? "-"}\0${requiredString(path, "Remote file path")}`;
}

export class HexHubFileReadEvidence {
  private readonly keys = new Set<string>();

  clear(): void {
    this.keys.clear();
  }

  mark(key: string): void {
    this.keys.add(key);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  assert(key: string): void {
    if (!this.keys.has(key)) {
      throw new Error(
        "Read this exact HexHub asset/container/path with hexhub_read before changing it.",
      );
    }
  }
}

export async function prepareHexHubInput(
  context: PrepareHexHubInputContext,
): Promise<HexHubPreparedInput> {
  const remoteArgs: Record<string, unknown> = { ...context.params };
  let asset: ResolvedHexHubAsset | undefined;
  let selectedContainer: ResolvedHexHubContainer | undefined;

  if (context.spec.remoteName === "list_assets") {
    if (remoteArgs.pattern === undefined) remoteArgs.pattern = "";
    return { remoteArgs, internal: {} };
  }

  const modelSchema = context.spec.parameters as unknown as Record<
    string,
    unknown
  >;
  const modelProperties = modelSchema.properties as
    | Record<string, unknown>
    | undefined;
  if (
    modelProperties &&
    "asset" in modelProperties &&
    remoteArgs.asset !== undefined
  ) {
    asset = context.registry.resolveAsset(remoteArgs.asset);
    delete remoteArgs.asset;
    remoteArgs.asset_ref = asset.ref;
  } else if (modelProperties && "asset" in modelProperties) {
    const required =
      Array.isArray(modelSchema.required) &&
      modelSchema.required.includes("asset");
    if (required)
      throw new Error("HexHub asset is required; call hexhub_assets first.");
    delete remoteArgs.asset;
  }

  if (context.spec.containerField && remoteArgs.container !== undefined) {
    if (!asset)
      throw new Error("Select a HexHub asset before selecting a container.");
    selectedContainer = context.registry.resolveContainer(
      asset,
      remoteArgs.container,
    );
    delete remoteArgs.container;
    remoteArgs[context.spec.containerField] =
      context.spec.containerField === "container_id"
        ? (selectedContainer.id ?? selectedContainer.name)
        : selectedContainer.name;
  } else {
    delete remoteArgs.container;
    if (asset?.type === "docker" && context.spec.containerField) {
      throw new Error(
        "A Docker container is required; call hexhub_docker_containers first.",
      );
    }
  }

  let resultOptions: HexHubPreparedInput["resultOptions"];
  if (context.spec.remoteName === "read") {
    const offset = integerInRange(
      remoteArgs.offset,
      DEFAULT_FILE_OFFSET,
      1,
      undefined,
      "HexHub read offset",
    );
    const limit = integerInRange(
      remoteArgs.limit,
      DEFAULT_FILE_LIMIT,
      1,
      MAX_FILE_LIMIT,
      "HexHub read limit",
    );
    delete remoteArgs.offset;
    delete remoteArgs.limit;
    resultOptions = { fileWindow: { offset, limit } };
  }

  if (
    context.spec.remoteName === "docker_container_logs" &&
    remoteArgs.tail_lines === undefined
  ) {
    remoteArgs.tail_lines = DEFAULT_DOCKER_LOG_TAIL;
  }

  if (context.spec.remoteName === "execute_sql") {
    requiredString(remoteArgs.db, "HexHub SQL db");
    requiredString(remoteArgs.schema, "HexHub SQL schema");
  }

  if (context.spec.remoteName === "scp_transfer") {
    const direction = remoteArgs.direction;
    if (direction !== "upload" && direction !== "download")
      throw new Error("HexHub SCP direction must be upload or download.");
    const supplied = requiredString(
      remoteArgs.local_path,
      "HexHub SCP local_path",
    );
    if (context.localPath) {
      remoteArgs.local_path = await context.localPath(supplied, {
        cwd: context.cwd,
        direction,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
  }

  const key =
    asset && "file_path" in remoteArgs
      ? fileKey(asset, selectedContainer, remoteArgs.file_path)
      : undefined;
  if (context.spec.requiresReadEvidence && key) context.evidence?.assert(key);

  return {
    remoteArgs,
    ...(resultOptions ? { resultOptions } : {}),
    internal: {
      ...(asset ? { asset } : {}),
      ...(selectedContainer ? { container: selectedContainer } : {}),
      ...(key ? { fileKey: key } : {}),
    },
  };
}
