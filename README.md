# Chat Room - Self-Hosted Chat Application

A self-hosted chat application supporting **text channels**, **image sharing**, and **voice chat** via WebRTC.

## Features

- **Text Channels** — Create servers with multiple text channels, markdown-style formatting, typing indicators
- **Image Sharing** — Upload and share images inline in chat (drag-and-drop style, up to 10MB)
- **Voice Chat** — Real-time voice communication via WebRTC with mute/unmute controls
- **Direct Messages** — Private messaging between users
- **Server Management** — Create servers, invite via server ID, manage channels
- **User Presence** — Online/offline status indicators
- **Persistent Storage** — SQLite database, no external database server needed
- **Dark Theme** — Modern dark UI

## Tech Stack

| Layer     | Technology                          |
|-----------|-------------------------------------|
| Backend   | Node.js, Express, Socket.IO        |
| Database  | SQLite (via better-sqlite3)         |
| Frontend  | Vanilla JS (no build step needed)   |
| Voice     | WebRTC + Socket.IO signaling        |
| Auth      | bcrypt + express-session            |
| Deploy    | Docker / Docker Compose             |

---

## Quick Start (Local Development)

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload for development
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Proxmox LXC One-Liner (Helper Script)

Run this on your **Proxmox host** to auto-create an LXC container and install everything:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/majorpaynedof/Chat-Room-with-voice/main/scripts/install.sh)"
```

> **Before merging to main?** Use the branch URL instead:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/majorpaynedof/Chat-Room-with-voice/claude/discord-clone-app-Z7XOm/scripts/install.sh -o install.sh
> REPO_BRANCH=claude/discord-clone-app-Z7XOm bash install.sh
> ```

This will:
1. Download a Debian 12 template (if needed)
2. Create an LXC container with sensible defaults (2 cores, 1GB RAM, 8GB disk)
3. Install Node.js 20, clone the app, configure systemd service
4. Print the access URL when done

You can also run the script **inside any existing Linux machine/container**:

```bash
curl -fsSL https://raw.githubusercontent.com/majorpaynedof/Chat-Room-with-voice/main/scripts/install.sh | bash -s -- --install
```

Update an existing installation:

```bash
bash /opt/chat-room/scripts/install.sh --update
```

---

## Deployment Option 1: Docker Compose (Recommended)

### Prerequisites
- Docker Engine 20+
- Docker Compose v2+

### Steps

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd Chat-Room-with-voice

# 2. Create environment file
cp .env.example .env

# 3. Edit .env and set a strong SESSION_SECRET
#    Generate one with: openssl rand -hex 32
nano .env

# 4. Build and start
docker compose up -d --build

# 5. View logs
docker compose logs -f

# 6. Access the app
# Open http://<your-server-ip>:3000
```

### Persistent Data

Data is stored in Docker volumes:
- `app-data` — SQLite database
- `app-uploads` — Uploaded images

To back up:
```bash
docker compose exec app cp -r /app/data /backup/
docker compose exec app cp -r /app/uploads /backup/
```

### Update

```bash
git pull
docker compose up -d --build
```

### Stop

```bash
docker compose down         # Stop containers
docker compose down -v      # Stop and delete volumes (DESTROYS DATA)
```

---

## Deployment Option 2: Proxmox LXC Container

This runs the app directly inside a lightweight Linux container on Proxmox.

### Step 1: Create the LXC Container

In the Proxmox web UI (`https://<proxmox-ip>:8006`):

1. Click **Create CT** (top right)
2. Configure:
   - **Hostname:** `chat-room`
   - **Template:** Ubuntu 22.04 or Debian 12 (download from template list)
   - **Disk:** 4GB+ (8GB recommended)
   - **CPU:** 1-2 cores
   - **Memory:** 512MB-1GB
   - **Network:** DHCP or static IP on your bridge (e.g., `vmbr0`)
3. Check **Start after created**
4. Click **Create**

Or via CLI on the Proxmox host:

```bash
# Download template (if not already available)
pveam update
pveam download local debian-12-standard_12.2-1_amd64.tar.zst

# Create container
pct create 200 local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst \
  --hostname chat-room \
  --memory 1024 \
  --cores 2 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --start 1

# Enter the container
pct enter 200
```

