/** Creates the Node HTTP server and centralizes asynchronous route error handling. */
import http, { type Server } from "node:http";
import { parse } from "node:url";
import { handleRouteError, routeRequest } from "./routes.js";
import type { ServerDependencies } from "./types.js";
import type { AntiBanManager } from "../anti-ban/index.js";

/** Build an unbound server so tests and the CLI can choose the listen address. */
export function createServer(dependencies: ServerDependencies): Server {
  const { client, apiKeys, debug, antiBan } = dependencies;

  return http.createServer(async (request, response) => {
    try {
      const parsedUrl = parse(request.url || '', true);
      const pathname = parsedUrl.pathname || '';

      // Admin route for anti-ban configuration
      if (pathname === '/admin/antiban' && antiBan) {
        await handleAntiBanAdmin(request, response, antiBan);
        return;
      }

      // Apply anti-ban check if present and path is a completion endpoint
      if (antiBan) {
        const checkResult = await antiBan.check(pathname);
        if (!checkResult.allowed) {
          response.statusCode = checkResult.status || 403;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(checkResult.response));
          return;
        }
      }

      // Route the request
      await routeRequest(request, response, { client, apiKeys, debug });

      // Record completion on success
      if (antiBan && response.statusCode === 200) {
        await antiBan.recordCompletion();
      }
    } catch (error: unknown) {
      handleRouteError(response, error, debug);
    }
  });
}

async function handleAntiBanAdmin(request: http.IncomingMessage, response: http.ServerResponse, antiBan: AntiBanManager) {
  if (request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      config: antiBan.getConfig(),
      status: antiBan.getStatus(),
    }));
    return;
  }
  if (request.method === 'POST') {
    let body = '';
    request.on('data', chunk => body += chunk);
    await new Promise(resolve => request.on('end', resolve));
    try {
      const updates = JSON.parse(body);
      await antiBan.updateConfig(updates);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, config: antiBan.getConfig() }));
    } catch (err) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }
  response.writeHead(405, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Method not allowed' }));
}
