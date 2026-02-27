// ============================================
// API GATEWAY & ADMIN CONTROL CENTER
// Port: 3000
// ============================================

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SERVICE REGISTRY
// ============================================

interface ServiceConfig {
  name: string;
  url: string;
  enabled: boolean;
  healthEndpoint: string;
  lastHealthCheck?: Date;
  status?: 'healthy' | 'unhealthy' | 'unknown';
}

class ServiceRegistry {
  private services: Map<string, ServiceConfig> = new Map();

  constructor() {
    this.registerServices();
    this.startHealthChecks();
  }

  private registerServices() {
    const serviceConfigs: ServiceConfig[] = [
      {
        name: 'encryption',
        url: process.env.ENCRYPTION_SERVICE_URL || 'http://localhost:3001',
        enabled: true,
        healthEndpoint: '/health'
      },
      {
        name: 'poseidon',
        url: process.env.POSEIDON_SERVICE_URL || 'http://localhost:3002',
        enabled: true,
        healthEndpoint: '/health'
      },
      {
        name: 'note',
        url: process.env.NOTE_SERVICE_URL || 'http://localhost:3003',
        enabled: true,
        healthEndpoint: '/health'
      },
      {
        name: 'btc-bridge',
        url: process.env.BTC_BRIDGE_SERVICE_URL || 'http://localhost:3004',
        enabled: true,
        healthEndpoint: '/health'
      },
      {
        name: 'swap-coordinator',
        url: process.env.SWAP_COORDINATOR_SERVICE_URL || 'http://localhost:3005',
        enabled: true,
        healthEndpoint: '/health'
      },
      {
        name: 'starknet',
        url: process.env.STARKNET_SERVICE_URL || 'http://localhost:3006',
        enabled: true,
        healthEndpoint: '/health'
      }
    ];

    serviceConfigs.forEach(config => {
      this.services.set(config.name, config);
    });
  }

  private async startHealthChecks() {
    setInterval(async () => {
      for (const [name, config] of this.services.entries()) {
        try {
          const response = await axios.get(`${config.url}${config.healthEndpoint}`, {
            timeout: 5000
          });
          config.status = response.status === 200 ? 'healthy' : 'unhealthy';
          config.lastHealthCheck = new Date();
        } catch (error) {
          config.status = 'unhealthy';
          config.lastHealthCheck = new Date();
        }
        this.services.set(name, config);
      }
    }, 30000); // Check every 30 seconds
  }

  getService(name: string): ServiceConfig | undefined {
    return this.services.get(name);
  }

  getAllServices(): ServiceConfig[] {
    return Array.from(this.services.values());
  }

  enableService(name: string): boolean {
    const service = this.services.get(name);
    if (service) {
      service.enabled = true;
      this.services.set(name, service);
      return true;
    }
    return false;
  }

  disableService(name: string): boolean {
    const service = this.services.get(name);
    if (service) {
      service.enabled = false;
      this.services.set(name, service);
      return true;
    }
    return false;
  }

  isServiceHealthy(name: string): boolean {
    const service = this.services.get(name);
    return service?.enabled && service?.status === 'healthy' || false;
  }
}

// ============================================
// REQUEST ROUTER
// ============================================

class RequestRouter {
  private registry: ServiceRegistry;

  constructor(registry: ServiceRegistry) {
    this.registry = registry;
  }

  async proxyRequest(serviceName: string, path: string, method: string, data?: any): Promise<any> {
    const service = this.registry.getService(serviceName);
    
    if (!service) {
      throw new Error(`Service ${serviceName} not found`);
    }

    if (!service.enabled) {
      throw new Error(`Service ${serviceName} is disabled`);
    }

    if (service.status === 'unhealthy') {
      throw new Error(`Service ${serviceName} is unhealthy`);
    }

    try {
      const url = `${service.url}${path}`;
      const config: any = { timeout: 30000 };

      let response;
      switch (method.toUpperCase()) {
        case 'GET':
          response = await axios.get(url, config);
          break;
        case 'POST':
          response = await axios.post(url, data, config);
          break;
        case 'PUT':
          response = await axios.put(url, data, config);
          break;
        case 'DELETE':
          response = await axios.delete(url, config);
          break;
        default:
          throw new Error(`Unsupported method: ${method}`);
      }

      return response.data;
    } catch (error: any) {
      throw new Error(`Proxy error: ${error.message}`);
    }
  }
}

