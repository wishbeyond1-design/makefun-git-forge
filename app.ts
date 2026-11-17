// The forge's HTTP server: one in-memory store, and a router that hands each
// request to the surface that owns it — REST v3, GraphQL v4, MCP, or git
// smart HTTP. A request that matches nothing answers a JSON 404, and a
// handler that throws answers a JSON 500 without taking the server down:
// the suite probes the server's survival after errors.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { jsonError, newRequestId, parsePath, readBody, sendJson, type Req } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { deriveScenario } from './scenario.ts';
import { Store } from './store.ts';

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store(deriveScenario());
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = newRequestId();
      try {
        const body = await readBody(req);
        const { path, query } = parsePath(req.url);
        const request: Req = {
          method: req.method ?? 'GET',
          path,
          query,
          headers: req.headers,
          body,
          requestId,
        };

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (request.method === 'GET' && request.path === '/healthz') {
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        if (handleRest(request, res, store)) return;
        if (handleGraphQL(request, res, store)) return;
        if (handleMcp(request, res, store)) return;
        if (handleInfoRefs(request, res, store)) return;
        if (handleUploadPack(request, res, store)) return;
        if (handleReceivePack(request, res, store)) return;

        // Everything else, every method: GitHub's 404 body.
        jsonError(res, requestId, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try {
            jsonError(res, requestId, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            // The socket is gone; nothing left to do.
          }
        } else {
          try {
            res.end();
          } catch {
            // The socket is gone; nothing left to do.
          }
        }
      }
    })();
  });
}
