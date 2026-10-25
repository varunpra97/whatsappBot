#!/usr/bin/env bash
# Installs or updates the bot on a Debian/Ubuntu VM. Run from the repo checkout:
#   sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/whatsapp-bot
APP_USER=wabot
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

# The service user needs a system-wide Node.js >= 20 (not one under a home directory, e.g. nvm).
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /usr/* || "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg rsync
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  NODE_BIN=/usr/bin/node
fi
command -v rsync >/dev/null || { apt-get update -y && apt-get install -y rsync; }

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

echo "==> Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
# Never overwrite the live config, WhatsApp session or reply history.
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude config.json --exclude auth --exclude data \
  "$SRC_DIR"/ "$APP_DIR"/

if [[ ! -f "$APP_DIR/config.json" ]]; then
  PASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  sed "s/\"change-me\"/\"$PASS\"/" "$APP_DIR/config.example.json" > "$APP_DIR/config.json"
  echo "==> Created $APP_DIR/config.json (dashboard password: $PASS)"
fi

echo "==> Installing dependencies"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/config.json"

sed "s#^ExecStart=.*#ExecStart=$NODE_BIN src/index.js#" "$APP_DIR/deploy/whatsapp-bot.service" > /etc/systemd/system/whatsapp-bot.service
systemctl daemon-reload
systemctl enable whatsapp-bot >/dev/null
systemctl restart whatsapp-bot

cat <<MSG

==> Bot is running.
  Link WhatsApp:  sudo journalctl -u whatsapp-bot -f   (scan the QR code shown)
             or:  open the dashboard (see README) and scan the QR there
  Edit config:    sudo nano $APP_DIR/config.json     (applies live, no restart)
  Status:         systemctl status whatsapp-bot
MSG
