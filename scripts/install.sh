#!/bin/sh
# Zhiro · 职路 — install without Node (macOS / Linux).
#   curl -fsSL https://github.com/mazjq/zhiro/releases/latest/download/install.sh | sh
# Puts the official Node 22 (checked against nodejs.org's SHA-256 list) and Zhiro into ~/.zhiro/versions/<time>/,
# switches ~/.zhiro/current to it only when everything is in place, and adds ~/.zhiro/bin to your PATH.
# Running it again upgrades; the previous version stays until the next upgrade. Your data is elsewhere and untouched.
# Options (environment): ZHIRO_HOME (default ~/.zhiro), ZHIRO_PACKAGE (a .tgz path or URL), ZHIRO_NODE_DIST,
# ZHIRO_NO_PATH=1 (leave your shell profile alone).
set -eu

ROOT="${ZHIRO_HOME:-$HOME/.zhiro}"
PKG="${ZHIRO_PACKAGE:-https://github.com/mazjq/zhiro/releases/latest/download/zhiro.tgz}"
DIST="${ZHIRO_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"

say() { printf '%s\n' "$*"; }
die() { printf 'Zhiro install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "needs '$1'"; }
need curl; need tar

case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "this script is for macOS and Linux (Windows: install.ps1)" ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU: $(uname -m)" ;; esac
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }; else need shasum; sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
say "→ Node 22 for $os-$arch"
curl -fsSL "$DIST/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
file="$(grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -1)"
[ -n "$file" ] || die "no Node build for $os-$arch at $DIST"
curl -fsSL "$DIST/$file" -o "$tmp/$file"
want="$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
[ "$(sha "$tmp/$file")" = "$want" ] || die "Node download does not match its SHA-256; nothing was changed"

target="$ROOT/versions/$(date +%Y%m%d%H%M%S)"
mkdir -p "$target/node" "$target/app"
tar -xzf "$tmp/$file" -C "$target/node" --strip-components=1
node="$target/node/bin/node"

say "→ Zhiro from $PKG"
case "$PKG" in http*) curl -fsSL "$PKG" -o "$tmp/zhiro.tgz"; PKG="$tmp/zhiro.tgz" ;; esac
printf '{}\n' > "$target/app/package.json"
( cd "$target/app" && PATH="$target/node/bin:$PATH" "$node" "$target/node/lib/node_modules/npm/bin/npm-cli.js" install --no-audit --no-fund --loglevel=error "$PKG" ) \
  || { rm -rf "$target"; die "npm install failed; nothing was changed"; }
"$node" "$target/app/node_modules/zhiro/bin/zhiro.cjs" --version >/dev/null || { rm -rf "$target"; die "the new version does not start; nothing was changed"; }

# switch only now: everything above is in place and starts
ln -sfn "$target" "$ROOT/current"
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/zhiro" <<EOF
#!/bin/sh
exec "$ROOT/current/node/bin/node" "$ROOT/current/app/node_modules/zhiro/bin/zhiro.cjs" "\$@"
EOF
chmod +x "$ROOT/bin/zhiro"
# keep the new version and the one before it
versions="$(ls -1d "$ROOT"/versions/*/ | sort)"
printf '%s\n' "$versions" | awk -v n="$(printf '%s\n' "$versions" | wc -l)" 'NR <= n - 2' | while read -r old; do rm -rf "$old"; done

line="export PATH=\"$ROOT/bin:\$PATH\" # zhiro"
[ -n "${ZHIRO_NO_PATH:-}" ] || for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || continue
  grep -q '# zhiro$' "$rc" 2>/dev/null || printf '\n%s\n' "$line" >> "$rc"
done

say ""
say "✓ Zhiro $("$ROOT/bin/zhiro" --version) installed in $ROOT"
say "  Start it:   $ROOT/bin/zhiro        (new terminals: just 'zhiro')"
say "  Already running? Restart it to use the new version."
