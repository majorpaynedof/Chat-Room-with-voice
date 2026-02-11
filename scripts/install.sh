#!/usr/bin/env bash

# Copyright (c) 2024 Discord Clone
# License: MIT
# Self-hosted Discord Clone - Proxmox LXC Helper Script
# Inspired by community-scripts/ProxmoxVE style

set -Eeuo pipefail

# ──────────────────────────────────────────────
# Colors & Formatting
# ──────────────────────────────────────────────
RD=$(echo "\033[01;31m")
GN=$(echo "\033[1;92m")
YW=$(echo "\033[33m")
BL=$(echo "\033[36m")
DGN=$(echo "\033[32m")
CL=$(echo "\033[m")
BOLD=$(echo "\033[1m")
BFR="\\r\\033[K"
HOLD=" "
TAB="  "

CM="${GN}✓${CL}"
CROSS="${RD}✗${CL}"
INFO="${BL}ℹ${CL}"
WARN="${YW}⚠${CL}"

# ──────────────────────────────────────────────
# Messaging Functions
# ──────────────────────────────────────────────
msg_info() { echo -ne "${TAB}${HOLD}${INFO} ${YW}${1}...${CL}"; }
msg_ok() { echo -e "${BFR}${TAB}${CM} ${GN}${1}${CL}"; }
msg_warn() { echo -e "${BFR}${TAB}${WARN} ${YW}${1}${CL}"; }
msg_error() { echo -e "${BFR}${TAB}${CROSS} ${RD}${1}${CL}"; }

# ──────────────────────────────────────────────
# Error Handling
# ──────────────────────────────────────────────
error_handler() {
  local exit_code="$?"
  local line_number="$1"
  local command="$2"
  msg_error "Error on line ${line_number}: command '${command}' exited with status ${exit_code}"
  exit "$exit_code"
}
trap 'error_handler ${LINENO} "$BASH_COMMAND"' ERR

