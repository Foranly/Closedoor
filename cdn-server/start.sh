#!/bin/bash
# ══════════════════════════════════════════════════════════════
# FastChange CDN Server — Bootstrap & Launcher
# Auto-installs Go and compiles the CDN server on first run
# ══════════════════════════════════════════════════════════════
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

APP_BIN="$PROJECT_DIR/app"
GO_DIR="$PROJECT_DIR/.go"
GO_BIN="$GO_DIR/bin/go"

# ── Detect architecture ──
ARCH=$(uname -m)
case "$ARCH" in
    aarch64|arm64)
        GO_ARCH=arm64
        ;;
    armv7l|armhf|arm)
        GO_ARCH=armv6l
        ;;
    x86_64|amd64)
        GO_ARCH=amd64
        ;;
    *)
        echo "[ERROR] Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

echo "🔍 Architecture detected: $ARCH → Go arch: $GO_ARCH"

# ── Step 1: Ensure Go is available ──
if [ -f "$GO_BIN" ]; then
    echo "[INFO] Go found locally: $GO_BIN"
elif command -v go &>/dev/null; then
    echo "[INFO] Go found in PATH: $(which go)"
    GO_BIN="go"
else
    echo "📥 Downloading Go for Linux/$GO_ARCH..."
    GO_VERSION="1.22.5"
    TARBALL="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
    URL="https://go.dev/dl/${TARBALL}"

    mkdir -p "$PROJECT_DIR/.go"
    TMP_TAR="$PROJECT_DIR/.go/${TARBALL}"

    # Download with progress
    if command -v wget &>/dev/null; then
        wget -q --show-progress "$URL" -O "$TMP_TAR"
    elif command -v curl &>/dev/null; then
        curl -#L "$URL" -o "$TMP_TAR"
    else
        echo "[ERROR] Neither wget nor curl available"
        exit 1
    fi

    # Verify checksum (optional but recommended)
    CHECKSUM_URL="https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz.sha256"
    if command -v sha256sum &>/dev/null; then
        if command -v curl &>/dev/null; then
            EXPECTED=$(curl -sL "$CHECKSUM_URL" | awk '{print $1}')
        elif command -v wget &>/dev/null; then
            EXPECTED=$(wget -qO- "$CHECKSUM_URL" | awk '{print $1}')
        fi
        if [ -n "$EXPECTED" ]; then
            ACTUAL=$(sha256sum "$TMP_TAR" | awk '{print $1}')
            if [ "$EXPECTED" != "$ACTUAL" ]; then
                echo "[WARN] Checksum mismatch! Expected: $EXPECTED"
                echo "   Actual: $ACTUAL"
                echo "   Continuing anyway..."
            else
                echo "[INFO] Checksum verified"
            fi
        fi
    fi

    # Extract
    echo "[PROCESS] Extracting Go..."
    tar -xzf "$TMP_TAR" -C "$PROJECT_DIR/.go" --strip-components=1
    rm -f "$TMP_TAR"
    GO_BIN="$GO_DIR/bin/go"
    echo "[INFO] Go installed: $($GO_BIN version)"
fi

# ── Step 2: Export Go environment ──
if [ "$GO_BIN" != "go" ]; then
    export GOROOT="$GO_DIR"
    export PATH="$GO_DIR/bin:$PATH"
fi

# ── Step 3: Compile the CDN server ──
echo "[INFO] Compiling CDN server..."
cd "$PROJECT_DIR"
go build -o "$APP_BIN" -ldflags="-s -w" main.go
echo "[INFO] Compiled successfully: $APP_BIN ($(du -h "$APP_BIN" | cut -f1))"

# ── Step 4: Clean up Go installation to save disk space (optional) ──
# Keep Go binary cache for potential future use; remove source/tarball artifacts
rm -f "$PROJECT_DIR/.go/"*.tar.gz 2>/dev/null || true

# ── Step 5: Run the CDN server ──
echo "[INFO] Starting CDN Server..."
exec "$APP_BIN" "$@"
