import { z } from 'zod';

// Viewport configurations
export interface ViewportConfig {
    width: number;
    height: number;
}

export const VIEWPORTS: Record<string, ViewportConfig> = {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 375, height: 812 }
};

// Request validation schemas
export const ScreenshotRequestSchema = z.object({
    urls: z.array(z.string().url()).min(1).max(10),
    viewport: z.enum(['desktop', 'mobile']).default('desktop'),
    fullPage: z.boolean().default(true),
    waitTime: z.number().min(0).max(30000).default(2000),
    clientName: z.string().max(100).optional(),
    projectName: z.string().max(100).optional(),
    tags: z.array(z.string().max(50)).max(10).optional()
});

export type ScreenshotRequest = z.infer<typeof ScreenshotRequestSchema>;

// Database models
export interface Screenshot {
    id: string;
    url: string;
    filename: string;
    bucket: string;
    storageKey: string;
    fileSize: number | null;
    mimeType: string;
    viewport: string;
    fullPage: boolean;
    clientName: string | null;
    projectName: string | null;
    tags: string[];
    createdAt: Date;
    expiresAt: Date;
    downloadedAt: Date | null;
    status: 'pending' | 'completed' | 'failed' | 'expired';
}

export interface ScreenshotInsert {
    url: string;
    filename: string;
    bucket: string;
    storageKey: string;
    fileSize: number | null;
    viewport: string;
    fullPage: boolean;
    clientName?: string;
    projectName?: string;
    tags?: string[];
}

// API response types
export interface ScreenshotResult {
    id: string;
    url: string;
    filename: string;
    downloadUrl: string;
    viewport: string;
    fileSize: number;
    expiresAt: string;
    createdAt: string;
}

export interface ScreenshotFailure {
    url: string;
    error: string;
}

export interface ScreenshotResponse {
    success: boolean;
    screenshots: ScreenshotResult[];
    failed: ScreenshotFailure[];
}

export interface ScreenshotDetailResponse {
    id: string;
    url: string;
    downloadUrl: string;
    expiresIn: number;
    metadata: {
        viewport: string;
        fileSize: number | null;
        clientName: string | null;
        projectName: string | null;
        createdAt: string;
    };
}

export interface ScreenshotListResponse {
    screenshots: Screenshot[];
    total: number;
    limit: number;
    offset: number;
}

// Query parameters
export const ListQuerySchema = z.object({
    clientName: z.string().optional(),
    projectName: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
    offset: z.coerce.number().min(0).default(0),
    includeExpired: z.coerce.boolean().default(false)
});

export type ListQuery = z.infer<typeof ListQuerySchema>;

// API Key configuration
export interface ApiKey {
    key: string;
    name: string;
    rateLimit: string; // e.g., "10/second", "100/minute"
    enabled: boolean;
}

export interface ApiKeysConfig {
    keys: ApiKey[];
}

// Health check types
export interface HealthStatus {
    status: 'healthy' | 'unhealthy' | 'degraded';
    version: string;
    services: {
        api: 'healthy' | 'unhealthy';
        database: 'healthy' | 'unhealthy';
        storage: 'healthy' | 'unhealthy';
        browser: 'healthy' | 'unhealthy';
    };
    timestamp: string;
}

// Internal types
export interface CaptureResult {
    buffer: Buffer;
    url: string;
}

export interface UploadResult {
    bucket: string;
    key: string;
    size: number;
}

// Express request extension
declare global {
    namespace Express {
        interface Request {
            apiKey?: ApiKey;
            requestId?: string;
        }
    }
}

// ============================================
// Site Capture Types (Full-site screenshots)
// ============================================

// Request validation schema
export const SiteCaptureRequestSchema = z.object({
    url: z.string().url(),
    sitemapUrl: z.string().url().optional(),
    viewport: z.enum(['desktop', 'mobile']).default('desktop'),
    fullPage: z.boolean().default(true),
    waitTime: z.number().min(0).max(30000).default(2000),
    maxPages: z.number().min(1).max(500).default(100),
    clientName: z.string().max(100).optional(),
    projectName: z.string().max(100).optional()
});

export type SiteCaptureRequest = z.infer<typeof SiteCaptureRequestSchema>;

// Database model
export interface SiteCapture {
    id: string;
    url: string;
    sitemapUrl: string | null;
    totalPages: number;
    capturedPages: number;
    failedPages: number;
    viewport: string;
    fullPage: boolean;
    waitTime: number;
    clientName: string | null;
    projectName: string | null;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    createdAt: Date;
    completedAt: Date | null;
    expiresAt: Date;
}

export interface SiteCaptureInsert {
    url: string;
    sitemapUrl?: string;
    totalPages?: number;
    viewport?: string;
    fullPage?: boolean;
    waitTime?: number;
    clientName?: string;
    projectName?: string;
}

// Extended screenshot insert with site capture reference
export interface ScreenshotInsertWithSite extends ScreenshotInsert {
    siteCaptureId?: string;
}

// API response types
export interface SitePageResult {
    id: string;
    url: string;
    path: string;
    downloadUrl: string;
    fileSize: number;
}

export interface SiteCaptureResponse {
    success: boolean;
    siteId: string;
    url: string;
    sitemapUrl: string | null;
    totalPages: number;
    captured: number;
    failed: number;
    uniquePaths: number;
    pages: Record<string, SitePageResult>;
    failures: Array<{ url: string; error: string }>;
}

export interface SiteCaptureDetailResponse {
    id: string;
    url: string;
    sitemapUrl: string | null;
    totalPages: number;
    capturedPages: number;
    failedPages: number;
    viewport: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    pages: Record<string, SitePageResult>;
}

export interface SiteCaptureListResponse {
    sites: SiteCapture[];
    total: number;
    limit: number;
    offset: number;
}

// Query parameters for listing site captures
export const SiteListQuerySchema = z.object({
    clientName: z.string().optional(),
    projectName: z.string().optional(),
    status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
    offset: z.coerce.number().min(0).default(0),
    includeExpired: z.coerce.boolean().default(false)
});

export type SiteListQuery = z.infer<typeof SiteListQuerySchema>;

// Sitemap types
export interface SitemapUrl {
    loc: string;
    lastmod?: string;
    priority?: number;
}

export interface SitemapResult {
    urls: SitemapUrl[];
    errors: string[];
}
