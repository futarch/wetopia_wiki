// Durable bundle storage on S3-compatible object storage (Cellar on Clever
// Cloud, or any MinIO/Scaleway/AWS endpoint).
//
// This is the layer that makes a write survive the ephemeral disk, so it uses
// the standard SDK rather than a hand-rolled SigV4: request signing is exactly
// the kind of security-critical detail not worth reimplementing.
//
// It mirrors LocalBundleStore's contract precisely — same key space, same
// newest-first ordering, same fetch/prune semantics — so the two are
// interchangeable and the local driver stays a faithful stand-in in tests.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BundleStore, StoredBundle } from "./bundleStore.ts";

export interface S3BundleStoreOptions {
  bucket: string;
  /** Endpoint host or URL. Cellar: cellar-c2.services.clever-cloud.com */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Optional key prefix, so one bucket can hold several deployments. */
  prefix?: string;
}

export class S3BundleStore implements BundleStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(o: S3BundleStoreOptions) {
    if (!o.bucket) throw new Error("bucket manquant");
    const endpoint = /^https?:\/\//.test(o.endpoint) ? o.endpoint : `https://${o.endpoint}`;
    this.bucket = o.bucket;
    this.prefix = o.prefix ? o.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
    this.client = new S3Client({
      endpoint,
      // Cellar is not AWS; the region is a formality the SDK still requires.
      region: o.region ?? "us-east-1",
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      // Path-style addressing: the bucket goes in the path, not the hostname,
      // which is what non-AWS S3 endpoints expect.
      forcePathStyle: true,
    });
  }

  private key(k: string): string {
    return this.prefix + k;
  }

  /** Fail fast at boot with a readable message instead of on the first write. */
  async check(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (e) {
      throw new Error(
        `magasin de bundles injoignable (bucket « ${this.bucket} ») : ${(e as Error).message}`,
      );
    }
  }

  async put(key: string, filePath: string): Promise<void> {
    // The body is read into memory on purpose. Handed a stream, the SDK signs
    // the upload with `aws-chunked` framing, which every S3-compatible
    // endpoint must then unwrap — a needless compatibility risk for the one
    // layer that must not fail. A bundle is a snapshot of a text wiki, so it
    // stays small; if that ever stops being true, the fix is walgit, not a
    // cleverer upload.
    const body = fs.readFileSync(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: body,
        ContentLength: body.length,
        ContentType: "application/octet-stream",
      }),
    );
    // The PUT is acknowledged only once the object is stored, which is what
    // upload-before-ACK relies on.
  }

  async list(repo: string): Promise<StoredBundle[]> {
    const out: StoredBundle[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.key(`${repo}/`),
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key?.endsWith(".bundle")) continue;
        out.push({ key: o.Key.slice(this.prefix.length), size: o.Size ?? 0 });
      }
      // Keys can exceed one page; a truncated listing would silently hide the
      // newest bundle and make a restore quietly return stale content.
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // Keys embed a zero-padded timestamp, so lexical order is chronological.
    return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }

  async fetch(key: string, destFile: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
    if (!res.Body) throw new Error(`bundle vide : ${key}`);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const tmp = `${destFile}.part`;
    // Download to a temp name, then rename: a partial file must never be
    // mistaken for a restorable bundle.
    await pipeline(res.Body as Readable, fs.createWriteStream(tmp));
    fs.renameSync(tmp, destFile);
  }

  async listObjects(prefix: string): Promise<StoredBundle[]> {
    const out: StoredBundle[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.key(`${prefix}/`),
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key.slice(this.prefix.length), size: o.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }

  async removeObjects(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((k) => ({ Key: this.key(k) })) },
        }),
      );
    }
  }

  async prune(repo: string, keep: number): Promise<void> {
    const all = await this.list(repo);
    const doomed = all.slice(keep);
    for (let i = 0; i < doomed.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: doomed.slice(i, i + 1000).map((b) => ({ Key: this.key(b.key) })) },
        }),
      );
    }
  }
}

/**
 * Build the store from the environment. Clever Cloud injects CELLAR_ADDON_*
 * when a Cellar add-on is linked, so production needs no extra configuration
 * beyond naming the bucket.
 */
export function s3StoreFromEnv(): S3BundleStore | null {
  const bucket = process.env.WETOPIA_BUNDLE_BUCKET;
  const endpoint = process.env.CELLAR_ADDON_HOST ?? process.env.WETOPIA_S3_ENDPOINT;
  const accessKeyId = process.env.CELLAR_ADDON_KEY_ID ?? process.env.WETOPIA_S3_KEY_ID;
  const secretAccessKey = process.env.CELLAR_ADDON_KEY_SECRET ?? process.env.WETOPIA_S3_KEY_SECRET;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return new S3BundleStore({
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: process.env.WETOPIA_S3_REGION,
    prefix: process.env.WETOPIA_BUNDLE_PREFIX,
  });
}
