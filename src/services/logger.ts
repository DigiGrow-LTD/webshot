import pino from 'pino';
import type { LoggerOptions } from 'pino';
import { getConfig } from '../config/index.js';

let baseLogger: pino.Logger | null = null;

function getBaseLogger(): pino.Logger {
    if (!baseLogger) {
        let config: { nodeEnv: string };
        try {
            config = getConfig();
        } catch {
            // Config not loaded yet, use defaults
            config = { nodeEnv: process.env['NODE_ENV'] ?? 'production' };
        }

        const isDev = config.nodeEnv === 'development';
        const level = process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info');

        const baseOptions: LoggerOptions = {
            level,
            formatters: {
                level: (label) => ({ level: label })
            },
            timestamp: pino.stdTimeFunctions.isoTime
        };

        if (isDev) {
            baseOptions.transport = {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname'
                }
            };
        }

        baseLogger = pino(baseOptions);
    }

    return baseLogger;
}

export function createLogger(name: string): pino.Logger {
    return getBaseLogger().child({ service: name });
}

export function getLogger(): pino.Logger {
    return getBaseLogger();
}
