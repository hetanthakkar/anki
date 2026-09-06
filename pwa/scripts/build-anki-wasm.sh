#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required. Install it with: cargo install wasm-pack" >&2
  exit 1
fi

rustup target add wasm32-unknown-unknown >/dev/null

rm -rf "$ROOT_DIR/public/wasm/anki-core"

wasm-pack build \
  "$ROOT_DIR/wasm-core" \
  --target web \
  --out-dir "$ROOT_DIR/public/wasm/anki-core" \
  --release

echo "Anki WASM bundle written to public/wasm/anki-core"
