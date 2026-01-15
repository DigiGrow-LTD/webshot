import pg from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import type {
    Screenshot,
    ScreenshotInsert,
    ListQuery,
    SiteCapture,
    SiteCaptureInsert,
    SiteListQuery,
    ScreenshotInsertWithSite
} from '../types/index.js';
import { getConfig } from '../config/index.js';
import { createLogger } from './logger.js';

const { Pool } = pg;
const logger = createLogger('database');

let pool: pg.Pool | null = null;

export function createPool(): pg.Pool {
    const config = getConfig();

    pool = new Pool({
        connectionString: config.databaseUrl,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
    });

    pool.on('error', (err) => {
        logger.error({ err }, 'Unexpected database pool error');
    });

    return pool;
}

export function getPool(): pg.Pool {
    if (!pool) {
        throw new Error('Database pool not initialized. Call createPool() first.');
    }
    return pool;
}

export async function runMigrations(): Promise<void> {
    const client = await getPool().connect();

    try {
        // Schema path relative to dist folder (where compiled JS runs)
        // In Docker: /app/dist/db/schema.sql
        // In dev: ./dist/db/schema.sql
        const schemaPath = join(process.cwd(), 'dist', 'db', 'schema.sql');

        logger.info({ schemaPath }, 'Running database migrations');

        const schema = readFileSync(schemaPath, 'utf-8');
        await client.query(schema);

        logger.info('Database migrations completed successfully');
    } catch (error) {
        logger.error({ error }, 'Failed to run database migrations');
        throw error;
    } finally {
        client.release();
    }
}

export async function saveScreenshot(data: ScreenshotInsert): Promise<Screenshot> {
    const query = `
        INSERT INTO screenshots (
            url, filename, bucket, storage_key, file_size,
            viewport, full_page, client_name, project_name, tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `;

    const values = [
        data.url,
        data.filename,
        data.bucket,
        data.storageKey,
        data.fileSize,
        data.viewport,
        data.fullPage,
        data.clientName ?? null,
        data.projectName ?? null,
        data.tags ?? []
    ];

    const result = await getPool().query(query, values);
    return mapRowToScreenshot(result.rows[0]);
}

export async function getScreenshot(id: string): Promise<Screenshot | null> {
    const query = 'SELECT * FROM screenshots WHERE id = $1';
    const result = await getPool().query(query, [id]);

    if (result.rows.length === 0) {
        return null;
    }

    return mapRowToScreenshot(result.rows[0]);
}

