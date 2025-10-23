import { readFile, unlink, writeFile } from 'node:fs/promises';

import compression from 'compression';
import { exec } from 'node:child_process';
import express from 'express';
import http from 'http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

type MockOptions = { status: number; method: 'GET' | 'POST' };

type Mock = {
  response: string;
  options: MockOptions | null;
};

type RecordedRequest = {
  path: string;
  method: string;
  body: any;
};

export class MockScrapi {
  requests: RecordedRequest[] = [];

  private app: express.Application;
  private port: number;
  private server: http.Server;

  private mocks: Record<string, Mock> = {};
  private waiters: ((req: RecordedRequest) => void)[] = [];

  private constructor(onReady: () => void) {
    this.app = express();
    this.port = Math.floor(Math.random() * 2000) + 4000;
    this.server = this.app.listen(this.port, onReady);

    // compression middleware
    this.app.use(async (req: express.Request, res: express.Response, next) => {
      if (req.headers['content-encoding'] === 'zstd') {
        await decompressZstd(req);
        next();
      } else {
        express.json()(req, res, next);
      }
    });

    // Main route handler
    this.app.use(async (req: express.Request, res: express.Response) => {
      const recorded = {
        path: req.path,
        method: req.method,
        body: req.body,
      };

      // console.log(`[Scrapi] Req ${req.method}:`, req.url, Date.now());

      this.requests.push(recorded);
      this.waiters.forEach((waiter) => waiter(recorded));

      const found = Object.entries(this.mocks).find(([path, mock]) => {
        if (mock.options?.method !== req.method) {
          return false;
        }

        return req.path.startsWith(path);
      });

      if (!found) {
        console.log('Unmatched request:', req.method, req.url);
        res.status(404).send('Not Found');
        return;
      }

      const [_, mock] = found;
      res.status(mock.options?.status ?? 200).send(mock.response);
    });
  }

  static async create(): Promise<MockScrapi> {
    return new Promise((resolve) => {
      const scrapi = new MockScrapi(() => resolve(scrapi));
    });
  }

  close() {
    this.server.close();
  }

  getUrlForPath(path: string) {
    return `http://localhost:${this.port}${path}`;
  }

  getServerApi() {
    return `http://localhost:${this.port}`;
  }

  getOtelRequests() {
    return this.requests.filter((req) => req.path.startsWith('/otlp'));
  }

  mock(path: string, response: string, options?: MockOptions) {
    this.mocks[path] = {
      response,
      options: options ?? null,
    };
  }

  waitForNext(filter: (req: RecordedRequest) => boolean) {
    return new Promise<boolean>((resolve) => {
      const myWaiter = (req: RecordedRequest) => {
        if (filter(req)) {
          this.waiters = this.waiters.filter((waiter) => waiter !== myWaiter);

          clearTimeout(timeout);
          resolve(true);
        }
      };

      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== myWaiter);
        resolve(false);
      }, 1000);

      this.waiters.push(myWaiter);
    });
  }
}

async function decompressZstd(req: express.Request): Promise<boolean> {
  return new Promise(async (resolve, _reject) => {
    try {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const buffer = Buffer.concat(chunks);

        // Create temporary files for input and output
        const inputPath = path.join(os.tmpdir(), `zstd-input-${Date.now()}`);
        const outputPath = path.join(os.tmpdir(), `zstd-output-${Date.now()}`);

        try {
          // Write compressed data to temp file
          await writeFile(inputPath, buffer);

          // Decompress using zstd command
          const execPromise = promisify(exec);
          await execPromise(`zstd -d ${inputPath} -o ${outputPath}`);

          // Read decompressed data
          const decompressed = await readFile(outputPath);
          req.body = JSON.parse(decompressed.toString());

          resolve(true);
        } catch (error) {
          console.error('ZSTD decompression failed:', error);
          resolve(false);
        } finally {
          // Clean up temp files
          try {
            await unlink(inputPath);
            await unlink(outputPath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}
