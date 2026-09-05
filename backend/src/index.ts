import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import generateRoutes from './routes/generate.js';
import recordingRoutes from './routes/recordings.js';
import healRoutes from './routes/heal.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('http://localhost')) {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed'), false);
  },
});

app.get('/health', async () => ({ ok: true }));

await app.register(generateRoutes);
await app.register(recordingRoutes);
await app.register(healRoutes);

const port = Number(process.env.PORT) || 4000;
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
