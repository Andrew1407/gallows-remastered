import { createServer } from 'http';
import { join as joinPath } from 'path';
import { WebSocketServer } from 'ws';
import dgram from 'dgram';
import { createClient } from 'redis';
import DbClient from './dbClient.js';
import { makeStaticHandler } from './static.js';
import { connections } from './strategiesTooling.js';
import { parseComponents } from './env.js';
import envParams from './env.json' assert { type: 'json' };

const { host, port, redis } = envParams;
const { strategy, connection } = parseComponents();

const services = {
  dbClient: undefined,
  http: undefined,
  ws: undefined,
  udp: undefined,
};

const servicesShutdown = {
  udp: () => services.udp.close(),
  ws: () => new Promise(async (res, rej) => {
    services.ws.clients.forEach(c => c.close());
    services.ws.close(e => e ? rej(e) : res());
  }),
  http: () => new Promise((res, rej) => (
    services.http.close(e => e ? rej(e) : res())
  )),
  dbClient: async () => {
    await redisClient.FLUSHALL();
    await redisClient.QUIT();
  },
};

const serviceConnections = {
  [connections.ws]: () => services.ws = new WebSocketServer({
    server: services.http,
    path: '/' + strategy,
  }),
  [connections.udp]: () => {
    services.udp = dgram.createSocket('udp4');
    const udpPort = envParams.udp?.port ?? port + 1;
    const udpHost = envParams.udp?.host ?? host;
    services.udp.bind(udpPort, udpHost);
  },
};

const redisClient = createClient({ url: redis });
await redisClient.connect();
services.dbClient = new DbClient(redisClient);
services.http = createServer();

const shutdown = async () => {
  const forceQuitDelay = 5000;
  setTimeout(process.exit, forceQuitDelay, 1).unref();
  
  try {
    for (const key in servicesShutdown)
      if (services[key]) await servicesShutdown[key]();
    console.log();
    process.exit(0);
  } catch (e) {
    console.error('\n', e);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const strategyPath = joinPath('strategies', strategy, 'services', connection + '.js');
const { handleConnection } = await import('./' + strategyPath);
const serveStatic = makeStaticHandler({ strategy, connection });
serviceConnections[connection]?.();

await handleConnection?.(services, serveStatic);

services.http?.listen(port, host);
