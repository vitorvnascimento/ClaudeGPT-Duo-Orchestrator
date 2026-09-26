import { fileURLToPath } from "node:url";
import { join } from "node:path";

// dist/src/paths.js -> raiz do pacote (onde ficam schemas/ e skills/).
export function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function cliEntry(): string {
  return join(packageRoot(), "dist", "src", "cli", "main.js");
}

export function duoDir(projectRoot: string): string {
  return join(projectRoot, ".duo");
}
