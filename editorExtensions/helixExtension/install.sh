#!/bin/bash
# Workman Helix Extension Installer for Linux/macOS
# Run: ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELIX_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/helix"
HELIX_RUNTIME_DIR="$HELIX_CONFIG_DIR/runtime"
QUERIES_DIR="$HELIX_RUNTIME_DIR/queries/workman"

echo -e "\033[36mWorkman Helix Extension Installer\033[0m"
echo -e "\033[36m=================================\033[0m"
echo ""

# Create directories if they don't exist
echo -e "\033[33m[1/4] Creating directories...\033[0m"
mkdir -p "$HELIX_CONFIG_DIR"
mkdir -p "$QUERIES_DIR"
echo "  Created: $QUERIES_DIR"

# Copy query files
echo -e "\033[33m[2/4] Copying query files...\033[0m"
cp "$SCRIPT_DIR/queries/workman/"* "$QUERIES_DIR/"
echo "  Copied highlights.scm, indents.scm, injections.scm"

# Append to languages.toml (or create if doesn't exist)
echo -e "\033[33m[3/4] Updating languages.toml...\033[0m"
LANGUAGES_TOML="$HELIX_CONFIG_DIR/languages.toml"

if [ -f "$LANGUAGES_TOML" ]; then
    if grep -q 'name = "workman"' "$LANGUAGES_TOML"; then
        echo -e "  \033[31mWARNING: Workman config already exists in languages.toml\033[0m"
        echo "  Please manually merge or remove the existing config first."
    else
        echo "" >> "$LANGUAGES_TOML"
        echo "# ─────────────────────────────────────────────────────────────────────────────" >> "$LANGUAGES_TOML"
        echo "# Workman Language (auto-added by installer)" >> "$LANGUAGES_TOML"
        echo "# ─────────────────────────────────────────────────────────────────────────────" >> "$LANGUAGES_TOML"
        echo "" >> "$LANGUAGES_TOML"
        cat "$SCRIPT_DIR/languages.toml" >> "$LANGUAGES_TOML"
        echo "  Appended Workman config to existing languages.toml"
    fi
else
    cp "$SCRIPT_DIR/languages.toml" "$LANGUAGES_TOML"
    echo "  Created new languages.toml"
fi

# Fetch and build grammar
echo -e "\033[33m[4/4] Fetching and building Tree-sitter grammar...\033[0m"
echo "  Running: hx --grammar fetch"
hx --grammar fetch
echo "  Running: hx --grammar build"
hx --grammar build

echo ""
echo -e "\033[32mInstallation complete!\033[0m"
echo ""
echo -e "\033[36mNext steps:\033[0m"
echo "  1. Restart Helix (changes to languages.toml require restart)"
echo "  2. Open a .wm file to test"
echo "  3. Run :lsp-restart if you need to reload the language server"
echo ""
echo -e "\033[36mConfig locations:\033[0m"
echo "  languages.toml: $LANGUAGES_TOML"
echo "  queries:        $QUERIES_DIR"
