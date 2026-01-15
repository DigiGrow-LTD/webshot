# Webshot

Self-hosted screenshot API with full-site capture, S3 storage, and smart animation handling.

## Features

- **Single or batch screenshots** - Capture one URL or multiple in a single request
- **Full-site capture** - Automatically discover and screenshot every page via sitemap
- **Animation handling** - Forces visibility of scroll-triggered content (motion.dev, GSAP, AOS, etc.)
- **S3-compatible storage** - MinIO included, works with any S3 provider
- **Async processing** - Site captures run in background with progress polling
- **Auto-cleanup** - Screenshots expire after 24 hours (configurable)

## Quick Start

```bash
# Clone and configure
git clone https://github.com/YOUR_USERNAME/webshot.git
cd webshot
cp .env.example .env
cp config/api-keys.example.json config/api-keys.json

# Edit .env with secure passwords
# Edit config/api-keys.json with your API keys

# Start
docker compose up -d
```

Verify: `curl http://localhost/health`

## API

All endpoints require `X-API-Key` header (except health checks).

### POST /screenshot

Capture one or more URLs.

```bash
curl -X POST http://localhost/screenshot \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "urls": ["https://example.com"],
    "viewport": "desktop",
    "fullPage": true
  }'
```

**Request:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| urls | string[] | required | URLs to capture (max 10) |
| viewport | "desktop" \| "mobile" | "desktop" | Viewport size |
| fullPage | boolean | true | Full page or viewport only |
| waitTime | number | 2000 | Extra wait time (ms, max 30000) |
| clientName | string | - | Filter tag |
| projectName | string | - | Filter tag |

**Response:**
```json
{
  "success": true,
  "screenshots": [{
    "id": "uuid",
    "url": "https://example.com",
    "downloadUrl": "/screenshot/uuid/download",
    "fileSize": 245678
  }]
}
```

### POST /site

Capture an entire website via sitemap (async).

```bash
curl -X POST http://localhost/site \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "url": "https://example.com",
    "maxPages": 50
  }'
```

**Request:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| url | string | required | Site URL (will auto-discover sitemap) |
| sitemapUrl | string | - | Override sitemap location |
| maxPages | number | 100 | Max pages to capture |
| viewport | "desktop" \| "mobile" | "desktop" | Viewport size |
| fullPage | boolean | true | Full page capture |

**Response (202 Accepted):**
```json
{
  "siteId": "uuid",
  "status": "processing",
  "totalPages": 28,
  "message": "Poll GET /site/uuid for progress."
}
```

### GET /site/:id

Get site capture progress and results.

```json
{
  "id": "uuid",
  "status": "completed",
  "totalPages": 28,
  "capturedPages": 28,
  "failedPages": 0,
  "pages": {
    "/": { "id": "uuid", "downloadUrl": "/screenshot/uuid/download" },
    "/about": { "id": "uuid", "downloadUrl": "/screenshot/uuid/download" }
  }
}
```

### GET /screenshot/:id/download

Download a screenshot (redirects to presigned S3 URL).

### GET /screenshots

List screenshots with filtering.

| Param | Type | Description |
|-------|------|-------------|
| clientName | string | Filter by client |
| projectName | string | Filter by project |
| limit | number | Max results (default 50) |
| offset | number | Pagination offset |

### DELETE /screenshot/:id

Delete a screenshot.

### GET /health

Service health check.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| POSTGRES_PASSWORD | - | PostgreSQL password |
| MINIO_ACCESS_KEY | - | MinIO access key |
| MINIO_SECRET_KEY | - | MinIO secret key |
| MINIO_PUBLIC_URL | - | Public URL for presigned URLs |
| API_KEYS | - | JSON array of API keys (see below) |
| MAX_CONCURRENT_PAGES | 3 | Parallel browser pages |
| SCREENSHOT_TIMEOUT | 30000 | Page load timeout (ms) |
| PRESIGNED_URL_EXPIRY | 3600 | Download URL validity (seconds) |

### API Keys

**Option 1: Environment Variables (recommended for Coolify)**

```
API_KEY=sk_live_your_secret_key
API_KEY_NAME=Production
API_KEY_RATE_LIMIT=10/second
```

**Option 2: Config File (fallback)**

Create `config/api-keys.json`:

```json
{
  "keys": [
    {
      "key": "sk_live_your_secure_key",
      "name": "Production",
      "rateLimit": "10/second",
      "enabled": true
    }
  ]
}
```

**Rate limit formats:** `"10/second"`, `"100/minute"`

## Deployment

### Coolify

1. Create new service from Git repository
2. Set build pack to **Docker Compose**
3. Add environment variables in Coolify dashboard (including `API_KEYS`)
4. Deploy

### Architecture

```
┌─────────────────────────────────────┐
│         API (port 3000)             │
│           Express.js                │
└───────────┬───────────┬─────────────┘
            │           │
            ▼           ▼
    ┌───────────┐   ┌───────────┐
    │ PostgreSQL│   │   MinIO   │
    │  metadata │   │  storage  │
    └───────────┘   └───────────┘
```

- All endpoints served directly by the API
- File downloads streamed through `/screenshot/:id/download`
- MinIO accessed internally only

## Animation Handling

Webshot handles scroll-triggered animations (motion.dev, GSAP, AOS, Framer Motion) by:

1. Emulating `prefers-reduced-motion: reduce`
2. Injecting CSS to force visibility (`opacity: 1`, `visibility: visible`, `transform: none`)
3. Scrolling through the page to trigger lazy loading
4. Waiting for content to settle

This ensures full-page screenshots capture all content, not just above-the-fold elements.

## Rate Limiting

- Configurable per API key (e.g., `"10/second"`, `"100/minute"`)
- In-memory sliding window (no database overhead)
- Returns `429 Too Many Requests` with `retryAfter` header
- Default: 10 requests/second if not specified

## License

MIT
