#!/usr/bin/env bash
# Loan Recovery — one-step installer for Ubuntu / Debian.
#
# Installs Node.js 22 and MariaDB (if missing), creates the database and its user, copies the app to
# /opt/loan-recovery, creates the first admin, and runs the server as a service on port 8080.
# Safe to re-run: it updates the code and keeps the existing database, passwords and data.
#
# Usage (from the project folder, as root):
#   sudo bash scripts/install.sh                          # install / update
#   sudo bash scripts/install.sh --demo                   # also load demo data (empty database only)
#   sudo bash scripts/install.sh --domain app.example.com # also set up HTTPS with Caddy (Let's Encrypt)
#
# Options:  --app-dir DIR (default /opt/loan-recovery)   --port N (default 8080)   --db-name NAME (default loan_recovery)
#           --public (listen on all interfaces, e.g. for testing on your LAN without HTTPS)
set -euo pipefail

APP_DIR=/opt/loan-recovery
PORT=8080
DB_NAME=loan_recovery
DB_USER=recovery
APP_USER=recovery
DOMAIN=""
DEMO=0
HOST=127.0.0.1
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_FILE=/root/loan-recovery-credentials.txt

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    --public) HOST=0.0.0.0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
rand() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }
has_systemd() { [[ -d /run/systemd/system ]]; }
as_app() { (cd "$APP_DIR" && runuser -u "$APP_USER" -- "$@"); }

