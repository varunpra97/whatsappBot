#!/usr/bin/env bash
# Deploys this checkout to a VM over SSH and installs/updates the service.
#   ./deploy/deploy.sh user@vm-ip [ssh options...]
set -euo pipefail

TARGET="${1:?usage: deploy/deploy.sh user@host [ssh options]}"
shift
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Uploading to $TARGET"
ssh "$@" "$TARGET" 'mkdir -p ~/whatsapp-bot-src'
tar -C "$SRC_DIR" --exclude node_modules --exclude .git --exclude auth --exclude data --exclude config.json -czf - . \
  | ssh "$@" "$TARGET" 'tar -C ~/whatsapp-bot-src -xzf -'

echo "==> Installing on $TARGET"
ssh -t "$@" "$TARGET" 'sudo bash ~/whatsapp-bot-src/deploy/install.sh'

echo
echo "Watch for the QR code with:  ssh $TARGET sudo journalctl -u whatsapp-bot -f"
echo "Or open the dashboard with:  ssh -L 3000:127.0.0.1:3000 $TARGET   then browse http://localhost:3000"
