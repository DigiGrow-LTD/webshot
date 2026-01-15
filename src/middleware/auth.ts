import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import type { ApiKey, ApiKeysConfig } from '../types/index.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('auth');

let apiKeysConfig: ApiKeysConfig | null = null;

export function setApiKeysConfig(config: ApiKeysConfig): void {
    apiKeysConfig = config;
    logger.info({ keyCount: config.keys.length }, 'API keys loaded');
}

export function getApiKeysConfig(): ApiKeysConfig | null {
    return apiKeysConfig;
}

export function hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

export function validateApiKey(key: string): ApiKey | null {
    if (!apiKeysConfig) {
        logger.warn('API keys not configured');
        return null;
    }

    const apiKey = apiKeysConfig.keys.find((k) => k.key === key);

    if (!apiKey) {
        return null;
    }

    if (!apiKey.enabled) {
        return null;
    }

    return apiKey;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
        res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid X-API-Key header'
        });
        return;
    }

    const validatedKey = validateApiKey(apiKey);

    if (!validatedKey) {
        logger.warn({ keyPrefix: apiKey.substring(0, 8) }, 'Invalid API key attempt');
        res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid API key'
        });
        return;
    }

    // Attach API key info to request
    req.apiKey = validatedKey;

    logger.debug({ keyName: validatedKey.name }, 'API key authenticated');

    next();
}

// Optional: middleware that allows unauthenticated requests if no keys are configured
export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!apiKeysConfig || apiKeysConfig.keys.length === 0) {
        // No API keys configured, allow request
        next();
        return;
    }

    // API keys are configured, require authentication
    authMiddleware(req, res, next);
}
