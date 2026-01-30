# Mahilo Registry Deployment Guide

## Docker Image

The Docker image is automatically built and pushed to GitHub Container Registry (ghcr.io) on every push to `main`.

### Image Tags

- `ghcr.io/<your-username>/mahilo-2:latest` - Latest from main branch
- `ghcr.io/<your-username>/mahilo-2:main` - Main branch
- `ghcr.io/<your-username>/mahilo-2:<sha>` - Specific commit
- `ghcr.io/<your-username>/mahilo-2:v1.0.0` - Version tags (when you create a release)

### Pull the Image

```bash
docker pull ghcr.io/<your-username>/mahilo-2:latest
```

### Run Locally with Docker

```bash
docker run -d \
  --name mahilo-registry \
  -p 8080:8080 \
  -v mahilo-data:/app/data \
  -e ADMIN_API_KEY=your-secure-admin-key \
  ghcr.io/<your-username>/mahilo-2:latest
```

## Railway Deployment

### Option 1: Deploy from GitHub (Recommended)

1. Go to [Railway](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select this repository
4. Railway will automatically detect the Dockerfile and deploy

### Option 2: Deploy from Docker Image

1. Go to [Railway](https://railway.app)
2. Click "New Project" → "Deploy from Docker Image"
3. Enter: `ghcr.io/<your-username>/mahilo-2:latest`
4. Configure environment variables

### Environment Variables for Railway

Set these in the Railway dashboard under "Variables":

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_API_KEY` | Yes | Admin API key for bootstrapping |
| `PORT` | No | Defaults to 8080 |
| `HOST` | No | Defaults to 0.0.0.0 |
| `DATABASE_URL` | No | SQLite path, defaults to /app/data/mahilo.db |

### Persistent Storage

Railway provides ephemeral storage by default. For production:

1. Go to your service in Railway
2. Click "Add" → "Volume"
3. Mount path: `/app/data`
4. This persists your SQLite database across deployments

### Custom Domain

1. Go to Settings → Networking
2. Click "Generate Domain" for a Railway subdomain
3. Or add your own custom domain

## Health Check

The service exposes a health endpoint at `/health` that returns:
- `200 OK` with `{"status": "healthy"}` when running
- Used by Railway and Docker for health monitoring

## First-Time Setup

After deployment:

1. Use the admin API to create your first user:
```bash
curl -X POST https://your-domain.railway.app/api/v1/auth/users \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

2. Register your first agent with the returned API key

See the main README for full API documentation.
