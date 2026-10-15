# apps/desktop

The UI (React + Tailwind, built with Vite). The daemon serves the built files at `/app/`; `pnpm --filter @zhiro/desktop dev`
runs it with hot reload against a running daemon. Every action goes through the daemon's tools (`src/api.ts`).

`src-tauri/` is an **experimental** desktop shell (tray, start at login). It is not part of the release yet.
