import { Router } from 'express';
import type { Request, Response } from 'express';
import { getScreenshot, markDownloaded } from '../services/database.js';
import { getStorageClient } from '../services/storage.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '../services/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { Readable } from 'stream';

const router = Router();
const logger = createLogger('download-route');

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /screenshot/:id - Get screenshot metadata
router.get(
    '/:id',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const id = req.params['id'];

        // Validate UUID format
        if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
            res.status(400).json({
                error: 'Bad Request',
                message: 'Invalid screenshot ID format'
            });
            return;
        }

        try {
            const screenshot = await getScreenshot(id);

            if (!screenshot) {
                res.status(404).json({
                    error: 'Not Found',
                    message: 'Screenshot not found'
                });
                return;
            }

            // Check if expired
            if (screenshot.status === 'expired' || screenshot.expiresAt < new Date()) {
                res.status(410).json({
                    error: 'Gone',
                    message: 'Screenshot has expired'
                });
                return;
            }

            // Check if failed
            if (screenshot.status === 'failed') {
                res.status(410).json({
                    error: 'Gone',
                    message: 'Screenshot capture failed'
                });
                return;
            }

            res.json({
                id: screenshot.id,
                url: screenshot.url,
                filename: screenshot.filename,
                downloadUrl: `/screenshot/${screenshot.id}/download`,
                metadata: {
                    viewport: screenshot.viewport,
                    fullPage: screenshot.fullPage,
                    fileSize: screenshot.fileSize,
                    clientName: screenshot.clientName,
                    projectName: screenshot.projectName,
                    tags: screenshot.tags,
                    createdAt: screenshot.createdAt.toISOString(),
                    expiresAt: screenshot.expiresAt.toISOString()
                }
            });
        } catch (error) {
            logger.error({ error, screenshotId: id }, 'Error fetching screenshot');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to fetch screenshot'
            });
        }
    }
);

// GET /screenshot/:id/download - Stream the actual image file
router.get(
    '/:id/download',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const id = req.params['id'];

        if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
            res.status(400).json({
                error: 'Bad Request',
                message: 'Invalid screenshot ID format'
            });
            return;
        }

        try {
            const screenshot = await getScreenshot(id);

            if (!screenshot) {
                res.status(404).json({
                    error: 'Not Found',
                    message: 'Screenshot not found'
                });
                return;
            }

            if (screenshot.status === 'expired' || screenshot.expiresAt < new Date()) {
                res.status(410).json({
                    error: 'Gone',
                    message: 'Screenshot has expired'
                });
                return;
            }

            // Fetch from MinIO
            const client = getStorageClient();
            const command = new GetObjectCommand({
                Bucket: screenshot.bucket,
                Key: screenshot.storageKey
            });

            const response = await client.send(command);

            if (!response.Body) {
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: 'Failed to retrieve file from storage'
                });
                return;
            }

            // Mark as downloaded
            await markDownloaded(id);

            // Set headers
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', `attachment; filename="${screenshot.filename}"`);
            if (response.ContentLength) {
                res.setHeader('Content-Length', response.ContentLength);
            }

            // Stream the file
            const stream = response.Body as Readable;
            stream.pipe(res);

            logger.info({ screenshotId: id }, 'Screenshot downloaded');
        } catch (error) {
            logger.error({ error, screenshotId: id }, 'Error downloading screenshot');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to download screenshot'
            });
        }
    }
);

export default router;
