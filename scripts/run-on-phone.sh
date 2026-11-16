#!/data/data/com.termux/files/usr/bin/bash
# Runs the Shopify app on an Android phone with Termux, for testing on a
# development store. Free: a Cloudflare quick tunnel gives the phone a public
# address, and Shopify CLI points the app at it each time this starts.
#
#   bash run-on-phone.sh                 # uses einvoice-test-es.myshopify.com
#   bash run-on-phone.sh other.myshopify.com
#
# Stop it with Ctrl+C. Shopify retries notifications sent while it's stopped.
set -euo pipefail

STORE=${1:-einvoice-test-es.myshopify.com}
PORT=3456
DIR="$HOME/einvoice-kit"
LOG="$HOME/.einvoice-tunnel.log"

echo "== Installing what's needed (only slow the first time)"
pkg install -y nodejs git cloudflared > /dev/null

node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 12)) { console.error("Node " + process.versions.node + " is too old; 22.12 or newer is needed. Run: pkg upgrade nodejs"); process.exit(1); }'

if [ -d "$DIR/.git" ]; then
  echo "== Updating the app"
  cd "$DIR"
  # Keep the app ID that Shopify CLI wrote into shopify.app.toml.
  git stash -q || true
  git pull -q --ff-only
  git stash pop -q 2>/dev/null || true
else
  echo "== Downloading the app"
  git clone -q https://github.com/daen8584-spec/einvoice-kit.git "$DIR"
  cd "$DIR"
fi

npm ci --no-audit --no-fund > /dev/null
command -v shopify > /dev/null || npm install -g --no-audit --no-fund @shopify/cli@5.0.0 > /dev/null

echo "== Opening the tunnel"
rm -f "$LOG"
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > "$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "The tunnel didn't start. Its log:" >&2
  cat "$LOG" >&2
  exit 1
fi
echo "   $URL"

if grep -q REPLACE_WITH_CLIENT_ID shopify.app.toml; then
  echo
  echo "== First time: connect the app to your Shopify account"
  echo "   Choose: create a new app, and name it einvoice-kit."
  shopify app config link
fi

echo
echo "== Starting. Press p to open the app in your store, Ctrl+C to stop."
shopify app dev --tunnel-url "$URL:$PORT" --store "$STORE" --skip-dependencies-installation
