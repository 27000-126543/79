import WebSocket, { Server } from 'ws';
import http from 'http';

interface ClientConnection {
  ws: WebSocket;
  userId: string;
  roles: string[];
  region?: string;
}

class WebSocketService {
  private wss: Server | null = null;
  private clients: Map<string, ClientConnection> = new Map();

  init(server: http.Server) {
    this.wss = new Server({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const userId = url.searchParams.get('userId') || 'anonymous';
      const roles = (url.searchParams.get('roles') || '').split(',').filter(Boolean);
      const region = url.searchParams.get('region') || undefined;
      const clientId = `${userId}-${Date.now()}`;

      this.clients.set(clientId, { ws, userId, roles, region });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });

      ws.on('error', () => {
        this.clients.delete(clientId);
      });

      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket connected' }));
    });

    console.log('✓ WebSocket service initialized');
  }

  broadcastToUser(userId: string, type: string, data: unknown) {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    this.clients.forEach((client) => {
      if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  broadcastToRoles(roles: string[], type: string, data: unknown, region?: string) {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    this.clients.forEach((client) => {
      const roleMatch = client.roles.some((r) => roles.includes(r));
      const regionMatch = !region || client.region === region;
      if (roleMatch && regionMatch && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  broadcastAll(type: string, data: unknown) {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    this.clients.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  sendStatusChange(entityType: string, entityId: string, status: string, data: unknown) {
    this.broadcastAll('status_change', {
      entityType,
      entityId,
      status,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}

export const wsService = new WebSocketService();
