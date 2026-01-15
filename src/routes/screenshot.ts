import { Router } from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ScreenshotRequestSchema } from '../types/index.js';
import type { ScreenshotResult, ScreenshotFailure, ScreenshotResponse } from '../types/index.js';
import { captureScreenshot } from '../services/browser.js';
import { uploadScreenshot } from '../services/storage.js';
import { saveScreenshot } from '../services/database.js';
import { createLogger } from '../services/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';

const router = Router();
const logger = createLogger('screenshot-route');

// Generate a filename from URL
function generateFilename(url: string): string {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/\./g, '-');
        const timestamp = Date.now();
        return `${hostname}-${timestamp}.png`;
    } catch {
        return `screenshot-${Date.now()}.png`;
    }
}

// Generate storage key with date prefix for organization
function generateStorageKey(filename: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}/${uuidv4()}-${filename}`;
}

// POST /screenshot
router.post(
    '/',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const requestId = req.requestId ?? uuidv4();

        // Validate request body
        const parseResult = ScreenshotRequestSchema.safeParse(req.body);

        if (!parseResult.success) {
            res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid request body',
                details: parseResult.error.flatten()
            });
            return;
        }

        const { urls, viewport, fullPage, waitTime, clientName, projectName, tags } = parseResult.data;

        logger.info(
            {
                requestId,
                urlCount: urls.length,
                viewport,
                fullPage,
                clientName,
                projectName
            },
            'Processing screenshot request'
        );

        const results: ScreenshotResult[] = [];
        const failures: ScreenshotFailure[] = [];

        // Process single URL helper
        async function processSingleUrl(url: string): Promise<ScreenshotResult> {
            logger.info({ requestId, url }, 'Processing URL');

            // Capture screenshot
            const captureResult = await captureScreenshot(url, viewport, fullPage, waitTime);

            // Generate filename and storage key
            const filename = generateFilename(url);
            const storageKey = generateStorageKey(filename);

            // Upload to MinIO
            const uploadResult = await uploadScreenshot(captureResult.buffer, storageKey, {
                'original-url': url,
                viewport
            });

            // Save metadata to database
            const screenshot = await saveScreenshot({
                url,
                filename,
                bucket: uploadResult.bucket,
                storageKey: uploadResult.key,
                fileSize: uploadResult.size,
                viewport,
                fullPage,
                clientName,
                projectName,
                tags
            });

            logger.info(
                {
                    requestId,
                    url,
                    screenshotId: screenshot.id,
                    fileSize: uploadResult.size
                },
                'Screenshot captured and stored successfully'
            );

            return {
                id: screenshot.id,
                url: screenshot.url,
                filename: screenshot.filename,
                downloadUrl: `/api/screenshot/${screenshot.id}/download`,
                viewport: screenshot.viewport,
                fileSize: screenshot.fileSize ?? 0,
                expiresAt: screenshot.expiresAt.toISOString(),
                createdAt: screenshot.createdAt.toISOString()
            };
        }

        // Process URLs in parallel (page pool handles concurrency limiting)
        const settledResults = await Promise.allSettled(
            urls.map(url => processSingleUrl(url))
        );

        // Separate successes and failures
        for (let i = 0; i < settledResults.length; i++) {
            const result = settledResults[i]!;
            const url = urls[i]!;

            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                const errorMessage = result.reason instanceof Error
                    ? result.reason.message
                    : 'Unknown error';
                logger.error({ requestId, url, error: errorMessage }, 'Failed to capture screenshot');
                failures.push({ url, error: errorMessage });
            }
        }

        const response: ScreenshotResponse = {
            success: results.length > 0,
            screenshots: results,
            failed: failures
        };

        const statusCode = results.length === urls.length ? 200 : results.length > 0 ? 207 : 500;

        res.status(statusCode).json(response);
    }
);

export default router;
