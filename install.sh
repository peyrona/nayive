#!/usr/bin/env bash
#
# install.sh - finish setting up nayive after you unzip nayive.zip.
#
# nayive.zip ships this script next to  nayive  (the server: one static Linux
# binary, nothing else to install) and  apps/ , so the whole install is:
#
#     unzip nayive.zip -d nayive
#     cd nayive
#     ./install.sh
#
# It creates the two things the zip leaves out on purpose:
#   config/server.json   server settings; admin name + password start as null
#   homes/               one folder per user (the admin panel fills this)
# and writes a  nayive.service  systemd unit so the server can run on boot.
#
# The admin account starts empty. On first run open
#   http://localhost:<port>/nayive/admin.html
# and set the admin user + password there - no login is asked the first time.
# After that the same page asks you to sign in as that admin, and it is where
# you add / edit / delete the normal users.
#
# Usage:
#   ./install.sh [--systemd]
#     --systemd   also install + start the systemd service now (needs sudo).
#                 Without it you are asked y/N; a non-interactive run just
#                 writes the unit file and prints the commands.
#
# Env:
#   PORT   listen port, only when config/server.json is created (default 4343)
#
# There is no server-wide timezone: a timezone belongs to a person, so each
# account picks its own in the launcher's "Mi cuenta" dialog. Until an account
# has one, its reminders use whatever zone the machine itself is set to.
#
# Optional: ffmpeg (sudo apt install ffmpeg) lets Drive convert uploaded videos
# to MP4. Without it the server still runs and Drive simply never offers it.
#
# Optional: LibreOffice (sudo apt install --no-install-recommends
# libreoffice-writer-nogui libreoffice-calc-nogui) lets Drive turn .odt/.ods
# into .docx/.xlsx. Without it they are uploaded as they are.
#
set -euo pipefail

DO_SYSTEMD=0
for a in "$@"; do
    case "$a" in
        --systemd)  DO_SYSTEMD=1 ;;
        -h|--help)  grep -E '^#( |$)' "$0" | sed 's/^#\ \{0,1\}//'; exit 0 ;;
        *)          echo "unknown option: $a (use --systemd or --help)" >&2; exit 2 ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---- sanity ---------------------------------------------------------------
[[ -f nayive ]] || { echo "error: the nayive binary is not next to install.sh" >&2; exit 1; }
[[ -d apps   ]] || { echo "error: apps/ not found next to install.sh"         >&2; exit 1; }
chmod +x nayive

# ---- config/server.json + homes/ ----------------------------------------
mkdir -p homes config

CFG="config/server.json"
PORT="${PORT:-4343}"
if [[ -f "$CFG" ]]; then
    echo "keeping existing $CFG"
    PORT="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CFG" | grep -oE '[0-9]+' || echo "$PORT")"
else
    cat > "$CFG" <<EOF
{
    "host": "0.0.0.0",
    "port": $PORT,
    "base_dir": ".",
    "session_hours": 12,
    "log_level": "error",
    "tls": {
        "cert_file": "",
        "key_file": ""
    },
    "admin": { "name": null, "password": null }
}
EOF
    echo "wrote $CFG  (admin account is empty - set it in the admin panel)"
fi

# ---- systemd unit ------------------------------------------------------------
# AmbientCapabilities lets the binary listen on a port below 1024 (80, 443)
# without running as root. It changes nothing on a higher port.
RUN_USER="$(id -un)"
UNIT="$ROOT/nayive.service"
cat > "$UNIT" <<EOF
[Unit]
Description=nayive - personal web apps file server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
ExecStart=$ROOT/nayive -config $ROOT/config/server.json
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
echo "wrote $UNIT"

# Ask before touching systemd, unless --systemd already said yes.
if [[ "$DO_SYSTEMD" != "1" && -t 0 ]]; then
    read -r -p "Install and start it as a systemd service now (needs sudo)? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] && DO_SYSTEMD=1
fi

if [[ "$DO_SYSTEMD" == "1" ]]; then
    echo "installing systemd service (needs sudo)"
    sudo cp "$UNIT" /etc/systemd/system/nayive.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now nayive.service
    sudo systemctl --no-pager --lines=0 status nayive.service || true
fi

# ---- done -------------------------------------------------------------------
cat <<EOF

done.

  run now:      cd "$ROOT" && ./nayive
  admin panel:  http://localhost:$PORT/nayive/admin.html
                First time: no user or password yet - type the admin user +
                password there and press Guardar. No login is asked.
                After that the panel signs you in as that admin, and it is
                where you create / edit / delete the normal users.
  apps:         http://localhost:$PORT/nayive/   (sign in at /nayive/login.html)
EOF

if [[ "$DO_SYSTEMD" == "1" ]]; then
    cat <<EOF

  service:      installed and started as  nayive.service
    sudo systemctl status nayive.service
    journalctl -u nayive.service -f
EOF
else
    cat <<EOF

  run on boot (systemd):
    sudo cp "$UNIT" /etc/systemd/system/nayive.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now nayive.service
EOF
fi

# ---- what just happened ----------------------------------------------------
echo
echo "----------------------------------------------------------------------"
echo "What this script did (it did NOT touch apps/ or the nayive binary):"
echo "  - config/server.json : server settings; admin name + password are null"
echo "                         until you set them in the admin panel"
echo "  - homes/             : one folder per user (the admin panel fills it)"
echo "  - nayive.service     : systemd unit to run the nayive binary and keep it up"
if [[ "$DO_SYSTEMD" == "1" ]]; then
    echo "  - installed that unit: nayive now starts on every boot"
else
    echo "  - the unit is only written, not installed (run the 3 commands above)"
fi
echo
echo "Next: open  http://localhost:$PORT/nayive/admin.html  and create the admin"
echo "account. The server is one static binary - nothing else to install."
echo "----------------------------------------------------------------------"
