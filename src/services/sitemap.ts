import { createLogger } from './logger.js';
import type { SitemapUrl, SitemapResult } from '../types/index.js';

const logger = createLogger('sitemap');

const USER_AGENT = 'ScreenshotService/1.0 (Sitemap Crawler)';
const FETCH_TIMEOUT = 30000;
const MAX_SITEMAP_DEPTH = 3;

/**
 * Fetch content from a URL with timeout
 */
async function fetchUrl(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/xml, text/xml, text/plain, */*'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Check if XML content is a sitemap index (contains nested sitemaps)
 */
function isSitemapIndex(xml: string): boolean {
    return xml.includes('<sitemapindex') || xml.includes(':sitemapindex');
}

/**
 * Parse a sitemap index to extract nested sitemap URLs
 */
function parseSitemapIndex(xml: string): string[] {
    const sitemapUrls: string[] = [];

    // Match <sitemap><loc>...</loc></sitemap> patterns
    const sitemapRegex = /<sitemap[^>]*>[\s\S]*?<loc[^>]*>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi;
    let match;

    while ((match = sitemapRegex.exec(xml)) !== null) {
        const captured = match[1];
        if (captured) {
            const url = captured.trim();
            if (url) {
                sitemapUrls.push(url);
            }
        }
    }

    return sitemapUrls;
}

/**
 * Parse a regular sitemap to extract page URLs
 */
function parseSitemapUrls(xml: string): SitemapUrl[] {
    const urls: SitemapUrl[] = [];

    // Match <url>...</url> patterns
    const urlRegex = /<url[^>]*>([\s\S]*?)<\/url>/gi;
    let match;

    while ((match = urlRegex.exec(xml)) !== null) {
        const urlBlock = match[1];
        if (!urlBlock) continue;

        // Extract loc (required)
        const locMatch = /<loc[^>]*>([^<]+)<\/loc>/i.exec(urlBlock);
        if (!locMatch || !locMatch[1]) continue;

        const loc = locMatch[1].trim();
        if (!loc) continue;

        // Extract optional fields
        const lastmodMatch = /<lastmod[^>]*>([^<]+)<\/lastmod>/i.exec(urlBlock);
        const priorityMatch = /<priority[^>]*>([^<]+)<\/priority>/i.exec(urlBlock);

        urls.push({
            loc,
            lastmod: lastmodMatch?.[1]?.trim(),
            priority: priorityMatch?.[1] ? parseFloat(priorityMatch[1].trim()) : undefined
        });
    }

    return urls;
}

/**
 * Try to find a sitemap URL from robots.txt
 */
async function findSitemapFromRobots(baseUrl: string): Promise<string | null> {
    try {
        const robotsUrl = new URL('/robots.txt', baseUrl).toString();
        const content = await fetchUrl(robotsUrl);

        // Look for Sitemap: directive
        const sitemapMatch = /^Sitemap:\s*(.+)$/im.exec(content);
        if (sitemapMatch?.[1]) {
            return sitemapMatch[1].trim();
        }
    } catch (error) {
        logger.debug({ baseUrl, error }, 'Failed to fetch robots.txt');
    }

    return null;
}

/**
 * Discover the sitemap URL for a website
 */
export async function discoverSitemapUrl(baseUrl: string, providedUrl?: string): Promise<string> {
    const tried: string[] = [];

    // 1. Try provided URL first
    if (providedUrl) {
        try {
            await fetchUrl(providedUrl);
            logger.info({ url: providedUrl }, 'Using provided sitemap URL');
            return providedUrl;
        } catch (error) {
            tried.push(providedUrl);
            logger.debug({ url: providedUrl, error }, 'Provided sitemap URL failed');
        }
    }

    // 2. Try /sitemap.xml
    const sitemapXml = new URL('/sitemap.xml', baseUrl).toString();
    try {
        await fetchUrl(sitemapXml);
        logger.info({ url: sitemapXml }, 'Found sitemap.xml');
        return sitemapXml;
    } catch {
        tried.push(sitemapXml);
    }

    // 3. Try /sitemap_index.xml
    const sitemapIndex = new URL('/sitemap_index.xml', baseUrl).toString();
    try {
        await fetchUrl(sitemapIndex);
        logger.info({ url: sitemapIndex }, 'Found sitemap_index.xml');
        return sitemapIndex;
    } catch {
        tried.push(sitemapIndex);
    }

    // 4. Try robots.txt
    const fromRobots = await findSitemapFromRobots(baseUrl);
    if (fromRobots) {
        try {
            await fetchUrl(fromRobots);
            logger.info({ url: fromRobots }, 'Found sitemap from robots.txt');
            return fromRobots;
        } catch {
            tried.push(fromRobots);
        }
    }

    // No sitemap found
    throw new Error(`No sitemap found. Tried: ${tried.join(', ')}`);
}

/**
 * Recursively collect all URLs from a sitemap (handling nested sitemaps)
 */
export async function collectAllUrls(
    sitemapUrl: string,
    maxPages: number = 100,
    depth: number = 0
): Promise<SitemapResult> {
    const result: SitemapResult = {
        urls: [],
        errors: []
    };

    if (depth >= MAX_SITEMAP_DEPTH) {
        result.errors.push(`Max sitemap depth (${MAX_SITEMAP_DEPTH}) reached at ${sitemapUrl}`);
        return result;
    }

    try {
        logger.info({ sitemapUrl, depth }, 'Fetching sitemap');
        const xml = await fetchUrl(sitemapUrl);

        if (isSitemapIndex(xml)) {
            // This is a sitemap index - recursively fetch nested sitemaps
            const nestedUrls = parseSitemapIndex(xml);
            logger.info({ sitemapUrl, nestedCount: nestedUrls.length }, 'Found sitemap index');

            for (const nestedUrl of nestedUrls) {
                if (result.urls.length >= maxPages) {
                    break;
                }

                const nestedResult = await collectAllUrls(
                    nestedUrl,
                    maxPages - result.urls.length,
                    depth + 1
                );

                result.urls.push(...nestedResult.urls);
                result.errors.push(...nestedResult.errors);
            }
        } else {
            // This is a regular sitemap - extract URLs
            const urls = parseSitemapUrls(xml);
            logger.info({ sitemapUrl, urlCount: urls.length }, 'Parsed sitemap URLs');

            // Respect maxPages limit
            const toAdd = urls.slice(0, maxPages - result.urls.length);
            result.urls.push(...toAdd);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to fetch ${sitemapUrl}: ${errorMessage}`);
        logger.error({ sitemapUrl, error: errorMessage }, 'Failed to fetch sitemap');
    }

    return result;
}

/**
 * Extract the path from a full URL
 */
export function extractPath(fullUrl: string, baseUrl: string): string {
    try {
        const url = new URL(fullUrl);
        const base = new URL(baseUrl);

        // Only extract path if same origin
        if (url.origin === base.origin) {
            return url.pathname || '/';
        }

        // For different origins, return full URL as path
        return fullUrl;
    } catch {
        return fullUrl;
    }
}

/**
 * Sort URLs by path for consistent ordering
 */
export function sortUrlsByPath(urls: SitemapUrl[]): SitemapUrl[] {
    return [...urls].sort((a, b) => {
        const pathA = new URL(a.loc).pathname;
        const pathB = new URL(b.loc).pathname;
        return pathA.localeCompare(pathB);
    });
}
