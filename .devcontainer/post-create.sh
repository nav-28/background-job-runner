#!/usr/bin/env bash
# Brings the workspace up to "pnpm dev works" from a fresh container.
set -euo pipefail

cd "$(dirname "$0")/.."

corepack enable
pnpm install --frozen-lockfile

[ -f backend/.env ] || cp backend/.env.example backend/.env

# In a Codespace the browser reaches each port through a forwarded https host, not localhost, so
# the baked-in NEXT_PUBLIC_API_URL and the CORS allow-list both have to be rewritten. Those hosts
# are siblings under a public suffix, which makes them cross-SITE: a SameSite=Lax cookie would be
# withheld and every authenticated request would 401.
if [ -n "${CODESPACE_NAME:-}" ]; then
  domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  api="https://${CODESPACE_NAME}-3000.${domain}"
  ui="https://${CODESPACE_NAME}-3001.${domain}"

  printf 'NEXT_PUBLIC_API_URL=%s\n' "$api" > frontend/.env.local
  {
    printf '\n# Written by .devcontainer/post-create.sh\n'
    printf 'CORS_ORIGIN=%s\n' "$ui"
    printf 'SESSION_COOKIE_SAMESITE=none\n'
  } >> backend/.env

  echo "Codespaces detected — API origin set to ${api}"
  echo "Port 3000 must be PUBLIC or the browser cannot reach the API (Ports panel → Port Visibility)."
else
  printf 'NEXT_PUBLIC_API_URL=http://localhost:3000\n' > frontend/.env.local
fi

docker compose up -d postgres

printf 'Waiting for Postgres'
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U admin -d test >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  printf '.'
  sleep 1
done

cd backend
pnpm db:migrate
pnpm db:seed

cat <<'EOF'

Ready. Start both apps with:

    pnpm dev

Then open the UI on port 3001 and sign in as demo@example.com / password123.
EOF
