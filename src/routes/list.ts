import { Router } from 'express';
import type { Request, Response } from 'express';
import { ListQuerySchema } from '../types/index.js';
import type { ScreenshotListResponse } from '../types/index.js';
import {
    listScreenshots,
    getScreenshot,
    deleteScreenshotRecord,
    updateScreenshotStatus
} from '../services/database.js';
import { deleteScreenshot } from '../services/storage.js';
import { createLogger } from '../services/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';

const router = Router();
const logger = createLogger('list-route');

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /screenshots
router.get(
    '/',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        // Validate query parameters
        const parseResult = ListQuerySchema.safeParse(req.query);

        if (!parseResult.success) {
            res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid query parameters',
                details: parseResult.error.flatten()
            });
            return;
        }

        const filters = parseResult.data;

        try {
            const { screenshots, total } = await listScreenshots(filters);

            const response: ScreenshotListResponse = {
                screenshots,
                total,
                limit: filters.limit,
                offset: filters.offset
            };

            logger.info(
                {
                    filters,
                    resultCount: screenshots.length,
                    total
                },
                'Screenshots listed'
            );

            res.json(response);
        } catch (error) {
            logger.error({ error, filters }, 'Error listing screenshots');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to list screenshots'
            });
        }
    }
);

// DELETE /screenshot/:id (mounted on /screenshots, so path is /:id)
router.delete(
    '/:id',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const id = req.params['id'];
        const immediate = req.query['immediate'];

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

            if (immediate === 'true') {
                // Immediately delete from storage and database
                try {
                    await deleteScreenshot(screenshot.bucket, screenshot.storageKey);
                } catch (storageError) {
                    // Log but continue - file might already be deleted
                    logger.warn(
                        { error: storageError, screenshotId: id },
                        'Failed to delete from storage'
                    );
                }

                await deleteScreenshotRecord(id);

                logger.info({ screenshotId: id }, 'Screenshot deleted immediately');

                res.json({
                    success: true,
                    message: 'Screenshot deleted'
                });
            } else {
                // Mark as expired for cleanup job to handle
                await updateScreenshotStatus(id, 'expired');

                logger.info({ screenshotId: id }, 'Screenshot marked for deletion');

                res.json({
                    success: true,
                    message: 'Screenshot marked for deletion'
                });
            }
        } catch (error) {
            logger.error({ error, screenshotId: id }, 'Error deleting screenshot');

            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to delete screenshot'
            });
        }
    }
);

export default router;
