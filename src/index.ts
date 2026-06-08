import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config';
import { connectDB, disconnectDB } from './config/database';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { wsService } from './services/websocket.service';
import routes from './routes';

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

async function start() {
  await connectDB();
  wsService.init(server);

  server.listen(config.port, () => {
    console.log(`\n=======================================`);
    console.log(`  智慧疫苗冷链与接种调度系统`);
    console.log(`  API Server: http://localhost:${config.port}`);
    console.log(`  WebSocket: ws://localhost:${config.port}/ws`);
    console.log(`  Health: http://localhost:${config.port}/api/health`);
    console.log(`=======================================\n`);
  });
}

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await disconnectDB();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await disconnectDB();
  process.exit(0);
});

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
