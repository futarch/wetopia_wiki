// A minimal S3-compatible server: enough of the protocol for the bundle store
// (HeadBucket, PutObject, GetObject, ListObjectsV2 with pagination,
// DeleteObjects). Used by the tests so the driver is exercised over real HTTP
// and real XML rather than a hand-written stub of itself.
import http from "node:http";

const xmlEscape = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export async function startS3Mock({ bucket = "wetopia", pageSize = 2 } = {}) {
  /** @type {Map<string, Buffer>} */
  const objects = new Map();
  const calls = { put: 0, get: 0, list: 0, delete: 0, head: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    const reqBucket = segments[0];
    const key = segments.slice(1).join("/");
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

    if (reqBucket !== bucket) {
      res.writeHead(404, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>`);
    }

    // HeadBucket
    if (req.method === "HEAD" && !key) {
      calls.head++;
      res.writeHead(200);
      return res.end();
    }

    // DeleteObjects (POST /bucket?delete)
    if (req.method === "POST" && url.searchParams.has("delete")) {
      calls.delete++;
      const keys = [...body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      for (const k of keys) objects.delete(k);
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join("") +
          `</DeleteResult>`,
      );
    }

    // ListObjectsV2 (GET /bucket?list-type=2)
    if (req.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      calls.list++;
      const prefix = url.searchParams.get("prefix") ?? "";
      const after = url.searchParams.get("continuation-token") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const truncated = start + pageSize < all.length;
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
          `<KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : "") +
          page
            .map(
              (k) =>
                `<Contents><Key>${xmlEscape(k)}</Key><Size>${objects.get(k).length}</Size>` +
                `<LastModified>2026-08-24T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag>` +
                `<StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join("") +
          `</ListBucketResult>`,
      );
    }

    if (req.method === "PUT" && key) {
      calls.put++;
      objects.set(key, body);
      res.writeHead(200, { ETag: '"x"' });
      return res.end();
    }

    if (req.method === "GET" && key) {
      calls.get++;
      const data = objects.get(key);
      if (!data) {
        res.writeHead(404, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`);
      }
      res.writeHead(200, { "content-length": String(data.length) });
      return res.end(data);
    }

    res.writeHead(400);
    res.end();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}
