export type HexHubAssetKind = "ssh" | "docker" | "db" | "redis" | "asset";

export interface HexHubPublicAsset {
  readonly asset: string;
  readonly type: HexHubAssetKind;
  readonly name: string;
  readonly host?: string;
  readonly path?: string;
  readonly db_type?: string;
}

export interface HexHubPublicContainer {
  readonly container: string;
  readonly name: string;
  readonly image?: string;
  readonly status?: string;
  readonly health?: string;
}

export interface ResolvedHexHubAsset {
  readonly handle: string;
  readonly ref: string;
  readonly type: HexHubAssetKind;
  readonly name: string;
}

export interface ResolvedHexHubContainer {
  readonly handle: string;
  readonly name: string;
  readonly id?: string;
}

interface AssetEntry extends ResolvedHexHubAsset {
  readonly public: HexHubPublicAsset;
}

interface ContainerEntry extends ResolvedHexHubContainer {
  readonly assetRef: string;
  readonly public: HexHubPublicContainer;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseTextJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[")))
    return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function preferredPayload(result: unknown): unknown {
  const root = asRecord(result);
  if (!root) return parseTextJson(result);
  if (root.structuredContent !== undefined)
    return parseTextJson(root.structuredContent);
  if (Array.isArray(root.content)) {
    const text = root.content
      .map(asRecord)
      .filter(
        (block): block is Record<string, unknown> =>
          block !== undefined && block.type === "text",
      )
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return parseTextJson(text);
  }
  return root;
}

function findRecords(
  value: unknown,
  preferredKeys: readonly string[],
): Record<string, unknown>[] {
  const parsed = parseTextJson(value);
  if (Array.isArray(parsed))
    return parsed
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== undefined);
  const record = asRecord(parsed);
  if (!record) return [];
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== undefined);
    }
  }
  for (const child of Object.values(record)) {
    const childRecord = asRecord(child);
    if (childRecord) {
      const found = findRecords(childRecord, preferredKeys);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function assetKind(record: Record<string, unknown>): HexHubAssetKind {
  const raw =
    firstString(record, ["type", "asset_type", "kind"])?.toLowerCase() ?? "";
  if (raw.includes("docker") || raw.includes("container")) return "docker";
  if (raw.includes("redis")) return "redis";
  if (
    raw.includes("database") ||
    raw === "db" ||
    firstString(record, ["db_type", "database_type"])
  )
    return "db";
  if (raw.includes("ssh") || raw.includes("server") || raw.includes("host"))
    return "ssh";
  return "asset";
}

function compactCandidates(
  entries: readonly { handle: string; name: string }[],
): string {
  return entries
    .slice(0, 8)
    .map((entry) => `${entry.handle} (${entry.name})`)
    .join(", ");
}

function namesFromContainer(record: Record<string, unknown>): string[] {
  const direct = firstString(record, ["name", "container_name"]);
  if (direct) return [direct.replace(/^\//, "")];
  const namesValue = record.names ?? record.Names;
  if (Array.isArray(namesValue)) {
    return namesValue
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .map((value) => value.trim().replace(/^\//, ""));
  }
  return [];
}

export class HexHubAssetRegistry {
  private generation = -1;
  private epoch = -1;
  private readonly assetsByHandle = new Map<string, AssetEntry>();
  private readonly assetHandleByRef = new Map<string, string>();
  private readonly assetNames = new Map<string, Set<string>>();
  private readonly assetCounters: Record<HexHubAssetKind, number> = {
    ssh: 0,
    docker: 0,
    db: 0,
    redis: 0,
    asset: 0,
  };
  private readonly containersByHandle = new Map<string, ContainerEntry>();
  private readonly containerHandleByIdentity = new Map<string, string>();
  private readonly containerNames = new Map<string, Set<string>>();
  private containerCounter = 0;
  private readonly sensitiveValues = new Set<string>();

  sync(generation: number, epoch: number): boolean {
    if (this.generation === generation && this.epoch === epoch) return false;
    this.clear();
    this.generation = generation;
    this.epoch = epoch;
    return true;
  }

  clear(): void {
    this.assetsByHandle.clear();
    this.assetHandleByRef.clear();
    this.assetNames.clear();
    for (const kind of Object.keys(this.assetCounters) as HexHubAssetKind[])
      this.assetCounters[kind] = 0;
    this.containersByHandle.clear();
    this.containerHandleByIdentity.clear();
    this.containerNames.clear();
    this.containerCounter = 0;
    this.sensitiveValues.clear();
  }

  ingestAssets(result: unknown): readonly HexHubPublicAsset[] {
    const records = findRecords(preferredPayload(result), [
      "assets",
      "items",
      "data",
      "results",
    ]);
    const visible: HexHubPublicAsset[] = [];
    for (const record of records) {
      const ref = firstString(record, ["asset_ref", "assetRef"]);
      if (!ref) continue;
      const kind = assetKind(record);
      const name =
        firstString(record, [
          "name",
          "display_name",
          "title",
          "host",
          "path",
        ]) ?? `${kind} target`;
      let handle = this.assetHandleByRef.get(ref);
      if (!handle) {
        handle = `${kind}:${++this.assetCounters[kind]}`;
        this.assetHandleByRef.set(ref, handle);
      }
      const publicAsset: HexHubPublicAsset = Object.freeze({
        asset: handle,
        type: kind,
        name,
        ...(firstString(record, ["host", "hostname"])
          ? { host: firstString(record, ["host", "hostname"]) }
          : {}),
        ...(firstString(record, ["path"])
          ? { path: firstString(record, ["path"]) }
          : {}),
        ...(firstString(record, ["db_type", "database_type"])
          ? { db_type: firstString(record, ["db_type", "database_type"]) }
          : {}),
      });
      const entry: AssetEntry = {
        handle,
        ref,
        type: kind,
        name,
        public: publicAsset,
      };
      this.assetsByHandle.set(handle, entry);
      this.addName(this.assetNames, name, handle);
      this.sensitiveValues.add(ref);
      for (const key of [
        "id",
        "asset_id",
        "assetId",
        "route",
        "routing_key",
        "internal_route",
      ]) {
        const value = record[key];
        if (typeof value === "string" && value) this.sensitiveValues.add(value);
      }
      visible.push(publicAsset);
    }
    return Object.freeze(visible);
  }

  listAssets(): readonly HexHubPublicAsset[] {
    return Object.freeze(
      [...this.assetsByHandle.values()].map((entry) => entry.public),
    );
  }

  resolveAsset(selector: unknown): ResolvedHexHubAsset {
    if (typeof selector !== "string" || !selector.trim())
      throw new Error("HexHub asset is required; call hexhub_assets first.");
    const value = selector.trim();
    const direct = this.assetsByHandle.get(value);
    if (direct)
      return {
        handle: direct.handle,
        ref: direct.ref,
        type: direct.type,
        name: direct.name,
      };
    const handles = this.assetNames.get(value.toLocaleLowerCase());
    if (!handles || handles.size === 0)
      throw new Error(
        `Unknown HexHub asset '${value}'; call hexhub_assets first.`,
      );
    const matches = [...handles]
      .map((handle) => this.assetsByHandle.get(handle))
      .filter((entry): entry is AssetEntry => entry !== undefined);
    if (matches.length !== 1)
      throw new Error(
        `Ambiguous HexHub asset '${value}': ${compactCandidates(matches)}.`,
      );
    const match = matches[0];
    return {
      handle: match.handle,
      ref: match.ref,
      type: match.type,
      name: match.name,
    };
  }

  ingestContainers(
    asset: string | ResolvedHexHubAsset,
    result: unknown,
  ): readonly HexHubPublicContainer[] {
    const resolvedAsset =
      typeof asset === "string" ? this.resolveAsset(asset) : asset;
    const records = findRecords(preferredPayload(result), [
      "containers",
      "items",
      "data",
      "results",
    ]);
    const visible: HexHubPublicContainer[] = [];
    for (const record of records) {
      const names = namesFromContainer(record);
      const name = names[0];
      const id = firstString(record, ["container_id", "id", "containerId"]);
      if (!name && !id) continue;
      const displayName = name ?? "container";
      const identity = `${resolvedAsset.ref}\0${id ?? displayName.toLocaleLowerCase()}`;
      let handle = this.containerHandleByIdentity.get(identity);
      if (!handle) {
        handle = `container:${++this.containerCounter}`;
        this.containerHandleByIdentity.set(identity, handle);
      }
      const publicContainer: HexHubPublicContainer = Object.freeze({
        container: handle,
        name: displayName,
        ...(firstString(record, ["image", "image_name"])
          ? { image: firstString(record, ["image", "image_name"]) }
          : {}),
        ...(firstString(record, ["status", "state"])
          ? { status: firstString(record, ["status", "state"]) }
          : {}),
        ...(firstString(record, ["health", "health_status"])
          ? { health: firstString(record, ["health", "health_status"]) }
          : {}),
      });
      const entry: ContainerEntry = {
        handle,
        name: displayName,
        ...(id ? { id } : {}),
        assetRef: resolvedAsset.ref,
        public: publicContainer,
      };
      this.containersByHandle.set(handle, entry);
      for (const candidate of new Set([displayName, ...names])) {
        this.addName(
          this.containerNames,
          this.containerNameKey(resolvedAsset.ref, candidate),
          handle,
        );
      }
      if (id) this.sensitiveValues.add(id);
      visible.push(publicContainer);
    }
    return Object.freeze(visible);
  }

  listContainers(
    asset?: string | ResolvedHexHubAsset,
  ): readonly HexHubPublicContainer[] {
    const assetRef =
      asset === undefined
        ? undefined
        : typeof asset === "string"
          ? this.resolveAsset(asset).ref
          : asset.ref;
    return Object.freeze(
      [...this.containersByHandle.values()]
        .filter(
          (entry) => assetRef === undefined || entry.assetRef === assetRef,
        )
        .map((entry) => entry.public),
    );
  }

  resolveContainer(
    asset: ResolvedHexHubAsset,
    selector: unknown,
  ): ResolvedHexHubContainer {
    if (typeof selector !== "string" || !selector.trim())
      throw new Error(
        "HexHub container is required; call hexhub_docker_containers first.",
      );
    const value = selector.trim();
    const direct = this.containersByHandle.get(value);
    if (direct) {
      if (direct.assetRef !== asset.ref)
        throw new Error(
          `Container '${value}' belongs to a different Docker asset.`,
        );
      return {
        handle: direct.handle,
        name: direct.name,
        ...(direct.id ? { id: direct.id } : {}),
      };
    }
    const handles = this.containerNames.get(
      this.containerNameKey(asset.ref, value),
    );
    if (!handles || handles.size === 0)
      throw new Error(
        `Unknown HexHub container '${value}'; call hexhub_docker_containers first.`,
      );
    const matches = [...handles]
      .map((handle) => this.containersByHandle.get(handle))
      .filter(
        (entry): entry is ContainerEntry =>
          entry !== undefined && entry.assetRef === asset.ref,
      );
    if (matches.length !== 1)
      throw new Error(
        `Ambiguous HexHub container '${value}': ${compactCandidates(matches)}.`,
      );
    const match = matches[0];
    return {
      handle: match.handle,
      name: match.name,
      ...(match.id ? { id: match.id } : {}),
    };
  }

  getSensitiveValues(): readonly string[] {
    return Object.freeze(
      [...this.sensitiveValues]
        .filter((value) => value.length >= 3)
        .sort((a, b) => b.length - a.length),
    );
  }

  private addName(
    index: Map<string, Set<string>>,
    name: string,
    handle: string,
  ): void {
    const key = name.toLocaleLowerCase();
    const current = index.get(key) ?? new Set<string>();
    current.add(handle);
    index.set(key, current);
  }

  private containerNameKey(assetRef: string, name: string): string {
    return `${assetRef}\0${name.toLocaleLowerCase().replace(/^\//, "")}`;
  }
}

export const hexHubResultPayload = preferredPayload;
