import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../services/logger.js';

const logger = createLogger('rateLimit');

// Parse rate limit string (e.g., "10/second", "100/minute")
function parseRateLimit(limit: string): { requests: number; windowMs: number } {
    const match = limit.match(/^(\d+)\/(second|minute)$/);
    if (!match) {
        logger.warn({ limit }, 'Invalid rate limit format, using default 10/second');
        return { requests: 10, windowMs: 1000 };
    }
    const requests = parseInt(match[1]!, 10);
    const windowMs = match[2] === 'second' ? 1000 : 60000;
    return { requests, windowMs };
}

// In-memory rate limit tracking (per API key)
interface RateLimitWindow {
    timestamps: number[];
}

const rateLimitWindows = new Map<string, RateLimitWindow>();

export async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    // If no API key is set, skip rate limiting
    if (!req.apiKey) {
        next();
        return;
    }

    const keyName = req.apiKey.name;
    const { requests: maxRequests, windowMs } = parseRateLimit(req.apiKey.rateLimit);
    const now = Date.now();

    try {
        let window = rateLimitWindows.get(keyName);

        if (!window) {
            window = { timestamps: [] };
            rateLimitWindows.set(keyName, window);
        }

        // Remove timestamps older than the window
        window.timestamps = window.timestamps.filter(ts => now - ts < windowMs);

        // Check if rate limit exceeded
        if (window.timestamps.length >= maxRequests) {
            const oldestTs = window.timestamps[0] ?? now;
            const retryAfter = Math.ceil((oldestTs + windowMs - now) / 1000);

            logger.warn({ keyName, count: window.timestamps.length, limit: req.apiKey.rateLimit }, 'Rate limit exceeded');

            res.status(429).json({
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Limit: ${req.apiKey.rateLimit}.`,
                retryAfter: Math.max(1, retryAfter)
            });
            return;
        }

        // Add current request timestamp
        window.timestamps.push(now);

        // Set rate limit headers
        const windowLabel = windowMs === 1000 ? '1s' : '1m';
        res.setHeader('X-RateLimit-Limit', maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', (maxRequests - window.timestamps.length).toString());
        res.setHeader('X-RateLimit-Window', windowLabel);

        next();
    } catch (error) {
        logger.error({ error }, 'Rate limit check failed');
        next();
    }
}

// Simple in-memory rate limiter for endpoints that don't require API keys
// Uses a sliding window algorithm
interface RateLimitEntry {
    count: number;
    resetTime: number;
}

const memoryRateLimits = new Map<string, RateLimitEntry>();

export function memoryRateLimitMiddleware(
    requestsPerMinute: number = 60
): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const windowMs = 60000; // 1 minute

        const entry = memoryRateLimits.get(ip);

        if (!entry || now > entry.resetTime) {
            // Start new window
            memoryRateLimits.set(ip, {
                count: 1,
                resetTime: now + windowMs
            });
            next();
            return;
        }

        if (entry.count >= requestsPerMinute) {
            const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

            res.status(429).json({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded',
                retryAfter
            });
            return;
        }

        entry.count++;
        next();
    };
}

// Cleanup old entries periodically
setInterval(
    () => {
        const now = Date.now();
        for (const [key, entry] of memoryRateLimits) {
            if (now > entry.resetTime) {
                memoryRateLimits.delete(key);
            }
        }
        // Also clean up stale API key windows (older than 1 minute)
        for (const [key, window] of rateLimitWindows) {
            window.timestamps = window.timestamps.filter(ts => now - ts < 60000);
            if (window.timestamps.length === 0) {
                rateLimitWindows.delete(key);
            }
        }
    },
    60000
); // Cleanup every minute
