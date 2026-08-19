import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installHexHubExtension } from "./runtime.js";

export default function hexHubExtension(pi: ExtensionAPI): void {
  installHexHubExtension(pi);
}
