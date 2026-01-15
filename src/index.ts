import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig, loadApiKeys } from './config/index.js';
import { createPool, runMigrations, closePool } from './services/database.js';
import { createStorageClient, ensureBucket } from './services/storage.js';
import { initBrowser, closeBrowser } from './services/browser.js';
import { setApiKeysConfig } from './middleware/auth.js';
import { startCleanupJob, stopCleanupJob } from './jobs/cleanup.js';
import { createLogger, getLogger } from './services/logger.js';

// Routes
import healthRoutes from './routes/health.js';
import screenshotRoutes from './routes/screenshot.js';
import downloadRoutes from './routes/download.js';
import listRoutes from './routes/list.js';
import siteRoutes from './routes/site.js';

const logger = createLogger('app');

// Create Express app
const app = express();

// Trust proxy for correct IP detection behind reverse proxy
app.set('trust proxy', 1);

// Parse JSON bodies
app.use(express.json({ limit: '1mb' }));

// Request ID middleware
app.use((req, _res, next) => {
    req.requestId = (req.headers['x-request-id'] as string) ?? uuidv4();
    next();
});

// Request logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - startTime;

        // Skip logging health checks to reduce noise
        if (req.path.startsWith('/health')) {
            return;
        }

        logger.info({
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: duration,
            userAgent: req.headers['user-agent'],
            ip: req.ip
        });
    });

    next();
});

// Mount routes
app.use('/health', healthRoutes);
app.use('/screenshot', screenshotRoutes);
app.use('/screenshot', downloadRoutes);
app.use('/screenshots', listRoutes);
app.use('/site', siteRoutes);
app.use('/sites', siteRoutes);

// 404 handler
app.use((_req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: 'The requested resource was not found'
    });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');

    res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
    });
});

// Startup sequence
async function startup(): Promise<void> {
    logger.info('Starting screenshot service...');

    // Load configuration
    const config = loadConfig();
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'Configuration loaded');

    // Connect to PostgreSQL
    logger.info('Connecting to database...');
    createPool();
    await runMigrations();
    logger.info('Database connected and migrations complete');

    // Connect to MinIO
    logger.info('Connecting to MinIO...');
    createStorageClient();
    await ensureBucket(config.minio.bucket);
    logger.info('MinIO connected and bucket ready');

    // Load API keys
    logger.info('Loading API keys...');
    const apiKeysConfig = loadApiKeys(config.configDir);
    setApiKeysConfig(apiKeysConfig);

    // Start cleanup job
    logger.info('Starting cleanup job...');
    startCleanupJob();

    // Initialize browser (lazy - done here to verify it works)
    logger.info('Initializing browser...');
    await initBrowser();
    logger.info('Browser ready');

    // Start HTTP server
    const server = app.listen(config.port, () => {
        logger.info({ port: config.port }, 'Server listening');
    });

    // Graceful shutdown handler
    const shutdown = async (signal: string): Promise<void> => {
        logger.info({ signal }, 'Shutdown signal received');

        // Stop accepting new connections
        server.close(() => {
            logger.info('HTTP server closed');
        });

        // Stop cleanup job
        stopCleanupJob();

        // Close browser (waits for active pages)
        await closeBrowser();

        // Close database pool
        await closePool();

        logger.info('Shutdown complete');
        process.exit(0);
    };

    // Register shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        getLogger().fatal({ error }, 'Uncaught exception');
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        getLogger().fatal({ reason }, 'Unhandled rejection');
        process.exit(1);
    });
}

// Run startup
startup().catch((error) => {
    const errorDetails = error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : { message: String(error) };
    getLogger().fatal({ error: errorDetails }, 'Failed to start service');
    process.exit(1);
});
