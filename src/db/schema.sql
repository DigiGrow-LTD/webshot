-- Site captures table (for full-site screenshot jobs)
CREATE TABLE IF NOT EXISTS site_captures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    sitemap_url TEXT,
    total_pages INTEGER DEFAULT 0,
    captured_pages INTEGER DEFAULT 0,
    failed_pages INTEGER DEFAULT 0,
    viewport TEXT DEFAULT 'desktop',
    full_page BOOLEAN DEFAULT TRUE,
    wait_time INTEGER DEFAULT 2000,
    client_name TEXT,
    project_name TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- Indexes for site_captures
CREATE INDEX IF NOT EXISTS idx_site_captures_status ON site_captures(status);
CREATE INDEX IF NOT EXISTS idx_site_captures_client ON site_captures(client_name);
CREATE INDEX IF NOT EXISTS idx_site_captures_expires ON site_captures(expires_at);

-- Screenshots metadata table
CREATE TABLE IF NOT EXISTS screenshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source information
    url TEXT NOT NULL,

    -- Storage information
    filename TEXT NOT NULL,
    bucket TEXT NOT NULL DEFAULT 'screenshots',
    storage_key TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT DEFAULT 'image/png',

    -- Capture settings
    viewport TEXT NOT NULL DEFAULT 'desktop',
    full_page BOOLEAN DEFAULT TRUE,

    -- Metadata
    client_name TEXT,
    project_name TEXT,
    tags TEXT[],

    -- Site capture reference (for full-site jobs)
    site_capture_id UUID REFERENCES site_captures(id) ON DELETE CASCADE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
    downloaded_at TIMESTAMP WITH TIME ZONE,

    -- Status
    status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'expired'))
);

-- Index for cleanup job
CREATE INDEX IF NOT EXISTS idx_screenshots_expires_at ON screenshots(expires_at);

-- Index for listing by client
CREATE INDEX IF NOT EXISTS idx_screenshots_client ON screenshots(client_name);

-- Index for listing by project
CREATE INDEX IF NOT EXISTS idx_screenshots_project ON screenshots(project_name);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_screenshots_status ON screenshots(status);

-- Index for site capture queries
CREATE INDEX IF NOT EXISTS idx_screenshots_site_capture ON screenshots(site_capture_id);

-- API keys table (alternative to JSON file - optional)
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    rate_limit INTEGER DEFAULT 100,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE
);

-- Rate limiting tracking
CREATE TABLE IF NOT EXISTS rate_limit_log (
    id SERIAL PRIMARY KEY,
    api_key_hash TEXT NOT NULL,
    request_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for rate limit queries
CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time ON rate_limit_log(api_key_hash, request_time);

-- Cleanup old rate limit logs (keep last 2 hours)
CREATE OR REPLACE FUNCTION cleanup_rate_limit_logs() RETURNS void AS $$
BEGIN
    DELETE FROM rate_limit_log WHERE request_time < NOW() - INTERVAL '2 hours';
END;
$$ LANGUAGE plpgsql;
