const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config/env');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

//setting express trust proxy

// Route imports
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const orderRoutes = require('./routes/orderRoutes');
const customerRoutes = require('./routes/customerRoutes');
const settingRoutes = require('./routes/settingRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const noteRoutes = require('./routes/noteRoutes');

const app = express();
app.set("trust proxy", 1);

const path = require('path');
const fs = require('fs');

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS configuration (Supporting Admin domain & dev origins)
const rawOrigins = [
  config.clientUrl,
  config.adminUrl,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174'
];

const allowedOrigins = rawOrigins
  .flatMap(url => (url ? url.split(',') : []))
  .map(url => url.trim().replace(/\/$/, ''))
  .filter(Boolean);

function isAllowedOrigin(origin) {
  const cleanOrigin = origin.trim().replace(/\/$/, '');
  if (allowedOrigins.includes(cleanOrigin)) return true;

  try {
    const hostname = new URL(cleanOrigin).hostname.toLowerCase();
    const appDomain = String(config.appDomain || '').trim().toLowerCase();
    return Boolean(appDomain) && (hostname === appDomain || hostname.endsWith(`.${appDomain}`));
  } catch {
    return false;
  }
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (config.nodeEnv === 'development' || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not permitted by CORS policy.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-razorpay-event-id', 'x-razorpay-signature']
}));

// Body parsers with raw body capturing for Razorpay Webhook signature verification
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Golden Zone Backend API is healthy & running',
    timestamp: new Date().toISOString()
  });
});

// ==========================================================
// 1. Backend REST API Routes (/api/*)
// ==========================================================
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notes', noteRoutes);

// ==========================================================
// 2. SPA Production Build Serving & Fallback Routing
// ==========================================================
const clientDistPath = path.resolve(__dirname, '../../client/dist');
const adminDistPath = path.resolve(__dirname, '../../admin/dist');

function getRequestHostname(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const hostHeader = (forwardedHost ? forwardedHost.split(',')[0] : req.headers.host) || req.hostname || '';
  return hostHeader.trim().toLowerCase().split(':')[0];
}

function isAdminHost(req) {
  const host = getRequestHostname(req);
  if (!host) return false;
  if (host.startsWith('admin.') || host === 'admin') return true;

  try {
    if (config.adminUrl) {
      const adminUrlHost = new URL(config.adminUrl).hostname.toLowerCase();
      if (adminUrlHost && host === adminUrlHost) {
        return true;
      }
    }
  } catch {}

  return false;
}

function isAdminPath(req) {
  return req.path === '/admin' || req.path.startsWith('/admin/');
}

function isAdminRequest(req) {
  return isAdminHost(req) || isAdminPath(req);
}

// 2.1 Static Asset Serving
// Serve admin assets if requested from admin host/subdomain
if (fs.existsSync(adminDistPath)) {
  app.use((req, res, next) => {
    if (isAdminHost(req)) {
      return express.static(adminDistPath, { maxAge: '1d', index: false })(req, res, next);
    }
    next();
  });

  // Serve static assets for /admin prefix
  app.use('/admin', express.static(adminDistPath, { maxAge: '1d', index: false, redirect: false }));
}

// Serve client static assets
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath, { maxAge: '1d', index: false }));
}

// Fallback: serve admin assets at root (e.g. if loaded via relative asset path or root domain)
if (fs.existsSync(adminDistPath)) {
  app.use(express.static(adminDistPath, { maxAge: '1d', index: false }));
}

// 2.2 SPA Fallback Routing for Non-API GET & HEAD Requests
app.get('*', (req, res, next) => {
  // Never intercept API routes
  if (req.path.startsWith('/api')) {
    return next();
  }

  // Do not serve index.html for missing static files with extensions (e.g., .js, .css, .png, etc.)
  const ext = path.extname(req.path).toLowerCase();
  if (ext && ext !== '.html') {
    return next();
  }

  const targetIsAdmin = isAdminRequest(req);
  const targetDistPath = targetIsAdmin ? adminDistPath : clientDistPath;
  const indexPath = path.join(targetDistPath, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  // Fallback: if targeted build is missing but the other exists, or provide clear status
  if (!targetIsAdmin && fs.existsSync(path.join(clientDistPath, 'index.html'))) {
    return res.sendFile(path.join(clientDistPath, 'index.html'));
  }

  if (targetIsAdmin && fs.existsSync(path.join(clientDistPath, 'index.html')) && !isAdminHost(req)) {
    return res.status(503).type('html').send(`
      <!doctype html>
      <html lang="en">
        <head><title>Admin Dashboard Build Required</title></head>
        <body style="font-family:sans-serif;padding:40px;background:#f8fafc;color:#1e293b;text-align:center;">
          <h2 style="color:#520612;">Golden Zone Admin Portal</h2>
          <p>The admin production build is not yet generated.</p>
          <p>Please run <code>npm run build:admin</code> or <code>npm run build:all</code> to compile admin assets.</p>
        </body>
      </html>
    `);
  }

  // If storefront build is missing
  if (!fs.existsSync(indexPath)) {
    return res.status(503).type('html').send(`
      <!doctype html>
      <html lang="en">
        <head><title>Frontend Build Required</title></head>
        <body style="font-family:sans-serif;padding:40px;background:#1a0105;color:#f3ece1;text-align:center;">
          <h2 style="color:#c5a059;">Golden Zone Storefront</h2>
          <p>The frontend production build is not yet generated.</p>
          <p>Please run <code>npm run build:all</code> to compile frontend assets.</p>
        </body>
      </html>
    `);
  }

  next();
});

// 404 handler for unmatched API routes
app.use(notFoundHandler);

// Centralized error handler
app.use(errorHandler);

module.exports = app;

// If executed directly, run the server entry point
if (require.main === module) {
  require('./server');
}
