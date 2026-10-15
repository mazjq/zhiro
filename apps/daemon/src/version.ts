import { readFileSync } from "node:fs";

declare const __ZHIRO_VERSION__: string | undefined;

/** The program's version: set by the build (esbuild `define`); from the repository root package.json when run from source. */
export const VERSION: string = typeof __ZHIRO_VERSION__ === "string"
  ? __ZHIRO_VERSION__
  : (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
