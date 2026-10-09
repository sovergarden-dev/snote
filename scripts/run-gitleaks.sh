#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="8.30.1"
readonly ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
readonly SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
readonly URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

curl --fail --silent --show-error --location --retry 3 \
  --output "$TEMP_DIR/$ARCHIVE" "$URL"
printf '%s  %s\n' "$SHA256" "$TEMP_DIR/$ARCHIVE" | sha256sum --check --status
tar --extract --gzip --file "$TEMP_DIR/$ARCHIVE" --directory "$TEMP_DIR" gitleaks

"$TEMP_DIR/gitleaks" version
"$TEMP_DIR/gitleaks" git --redact --no-banner --log-opts="--all" .
