import http from 'http';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const INITIAL_MENU_FILE = path.join(__dirname, 'data', 'initialMenu.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const adminSessions = new Map();
const loginAttempts = new Map();

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Initial discount coupons
const INITIAL_COUPONS = [
  { code: 'TASTY20', type: 'percent', value: 20, description: '20% discount on entire meal' },
  { code: 'FREEDEL', type: 'flat_delivery', value: 3.99, description: 'Free delivery coupon' },
  { code: 'SAVE10', type: 'flat', value: 10.0, minOrder: 35, description: '$10 off orders above $35' },
  { code: 'BITE50', type: 'percent', value: 50, maxDiscount: 15, description: '50% off up to $15' }
];

let db = null;

// Determine Local Network IPv4 Address
function getLocalNetworkIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function requiresAdminAuth(pathname, method) {
  return (
    (pathname === '/api/admin/stats' && method === 'GET') ||
    (pathname === '/api/admin/logout' && method === 'POST') ||
    (pathname === '/api/orders' && method === 'GET') ||
    (pathname === '/api/menu' && method === 'POST') ||
    (/^\/api\/menu\/[^/]+$/.test(pathname) && ['PUT', 'DELETE'].includes(method)) ||
    (/^\/api\/orders\/[^/]+\/status$/.test(pathname) && method === 'PATCH')
  );
}

function isAdminAuthorized(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match) return false;

  const expiresAt = adminSessions.get(match[1]);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(match[1]);
    return false;
  }
  return true;
}

function getPublicOrder(order) {
  return {
    id: order.id,
    items: order.items.map(item => ({
      name: item.name,
      quantity: item.quantity,
      selectedSize: item.selectedSize,
      itemTotal: item.itemTotal
    })),
    total: order.total,
    status: order.status,
    createdAt: order.createdAt,
    estimatedDeliveryMinutes: order.estimatedDeliveryMinutes,
    driver: order.driver ? {
      name: order.driver.name,
      vehicle: order.driver.vehicle,
      rating: order.driver.rating
    } : null
  };
}

// Database initialization
async function initDatabase() {
  if (db) return db;
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    console.log(`[DB] Loaded existing database with ${db.menu.length} menu items and ${db.orders.length} orders.`);
  } catch (err) {
    let initialMenu = [];
    try {
      const rawInitial = await fs.readFile(INITIAL_MENU_FILE, 'utf8');
      initialMenu = JSON.parse(rawInitial);
    } catch (e) {
      initialMenu = [];
    }

    db = {
      menu: initialMenu,
      orders: [
        {
          id: 'ORD-5401',
          customer: {
            name: 'Sarah Connor',
            email: 'sarah.c@example.com',
            phone: '+1 (555) 789-0123',
            address: '840 Sunset Boulevard, Suite 12B, Los Angeles'
          },
          items: [
            {
              id: 'item-1',
              name: 'Truffle Smash Double Burger',
              price: 14.99,
              quantity: 2,
              selectedSize: 'Large (Triple Patty)',
              selectedAddons: ['Extra Truffle Aioli', 'Crispy Smoked Bacon'],
              itemTotal: 39.48
            },
            {
              id: 'item-9',
              name: 'Mango Passion Fruit Craft Boba',
              price: 6.25,
              quantity: 1,
              selectedSize: null,
              selectedAddons: [],
              itemTotal: 6.25
            }
          ],
          subtotal: 45.73,
          tax: 3.65,
          deliveryFee: 3.99,
          discount: 9.15,
          couponCode: 'TASTY20',
          total: 44.22,
          paymentMethod: 'Credit Card (Simulated)',
          paymentStatus: 'Paid',
          status: 'Out for Delivery',
          notes: 'Please buzz code #4492 on intercom',
          createdAt: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
          estimatedDeliveryMinutes: 8,
          driver: {
            name: 'Carlos Mendez',
            phone: '+1 (555) 321-7654',
            vehicle: 'Honda Forza Scooter (Blue)',
            rating: 4.95
          }
        }
      ],
      coupons: INITIAL_COUPONS
    };
    await saveDatabase();
    console.log(`[DB] Created fresh database with ${db.menu.length} menu items and sample order.`);
  }
  return db;
}

