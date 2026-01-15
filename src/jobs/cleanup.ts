import {
    getExpiredScreenshots,
    updateScreenshotStatus,
    deleteScreenshotRecord,
    cleanupRateLimitLogs,
    getExpiredSiteCaptures,
    deleteSiteCaptureRecord
} from '../services/database.js';
import { deleteScreenshot } from '../services/storage.js';
import { getConfig } from '../config/index.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('cleanup');

let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

export async function runCleanup(): Promise<void> {
    if (isRunning) {
        logger.debug('Cleanup already running, skipping');
        return;
    }

    isRunning = true;
    const startTime = Date.now();

    try {
        logger.info('Starting cleanup job');

        // Get expired screenshots
        const expiredScreenshots = await getExpiredScreenshots();

        logger.info({ count: expiredScreenshots.length }, 'Found expired screenshots');

        let deletedCount = 0;
        let errorCount = 0;

        for (const screenshot of expiredScreenshots) {
            try {
                // Delete from storage
                await deleteScreenshot(screenshot.bucket, screenshot.storageKey);

                // Delete from database (or just mark as expired if you want to keep records)
                await deleteScreenshotRecord(screenshot.id);

                deletedCount++;

                logger.debug(
                    {
                        screenshotId: screenshot.id,
                        url: screenshot.url
                    },
                    'Screenshot cleaned up'
                );
            } catch (error) {
                errorCount++;

                // If storage deletion fails (file might already be gone), still mark as expired
                try {
                    await updateScreenshotStatus(screenshot.id, 'expired');
                } catch (dbError) {
                    logger.error(
                        {
                            error: dbError,
                            screenshotId: screenshot.id
                        },
                        'Failed to update screenshot status'
                    );
                }

                logger.error(
                    {
                        error,
                        screenshotId: screenshot.id
                    },
                    'Failed to cleanup screenshot'
                );
            }
        }

        // Cleanup expired site captures (screenshots deleted via CASCADE)
        const expiredSiteCaptures = await getExpiredSiteCaptures();
        let siteDeletedCount = 0;

        for (const siteCapture of expiredSiteCaptures) {
            try {
                await deleteSiteCaptureRecord(siteCapture.id);
                siteDeletedCount++;
                logger.debug({ siteCaptureId: siteCapture.id }, 'Site capture cleaned up');
            } catch (error) {
                logger.error({ error, siteCaptureId: siteCapture.id }, 'Failed to cleanup site capture');
            }
        }

        // Cleanup old rate limit logs
        const rateLimitLogsDeleted = await cleanupRateLimitLogs();

        const duration = Date.now() - startTime;

        logger.info(
            {
                deletedCount,
                errorCount,
                siteDeletedCount,
                rateLimitLogsDeleted,
                durationMs: duration
            },
            'Cleanup job completed'
        );
    } catch (error) {
        logger.error({ error }, 'Cleanup job failed');
    } finally {
        isRunning = false;
    }
}

export function startCleanupJob(): void {
    const config = getConfig();

    if (cleanupInterval) {
        logger.warn('Cleanup job already started');
        return;
    }

    logger.info(
        { intervalMs: config.cleanupInterval },
        'Starting cleanup job scheduler'
    );

    // Run immediately on start
    runCleanup().catch((error) => {
        logger.error({ error }, 'Initial cleanup run failed');
    });

    // Schedule periodic runs
    cleanupInterval = setInterval(() => {
        runCleanup().catch((error) => {
            logger.error({ error }, 'Scheduled cleanup run failed');
        });
    }, config.cleanupInterval);
}

export function stopCleanupJob(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        logger.info('Cleanup job stopped');
    }
}

export function isCleanupRunning(): boolean {
    return isRunning;
}
