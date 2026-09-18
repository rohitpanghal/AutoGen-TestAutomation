import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { isAllowedOrigin } from './cors.js';
import generateRoutes from './routes/generate.js';
import recordingRoutes from './routes/recordings.js';
import healRoutes from './routes/heal.js';
import jobRoutes from './routes/jobs.js';
import testRoutes from './routes/tests.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
});

app.setErrorHandler((err, request, reply) => {
  request.log.error(err);
  const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
  reply.status(status).send({ error: err.name || 'Error', message: err.message });
});

app.setNotFoundHandler((request, reply) => {
  reply.status(404).send({ error: 'Not found', message: `${request.method} ${request.url}` });
});

app.get('/health', async () => ({ ok: true }));

await app.register(generateRoutes);
await app.register(recordingRoutes);
await app.register(healRoutes);
await app.register(jobRoutes);
await app.register(testRoutes);

const port = Number(process.env.PORT) || 4000;
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