### Step 2: Install Dependencies Inside LXC

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install build tools (needed for native modules)
apt install -y build-essential python3 git
```

### Step 3: Deploy the Application

```bash
# Clone the repo
cd /opt
git clone <your-repo-url> chat-room
cd chat-room

# Install dependencies
npm install --production

# Create data directories
mkdir -p data uploads

# Set environment variables
cp .env.example .env
nano .env
# Set SESSION_SECRET to a random string:
#   SESSION_SECRET=$(openssl rand -hex 32)
```

### Step 4: Create a Systemd Service

```bash
cat > /etc/systemd/system/chat-room.service << 'EOF'
[Unit]
Description=Chat Room - Self-hosted Chat Application
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/chat-room
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/chat-room/.env

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable chat-room
systemctl start chat-room

# Check status
systemctl status chat-room

# View logs
journalctl -u chat-room -f
```

### Step 5: Access

Open `http://<lxc-ip>:3000` in your browser.

To find the LXC IP:
```bash
# Inside the container
ip addr show eth0
# Or from Proxmox host
pct exec 200 -- ip addr show eth0
```

---

## Deployment Option 3: Docker Inside Proxmox LXC

You can also run Docker inside an LXC container (best of both worlds).

### Step 1: Create a Privileged LXC

In Proxmox, create the container with **nesting** and **keyctl** features:

```bash
pct create 201 local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst \
  --hostname chat-room-docker \
  --memory 2048 \
  --cores 2 \
  --rootfs local-lvm:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1,keyctl=1 \
  --unprivileged 0 \
  --start 1

pct enter 201
```

### Step 2: Install Docker Inside LXC

```bash
apt update && apt install -y curl gnupg

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose plugin
apt install -y docker-compose-plugin

# Verify
docker --version
docker compose version
```

### Step 3: Deploy with Docker Compose

```bash
cd /opt
git clone <your-repo-url> chat-room
cd chat-room

cp .env.example .env
nano .env  # Set SESSION_SECRET

docker compose up -d --build
```

---

## Voice Chat Notes

Voice chat uses **WebRTC** for peer-to-peer audio communication.

### How It Works
1. Users join a voice channel
2. The server acts as a **signaling server** (exchanges connection info via Socket.IO)
3. Audio streams are sent **directly between browsers** (peer-to-peer)
4. No audio passes through the server

### Troubleshooting Voice Chat

**Works on LAN but not over the internet?**

You need a TURN server. The easiest option is [coturn](https://github.com/coturn/coturn):

```bash
# Install coturn (on the host or a separate machine)
apt install -y coturn

# Edit config
cat > /etc/turnserver.conf << EOF
listening-port=3478
fingerprint
lt-cred-mech
user=myuser:mypassword
realm=mydomain.com
total-quota=100
EOF

# Start
systemctl enable coturn
systemctl start coturn
```

Then set in your `.env`:
```
TURN_URL=turn:your-server-ip:3478
TURN_USERNAME=myuser
TURN_PASSWORD=mypassword
```

**Browser shows microphone permission denied?**

Voice chat requires HTTPS in production (browsers block microphone access on HTTP except localhost). Use a reverse proxy with SSL:

```bash
# Quick option: use Caddy as reverse proxy (auto-HTTPS)
apt install -y caddy
cat > /etc/caddy/Caddyfile << EOF
chat.yourdomain.com {
    reverse_proxy localhost:3000
}
EOF
systemctl restart caddy
```

---

## Reverse Proxy with Nginx (Optional)

If you want to put this behind nginx with SSL:

```nginx
server {
    listen 80;
    server_name chat.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name chat.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/chat.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.yourdomain.com/privkey.pem;

    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Get a certificate with Let's Encrypt:
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d chat.yourdomain.com
```

---

## Configuration Reference

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `SESSION_SECRET` | (required) | Session encryption key |
| `MAX_UPLOAD_SIZE` | `10` | Max image upload size in MB |
| `TURN_URL` | (optional) | TURN server URL for voice |
| `TURN_USERNAME` | (optional) | TURN server username |
| `TURN_PASSWORD` | (optional) | TURN server password |

---

## License

MIT