[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash $0 $*"
command -v apt-get >/dev/null || die "This installer supports Ubuntu/Debian (apt). See README.md for manual steps."
[[ -f "$SRC_DIR/server/index.js" && -f "$SRC_DIR/package.json" ]] || die "Run this from the project folder (server/index.js not found in $SRC_DIR)."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "--db-name may only contain letters, digits and _"

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- packages
say "Installing system packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg tar >/dev/null

node_ok() {
  command -v node >/dev/null && node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit(maj > 20 || (maj === 20 && min >= 12) ? 0 : 1)'
}
if node_ok; then
  echo "Node.js $(node -v) already installed"
else
  say "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node.js 20.12+ is required but $(node -v 2>/dev/null || echo none) is installed."
  echo "Node.js $(node -v) installed"
fi

if ! command -v mariadb >/dev/null || ! command -v mariadbd >/dev/null; then
  say "Installing MariaDB server"
  apt-get install -y -qq mariadb-server mariadb-client >/dev/null
fi

# ---------------------------------------------------------------- database server
say "Starting MariaDB"
if has_systemd; then
  systemctl enable --now mariadb >/dev/null 2>&1 || systemctl enable --now mysql >/dev/null
else
  # Containers / WSL without systemd
  mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld
  if ! mariadb -e 'SELECT 1' >/dev/null 2>&1; then
    service mariadb start </dev/null >/dev/null 2>&1 || { nohup mariadbd --user=mysql </dev/null >/var/log/mariadbd.log 2>&1 & disown; }
  fi
fi
for _ in $(seq 1 30); do mariadb -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
mariadb -e 'SELECT 1' >/dev/null 2>&1 || die "MariaDB did not start, or root cannot log in via the local socket."
echo "MariaDB $(mariadb -N -e 'SELECT VERSION()') is running"

# ---------------------------------------------------------------- app user & files
say "Copying the app to $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
# Copy everything except local-only files; an existing .env and node_modules are kept.
tar -C "$SRC_DIR" --exclude=./.git --exclude=./node_modules --exclude=./.env -cf - . | tar -C "$APP_DIR" -xf -
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------------------------------------------------------------- database & .env
DB_PASS=""
if [[ -f "$APP_DIR/.env" ]]; then
  DB_PASS="$(grep -E '^DB_PASSWORD=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//')"
fi
[[ -n "$DB_PASS" && "$DB_PASS" != "change-me" ]] || DB_PASS="$(rand 28)"

say "Creating database '$DB_NAME' and user '$DB_USER'"
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

cat > "$APP_DIR/.env" <<ENV
# Written by scripts/install.sh on $(date '+%Y-%m-%d %H:%M'). Keep this file private.
PORT=$PORT
HOST=$HOST
TZ=Asia/Kolkata
SESSION_DAYS=30

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_POOL_SIZE=10
ENV
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

say "Installing Node.js dependencies"
# Installed as root (uses root's npm/proxy settings), then handed to the service user.
rm -rf "$APP_DIR/.npm"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Creating / upgrading tables"
as_app node server/admin.js migrate

# ---------------------------------------------------------------- first admin
users=$(mariadb -N "$DB_NAME" -e 'SELECT COUNT(*) FROM users')
admins=$(mariadb -N "$DB_NAME" -e "SELECT COUNT(*) FROM users WHERE role = 'admin'")
ADMIN_PASS=""
if [[ "$DEMO" == 1 && "$users" == 0 ]]; then
  say "Loading demo data"
  as_app node server/admin.js seed-demo >/dev/null
  echo "Demo branch 'Lucknow Rural': officers FO27 / FO31 (PIN 1234), supervisor SUP1 (PIN 9999), 12 loans"
  ADMIN_PASS="Lr$(rand 12)$((RANDOM % 90 + 10))"
  as_app node server/admin.js set-pin --code ADMIN --pin "$ADMIN_PASS" >/dev/null
elif [[ "$DEMO" == 1 ]]; then
  warn "Database already has users — demo data not loaded."
fi
if [[ -z "$ADMIN_PASS" && "$admins" == 0 && "$(mariadb -N "$DB_NAME" -e "SELECT COUNT(*) FROM users WHERE role = 'admin'")" == 0 ]]; then
  say "Creating the first admin account"
  ADMIN_PASS="Lr$(rand 12)$((RANDOM % 90 + 10))"
  as_app node server/admin.js add-user --code ADMIN --name "Administrator" --role admin --branch "Head Office" --pin "$ADMIN_PASS" >/dev/null
fi
if [[ -n "$ADMIN_PASS" ]]; then
  umask 077
  cat > "$CRED_FILE" <<CRED
Loan Recovery — created $(date '+%Y-%m-%d %H:%M')
Admin console : http://localhost:$PORT/admin/${DOMAIN:+   (public: https://$DOMAIN/admin/)}
Admin code    : ADMIN
Admin password: $ADMIN_PASS
$( [[ "$DEMO" == 1 ]] && echo "Demo field logins: FO27 / FO31 (PIN 1234), supervisor SUP1 (PIN 9999)" )
Change the password after signing in (account menu → Change password).
CRED
fi

# ---------------------------------------------------------------- service
say "Starting the Loan Recovery server"
NODE_BIN="$(command -v node)"
if has_systemd; then
  cat > /etc/systemd/system/loan-recovery.service <<UNIT
[Unit]
Description=Loan Recovery server
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable loan-recovery >/dev/null 2>&1
  systemctl restart loan-recovery
else
  warn "systemd not available — starting the server in the background (it won't restart after a reboot)."
  pkill -u "$APP_USER" -f "server/index.js" 2>/dev/null || true
  sleep 1
  # Redirect the whole group so no process keeps this script's stdout open.
  (cd "$APP_DIR" && exec nohup runuser -u "$APP_USER" -- "$NODE_BIN" server/index.js) >"$APP_DIR/server.log" 2>&1 </dev/null &
  disown
fi

for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || {
  has_systemd && journalctl -u loan-recovery -n 30 --no-pager || tail -30 "$APP_DIR/server.log"
  die "The server did not answer on port $PORT. See the log above."
}

# ---------------------------------------------------------------- HTTPS (optional)
if [[ -n "$DOMAIN" ]]; then
  say "Setting up HTTPS for $DOMAIN with Caddy"
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    request_body {
        max_size 50MB
    }
    reverse_proxy 127.0.0.1:$PORT
}
CADDY
  if has_systemd; then systemctl reload caddy 2>/dev/null || systemctl restart caddy; else caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || { nohup caddy run --config /etc/caddy/Caddyfile </dev/null >/var/log/caddy.log 2>&1 & disown; }; fi
  echo "Caddy will fetch a certificate for $DOMAIN. The domain's DNS must point to this machine, and ports 80 and 443 must be open."
fi

# ---------------------------------------------------------------- summary
say "Done — Loan Recovery is running"
cat <<SUMMARY

  Field app     : http://localhost:$PORT/${DOMAIN:+          https://$DOMAIN/}
  Admin console : http://localhost:$PORT/admin/${DOMAIN:+    https://$DOMAIN/admin/}
  App folder    : $APP_DIR   (settings in $APP_DIR/.env)
  Database      : $DB_NAME on MariaDB, user $DB_USER
SUMMARY
if [[ -n "$ADMIN_PASS" ]]; then
  cat <<SUMMARY
  Admin login   : ADMIN / $ADMIN_PASS
                  (also saved in $CRED_FILE — change it after signing in)
SUMMARY
else
  echo "  Admin login   : unchanged (existing admin accounts kept)"
fi
if has_systemd; then
  cat <<SUMMARY

  Logs          : journalctl -u loan-recovery -f
  Restart/stop  : systemctl restart loan-recovery   |   systemctl stop loan-recovery
SUMMARY
else
  echo -e "\n  Logs          : tail -f $APP_DIR/server.log"
fi
[[ -z "$DOMAIN" && "$HOST" == 127.0.0.1 ]] && echo -e "\n  Phones need HTTPS: re-run with --domain your.domain.com once DNS points here."
echo
