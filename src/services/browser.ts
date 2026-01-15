import puppeteer, { Browser, Page } from 'puppeteer';
import { getConfig } from '../config/index.js';
import { createLogger } from './logger.js';
import type { ViewportConfig, CaptureResult } from '../types/index.js';
import { VIEWPORTS } from '../types/index.js';

const logger = createLogger('browser');

// Browser state
let browser: Browser | null = null;
let isShuttingDown = false;
let activePages = 0;
const pageQueue: Array<{
    resolve: (page: Page) => void;
    reject: (error: Error) => void;
}> = [];

// Browser launch arguments (optimized for container performance)
const BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--single-process',
    '--no-zygote',
    '--disable-crash-reporter',
    '--disable-breakpad',
    // Performance optimizations
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--disable-hang-monitor',
    '--memory-pressure-off'
];

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function initBrowser(): Promise<Browser> {
    if (browser) {
        return browser;
    }

    const executablePath = process.env['PUPPETEER_EXECUTABLE_PATH'] ?? undefined;

    logger.info({ executablePath, args: BROWSER_ARGS }, 'Launching browser');

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: BROWSER_ARGS,
            executablePath
        });
    } catch (error) {
        const errorDetails = error instanceof Error
            ? { message: error.message, stack: error.stack, name: error.name }
            : { message: String(error) };
        logger.fatal({ error: errorDetails, executablePath }, 'Failed to launch browser');
        throw error;
    }

    // Handle browser disconnection
    browser.on('disconnected', () => {
        logger.warn('Browser disconnected');
        browser = null;

        if (!isShuttingDown) {
            logger.info('Attempting to restart browser');
            initBrowser().catch((err) => {
                logger.error({ err }, 'Failed to restart browser');
            });
        }
    });

    logger.info('Browser launched successfully');

    return browser;
}

export function getBrowser(): Browser | null {
    return browser;
}

async function acquirePage(): Promise<Page> {
    const config = getConfig();

    // Check if we can create a new page
    if (activePages < config.maxConcurrentPages) {
        activePages++;
        const currentBrowser = await initBrowser();
        const page = await currentBrowser.newPage();

        await page.setUserAgent(USER_AGENT);

        return page;
    }

    // Queue the request
    return new Promise((resolve, reject) => {
        pageQueue.push({ resolve, reject });
        logger.debug({ queueLength: pageQueue.length, activePages }, 'Page request queued');
    });
}

async function releasePage(page: Page): Promise<void> {
    try {
        await page.close();
    } catch (error) {
        logger.warn({ error }, 'Error closing page');
    }

    activePages--;

    // Process queued requests
    if (pageQueue.length > 0 && !isShuttingDown) {
        const next = pageQueue.shift();
        if (next) {
            try {
                const currentBrowser = await initBrowser();
                activePages++;
                const newPage = await currentBrowser.newPage();
                await newPage.setUserAgent(USER_AGENT);
                next.resolve(newPage);
            } catch (error) {
                next.reject(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
}

export async function captureScreenshot(
    url: string,
    viewport: string,
    fullPage: boolean,
    waitTime: number
): Promise<CaptureResult> {
    const config = getConfig();

    if (isShuttingDown) {
        throw new Error('Browser is shutting down');
    }

    const page = await acquirePage();

    try {
        // Set viewport
        const viewportConfig: ViewportConfig = VIEWPORTS[viewport] ?? VIEWPORTS['desktop']!;
        await page.setViewport(viewportConfig);

        logger.info({ url, viewport, fullPage }, 'Capturing screenshot');

        // 1. Emulate reduced motion preference (makes well-behaved sites show content immediately)
        await page.emulateMediaFeatures([
            { name: 'prefers-reduced-motion', value: 'reduce' }
        ]);

        // Navigate to URL
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: config.screenshotTimeout
        });

        // 2. Inject CSS to force all elements visible and disable animations
        await page.addStyleTag({
            content: `
                *, *::before, *::after {
                    /* Force visibility - reveals elements hidden for animation */
                    opacity: 1 !important;
                    visibility: visible !important;
                    transform: none !important;

                    /* Disable animations */
                    animation: none !important;
                    transition: none !important;
                }
            `
        });

        // 3. Scroll to trigger lazy loading and intersection observers
        if (fullPage) {
            await page.evaluate(`(async () => {
                await new Promise((resolve) => {
                    const distance = 400;
                    const delay = 100;
                    const scrollHeight = document.body.scrollHeight;
                    let currentPosition = 0;

                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        currentPosition += distance;

                        if (currentPosition >= scrollHeight) {
                            clearInterval(timer);
                            window.scrollTo(0, 0);
                            resolve();
                        }
                    }, delay);
                });
            })()`);

            // Wait for lazy-loaded content
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Wait additional time if specified
        if (waitTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        // Capture screenshot
        const buffer = await page.screenshot({
            type: 'png',
            fullPage,
            encoding: 'binary'
        });

        logger.info({ url, size: buffer.length }, 'Screenshot captured');

        return {
            buffer: Buffer.from(buffer),
            url
        };
    } finally {
        await releasePage(page);
    }
}

export async function closeBrowser(): Promise<void> {
    isShuttingDown = true;

    // Reject all queued requests
    while (pageQueue.length > 0) {
        const next = pageQueue.shift();
        if (next) {
            next.reject(new Error('Browser is shutting down'));
        }
    }

    // Wait for active pages to complete (with timeout)
    const maxWait = 30000;
    const startTime = Date.now();

    while (activePages > 0 && Date.now() - startTime < maxWait) {
        logger.info({ activePages }, 'Waiting for active pages to complete');
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (activePages > 0) {
        logger.warn({ activePages }, 'Timeout waiting for pages, force closing browser');
    }

    if (browser) {
        try {
            await browser.close();
            logger.info('Browser closed');
        } catch (error) {
            logger.error({ error }, 'Error closing browser');
        }
        browser = null;
    }
}

export function checkBrowserHealth(): boolean {
    return browser !== null && browser.connected;
}

export function getBrowserStats(): { activePages: number; queueLength: number; isConnected: boolean } {
    return {
        activePages,
        queueLength: pageQueue.length,
        isConnected: browser !== null && browser.connected
    };
}
