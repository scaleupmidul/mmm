import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { CONNECTOR_FILES, EXTENSION_FILES } from '../data/connectorFileContents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MT5Payload {
  symbol: string;
  tick?: {
    bid: number;
    ask: number;
    spread: number;
    time: number;
    iso_time?: string;
  };
  candles_m5?: any[];
  candles_h1?: any[];
  account?: {
    login?: number;
    server?: string;
    company?: string;
    trade_mode?: number;
    currency?: string;
    balance?: number;
    equity?: number;
    leverage?: number;
  };
  terminal?: {
    connected?: boolean;
    path?: string;
    name?: string;
    build?: number;
  };
  available_symbols?: any[];
  indicators?: {
    ema20?: number;
    ema200?: number;
    ema200_slope?: number;
    rsi14?: number;
  };
  strategy?: {
    buy?: any;
    sell?: any;
  };
  client_timestamp?: string;
  token?: string;
}

// In-memory state store for real MT5 feed
let latestMT5Data: MT5Payload | null = null;
let lastReceivedTimestamp: number = 0;
let userModeOverride: 'AUTO' | 'DEMO' | 'DISCONNECTED' = 'AUTO';

export function createApiApp() {
  const app = express();

  // Support JSON payload up to 10MB (for historical candles)
  app.use(express.json({ limit: '10mb' }));

  // CORS headers so local Python connector can push from any origin
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-GEP5-Token');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Health check
  app.get(['/api/health', '/health'], (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'GEP-5 Market Data API',
      timestamp: new Date().toISOString(),
    });
  });

  // Connector Push Endpoint: Python backend on Windows pushes MT5 data here
  app.post(['/api/connector/push', '/connector/push'], (req: Request, res: Response) => {
    const data: MT5Payload = req.body;
    if (!data || !data.symbol) {
      return res.status(400).json({ error: 'Missing symbol or invalid MT5 payload' });
    }

    latestMT5Data = data;
    lastReceivedTimestamp = Date.now();
    userModeOverride = 'AUTO';

    return res.json({
      success: true,
      received_at: lastReceivedTimestamp,
      symbol: data.symbol,
      m5_count: data.candles_m5?.length || 0,
      h1_count: data.candles_h1?.length || 0,
      tick: data.tick,
    });
  });

  // Latest Feed Data Endpoint: Polled by React frontend
  app.get(['/api/connector/latest', '/connector/latest'], (req: Request, res: Response) => {
    const now = Date.now();
    const ageSeconds = lastReceivedTimestamp > 0 ? Math.floor((now - lastReceivedTimestamp) / 1000) : null;

    let computedStatus: 'LIVE' | 'STALE' | 'DISCONNECTED' | 'DEMO' = 'DISCONNECTED';

    if (userModeOverride === 'DEMO') {
      computedStatus = 'DEMO';
    } else if (userModeOverride === 'DISCONNECTED') {
      computedStatus = 'DISCONNECTED';
    } else if (lastReceivedTimestamp > 0) {
      if (ageSeconds !== null && ageSeconds <= 20) {
        computedStatus = 'LIVE';
      } else if (ageSeconds !== null && ageSeconds <= 90) {
        computedStatus = 'STALE';
      } else {
        computedStatus = 'DISCONNECTED';
      }
    } else {
      computedStatus = 'DISCONNECTED';
    }

    if (computedStatus === 'DISCONNECTED' && userModeOverride !== 'DEMO') {
      return res.json({
        status: 'DISCONNECTED',
        is_live: false,
        message: 'No active MT5 feed received from local connector within the last 90 seconds.',
        last_received_at: lastReceivedTimestamp || null,
        age_seconds: ageSeconds,
        data: null,
      });
    }

    return res.json({
      status: computedStatus,
      is_live: computedStatus === 'LIVE',
      last_received_at: lastReceivedTimestamp,
      age_seconds: ageSeconds,
      data: latestMT5Data,
    });
  });

  // Status Endpoint
  app.get(['/api/connector/status', '/connector/status'], (req: Request, res: Response) => {
    const isLive = lastReceivedTimestamp > 0 && Date.now() - lastReceivedTimestamp <= 20000;
    res.json({
      online: isLive || userModeOverride === 'DEMO',
      status: isLive ? 'LIVE' : userModeOverride === 'DEMO' ? 'DEMO' : 'DISCONNECTED',
      symbol: latestMT5Data?.symbol || 'XAUUSDm',
      last_tick: latestMT5Data?.tick || null,
      age_seconds: lastReceivedTimestamp > 0 ? Math.floor((Date.now() - lastReceivedTimestamp) / 1000) : null,
      mode: userModeOverride,
    });
  });

  // Mode Override
  app.post(['/api/connector/mode', '/connector/mode'], (req: Request, res: Response) => {
    const { mode } = req.body;
    if (mode === 'DEMO' || mode === 'AUTO' || mode === 'DISCONNECTED') {
      userModeOverride = mode;
      return res.json({ success: true, mode: userModeOverride });
    }
    return res.status(400).json({ error: 'Invalid mode. Use DEMO, AUTO, or DISCONNECTED.' });
  });

  // Connect Trigger
  app.post(['/api/connector/connect', '/connector/connect'], (req: Request, res: Response) => {
    userModeOverride = 'AUTO';
    return res.json({ success: true, status: 'AUTO', message: 'Connecting to MT5 feed...' });
  });

  // Disconnect Trigger
  app.post(['/api/connector/disconnect', '/connector/disconnect'], (req: Request, res: Response) => {
    userModeOverride = 'DISCONNECTED';
    latestMT5Data = null;
    lastReceivedTimestamp = 0;
    return res.json({ success: true, status: 'DISCONNECTED', message: 'Feed disconnected' });
  });

  // Download connector scripts directly
  app.get(['/api/connector/download/:file', '/connector/download/:file'], (req: Request, res: Response) => {
    const filename = req.params.file;
    const allowedFilenames = new Set([
      'gep5_connector.py',
      'test_stage1_connection.py',
      'run_connector.bat',
      'run_stage1_test.bat',
      'requirements.txt',
      'README.md',
      'GEP5_Strategy_Engine.mq5',
      'gep5_mt5_connector.zip',
      'manifest.json',
      'popup.html',
      'popup.js',
      'background.js',
    ]);

    if (!allowedFilenames.has(filename)) {
      return res.status(403).json({ error: 'Forbidden or unrecognized filename' });
    }

    const candidatePaths = [
      path.resolve(__dirname, '..', '..', 'public', 'connector', filename),
      path.resolve(process.cwd(), 'public', 'connector', filename),
      path.resolve(process.cwd(), 'connector', filename),
      path.resolve(__dirname, '..', '..', 'connector', filename),
      path.resolve(process.cwd(), 'public', 'extension', filename),
      path.resolve(process.cwd(), 'extension', filename),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (filename.endsWith('.py')) {
          res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
        } else if (filename.endsWith('.bat')) {
          res.setHeader('Content-Type', 'application/x-bat; charset=utf-8');
        } else if (filename.endsWith('.zip')) {
          res.setHeader('Content-Type', 'application/zip');
        } else if (filename.endsWith('.mq5')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
        return res.sendFile(p);
      }
    }

    // Embedded fallback
    const content = CONNECTOR_FILES[filename] || EXTENSION_FILES[filename];
    if (content) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(content);
    }

    return res.status(404).json({ error: `File '${filename}' not found on server.` });
  });

  // Direct ZIP download route
  app.get(['/api/connector/download-zip', '/connector/download-zip'], (req: Request, res: Response) => {
    const zipPaths = [
      path.resolve(process.cwd(), 'public', 'connector', 'gep5_mt5_connector.zip'),
      path.resolve(process.cwd(), 'connector', 'gep5_mt5_connector.zip'),
    ];

    for (const p of zipPaths) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Disposition', 'attachment; filename="gep5_mt5_connector.zip"');
        res.setHeader('Content-Type', 'application/zip');
        return res.sendFile(p);
      }
    }

    return res.status(404).json({ error: 'Connector ZIP archive not found on server.' });
  });

  return app;
}
