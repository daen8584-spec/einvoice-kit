#!/data/data/com.termux/files/usr/bin/bash
# Try the invoice checker on your phone.
# Run in Termux:  bash try-on-termux.sh
# Then open http://localhost:4173 in your phone's browser.
set -euo pipefail

BRANCH=${1:-main}
pkg install -y nodejs git > /dev/null

cd "$HOME"
if [ -d einvoice-kit ]; then
  cd einvoice-kit && git fetch -q origin "$BRANCH" && git checkout -q "$BRANCH" && git reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" https://github.com/daen8584-spec/einvoice-kit.git && cd einvoice-kit
fi

echo "== Installing (the first time takes a minute)"
npm ci --no-audit --no-fund > /dev/null
echo "== Running the tests"
npm test
echo "== Building the checker"
npm run build > /dev/null
echo
echo "Open http://localhost:4173 in your browser. Press Ctrl+C here to stop."
npx vite preview web --host 127.0.0.1 --port 4173
