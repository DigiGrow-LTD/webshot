import { Router } from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
    SiteCaptureRequestSchema,
    SiteListQuerySchema
} from '../types/index.js';
import type { SitePageResult, SitemapUrl } from '../types/index.js';
import { discoverSitemapUrl, collectAllUrls, extractPath, sortUrlsByPath } from '../services/sitemap.js';
import { captureScreenshot } from '../services/browser.js';
import { uploadScreenshot } from '../services/storage.js';
import {
    createSiteCapture,
    getSiteCapture,
    updateSiteCaptureProgress,
    completeSiteCapture,
    listSiteCaptures,
    getScreenshotsBySiteCapture,
    saveScreenshotWithSite
} from '../services/database.js';
import { createLogger } from '../services/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';

const router = Router();
const logger = createLogger('site-route');

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generate a filename from URL
function generateFilename(url: string): string {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/\./g, '-');
        const path = urlObj.pathname.replace(/\//g, '-').replace(/^-|-$/g, '') || 'home';
        const timestamp = Date.now();
        return `${hostname}-${path}-${timestamp}.png`;
    } catch {
        return `screenshot-${Date.now()}.png`;
    }
}

// Generate storage key with date prefix
function generateStorageKey(filename: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}/${uuidv4()}-${filename}`;
}

// Background processing options
interface ProcessingOptions {
    viewport: string;
    fullPage: boolean;
    waitTime: number;
    clientName?: string;
    projectName?: string;
}

// Concurrency limit for parallel site captures (stays within page pool limits)
const SITE_CAPTURE_CONCURRENCY = 2;

// Background task to process site capture with parallel processing
async function processSiteCapture(
    siteCaptureId: string,
    urls: SitemapUrl[],
    options: ProcessingOptions
): Promise<void> {
    const { viewport, fullPage, waitTime, clientName, projectName } = options;
    let capturedCount = 0;
    let failedCount = 0;

    logger.info({ siteCaptureId, totalUrls: urls.length, concurrency: SITE_CAPTURE_CONCURRENCY }, 'Starting background capture');

    // Process a single URL
    async function processUrl(sitemapEntry: SitemapUrl): Promise<boolean> {
        const pageUrl = sitemapEntry.loc;

        try {
            logger.info({ siteCaptureId, pageUrl }, 'Capturing page');

            // Capture screenshot
            const captureResult = await captureScreenshot(pageUrl, viewport, fullPage, waitTime);

            // Generate filename and storage key
            const filename = generateFilename(pageUrl);
            const storageKey = generateStorageKey(filename);

            // Upload to MinIO
            const uploadResult = await uploadScreenshot(captureResult.buffer, storageKey, {
                'original-url': pageUrl,
                'site-capture-id': siteCaptureId,
                viewport
            });

            // Save to database
            await saveScreenshotWithSite({
                url: pageUrl,
                filename,
                bucket: uploadResult.bucket,
                storageKey: uploadResult.key,
                fileSize: uploadResult.size,
                viewport,
                fullPage,
                clientName,
                projectName,
                siteCaptureId
            });

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ siteCaptureId, pageUrl, error: errorMessage }, 'Failed to capture page');
            return false;
        }
    }

    // Worker function that pulls from queue
    const queue = [...urls];
    async function worker(): Promise<void> {
        while (queue.length > 0) {
            const entry = queue.shift();
            if (!entry) break;

            const success = await processUrl(entry);
            if (success) {
                capturedCount++;
            } else {
                failedCount++;
            }

            // Update progress (atomic counter updates are safe here)
            await updateSiteCaptureProgress(siteCaptureId, capturedCount, failedCount);
        }
    }

    // Start workers in parallel
    const workers = Array(SITE_CAPTURE_CONCURRENCY)
        .fill(null)
        .map(() => worker());

    await Promise.all(workers);

    // Complete site capture
    const finalStatus = capturedCount > 0 ? 'completed' : 'failed';
    await completeSiteCapture(siteCaptureId, finalStatus);

    logger.info(
        { siteCaptureId, captured: capturedCount, failed: failedCount },
        'Background capture completed'
    );
}

// POST /site - Capture entire site from sitemap (async)
router.post(
    '/',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const requestId = req.requestId ?? uuidv4();

        // Validate request
        const parseResult = SiteCaptureRequestSchema.safeParse(req.body);

        if (!parseResult.success) {
            res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid request body',
                details: parseResult.error.flatten()
            });
            return;
        }

        const {
            url: siteUrl,
            sitemapUrl: providedSitemapUrl,
            viewport,
            fullPage,
            waitTime,
            maxPages,
            clientName,
            projectName
        } = parseResult.data;

        logger.info(
            { requestId, siteUrl, providedSitemapUrl, maxPages, viewport },
            'Starting site capture'
        );

        try {
            // Step 1: Discover sitemap URL (sync - fast)
            let sitemapUrl: string;
            try {
                sitemapUrl = await discoverSitemapUrl(siteUrl, providedSitemapUrl);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                res.status(400).json({
                    error: 'Sitemap Not Found',
                    message: errorMessage
                });
                return;
            }

            // Step 2: Collect all URLs from sitemap (sync - fast)
            const sitemapResult = await collectAllUrls(sitemapUrl, maxPages);

            if (sitemapResult.urls.length === 0) {
                res.status(400).json({
                    error: 'Empty Sitemap',
                    message: 'Sitemap contains no URLs',
                    sitemapErrors: sitemapResult.errors
                });
                return;
            }

            // Sort URLs for consistent ordering
            const sortedUrls = sortUrlsByPath(sitemapResult.urls);

            logger.info(
                { requestId, sitemapUrl, urlCount: sortedUrls.length },
                'Sitemap parsed successfully'
            );

            // Step 3: Create site capture record
            const siteCapture = await createSiteCapture({
                url: siteUrl,
                sitemapUrl,
                totalPages: sortedUrls.length,
                viewport,
                fullPage,
                waitTime,
                clientName,
                projectName
            });

            // Step 4: Return immediately with job info
            res.status(202).json({
                siteId: siteCapture.id,
                url: siteUrl,
                sitemapUrl,
                status: 'processing',
                totalPages: sortedUrls.length,
                message: `Site capture started. Poll GET /api/site/${siteCapture.id} for progress.`
            });

            // Step 5: Spawn background processing
            setImmediate(() => {
                processSiteCapture(siteCapture.id, sortedUrls, {
                    viewport: viewport ?? 'desktop',
                    fullPage: fullPage ?? true,
                    waitTime: waitTime ?? 2000,
                    clientName,
                    projectName
                }).catch(err => {
                    logger.error({ err, siteId: siteCapture.id }, 'Background capture failed');
                    completeSiteCapture(siteCapture.id, 'failed').catch(() => {});
                });
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errorMessage }, 'Site capture failed');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to capture site'
            });
        }
    }
);

// GET /site/:id - Get site capture details
router.get(
    '/:id',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const id = req.params['id'];

        if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
            res.status(400).json({
                error: 'Bad Request',
                message: 'Invalid site capture ID format'
            });
            return;
        }

        try {
            const siteCapture = await getSiteCapture(id);

            if (!siteCapture) {
                res.status(404).json({
                    error: 'Not Found',
                    message: 'Site capture not found'
                });
                return;
            }

            // Get associated screenshots
            const screenshots = await getScreenshotsBySiteCapture(id);

            // Build pages map
            const pages: Record<string, SitePageResult> = {};
            for (const screenshot of screenshots) {
                const path = extractPath(screenshot.url, siteCapture.url);
                pages[path] = {
                    id: screenshot.id,
                    url: screenshot.url,
                    path,
                    downloadUrl: `/screenshot/${screenshot.id}/download`,
                    fileSize: screenshot.fileSize ?? 0
                };
            }

            res.json({
                id: siteCapture.id,
                url: siteCapture.url,
                sitemapUrl: siteCapture.sitemapUrl,
                totalPages: siteCapture.totalPages,
                capturedPages: siteCapture.capturedPages,
                failedPages: siteCapture.failedPages,
                uniquePaths: Object.keys(pages).length,
                viewport: siteCapture.viewport,
                status: siteCapture.status,
                createdAt: siteCapture.createdAt.toISOString(),
                completedAt: siteCapture.completedAt?.toISOString() ?? null,
                pages
            });

        } catch (error) {
            logger.error({ error, siteId: id }, 'Error fetching site capture');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to fetch site capture'
            });
        }
    }
);

// GET /sites - List site captures
router.get(
    '/',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        // Validate query parameters
        const parseResult = SiteListQuerySchema.safeParse(req.query);

        if (!parseResult.success) {
            res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid query parameters',
                details: parseResult.error.flatten()
            });
            return;
        }

        try {
            const result = await listSiteCaptures(parseResult.data);

            res.json({
                sites: result.sites.map(site => ({
                    id: site.id,
                    url: site.url,
                    sitemapUrl: site.sitemapUrl,
                    totalPages: site.totalPages,
                    capturedPages: site.capturedPages,
                    failedPages: site.failedPages,
                    viewport: site.viewport,
                    status: site.status,
                    createdAt: site.createdAt.toISOString(),
                    completedAt: site.completedAt?.toISOString() ?? null
                })),
                total: result.total,
                limit: parseResult.data.limit,
                offset: parseResult.data.offset
            });

        } catch (error) {
            logger.error({ error }, 'Error listing site captures');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to list site captures'
            });
        }
    }
);

export default router;
