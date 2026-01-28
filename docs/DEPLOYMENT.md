# Mahilo Registry: Production Deployment Guide

This guide covers deploying Mahilo Registry in production environments.

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Database Setup](#database-setup)
3. [Docker Deployment](#docker-deployment)
4. [Reverse Proxy Configuration](#reverse-proxy-configuration)
5. [Security Checklist](#security-checklist)
6. [Monitoring](#monitoring)
7. [Backup and Recovery](#backup-and-recovery)
8. [Troubleshooting](#troubleshooting)

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SECRET_KEY` | **Yes** | - | Secret key for signing API keys and callbacks. Use a cryptographically secure random string (min 32 chars) |
| `PORT` | No | 8080 | HTTP server port |
| `HOST` | No | 0.0.0.0 | Server bind address |
| `DATABASE_URL` | No | ./data/mahilo.db | Path to SQLite database file |
| `NODE_ENV` | No | development | Set to `production` for production |
| `RATE_LIMIT` | No | 100 | Requests per minute per user |
| `MAX_PAYLOAD_SIZE` | No | 32768 | Max message payload size in bytes (32KB) |
| `MAX_RETRIES` | No | 5 | Max delivery retry attempts |
| `CALLBACK_TIMEOUT_MS` | No | 30000 | Callback URL timeout in milliseconds |
| `ALLOW_PRIVATE_IPS` | No | false | Allow private IP ranges for callback URLs (set `true` for self-hosted) |

### Generating a Secure SECRET_KEY

```bash
# Using OpenSSL
openssl rand -base64 32

# Using Python
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## Database Setup

### SQLite (Recommended for Single Instance)

SQLite is the default and recommended database for self-hosted deployments.

```bash
# Create data directory
mkdir -p /var/lib/mahilo

# Set permissions
chown -R mahilo:mahilo /var/lib/mahilo

# Start with custom database path
DATABASE_URL=/var/lib/mahilo/mahilo.db bun run start
```

**SQLite Best Practices:**
- Place database on fast storage (SSD recommended)
- Enable WAL mode for better concurrent read performance (enabled by default)
- Ensure the data directory is on a persistent volume
- Do not share SQLite files across multiple instances

### PostgreSQL (For High Availability)

For multi-instance or high-availability deployments, PostgreSQL is recommended (Phase 2 feature):

```bash
# Connection string format
DATABASE_URL=postgres://user:password@host:5432/mahilo
```

---

## Docker Deployment

### Basic Docker Run

```bash
# Create a volume for persistent data
docker volume create mahilo-data

# Generate a secret key
SECRET_KEY=$(openssl rand -base64 32)

# Run the container
docker run -d \
  --name mahilo-registry \
  --restart unless-stopped \
  -p 8080:8080 \
  -v mahilo-data:/app/data \
  -e SECRET_KEY="$SECRET_KEY" \
  -e NODE_ENV=production \
  mahilo-registry:latest
```

### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  mahilo:
    image: mahilo-registry:latest
    container_name: mahilo-registry
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - mahilo-data:/app/data
    environment:
      - SECRET_KEY=${SECRET_KEY}
      - NODE_ENV=production
      - RATE_LIMIT=100
      - MAX_PAYLOAD_SIZE=32768
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 5s

volumes:
  mahilo-data:
    driver: local
```

Start with:

```bash
export SECRET_KEY=$(openssl rand -base64 32)
docker-compose up -d
```

### Building the Image

```bash
# Build from source
docker build -t mahilo-registry:latest .

# Tag for registry
docker tag mahilo-registry:latest your-registry.com/mahilo-registry:v1.0.0
docker push your-registry.com/mahilo-registry:v1.0.0
```

---

## Reverse Proxy Configuration

### Nginx

```nginx
upstream mahilo {
    server 127.0.0.1:8080;
    keepalive 32;
}

server {
    listen 80;
    server_name api.mahilo.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.mahilo.yourdomain.com;

    # SSL certificates (use Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/api.mahilo.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.mahilo.yourdomain.com/privkey.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Request size limit (match MAX_PAYLOAD_SIZE + headers)
    client_max_body_size 64k;

    # Timeouts
    proxy_connect_timeout 30s;
    proxy_send_timeout 30s;
    proxy_read_timeout 60s;

    location / {
        proxy_pass http://mahilo;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Health check endpoint (can be accessed internally without rate limiting)
    location /health {
        proxy_pass http://mahilo/health;
        access_log off;
    }
}
```

### Caddy

```caddyfile
api.mahilo.yourdomain.com {
    reverse_proxy localhost:8080 {
        health_uri /health
        health_interval 30s
    }

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options DENY
        X-Content-Type-Options nosniff
        X-XSS-Protection "1; mode=block"
        -Server
    }

    # Request size limit
    request_body {
        max_size 64KB
    }

    log {
        output file /var/log/caddy/mahilo.log
        format json
    }
}
```

---

## Security Checklist

### Pre-Deployment

- [ ] **Generate strong SECRET_KEY** - Minimum 32 characters, cryptographically random
- [ ] **Set NODE_ENV=production** - Enables production security defaults
- [ ] **Use HTTPS** - All traffic must be encrypted in transit
- [ ] **Review ALLOW_PRIVATE_IPS** - Keep `false` for hosted, set `true` only for air-gapped self-hosted

### Network Security

- [ ] **Firewall rules** - Only expose port 443 (HTTPS) externally
- [ ] **Internal communication** - Keep Mahilo container on internal network
- [ ] **Rate limiting** - Configure appropriate RATE_LIMIT for your use case
- [ ] **DDoS protection** - Use Cloudflare or similar for public deployments

### Data Security

- [ ] **Database permissions** - Restrict file permissions to mahilo user only
- [ ] **Volume encryption** - Enable disk encryption for data volumes
- [ ] **Regular backups** - Implement automated backup strategy
- [ ] **Secrets management** - Use Docker secrets or Vault for SECRET_KEY

### Container Security

- [ ] **Non-root user** - Container runs as non-root by default (verify in Dockerfile)
- [ ] **Read-only filesystem** - Consider `--read-only` flag with explicit writable mounts
- [ ] **Resource limits** - Set CPU and memory limits

```bash
docker run -d \
  --name mahilo-registry \
  --read-only \
  --tmpfs /tmp \
  -v mahilo-data:/app/data \
  --memory="512m" \
  --cpus="1.0" \
  -e SECRET_KEY="$SECRET_KEY" \
  mahilo-registry:latest
```

### API Security

- [ ] **API key rotation** - Remind users to rotate keys periodically
- [ ] **Callback URL validation** - SSRF protection enabled by default
- [ ] **Payload size limits** - MAX_PAYLOAD_SIZE prevents large payload attacks
- [ ] **Idempotency keys** - Enabled for duplicate request protection

### Monitoring Security

- [ ] **Log review** - Regular review of access logs for anomalies
- [ ] **Failed auth monitoring** - Alert on excessive 401 responses
- [ ] **Health endpoint** - Do not expose detailed health info publicly

---

## Monitoring

### Health Check Endpoint

```bash
# Basic health check
curl http://localhost:8080/health
# Response: {"status":"ok","timestamp":"..."}
```

### Prometheus Metrics (Future)

Mahilo Registry will expose `/metrics` endpoint in a future release.

### Logging

Mahilo logs to stdout in JSON format. Configure your log aggregator to collect from Docker:

```bash
# View logs
docker logs -f mahilo-registry

# With timestamps
docker logs -f --timestamps mahilo-registry
```

### Recommended Monitoring Stack

1. **Logs**: Collect with Promtail/Fluentd, store in Loki/Elasticsearch
2. **Metrics**: Prometheus + Grafana (when /metrics available)
3. **Alerts**: Set up alerts for:
   - Health check failures
   - High error rates (5xx responses)
   - Database file size approaching disk limits
   - High memory usage

### Example Alerting Rules

**Health check (using blackbox exporter):**

```yaml
- alert: MahiloDown
  expr: probe_success{job="mahilo"} == 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Mahilo Registry is down"
```

**Log-based alert (Loki):**

```yaml
- alert: MahiloHighErrorRate
  expr: |
    sum(rate({job="mahilo"} |= "error" [5m])) > 10
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High error rate in Mahilo logs"
```

---

## Backup and Recovery

### SQLite Backup

**Option 1: File copy (requires stopping service)**

```bash
# Stop the service
docker stop mahilo-registry

# Copy database file
cp /var/lib/mahilo/mahilo.db /backup/mahilo-$(date +%Y%m%d).db

# Start the service
docker start mahilo-registry
```

**Option 2: SQLite online backup (no downtime)**

```bash
# Using sqlite3 CLI
sqlite3 /var/lib/mahilo/mahilo.db ".backup '/backup/mahilo-$(date +%Y%m%d).db'"
```

**Option 3: Docker volume backup**

```bash
# Create backup container
docker run --rm \
  -v mahilo-data:/data:ro \
  -v /backup:/backup \
  alpine tar czf /backup/mahilo-data-$(date +%Y%m%d).tar.gz -C /data .
```

### Automated Backup Script

Create `/etc/cron.daily/mahilo-backup`:

```bash
#!/bin/bash
set -e

BACKUP_DIR=/backup/mahilo
RETENTION_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup database
sqlite3 /var/lib/mahilo/mahilo.db ".backup '$BACKUP_DIR/mahilo-$(date +%Y%m%d-%H%M%S).db'"

# Remove old backups
find "$BACKUP_DIR" -name "mahilo-*.db" -mtime +$RETENTION_DAYS -delete

# Optional: upload to S3/GCS
# aws s3 cp "$BACKUP_DIR/mahilo-$(date +%Y%m%d).db" s3://your-bucket/backups/
```

### Recovery

```bash
# Stop the service
docker stop mahilo-registry

# Restore from backup
cp /backup/mahilo-20260127.db /var/lib/mahilo/mahilo.db

# Fix permissions
chown mahilo:mahilo /var/lib/mahilo/mahilo.db

# Start the service
docker start mahilo-registry
```

---

## Troubleshooting

### Common Issues

**Container fails to start:**

```bash
# Check logs
docker logs mahilo-registry

# Common causes:
# - SECRET_KEY not set
# - Database directory not writable
# - Port already in use
```

**Database locked errors:**

```bash
# Ensure only one instance is running
docker ps | grep mahilo

# Check for stuck processes
lsof /var/lib/mahilo/mahilo.db
```

**Callback delivery failures:**

```bash
# Check if ALLOW_PRIVATE_IPS needs to be true (self-hosted)
# Verify callback URLs are reachable from the container

# Test network connectivity
docker exec mahilo-registry wget -q --spider https://your-callback-url.com/health
```

**High memory usage:**

```bash
# SQLite WAL file can grow large under high write load
# Run checkpoint manually
sqlite3 /var/lib/mahilo/mahilo.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Getting Help

- Check logs first: `docker logs mahilo-registry`
- Review this guide's security and configuration sections
- Open an issue at: https://github.com/your-org/mahilo-registry/issues
- Join the community Discord (if available)

---

## Appendix: Quick Reference

### Start Production Instance

```bash
# One-liner for quick deployment
docker run -d --name mahilo \
  -p 8080:8080 \
  -v mahilo-data:/app/data \
  -e SECRET_KEY=$(openssl rand -base64 32) \
  -e NODE_ENV=production \
  mahilo-registry:latest
```

### Environment Template

Create `.env.production`:

```bash
# Required
SECRET_KEY=your-secure-secret-key-here

# Server
PORT=8080
HOST=0.0.0.0
NODE_ENV=production

# Database
DATABASE_URL=/app/data/mahilo.db

# Limits
RATE_LIMIT=100
MAX_PAYLOAD_SIZE=32768
MAX_RETRIES=5
CALLBACK_TIMEOUT_MS=30000

# Security (set true for self-hosted with local callbacks)
ALLOW_PRIVATE_IPS=false
```

### Verify Deployment

```bash
# Health check
curl -s http://localhost:8080/health | jq .

# Test registration
curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser"}' | jq .
```
