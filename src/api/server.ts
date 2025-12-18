import express from 'express';
import reportRoutes from '../reports/report-routes';
import { Logger } from '../utils/logger';

export class ApiServer {
  private app: express.Application;
  private port: number;

  constructor(port: number = 3001) {
    this.app = express();
    this.port = port;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // CORS middleware
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });

    // Request logging
    this.app.use((req, _res, next) => {
      Logger.info(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'audit-sales-api',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Reports routes
    this.app.use('/reports', reportRoutes);

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Not found',
        path: req.originalUrl
      });
    });

    // Error handler
    this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      Logger.error('API Error', err);
      res.status(500).json({
        error: 'Internal server error',
        message: err.message
      });
    });
  }

  public start(): void {
    this.app.listen(this.port, '0.0.0.0', () => {
      Logger.info(`API server running on port ${this.port}`);
      Logger.info(`Reports available at:`);
      Logger.info(`  Daily JPG: http://localhost:${this.port}/reports/daily/jpg?date=YYYY-MM-DD`);
      Logger.info(`  Monthly Excel: http://localhost:${this.port}/reports/monthly/excel?month=YYYY-MM`);
    });
  }

  public getApp(): express.Application {
    return this.app;
  }
}