export async function listScreenshots(filters: ListQuery): Promise<{ screenshots: Screenshot[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.clientName) {
        conditions.push(`client_name = $${paramIndex}`);
        values.push(filters.clientName);
        paramIndex++;
    }

    if (filters.projectName) {
        conditions.push(`project_name = $${paramIndex}`);
        values.push(filters.projectName);
        paramIndex++;
    }

    if (!filters.includeExpired) {
        conditions.push(`(status != 'expired' AND expires_at > NOW())`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM screenshots ${whereClause}`;
    const countResult = await getPool().query(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    // Get paginated results
    const dataQuery = `
        SELECT * FROM screenshots
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const dataResult = await getPool().query(dataQuery, [...values, filters.limit, filters.offset]);

    return {
        screenshots: dataResult.rows.map(mapRowToScreenshot),
        total
    };
}

export async function markDownloaded(id: string): Promise<void> {
    const query = 'UPDATE screenshots SET downloaded_at = NOW() WHERE id = $1';
    await getPool().query(query, [id]);
}

export async function getExpiredScreenshots(): Promise<Screenshot[]> {
    const query = `
        SELECT * FROM screenshots
        WHERE status = 'completed' AND expires_at < NOW()
        LIMIT 100
    `;

    const result = await getPool().query(query);
    return result.rows.map(mapRowToScreenshot);
}

export async function updateScreenshotStatus(id: string, status: Screenshot['status']): Promise<void> {
    const query = 'UPDATE screenshots SET status = $1 WHERE id = $2';
    await getPool().query(query, [status, id]);
}

export async function deleteScreenshotRecord(id: string): Promise<void> {
    const query = 'DELETE FROM screenshots WHERE id = $1';
    await getPool().query(query, [id]);
}

export async function checkDatabaseHealth(): Promise<boolean> {
    try {
        const result = await getPool().query('SELECT 1');
        return result.rowCount === 1;
    } catch {
        return false;
    }
}

export async function logRateLimitRequest(apiKeyHash: string): Promise<void> {
    const query = 'INSERT INTO rate_limit_log (api_key_hash) VALUES ($1)';
    await getPool().query(query, [apiKeyHash]);
}

export async function getRateLimitCount(apiKeyHash: string, windowMinutes: number): Promise<number> {
    const query = `
        SELECT COUNT(*) as count
        FROM rate_limit_log
        WHERE api_key_hash = $1
        AND request_time > NOW() - INTERVAL '${windowMinutes} minutes'
    `;

    const result = await getPool().query(query, [apiKeyHash]);
    return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function cleanupRateLimitLogs(): Promise<number> {
    const query = `
        DELETE FROM rate_limit_log
        WHERE request_time < NOW() - INTERVAL '2 hours'
    `;

    const result = await getPool().query(query);
    return result.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
        logger.info('Database pool closed');
    }
}

// Helper function to map database row to Screenshot type
interface ScreenshotRow {
    id: string;
    url: string;
    filename: string;
    bucket: string;
    storage_key: string;
    file_size: number | null;
    mime_type: string;
    viewport: string;
    full_page: boolean;
    client_name: string | null;
    project_name: string | null;
    tags: string[] | null;
    created_at: Date;
    expires_at: Date;
    downloaded_at: Date | null;
    status: string;
}

function mapRowToScreenshot(row: ScreenshotRow): Screenshot {
    return {
        id: row.id,
        url: row.url,
        filename: row.filename,
        bucket: row.bucket,
        storageKey: row.storage_key,
        fileSize: row.file_size,
        mimeType: row.mime_type,
        viewport: row.viewport,
        fullPage: row.full_page,
        clientName: row.client_name,
        projectName: row.project_name,
        tags: row.tags ?? [],
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        downloadedAt: row.downloaded_at,
        status: row.status as Screenshot['status']
    };
}

// ============================================
// Site Capture Database Functions
// ============================================

interface SiteCaptureRow {
    id: string;
    url: string;
    sitemap_url: string | null;
    total_pages: number;
    captured_pages: number;
    failed_pages: number;
    viewport: string;
    full_page: boolean;
    wait_time: number;
    client_name: string | null;
    project_name: string | null;
    status: string;
    created_at: Date;
    completed_at: Date | null;
    expires_at: Date;
}

function mapRowToSiteCapture(row: SiteCaptureRow): SiteCapture {
    return {
        id: row.id,
        url: row.url,
        sitemapUrl: row.sitemap_url,
        totalPages: row.total_pages,
        capturedPages: row.captured_pages,
        failedPages: row.failed_pages,
        viewport: row.viewport,
        fullPage: row.full_page,
        waitTime: row.wait_time,
        clientName: row.client_name,
        projectName: row.project_name,
        status: row.status as SiteCapture['status'],
        createdAt: row.created_at,
        completedAt: row.completed_at,
        expiresAt: row.expires_at
    };
}

export async function createSiteCapture(data: SiteCaptureInsert): Promise<SiteCapture> {
    const query = `
        INSERT INTO site_captures (
            url, sitemap_url, total_pages, viewport, full_page,
            wait_time, client_name, project_name, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing')
        RETURNING *
    `;

    const values = [
        data.url,
        data.sitemapUrl ?? null,
        data.totalPages ?? 0,
        data.viewport ?? 'desktop',
        data.fullPage ?? true,
        data.waitTime ?? 2000,
        data.clientName ?? null,
        data.projectName ?? null
    ];

    const result = await getPool().query(query, values);
    return mapRowToSiteCapture(result.rows[0]);
}

export async function getSiteCapture(id: string): Promise<SiteCapture | null> {
    const query = 'SELECT * FROM site_captures WHERE id = $1';
    const result = await getPool().query(query, [id]);

    if (result.rows.length === 0) {
        return null;
    }

    return mapRowToSiteCapture(result.rows[0]);
}

export async function updateSiteCaptureProgress(
    id: string,
    capturedPages: number,
    failedPages: number
): Promise<void> {
    const query = `
        UPDATE site_captures
        SET captured_pages = $2, failed_pages = $3
        WHERE id = $1
    `;
    await getPool().query(query, [id, capturedPages, failedPages]);
}

export async function completeSiteCapture(
    id: string,
    status: 'completed' | 'failed'
): Promise<void> {
    const query = `
        UPDATE site_captures
        SET status = $2, completed_at = NOW()
        WHERE id = $1
    `;
    await getPool().query(query, [id, status]);
}

export async function listSiteCaptures(filters: SiteListQuery): Promise<{ sites: SiteCapture[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.clientName) {
        conditions.push(`client_name = $${paramIndex}`);
        values.push(filters.clientName);
        paramIndex++;
    }

    if (filters.projectName) {
        conditions.push(`project_name = $${paramIndex}`);
        values.push(filters.projectName);
        paramIndex++;
    }

    if (filters.status) {
        conditions.push(`status = $${paramIndex}`);
        values.push(filters.status);
        paramIndex++;
    }

    if (!filters.includeExpired) {
        conditions.push(`expires_at > NOW()`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM site_captures ${whereClause}`;
    const countResult = await getPool().query(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    // Get paginated results
    const dataQuery = `
        SELECT * FROM site_captures
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const dataResult = await getPool().query(dataQuery, [...values, filters.limit, filters.offset]);

    return {
        sites: dataResult.rows.map(mapRowToSiteCapture),
        total
    };
}

export async function getScreenshotsBySiteCapture(siteCaptureId: string): Promise<Screenshot[]> {
    const query = `
        SELECT * FROM screenshots
        WHERE site_capture_id = $1
        ORDER BY url ASC
    `;
    const result = await getPool().query(query, [siteCaptureId]);
    return result.rows.map(mapRowToScreenshot);
}

export async function saveScreenshotWithSite(data: ScreenshotInsertWithSite): Promise<Screenshot> {
    const query = `
        INSERT INTO screenshots (
            url, filename, bucket, storage_key, file_size,
            viewport, full_page, client_name, project_name, tags,
            site_capture_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
    `;

    const values = [
        data.url,
        data.filename,
        data.bucket,
        data.storageKey,
        data.fileSize,
        data.viewport,
        data.fullPage,
        data.clientName ?? null,
        data.projectName ?? null,
        data.tags ?? [],
        data.siteCaptureId ?? null
    ];

    const result = await getPool().query(query, values);
    return mapRowToScreenshot(result.rows[0]);
}

export async function getExpiredSiteCaptures(): Promise<SiteCapture[]> {
    const query = `
        SELECT * FROM site_captures
        WHERE expires_at < NOW() AND status != 'pending'
        LIMIT 50
    `;
    const result = await getPool().query(query);
    return result.rows.map(mapRowToSiteCapture);
}

export async function deleteSiteCaptureRecord(id: string): Promise<void> {
    // Screenshots are deleted via ON DELETE CASCADE
    const query = 'DELETE FROM site_captures WHERE id = $1';
    await getPool().query(query, [id]);
}