// ============================================
// RATE LIMITING
// ============================================

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '100'),
  message: 'Too many requests from this IP'
});

app.use('/api/', limiter);

// ============================================
// ADMIN MIDDLEWARE
// ============================================

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN || 'admin_secret_token';

  if (adminToken !== expectedToken) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  next();
}

// ============================================
// INITIALIZE
// ============================================

const registry = new ServiceRegistry();
const router = new RequestRouter(registry);

// ============================================
// ADMIN ENDPOINTS
// ============================================

app.get('/admin/services', adminAuth, (req, res) => {
  const services = registry.getAllServices();
  res.json({ services });
});

app.get('/admin/services/:name', adminAuth, (req, res) => {
  const service = registry.getService(req.params.name);
  if (!service) {
    return res.status(404).json({ error: 'Service not found' });
  }
  res.json({ service });
});

app.post('/admin/services/:name/enable', adminAuth, (req, res) => {
  const success = registry.enableService(req.params.name);
  if (success) {
    res.json({ message: `Service ${req.params.name} enabled` });
  } else {
    res.status(404).json({ error: 'Service not found' });
  }
});

app.post('/admin/services/:name/disable', adminAuth, (req, res) => {
  const success = registry.disableService(req.params.name);
  if (success) {
    res.json({ message: `Service ${req.params.name} disabled` });
  } else {
    res.status(404).json({ error: 'Service not found' });
  }
});

// ============================================
// PUBLIC ENDPOINTS - PROXY TO SERVICES
// ============================================

app.get('/health', (req, res) => {
  const services = registry.getAllServices();
  const allHealthy = services.every(s => s.enabled ? s.status === 'healthy' : true);
  
  res.json({
    status: allHealthy ? 'ok' : 'degraded',
    gateway: 'running',
    services: services.map(s => ({
      name: s.name,
      enabled: s.enabled,
      status: s.status,
      lastCheck: s.lastHealthCheck
    })),
    timestamp: Date.now()
  });
});

// Privacy Notes
app.post('/api/notes/generate', async (req, res) => {
  try {
    const result = await router.proxyRequest('note', '/api/notes/generate', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/merkle/root', async (req, res) => {
  try {
    const result = await router.proxyRequest('note', '/api/merkle/root', 'GET');
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/proofs/spend', async (req, res) => {
  try {
    const result = await router.proxyRequest('note', '/api/proofs/spend', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Atomic Swaps
app.post('/api/swaps/initiate', async (req, res) => {
  try {
    const result = await router.proxyRequest('swap-coordinator', '/api/swaps/initiate', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/swaps/lock', async (req, res) => {
  try {
    const result = await router.proxyRequest('swap-coordinator', '/api/swaps/lock', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/swaps/complete', async (req, res) => {
  try {
    const result = await router.proxyRequest('swap-coordinator', '/api/swaps/complete', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/swaps/:swapId', async (req, res) => {
  try {
    const result = await router.proxyRequest('swap-coordinator', `/api/swaps/${req.params.swapId}`, 'GET');
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Bitcoin Bridge
app.post('/api/btc/spv-proof', async (req, res) => {
  try {
    const result = await router.proxyRequest('btc-bridge', '/api/btc/spv-proof', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Starknet Contract
app.post('/api/contract/commit-note', async (req, res) => {
  try {
    const result = await router.proxyRequest('starknet', '/api/contract/commit-note', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contract/initiate-swap', async (req, res) => {
  try {
    const result = await router.proxyRequest('starknet', '/api/contract/initiate-swap', 'POST', req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 API Gateway & Admin Center running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin/services`);
  console.log(`🔑 Set X-Admin-Token header for admin access`);
});

export { ServiceRegistry, RequestRouter };