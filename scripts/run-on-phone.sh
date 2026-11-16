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

if [ ! -f shopify.web.toml ]; then
  echo "This copy of the app is too old to run from a phone. Merge the pull request that adds it, then run this again." >&2
  exit 1
fi

npm ci --no-audit --no-fund > /dev/null
# Shopify CLI only lists Mac, Linux and Windows. Termux reports "android", but
# the CLI is plain JavaScript, so it's installed anyway.
command -v shopify > /dev/null || npm install -g --force --no-audit --no-fund @shopify/cli@5.0.0 > /dev/null
shopify version > /dev/null

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

# Shopify CLI keeps this shop's link to the app in its own file. The settings
# themselves (permissions, webhooks) come from shopify.app.toml, copied in on
# every start so changes there always take effect. Only the app ID is kept.
CONFIG=shopify.app.einvoice-kit.toml
if [ ! -f "$CONFIG" ]; then
  echo
  echo "== First time: connect the app to your Shopify account"
  echo "   Choose: create a new app, and name it einvoice-kit."
  shopify app config link --config einvoice-kit
fi
CLIENT_ID=$(grep -oE '^client_id = "[^"]+"' "$CONFIG" | head -1)
if [ -z "$CLIENT_ID" ]; then
  echo "Couldn't find the app's client ID in $CONFIG. Delete that file and run this again." >&2
  exit 1
fi
sed "s/^client_id = .*/$CLIENT_ID/" shopify.app.toml > "$CONFIG"

echo
echo "== Starting. Press p to open the app in your store, Ctrl+C to stop."
shopify app dev --config einvoice-kit --tunnel-url "$URL:$PORT" --store "$STORE" --skip-dependencies-installation