# ──────────────────────────────────────────────
# Header
# ──────────────────────────────────────────────
header() {
  clear
  cat <<"EOF"

     ____  _                       _    ____ _
    |  _ \(_)___  ___ ___  _ __ __| |  / ___| | ___  _ __   ___
    | | | | / __|/ __/ _ \| '__/ _` | | |   | |/ _ \| '_ \ / _ \
    | |_| | \__ \ (_| (_) | | | (_| | | |___| | (_) | | | |  __/
    |____/|_|___/\___\___/|_|  \__,_|  \____|_|\___/|_| |_|\___|

    Self-Hosted Chat with Text, Images & Voice
    Proxmox VE LXC Helper Script

EOF
  echo -e "${BL}────────────────────────────────────────────────────${CL}\n"
}

# ──────────────────────────────────────────────
# Environment Check
# ──────────────────────────────────────────────
check_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    msg_error "This script must be run as root"
    exit 1
  fi
}

detect_environment() {
  # Are we inside Proxmox host or inside an LXC/VM?
  if command -v pveversion &>/dev/null; then
    ENVIRONMENT="proxmox"
  elif [[ -f /run/systemd/container ]]; then
    ENVIRONMENT="container"
  else
    ENVIRONMENT="standalone"
  fi
}

# ──────────────────────────────────────────────
# Defaults
# ──────────────────────────────────────────────
APP_NAME="Discord Clone"
APP_DIR="/opt/discord-clone"
APP_PORT="3000"
APP_SERVICE="discord-clone"
REPO_URL="https://github.com/majorpaynedof/Chat-Room-with-voice.git"
REPO_BRANCH="${REPO_BRANCH:-main}"  # Override with: REPO_BRANCH=some-branch bash install.sh

# LXC defaults
CT_ID=""
CT_HOSTNAME="discord-clone"
CT_DISK="8"
CT_CORES="2"
CT_MEMORY="1024"
CT_SWAP="512"
CT_BRIDGE="vmbr0"
CT_IP="dhcp"
CT_GW=""
CT_OS="debian"
CT_OS_VERSION="12"
CT_UNPRIVILEGED="1"
CT_TEMPLATE=""
CT_STORAGE=""
NODE_VERSION="20"

# ══════════════════════════════════════════════
# PROXMOX HOST FUNCTIONS (LXC Creation)
# ══════════════════════════════════════════════

get_next_ct_id() {
  local id=100
  while pct status "$id" &>/dev/null; do
    ((id++))
  done
  echo "$id"
}

detect_storage() {
  msg_info "Detecting available storage"

  # Capture pvesm output to a temp file to avoid subshell/pipefail issues
  local tmpfile
  tmpfile=$(mktemp)

  # Disable ERR trap temporarily — pvesm might return non-zero
  trap - ERR
  pvesm status > "$tmpfile" 2>/dev/null || true
  trap 'error_handler ${LINENO} "$BASH_COMMAND"' ERR

  # Parse: Name($1) Type($2) Status($3) — skip header, find active non-backup storage
  # Prefer lvmthin/zfspool/lvm for rootfs; fall back to dir
  local storages=""
  local line name stype sstatus

  while IFS= read -r line; do
    # Skip header
    [[ "$line" =~ ^Name ]] && continue
    # Parse fields
    name=$(echo "$line" | awk '{print $1}')
    stype=$(echo "$line" | awk '{print $2}')
    sstatus=$(echo "$line" | awk '{print $3}')

    # Only active storage, skip pbs (backup) and disabled
    [[ "$sstatus" != "active" ]] && continue
    [[ "$stype" == "pbs" ]] && continue

    # Skip dir storage named "local" (usually only holds ISOs/templates, not rootfs)
    # unless it's the only option (handled below)
    if [[ "$stype" == "dir" && "$name" == "local" ]]; then
      continue
    fi

    if [[ -z "$storages" ]]; then
      storages="$name"
    else
      storages="${storages}"$'\n'"${name}"
    fi
  done < "$tmpfile"

  # If nothing found, retry including "local" dir storage as last resort
  if [[ -z "$storages" ]]; then
    while IFS= read -r line; do
      [[ "$line" =~ ^Name ]] && continue
      name=$(echo "$line" | awk '{print $1}')
      stype=$(echo "$line" | awk '{print $2}')
      sstatus=$(echo "$line" | awk '{print $3}')
      [[ "$sstatus" != "active" ]] && continue
      [[ "$stype" == "pbs" ]] && continue
      if [[ -z "$storages" ]]; then
        storages="$name"
      else
        storages="${storages}"$'\n'"${name}"
      fi
    done < "$tmpfile"
  fi

  rm -f "$tmpfile"

  if [[ -z "$storages" ]]; then
    msg_error "No active storage pools found."
    echo -e "${TAB}  ${YW}Run 'pvesm status' manually to check your storage configuration.${CL}"
    exit 1
  fi

  # Count available storages
  local count
  count=$(echo "$storages" | wc -l)

  if [[ "$count" -eq 1 ]]; then
    CT_STORAGE="$storages"
    msg_ok "Storage: ${CT_STORAGE}"
  else
    msg_ok "Found ${count} storage pools"
    echo ""
    echo -e "${TAB}${BOLD}Available storage pools:${CL}"
    local i=1
    local storage_array=()
    while IFS= read -r s; do
      storage_array+=("$s")
      # Re-read info from pvesm
      trap - ERR
      local sinfo
      sinfo=$(pvesm status 2>/dev/null | awk -v name="$s" '$1==name {printf "%s, %.1fGB free", $2, $6/1024/1024}')
      trap 'error_handler ${LINENO} "$BASH_COMMAND"' ERR
      echo -e "${TAB}  ${GN}${i})${CL} ${s} ${DGN}(${sinfo})${CL}"
      ((i++))
    done <<< "$storages"
    echo ""
    read -rp "${TAB}Select storage [1]: " choice
    choice="${choice:-1}"
    CT_STORAGE="${storage_array[$((choice-1))]}"
    echo ""
    msg_ok "Storage: ${CT_STORAGE}"
  fi
}

select_template() {
  msg_info "Checking available templates"

  # Try to find a Debian 12 template
  CT_TEMPLATE=$(pveam list local 2>/dev/null | grep -i "debian-12" | head -1 | awk '{print $1}' || true)

  if [[ -z "$CT_TEMPLATE" ]]; then
    msg_warn "Debian 12 template not found locally, downloading..."
    pveam update &>/dev/null
    local tpl
    tpl=$(pveam available --section system 2>/dev/null | grep -i "debian-12" | head -1 | awk '{print $2}' || true)
    if [[ -z "$tpl" ]]; then
      # Fallback to Ubuntu
      tpl=$(pveam available --section system 2>/dev/null | grep -i "ubuntu-22" | head -1 | awk '{print $2}' || true)
    fi
    if [[ -z "$tpl" ]]; then
      msg_error "No suitable template found. Please download a Debian 12 or Ubuntu 22.04 template manually."
      exit 1
    fi
    pveam download local "$tpl" &>/dev/null
    CT_TEMPLATE="local:vztmpl/${tpl}"
  fi

  msg_ok "Template: ${CT_TEMPLATE}"
}

prompt_settings() {
  echo -e "${BOLD}${BL}LXC Container Settings${CL}\n"

  CT_ID=$(get_next_ct_id)
  echo -e "${TAB}${DGN}Container ID:    ${GN}${CT_ID}${CL}"
  echo -e "${TAB}${DGN}Hostname:        ${GN}${CT_HOSTNAME}${CL}"
  echo -e "${TAB}${DGN}OS:              ${GN}Debian 12${CL}"
  echo -e "${TAB}${DGN}Storage:         ${GN}${CT_STORAGE}${CL}"
  echo -e "${TAB}${DGN}Disk:            ${GN}${CT_DISK}GB${CL}"
  echo -e "${TAB}${DGN}CPU Cores:       ${GN}${CT_CORES}${CL}"
  echo -e "${TAB}${DGN}Memory:          ${GN}${CT_MEMORY}MB${CL}"
  echo -e "${TAB}${DGN}Swap:            ${GN}${CT_SWAP}MB${CL}"
  echo -e "${TAB}${DGN}Bridge:          ${GN}${CT_BRIDGE}${CL}"
  echo -e "${TAB}${DGN}IP:              ${GN}${CT_IP}${CL}"
  echo -e "${TAB}${DGN}Application Port:${GN} ${APP_PORT}${CL}"
  echo ""

  read -rp "${TAB}${BOLD}Use these defaults? [Y/n]: ${CL}" USE_DEFAULTS

  if [[ "${USE_DEFAULTS,,}" == "n" ]]; then
    echo ""
    read -rp "${TAB}Container ID [${CT_ID}]: " input && CT_ID="${input:-$CT_ID}"
    read -rp "${TAB}Hostname [${CT_HOSTNAME}]: " input && CT_HOSTNAME="${input:-$CT_HOSTNAME}"
    read -rp "${TAB}Storage [${CT_STORAGE}]: " input && CT_STORAGE="${input:-$CT_STORAGE}"
    read -rp "${TAB}Disk Size GB [${CT_DISK}]: " input && CT_DISK="${input:-$CT_DISK}"
    read -rp "${TAB}CPU Cores [${CT_CORES}]: " input && CT_CORES="${input:-$CT_CORES}"
    read -rp "${TAB}Memory MB [${CT_MEMORY}]: " input && CT_MEMORY="${input:-$CT_MEMORY}"
    read -rp "${TAB}Bridge [${CT_BRIDGE}]: " input && CT_BRIDGE="${input:-$CT_BRIDGE}"
    read -rp "${TAB}IP (dhcp or IP/CIDR) [${CT_IP}]: " input && CT_IP="${input:-$CT_IP}"
    if [[ "$CT_IP" != "dhcp" ]]; then
      read -rp "${TAB}Gateway: " CT_GW
    fi
    echo ""
  fi
}

create_lxc() {
  msg_info "Creating LXC container ${CT_ID} (${CT_HOSTNAME})"

  local net_config="name=eth0,bridge=${CT_BRIDGE}"
  if [[ "$CT_IP" == "dhcp" ]]; then
    net_config+=",ip=dhcp"
  else
    net_config+=",ip=${CT_IP}"
    if [[ -n "$CT_GW" ]]; then
      net_config+=",gw=${CT_GW}"
    fi
  fi

  local pct_output
  if ! pct_output=$(pct create "$CT_ID" "$CT_TEMPLATE" \
    --hostname "$CT_HOSTNAME" \
    --memory "$CT_MEMORY" \
    --swap "$CT_SWAP" \
    --cores "$CT_CORES" \
    --rootfs "${CT_STORAGE}:${CT_DISK}" \
    --net0 "$net_config" \
    --unprivileged "$CT_UNPRIVILEGED" \
    --features nesting=1 \
    --onboot 1 \
    --start 0 \
    2>&1); then
    msg_error "Failed to create LXC container"
    echo -e "${TAB}  ${RD}${pct_output}${CL}"
    echo ""
    echo -e "${TAB}${YW}Tip: Check storage with 'pvesm status' and bridges with 'ip link'.${CL}"
    exit 1
  fi

  msg_ok "LXC container ${CT_ID} created"
}

push_install_script() {
  msg_info "Preparing install script for container"

  # Get the path to this script (it contains both host and install logic)
  local script_path
  script_path="$(readlink -f "$0")"

  # Copy this script into the container rootfs
  local rootfs
  rootfs=$(pct config "$CT_ID" | grep rootfs | awk '{print $2}' | cut -d',' -f1)

  # Start the container first
  pct start "$CT_ID" &>/dev/null
  sleep 3

  # Push script into container
  pct push "$CT_ID" "$script_path" /tmp/install.sh --perms 755

  msg_ok "Install script ready"
}

run_install_in_container() {
  msg_info "Running installation inside container (this takes a few minutes)"
  echo ""

  pct exec "$CT_ID" -- bash -c "export INSIDE_CT=1 && bash /tmp/install.sh --install"

  echo ""
  msg_ok "Installation complete"
}

show_completion() {
  local ct_ip
  ct_ip=$(pct exec "$CT_ID" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || echo "<container-ip>")

  echo ""
  echo -e "${BL}══════════════════════════════════════════════════${CL}"
  echo -e "${BOLD}${GN}  ${APP_NAME} - Installation Complete!${CL}"
  echo -e "${BL}══════════════════════════════════════════════════${CL}"
  echo ""
  echo -e "${TAB}${GN}Container ID:${CL}  ${CT_ID}"
  echo -e "${TAB}${GN}Hostname:${CL}      ${CT_HOSTNAME}"
  echo -e "${TAB}${GN}IP Address:${CL}    ${ct_ip}"
  echo -e "${TAB}${GN}Access URL:${CL}    ${BL}http://${ct_ip}:${APP_PORT}${CL}"
  echo ""
  echo -e "${TAB}${YW}Next Steps:${CL}"
  echo -e "${TAB} 1. Open the URL above in your browser"
  echo -e "${TAB} 2. Register your first account (becomes first user)"
  echo -e "${TAB} 3. Create a server and share the server ID with friends"
  echo ""
  echo -e "${TAB}${YW}Manage the service:${CL}"
  echo -e "${TAB} ${DGN}pct enter ${CT_ID}${CL}"
  echo -e "${TAB} ${DGN}systemctl status ${APP_SERVICE}${CL}"
  echo -e "${TAB} ${DGN}journalctl -u ${APP_SERVICE} -f${CL}"
  echo ""
  echo -e "${TAB}${YW}Voice chat over internet:${CL}"
  echo -e "${TAB} Requires a TURN server. See README.md for setup."
  echo ""
  echo -e "${BL}══════════════════════════════════════════════════${CL}"
}

# ══════════════════════════════════════════════
# CONTAINER INSTALL FUNCTIONS (Runs inside LXC)
# ══════════════════════════════════════════════

install_dependencies() {
  msg_info "Updating system packages"
  apt-get update -qq &>/dev/null
  apt-get upgrade -y -qq &>/dev/null
  msg_ok "System packages updated"

  msg_info "Installing dependencies"
  apt-get install -y -qq \
    curl \
    git \
    build-essential \
    python3 \
    ca-certificates \
    gnupg \
    &>/dev/null
  msg_ok "Dependencies installed"
}

install_nodejs() {
  msg_info "Installing Node.js ${NODE_VERSION}"

  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq &>/dev/null
  apt-get install -y -qq nodejs &>/dev/null

  msg_ok "Node.js $(node --version) installed"
}

install_application() {
  msg_info "Cloning Discord Clone repository"

  if [[ -d "${APP_DIR}/.git" ]]; then
    cd "${APP_DIR}"
    git pull --quiet &>/dev/null
  else
    git clone --quiet --branch "${REPO_BRANCH}" "${REPO_URL}" "${APP_DIR}" &>/dev/null
  fi

  msg_ok "Repository cloned to ${APP_DIR}"

  msg_info "Installing Node.js packages"
  cd "${APP_DIR}"
  npm install --production --loglevel=error &>/dev/null
  msg_ok "Node.js packages installed"

  # Create data directories
  mkdir -p "${APP_DIR}/data" "${APP_DIR}/uploads"
}

configure_environment() {
  msg_info "Configuring environment"

  local secret
  secret=$(openssl rand -hex 32)

  cat > "${APP_DIR}/.env" <<EOF
PORT=${APP_PORT}
HOST=0.0.0.0
SESSION_SECRET=${secret}
MAX_UPLOAD_SIZE=10
NODE_ENV=production
EOF

  msg_ok "Environment configured (session secret auto-generated)"
}

create_service() {
  msg_info "Creating systemd service"

  cat > /etc/systemd/system/${APP_SERVICE}.service <<EOF
[Unit]
Description=Discord Clone - Self-hosted Chat Application
Documentation=https://github.com/majorpaynedof/Chat-Room-with-voice
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
EnvironmentFile=${APP_DIR}/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/uploads

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload &>/dev/null
  systemctl enable ${APP_SERVICE} &>/dev/null
  systemctl start ${APP_SERVICE} &>/dev/null

  # Wait for service to start
  sleep 2

  if systemctl is-active --quiet ${APP_SERVICE}; then
    msg_ok "Service created and started"
  else
    msg_warn "Service created but may not be running. Check: journalctl -u ${APP_SERVICE}"
  fi
}

setup_motd() {
  # Custom login banner
  cat > /etc/motd <<'EOF'

    ╔══════════════════════════════════════════╗
    ║     Discord Clone - Chat Application     ║
    ║   Text • Images • Voice (WebRTC)         ║
    ╚══════════════════════════════════════════╝

    App Dir:    /opt/discord-clone
    Service:    systemctl status discord-clone
    Logs:       journalctl -u discord-clone -f
    Config:     /opt/discord-clone/.env

EOF
}

cleanup() {
  msg_info "Cleaning up"
  apt-get autoremove -y -qq &>/dev/null
  apt-get autoclean -y -qq &>/dev/null
  rm -f /tmp/install.sh 2>/dev/null || true
  msg_ok "Cleanup complete"
}

run_install() {
  header
  echo -e "${BOLD}${YW}  Installing ${APP_NAME} inside container...${CL}\n"

  install_dependencies
  install_nodejs
  install_application
  configure_environment
  create_service
  setup_motd
  cleanup

  echo ""
  msg_ok "${APP_NAME} installation finished!"
}

# ══════════════════════════════════════════════
# STANDALONE INSTALL (no Proxmox, bare Linux)
# ══════════════════════════════════════════════

run_standalone_install() {
  header
  echo -e "${BOLD}${YW}  Standalone Installation (no Proxmox detected)${CL}\n"
  echo -e "${TAB}This will install ${APP_NAME} directly on this machine.\n"

  read -rp "${TAB}${BOLD}Continue? [y/N]: ${CL}" CONFIRM
  if [[ "${CONFIRM,,}" != "y" ]]; then
    echo -e "\n${TAB}Installation cancelled."
    exit 0
  fi
  echo ""

  install_dependencies
  install_nodejs
  install_application
  configure_environment
  create_service
  setup_motd
  cleanup

  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')

  echo ""
  echo -e "${BL}══════════════════════════════════════════════════${CL}"
  echo -e "${BOLD}${GN}  ${APP_NAME} - Installation Complete!${CL}"
  echo -e "${BL}══════════════════════════════════════════════════${CL}"
  echo ""
  echo -e "${TAB}${GN}Access URL:${CL}  ${BL}http://${ip:-localhost}:${APP_PORT}${CL}"
  echo ""
  echo -e "${TAB}${YW}Manage:${CL}"
  echo -e "${TAB} ${DGN}systemctl status ${APP_SERVICE}${CL}"
  echo -e "${TAB} ${DGN}systemctl restart ${APP_SERVICE}${CL}"
  echo -e "${TAB} ${DGN}journalctl -u ${APP_SERVICE} -f${CL}"
  echo ""
  echo -e "${BL}══════════════════════════════════════════════════${CL}"
}

# ══════════════════════════════════════════════
# UPDATE FUNCTION
# ══════════════════════════════════════════════

run_update() {
  header
  echo -e "${BOLD}${YW}  Updating ${APP_NAME}...${CL}\n"

  if [[ ! -d "${APP_DIR}" ]]; then
    msg_error "${APP_NAME} is not installed at ${APP_DIR}"
    exit 1
  fi

  msg_info "Pulling latest code"
  cd "${APP_DIR}"
  git pull --quiet &>/dev/null
  msg_ok "Code updated"

  msg_info "Installing updated packages"
  npm install --production --loglevel=error &>/dev/null
  msg_ok "Packages updated"

  msg_info "Restarting service"
  systemctl restart ${APP_SERVICE} &>/dev/null
  sleep 2

  if systemctl is-active --quiet ${APP_SERVICE}; then
    msg_ok "Service restarted successfully"
  else
    msg_warn "Service may not be running. Check: journalctl -u ${APP_SERVICE}"
  fi

  echo ""
  msg_ok "${APP_NAME} has been updated!"
}

# ══════════════════════════════════════════════
# MAIN ENTRY POINT
# ══════════════════════════════════════════════

main() {
  check_root
  detect_environment

  # Parse arguments
  case "${1:-}" in
    --install)
      # Called internally when running inside the container
      run_install
      exit 0
      ;;
    --update)
      run_update
      exit 0
      ;;
    --help|-h)
      header
      echo -e "${TAB}${BOLD}Usage:${CL}"
      echo -e "${TAB}  ${GN}bash $(basename "$0")${CL}              Create LXC + install (on Proxmox host)"
      echo -e "${TAB}  ${GN}bash $(basename "$0") --install${CL}    Install app (inside LXC or any Linux)"
      echo -e "${TAB}  ${GN}bash $(basename "$0") --update${CL}     Update existing installation"
      echo -e "${TAB}  ${GN}bash $(basename "$0") --help${CL}       Show this help"
      echo ""
      exit 0
      ;;
  esac

  header

  if [[ "$ENVIRONMENT" == "proxmox" ]]; then
    # Running on Proxmox host — full LXC creation flow
    echo -e "${BOLD}${GN}  Proxmox VE detected — Creating LXC Container${CL}\n"

    select_template
    detect_storage
    prompt_settings
    create_lxc
    push_install_script
    run_install_in_container
    show_completion

  elif [[ "$ENVIRONMENT" == "container" || "${INSIDE_CT:-}" == "1" ]]; then
    # Already inside a container
    run_install

  else
    # Standalone Linux (no Proxmox, no container)
    run_standalone_install
  fi
}

main "$@"
