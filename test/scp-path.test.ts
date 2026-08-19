import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalHexHubWindowsScpPath,
  encodeHexHubWindowsScpPath,
  isHexHubWindowsScpPath,
} from "../extensions/hexhub/scp-path.js";

test("drive paths normalize before using HexHub extended wire syntax", () => {
  assert.equal(
    encodeHexHubWindowsScpPath("d:\\work\\a b\\..\\文件.txt"),
    "//?/D:/work/文件.txt",
  );
  assert.equal(encodeHexHubWindowsScpPath("C:\\"), "//?/C:/");
  assert.equal(
    encodeHexHubWindowsScpPath("//?/D:/work/file.txt"),
    "//?/D:/work/file.txt",
  );
  assert.equal(
    canonicalHexHubWindowsScpPath("//?/d:/work/file.txt"),
    "D:\\work\\file.txt",
  );
});

test("UNC and WSL paths use forward slash wire syntax without admin shares", () => {
  assert.equal(
    encodeHexHubWindowsScpPath("\\\\wsl.localhost\\Ubuntu\\tmp\\a b.txt"),
    "//wsl.localhost/Ubuntu/tmp/a b.txt",
  );
  assert.equal(
    encodeHexHubWindowsScpPath("\\\\server\\share\\a\\..\\b"),
    "//server/share/b",
  );
  assert.equal(
    encodeHexHubWindowsScpPath("\\\\?\\UNC\\server\\share\\dir"),
    "//server/share/dir",
  );
  assert.equal(
    encodeHexHubWindowsScpPath("//server/share/dir"),
    "//server/share/dir",
  );
});

test("relative, device, malformed, and control-character paths are rejected", () => {
  for (const value of [
    "C:relative",
    "relative.txt",
    "\\rooted-only",
    "\\\\.\\pipe\\name",
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1",
    "\\\\server",
    "D:\\bad\npath",
    "D:\\bad\0path",
  ]) {
    assert.throws(
      () => encodeHexHubWindowsScpPath(value),
      /HexHub SCP/u,
      value,
    );
    assert.equal(isHexHubWindowsScpPath(value), false, value);
  }
  assert.equal(isHexHubWindowsScpPath("D:\\work\\file"), true);
  assert.equal(isHexHubWindowsScpPath("\\\\server\\share\\file"), true);
});
