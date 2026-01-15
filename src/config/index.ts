import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ApiKeysConfig } from '../types/index.js';

interface Config {
    // Server
    port: number;
    nodeEnv: string;

    // Database
    databaseUrl: string;

    // MinIO/S3
    minio: {
        endpoint: string;
        port: number;
        useSSL: boolean;
        accessKey: string;
        secretKey: string;
        bucket: string;
        publicUrl: string;
    };

    // Browser/Puppeteer
    maxConcurrentPages: number;
    screenshotTimeout: number;

    // Jobs
    cleanupInterval: number;

    // URLs
    presignedUrlExpiry: number;

    // Config directory
    configDir: string;
}

function getEnvOrThrow(key: string): string {
    const value = process.env[key];
    if (value === undefined || value === '') {
        throw new Error(`Required environment variable ${key} is not set`);
    }
    return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
    return process.env[key] ?? defaultValue;
}

function getEnvIntOrDefault(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        throw new Error(`Environment variable ${key} must be a valid integer`);
    }
    return parsed;
}

function getEnvBoolOrDefault(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(): Config {
    return {
        port: getEnvIntOrDefault('PORT', 3000),
        nodeEnv: getEnvOrDefault('NODE_ENV', 'production'),

        databaseUrl: getEnvOrThrow('DATABASE_URL'),

        minio: {
            endpoint: getEnvOrDefault('MINIO_ENDPOINT', 'minio'),
            port: getEnvIntOrDefault('MINIO_PORT', 9000),
            useSSL: getEnvBoolOrDefault('MINIO_USE_SSL', false),
            accessKey: getEnvOrThrow('MINIO_ACCESS_KEY'),
            secretKey: getEnvOrThrow('MINIO_SECRET_KEY'),
            bucket: getEnvOrDefault('MINIO_BUCKET', 'screenshots'),
            publicUrl: getEnvOrThrow('MINIO_PUBLIC_URL')
        },

        maxConcurrentPages: getEnvIntOrDefault('MAX_CONCURRENT_PAGES', 3),
        screenshotTimeout: getEnvIntOrDefault('SCREENSHOT_TIMEOUT', 30000),

        cleanupInterval: getEnvIntOrDefault('CLEANUP_INTERVAL', 3600000),

        presignedUrlExpiry: getEnvIntOrDefault('PRESIGNED_URL_EXPIRY', 3600),

        configDir: getEnvOrDefault('CONFIG_DIR', '/app/config')
    };
}

function loadApiKeysFromEnv(): ApiKeysConfig | null {
    const key = process.env['API_KEY'];
    if (!key) return null;

    return {
        keys: [{
            key,
            name: process.env['API_KEY_NAME'] ?? 'Default',
            rateLimit: process.env['API_KEY_RATE_LIMIT'] ?? '10/second',
            enabled: process.env['API_KEY_ENABLED'] !== 'false'
        }]
    };
}

function loadApiKeysFromFile(configDir: string): ApiKeysConfig | null {
    const apiKeysPath = join(configDir, 'api-keys.json');

    if (!existsSync(apiKeysPath)) {
        return null;
    }

    try {
        const content = readFileSync(apiKeysPath, 'utf-8');
        const config = JSON.parse(content) as ApiKeysConfig;

        if (!config.keys || !Array.isArray(config.keys)) {
            throw new Error('Invalid API keys config: missing keys array');
        }

        return config;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSON in API keys file: ${error.message}`);
        }
        throw error;
    }
}

export function loadApiKeys(configDir: string): ApiKeysConfig {
    // Try env var first (preferred for Coolify/containerized deployments)
    const envConfig = loadApiKeysFromEnv();
    if (envConfig) {
        console.log(`Loaded ${envConfig.keys.length} API key(s) from API_KEYS env var`);
        return envConfig;
    }

    // Fallback to config file
    const fileConfig = loadApiKeysFromFile(configDir);
    if (fileConfig) {
        console.log(`Loaded ${fileConfig.keys.length} API key(s) from config file`);
        return fileConfig;
    }

    console.warn('No API keys configured (neither API_KEYS env var nor config file found)');
    return { keys: [] };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

export type { Config };
