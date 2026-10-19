import { createServer } from 'node:http';
import { routeHealth } from './handlers/health.js';

const port = Number(process.env.BACKEND_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('BACKEND_PORT must be an integer from 1 to 65535');
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const result = routeHealth(request.method ?? '', path);
  response.writeHead(result.statusCode ?? 500, result.headers);
  response.end(result.body);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `Backend health server: http://127.0.0.1:${port}/health\n`,
  );
});