async function saveDatabase() {
  const tempPath = `${DB_FILE}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tempPath, DB_FILE);
}

// Request body parser helper
function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON responses with universal CORS
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  });
  res.end(JSON.stringify(data));
}

// Main HTTP request listener
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // Detect public host behind reverse proxy or direct
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const isPublicDomain = Boolean(rawHost && !rawHost.startsWith('localhost') && !rawHost.startsWith('127.0.0.1'));
  const currentPublicOrigin = `${proto}://${rawHost}`;

  const parsedUrl = new URL(req.url, currentPublicOrigin);
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;

  // Make sure database is loaded
  await initDatabase();

  // =====================
  // REST API ENDPOINTS
  // =====================
  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        if (ADMIN_PASSWORD.length < 16) {
          return sendJson(res, 503, { success: false, error: 'Admin access is not configured. Set ADMIN_PASSWORD to at least 16 characters.' });
        }

        const clientIp = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        for (const [ip, state] of loginAttempts) {
          if (now - state.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS && state.blockedUntil <= now) {
            loginAttempts.delete(ip);
          }
        }
        for (const [token, expiresAt] of adminSessions) {
          if (expiresAt <= now) adminSessions.delete(token);
        }
        let attempt = loginAttempts.get(clientIp);
        if (!attempt || now - attempt.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS) {
          attempt = { count: 0, windowStartedAt: now, blockedUntil: 0 };
          loginAttempts.set(clientIp, attempt);
        }
        if (attempt.blockedUntil > now) {
          return sendJson(res, 429, { success: false, error: 'Too many sign-in attempts. Try again later.' });
        }

        const body = await getRequestBody(req);
        const suppliedPassword = typeof body?.password === 'string' ? Buffer.from(body.password) : Buffer.alloc(0);
        const configuredPassword = Buffer.from(ADMIN_PASSWORD);
        const passwordMatches = suppliedPassword.length === configuredPassword.length &&
          timingSafeEqual(suppliedPassword, configuredPassword);

        if (!passwordMatches) {
          attempt.count += 1;
          if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
            attempt.blockedUntil = now + LOGIN_ATTEMPT_WINDOW_MS;
          }
          return sendJson(res, 401, { success: false, error: 'Incorrect admin password.' });
        }

        loginAttempts.delete(clientIp);
        const token = randomBytes(32).toString('base64url');
        adminSessions.set(token, now + ADMIN_SESSION_TTL_MS);
        return sendJson(res, 200, { success: true, token, expiresIn: ADMIN_SESSION_TTL_MS });
      }

      if (requiresAdminAuth(pathname, req.method) && !isAdminAuthorized(req)) {
        return sendJson(res, 401, { success: false, error: 'Admin sign-in required.' });
      }

      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        const token = (req.headers.authorization || '').slice('Bearer '.length);
        adminSessions.delete(token);
        return sendJson(res, 200, { success: true });
      }

      // 1. Network Info (Provides external shareable URL)
      if (pathname === '/api/network-info' && req.method === 'GET') {
        const localIp = getLocalNetworkIp();
        const effectiveExternalUrl = isPublicDomain ? currentPublicOrigin : `http://${localIp}:${PORT}`;

        return sendJson(res, 200, {
          success: true,
          isPublicDomain,
          localIp,
          port: PORT,
          localUrl: `http://localhost:${PORT}`,
          externalUrl: effectiveExternalUrl,
          trackingUrlTemplate: `${effectiveExternalUrl}/?track={orderId}`
        });
      }

      // 2. Health check
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'Online Food Order System API',
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        });
      }

      // 3. GET /api/menu
      if (pathname === '/api/menu' && req.method === 'GET') {
        const category = searchParams.get('category');
        const search = searchParams.get('search');
        const vegOnly = searchParams.get('vegOnly') === 'true';

        let items = [...db.menu];

        if (category && category !== 'All') {
          items = items.filter(i => (i.category || '').toLowerCase() === category.toLowerCase());
        }

        if (vegOnly) {
          items = items.filter(i => i.isVeg === true);
        }

        if (search) {
          const q = search.toLowerCase();
          items = items.filter(i =>
            (i.name && i.name.toLowerCase().includes(q)) ||
            (i.description && i.description.toLowerCase().includes(q)) ||
            (Array.isArray(i.tags) && i.tags.some(t => t.toLowerCase().includes(q)))
          );
        }

        return sendJson(res, 200, { success: true, count: items.length, data: items });
      }

      // 4. GET /api/menu/:id
      const menuIdMatch = pathname.match(/^\/api\/menu\/([^/]+)$/);
      if (menuIdMatch && req.method === 'GET') {
        const id = menuIdMatch[1];
        const item = db.menu.find(m => m.id === id);
        if (!item) return sendJson(res, 404, { success: false, error: 'Item not found' });
        return sendJson(res, 200, { success: true, data: item });
      }

      // 5. POST /api/menu (Admin add)
      if (pathname === '/api/menu' && req.method === 'POST') {
        const body = await getRequestBody(req);
        if (!body.name || !body.category || body.price === undefined) {
          return sendJson(res, 400, { success: false, error: 'Name, category, and price are required' });
        }
        const newItem = {
          id: `item-${Date.now()}`,
          name: body.name,
          category: body.category,
          price: Number(body.price),
          description: body.description || 'Freshly prepared specialty dish.',
          image: body.image || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=80',
          isVeg: Boolean(body.isVeg),
          rating: 5.0,
          prepTime: body.prepTime || '15-20 min',
          calories: body.calories || '550 kcal',
          tags: Array.isArray(body.tags) ? body.tags : ['Chef Special'],
          options: body.options || {}
        };
        db.menu.unshift(newItem);
        await saveDatabase();
        return sendJson(res, 201, { success: true, data: newItem });
      }

      // 6. PUT /api/menu/:id (Admin update)
      if (menuIdMatch && req.method === 'PUT') {
        const id = menuIdMatch[1];
        const body = await getRequestBody(req);
        const idx = db.menu.findIndex(m => m.id === id);
        if (idx === -1) return sendJson(res, 404, { success: false, error: 'Item not found' });
        db.menu[idx] = { ...db.menu[idx], ...body };
        if (body.price !== undefined) db.menu[idx].price = Number(body.price);
        await saveDatabase();
        return sendJson(res, 200, { success: true, data: db.menu[idx] });
      }

      // 7. DELETE /api/menu/:id (Admin delete)
      if (menuIdMatch && req.method === 'DELETE') {
        const id = menuIdMatch[1];
        const idx = db.menu.findIndex(m => m.id === id);
        if (idx === -1) return sendJson(res, 404, { success: false, error: 'Item not found' });
        db.menu.splice(idx, 1);
        await saveDatabase();
        return sendJson(res, 200, { success: true, message: 'Item deleted successfully' });
      }

      // 8. GET /api/orders (List all orders)
      if (pathname === '/api/orders' && req.method === 'GET') {
        return sendJson(res, 200, { success: true, count: db.orders.length, data: db.orders });
      }

      // 9. GET /api/orders/:id (Live Tracking endpoint)
      const orderIdMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (orderIdMatch && req.method === 'GET') {
        const id = orderIdMatch[1];
        const order = db.orders.find(o => o.id === id);
        if (!order) return sendJson(res, 404, { success: false, error: `Order ${id} not found` });
        return sendJson(res, 200, { success: true, data: getPublicOrder(order) });
      }

      // 10. POST /api/orders (Create order)
      if (pathname === '/api/orders' && req.method === 'POST') {
        const body = await getRequestBody(req);
        const { customer, items, subtotal, tax, deliveryFee, discount, couponCode, total, paymentMethod, notes } = body;

        if (!customer || !customer.name || !customer.address || !customer.phone) {
          return sendJson(res, 400, { success: false, error: 'Customer name, phone, and delivery address are required' });
        }
        if (!Array.isArray(items) || items.length === 0) {
          return sendJson(res, 400, { success: false, error: 'Cart cannot be empty' });
        }

        const newOrderId = `ORD-${randomUUID()}`;
        const localIp = getLocalNetworkIp();

        const trackingBase = isPublicDomain ? currentPublicOrigin : `http://${localIp}:${PORT}`;

        const newOrder = {
          id: newOrderId,
          customer: {
            name: customer.name.trim(),
            email: (customer.email || '').trim(),
            phone: customer.phone.trim(),
            address: customer.address.trim()
          },
          items: items.map(item => ({
            id: item.id,
            name: item.name,
            price: Number(item.price),
            quantity: Number(item.quantity) || 1,
            selectedSize: item.selectedSize || null,
            selectedAddons: Array.isArray(item.selectedAddons) ? item.selectedAddons : [],
            itemTotal: Number(item.itemTotal) || (Number(item.price) * (Number(item.quantity) || 1))
          })),
          subtotal: Number(subtotal) || 0,
          tax: Number(tax) || 0,
          deliveryFee: Number(deliveryFee) || 0,
          discount: Number(discount) || 0,
          couponCode: couponCode || null,
          total: Number(total) || 0,
          paymentMethod: paymentMethod || 'Cash on Delivery',
          paymentStatus: paymentMethod === 'Cash on Delivery' ? 'Pending' : 'Paid',
          status: 'Placed',
          notes: notes || '',
          createdAt: new Date().toISOString(),
          estimatedDeliveryMinutes: 30,
          shareableTrackingUrl: `${trackingBase}/?track=${newOrderId}`,
          driver: {
            name: 'Marcus Vance',
            phone: '+1 (555) 321-9876',
            vehicle: 'Eco Delivery E-Bike',
            rating: 4.9
          }
        };

        db.orders.unshift(newOrder);
        await saveDatabase();

        console.log(`[ORDER] Created new order ${newOrderId} for ${customer.name} - Total: $${newOrder.total}`);
        return sendJson(res, 201, { success: true, data: newOrder });
      }

      // 11. PATCH /api/orders/:id/status (Update order status)
      const orderStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
      if (orderStatusMatch && req.method === 'PATCH') {
        const id = orderStatusMatch[1];
        const body = await getRequestBody(req);
        const { status } = body;

        const allowedStatuses = ['Placed', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];
        if (!allowedStatuses.includes(status)) {
          return sendJson(res, 400, { success: false, error: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` });
        }

        const order = db.orders.find(o => o.id === id);
        if (!order) return sendJson(res, 404, { success: false, error: 'Order not found' });

        order.status = status;
        order.updatedAt = new Date().toISOString();

        if (status === 'Delivered') {
          order.estimatedDeliveryMinutes = 0;
          if (order.paymentStatus === 'Pending') order.paymentStatus = 'Paid';
        } else if (status === 'Out for Delivery') {
          order.estimatedDeliveryMinutes = 10;
        } else if (status === 'Preparing') {
          order.estimatedDeliveryMinutes = 20;
        }

        await saveDatabase();
        console.log(`[ORDER STATUS] Order ${id} updated to status "${status}"`);
        return sendJson(res, 200, { success: true, data: order });
      }

      // 12. POST /api/coupons/validate
      if (pathname === '/api/coupons/validate' && req.method === 'POST') {
        const body = await getRequestBody(req);
        const { code, subtotal } = body;
        if (!code) return sendJson(res, 400, { valid: false, message: 'Promo code required' });

        const coupon = (db.coupons || []).find(c => c.code.toUpperCase() === code.trim().toUpperCase());
        if (!coupon) {
          return sendJson(res, 200, { valid: false, message: 'Invalid or expired coupon code' });
        }

        const orderSubtotal = Number(subtotal) || 0;
        if (coupon.minOrder && orderSubtotal < coupon.minOrder) {
          return sendJson(res, 200, { valid: false, message: `Minimum order of $${coupon.minOrder.toFixed(2)} required for code ${coupon.code}` });
        }

        let discount = 0;
        let freeDelivery = false;
        if (coupon.type === 'percent') {
          discount = (orderSubtotal * coupon.value) / 100;
          if (coupon.maxDiscount && discount > coupon.maxDiscount) {
            discount = coupon.maxDiscount;
          }
        } else if (coupon.type === 'flat') {
          discount = coupon.value;
        } else if (coupon.type === 'flat_delivery') {
          freeDelivery = true;
          discount = coupon.value;
        }

        return sendJson(res, 200, {
          valid: true,
          code: coupon.code,
          discount: Number(discount.toFixed(2)),
          freeDelivery,
          description: coupon.description
        });
      }

      // 13. GET /api/admin/stats
      if (pathname === '/api/admin/stats' && req.method === 'GET') {
        const totalOrders = db.orders.length;
        const totalRevenue = db.orders
          .filter(o => o.status !== 'Cancelled')
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0);
        const activeOrders = db.orders.filter(o => o.status !== 'Delivered' && o.status !== 'Cancelled').length;
        const totalMenuItems = db.menu.length;

        return sendJson(res, 200, {
          success: true,
          data: {
            totalOrders,
            totalRevenue: Number(totalRevenue.toFixed(2)),
            activeOrders,
            totalMenuItems
          }
        });
      }

      return sendJson(res, 404, { success: false, error: 'Endpoint not found' });
    } catch (apiErr) {
      console.error(`[API ERROR] ${apiErr.message}`);
      return sendJson(res, 500, { success: false, error: apiErr.message });
    }
  }

  // =====================
  // STATIC FILE SERVING
  // =====================
  let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, safePath);

  try {
    if (existsSync(filePath)) {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        const stream = createReadStream(filePath);
        return stream.pipe(res);
      }
    }

    // SPA Fallback: if not found, serve index.html
    const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
    if (existsSync(fallbackPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      const stream = createReadStream(fallbackPath);
      return stream.pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error: ' + err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalNetworkIp();
  console.log('===========================================================');
  console.log('ONLINE FOOD ORDER SYSTEM - FULL STACK SERVER STARTED');
  console.log('===========================================================');
  console.log(`Local Machine:            http://localhost:${PORT}`);
  console.log(`External / Other Devices: http://${localIp}:${PORT}`);
  console.log(`Sample Tracking Link:     http://${localIp}:${PORT}/?track=ORD-5401`);
  console.log('===========================================================');
});
