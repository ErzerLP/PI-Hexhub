import { win32 } from "node:path";

const MAX_WINDOWS_PATH_CHARS = 32_767;
const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/u;
const CANONICAL_DRIVE_PATH = /^([A-Za-z]):\\(.*)$/u;
const CANONICAL_UNC_PATH = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/u;
const EXTENDED_DRIVE_PATH = /^\/\/\?\/([A-Za-z]):(?:\/(.*))?$/u;
const EXTENDED_UNC_PATH = /^\/\/\?\/UNC\/([^/]+)\/([^/]+)(?:\/(.*))?$/iu;

function slashToBackslash(value: string): string {
  return value.split("/").join("\\");
}

function backslashToSlash(value: string): string {
  return value.split("\\").join("/");
}

function assertPathText(value: string): void {
  if (
    !value ||
    value.length > MAX_WINDOWS_PATH_CHARS ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error("HexHub SCP local path is invalid");
  }
}

function decodeWirePath(value: string): string {
  const slashPath = backslashToSlash(value);
  const drive = EXTENDED_DRIVE_PATH.exec(slashPath);
  if (drive) {
    const letter = drive[1];
    if (!letter) throw new Error("HexHub SCP drive path is invalid");
    return `${letter}:\\${slashToBackslash(drive[2] ?? "")}`;
  }

  const unc = EXTENDED_UNC_PATH.exec(slashPath);
  if (unc) {
    const server = unc[1];
    const share = unc[2];
    if (!server || !share) throw new Error("HexHub SCP UNC path is invalid");
    const tail = unc[3] ? `\\${slashToBackslash(unc[3])}` : "";
    return `\\\\${server}\\${share}${tail}`;
  }

  if (slashPath.startsWith("//?/") || slashPath.startsWith("//./"))
    throw new Error("HexHub SCP device paths are not allowed");
  if (slashPath.startsWith("//") && slashPath.indexOf("/", 2) > 2)
    return `\\\\${slashToBackslash(slashPath.slice(2))}`;
  return value;
}

function canonicalDrivePath(value: string): string | undefined {
  if (!DRIVE_PATH.test(value)) return undefined;
  const normalized = win32.normalize(value);
  const drive = CANONICAL_DRIVE_PATH.exec(normalized);
  const letter = drive?.[1];
  if (!letter) throw new Error("HexHub SCP local path must be absolute");
  return `${letter.toUpperCase()}:${normalized.slice(2)}`;
}

function canonicalUncPath(value: string): string | undefined {
  if (!value.startsWith("\\\\")) return undefined;
  const normalized = win32.normalize(value);
  const unc = CANONICAL_UNC_PATH.exec(normalized);
  const server = unc?.[1];
  const share = unc?.[2];
  if (!server || !share || server === "." || server === "?")
    throw new Error("HexHub SCP UNC path is invalid");
  return normalized;
}

export function canonicalHexHubWindowsScpPath(value: string): string {
  assertPathText(value);
  const nativePath = decodeWirePath(value);
  const drive = canonicalDrivePath(nativePath);
  if (drive) return drive;
  const unc = canonicalUncPath(nativePath);
  if (unc) return unc;
  throw new Error("HexHub SCP local path must be an absolute Windows path");
}

export function encodeHexHubWindowsScpPath(value: string): string {
  const path = canonicalHexHubWindowsScpPath(value);
  const drive = CANONICAL_DRIVE_PATH.exec(path);
  if (drive) {
    const letter = drive[1];
    if (!letter) throw new Error("HexHub SCP drive path is invalid");
    return `//?/${letter.toUpperCase()}:/${backslashToSlash(drive[2] ?? "")}`;
  }

  const unc = CANONICAL_UNC_PATH.exec(path);
  const server = unc?.[1];
  const share = unc?.[2];
  if (!server || !share) throw new Error("HexHub SCP UNC path is invalid");
  const tail = unc[3] ? `/${backslashToSlash(unc[3])}` : "";
  return `//${server}/${share}${tail}`;
}

export function isHexHubWindowsScpPath(value: string): boolean {
  try {
    canonicalHexHubWindowsScpPath(value);
    return true;
  } catch {
    return false;
  }
}
