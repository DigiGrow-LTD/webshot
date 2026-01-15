import { Router } from 'express';
import type { Request, Response } from 'express';
import { checkDatabaseHealth } from '../services/database.js';
import { checkStorageHealth } from '../services/storage.js';
import { checkBrowserHealth, getBrowserStats } from '../services/browser.js';
import type { HealthStatus } from '../types/index.js';

const router = Router();

// GET /health
router.get('/', async (_req: Request, res: Response) => {
    const [dbHealthy, storageHealthy] = await Promise.all([
        checkDatabaseHealth(),
        checkStorageHealth()
    ]);

    const browserHealthy = checkBrowserHealth();
    const browserStats = getBrowserStats();

    const services = {
        api: 'healthy' as const,
        database: dbHealthy ? ('healthy' as const) : ('unhealthy' as const),
        storage: storageHealthy ? ('healthy' as const) : ('unhealthy' as const),
        browser: browserHealthy ? ('healthy' as const) : ('unhealthy' as const)
    };

    const allHealthy = dbHealthy && storageHealthy && browserHealthy;
    const anyHealthy = dbHealthy || storageHealthy || browserHealthy;

    let status: HealthStatus['status'];
    if (allHealthy) {
        status = 'healthy';
    } else if (anyHealthy) {
        status = 'degraded';
    } else {
        status = 'unhealthy';
    }

    const response: HealthStatus & { browser?: { activePages: number; queueLength: number } } = {
        status,
        version: process.env['npm_package_version'] ?? '1.0.0',
        services,
        timestamp: new Date().toISOString()
    };

    // Include browser stats in detailed health
    if (browserHealthy) {
        response.browser = {
            activePages: browserStats.activePages,
            queueLength: browserStats.queueLength
        };
    }

    const statusCode = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(response);
});

// GET /health/live - Kubernetes liveness probe
router.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
});

// GET /health/ready - Kubernetes readiness probe
router.get('/ready', async (_req: Request, res: Response) => {
    const dbHealthy = await checkDatabaseHealth();
    const storageHealthy = await checkStorageHealth();

    if (dbHealthy && storageHealthy) {
        res.status(200).json({ status: 'ready' });
    } else {
        res.status(503).json({
            status: 'not ready',
            database: dbHealthy,
            storage: storageHealthy
        });
    }
});

export default router;
