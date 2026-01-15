import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    CreateBucketCommand,
    PutBucketLifecycleConfigurationCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getConfig } from '../config/index.js';
import { createLogger } from './logger.js';
import type { UploadResult } from '../types/index.js';

const logger = createLogger('storage');

let s3Client: S3Client | null = null;

export function createStorageClient(): S3Client {
    const config = getConfig();

    const endpoint = `${config.minio.useSSL ? 'https' : 'http'}://${config.minio.endpoint}:${config.minio.port}`;

    s3Client = new S3Client({
        endpoint,
        region: 'us-east-1', // MinIO requires a region but doesn't use it
        credentials: {
            accessKeyId: config.minio.accessKey,
            secretAccessKey: config.minio.secretKey
        },
        forcePathStyle: true // Required for MinIO
    });

    logger.info({ endpoint }, 'Storage client created');

    return s3Client;
}

export function getStorageClient(): S3Client {
    if (!s3Client) {
        throw new Error('Storage client not initialized. Call createStorageClient() first.');
    }
    return s3Client;
}

export async function ensureBucket(bucketName: string): Promise<void> {
    const client = getStorageClient();

    try {
        // Check if bucket exists
        await client.send(new HeadBucketCommand({ Bucket: bucketName }));
        logger.info({ bucket: bucketName }, 'Bucket already exists');
    } catch (error) {
        // Bucket doesn't exist, create it
        if ((error as { name?: string }).name === 'NotFound' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
            logger.info({ bucket: bucketName }, 'Creating bucket');

            await client.send(new CreateBucketCommand({ Bucket: bucketName }));

            // Set lifecycle policy to auto-expire objects after 1 day
            await client.send(
                new PutBucketLifecycleConfigurationCommand({
                    Bucket: bucketName,
                    LifecycleConfiguration: {
                        Rules: [
                            {
                                ID: 'auto-expire',
                                Status: 'Enabled',
                                Filter: { Prefix: '' },
                                Expiration: { Days: 1 }
                            }
                        ]
                    }
                })
            );

            logger.info({ bucket: bucketName }, 'Bucket created with lifecycle policy');
        } else {
            throw error;
        }
    }
}

export async function uploadScreenshot(
    buffer: Buffer,
    key: string,
    metadata?: Record<string, string>
): Promise<UploadResult> {
    const config = getConfig();
    const client = getStorageClient();

    const command = new PutObjectCommand({
        Bucket: config.minio.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'image/png',
        Metadata: metadata
    });

    await client.send(command);

    logger.info({ bucket: config.minio.bucket, key, size: buffer.length }, 'Screenshot uploaded');

    return {
        bucket: config.minio.bucket,
        key,
        size: buffer.length
    };
}

export async function getPresignedUrl(
    bucket: string,
    key: string,
    expiresIn?: number
): Promise<string> {
    const config = getConfig();
    const client = getStorageClient();

    const expiry = expiresIn ?? config.presignedUrlExpiry;

    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key
    });

    // Generate presigned URL using internal endpoint
    const internalUrl = await getSignedUrl(client, command, { expiresIn: expiry });

    // Replace internal endpoint with public URL for external access
    const publicUrl = internalUrl.replace(
        new RegExp(`^https?://${config.minio.endpoint}:${config.minio.port}`),
        config.minio.publicUrl
    );

    return publicUrl;
}

export async function getDirectUrl(bucket: string, key: string): Promise<string> {
    const config = getConfig();

    // Return direct public URL (for public buckets)
    return `${config.minio.publicUrl}/${bucket}/${key}`;
}

export async function deleteScreenshot(bucket: string, key: string): Promise<void> {
    const client = getStorageClient();

    const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
    });

    await client.send(command);

    logger.info({ bucket, key }, 'Screenshot deleted from storage');
}

export async function checkStorageHealth(): Promise<boolean> {
    const config = getConfig();

    try {
        const client = getStorageClient();
        await client.send(new HeadBucketCommand({ Bucket: config.minio.bucket }));
        return true;
    } catch {
        return false;
    }
}
