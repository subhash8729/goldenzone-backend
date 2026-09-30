const http = require('http');
const assert = require('assert');
const app = require('../src/app');

function makeRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runSpaRoutingTests() {
  console.log('======================================================');
  console.log('🧪 GOLDEN ZONE SPA FALLBACK ROUTING AUDIT ON REFRESH');
  console.log('======================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  let passed = 0;
  let failed = 0;

  function test(name, condition, errorDetail = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name} ${errorDetail}`);
      failed++;
    }
  }

  try {
    // ----------------------------------------------------------
    // 1. Customer Frontend Routes on Refresh
    // ----------------------------------------------------------
    console.log('--- 1. Customer Storefront Direct Navigation & Refresh ---');
    const customerRoutes = [
      '/',
      '/shop',
      '/checkout',
      '/orders',
      '/orders/GZ-2026-0001',
      '/profile',
      '/about',
      '/contact',
      '/product/royal-gold-chain'
    ];

    for (const route of customerRoutes) {
      const res = await makeRequest({
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'GET',
        headers: { host: 'goldenzone.in' }
      });
      const isHtml = res.headers['content-type'] && res.headers['content-type'].includes('text/html');
      const isStorefront = res.body.includes('Golden Zone') && res.body.includes('1 GRAM GOLD-PLATED JEWELLERY');
      test(
        `GET ${route} -> 200 Storefront HTML (no Cannot GET / 404)`,
        res.status === 200 && isHtml && isStorefront,
        `Status: ${res.status}, isHtml: ${isHtml}`
      );
    }

    // HEAD request check
    const headRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/shop',
      method: 'HEAD',
      headers: { host: 'goldenzone.in' }
    });
    test('HEAD /shop -> 200 with text/html header', headRes.status === 200 && headRes.headers['content-type']?.includes('text/html'));

    // ----------------------------------------------------------
    // 2. Admin Portal Routes via /admin Path Prefix on Refresh
    // ----------------------------------------------------------
    console.log('\n--- 2. Admin Portal via /admin Path Prefix on Refresh ---');
    const adminPathRoutes = [
      '/admin',
      '/admin/',
      '/admin/login',
      '/admin/orders',
      '/admin/products',
      '/admin/categories',
      '/admin/customers',
      '/admin/payments',
      '/admin/settings',
      '/admin/notes',
      '/admin/account'
    ];

    for (const route of adminPathRoutes) {
      const res = await makeRequest({
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'GET',
        headers: { host: 'goldenzone.in' }
      });
      const isHtml = res.headers['content-type'] && res.headers['content-type'].includes('text/html');
      const isAdminPortal = res.body.includes('Admin Management Portal');
      test(
        `GET ${route} -> 200 Admin Portal HTML`,
        res.status === 200 && isHtml && isAdminPortal,
        `Status: ${res.status}, isAdminPortal: ${isAdminPortal}`
      );
    }

    // ----------------------------------------------------------
    // 3. Admin Portal Routes via Admin Subdomain on Refresh
    // ----------------------------------------------------------
    console.log('\n--- 3. Admin Portal via Subdomain (admin.goldenzone.in) on Refresh ---');
    const adminSubdomainRoutes = [
      '/',
      '/login',
      '/orders',
      '/products',
      '/categories',
      '/customers',
      '/payments',
      '/settings'
    ];

    for (const route of adminSubdomainRoutes) {
      const res = await makeRequest({
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'GET',
        headers: { host: 'admin.goldenzone.in' }
      });
      const isHtml = res.headers['content-type'] && res.headers['content-type'].includes('text/html');
      const isAdminPortal = res.body.includes('Admin Management Portal');
      test(
        `GET ${route} (Host: admin.goldenzone.in) -> 200 Admin Portal HTML`,
        res.status === 200 && isHtml && isAdminPortal,
        `Status: ${res.status}, isAdminPortal: ${isAdminPortal}`
      );
    }

    // Also test admin.localhost
    const adminLocalRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/orders',
      method: 'GET',
      headers: { host: 'admin.localhost:5000' }
    });
    test(
      'GET /orders (Host: admin.localhost:5000) -> 200 Admin Portal HTML',
      adminLocalRes.status === 200 && adminLocalRes.body.includes('Admin Management Portal')
    );

    // ----------------------------------------------------------
    // 4. API Routes Integrity (Must NOT be redirected to HTML!)
    // ----------------------------------------------------------
    console.log('\n--- 4. API Routes Preservation & Error Handling ---');
    // Valid public API
    const catRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/categories',
      method: 'GET'
    });
    test(
      'GET /api/categories -> 200 JSON (Not HTML)',
      catRes.status === 200 && catRes.headers['content-type']?.includes('application/json')
    );

    // Unmatched API endpoint -> must return 404 JSON, NOT index.html!
    const unkApiRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/nonexistent-endpoint-test',
      method: 'GET'
    });
    let parsedJson = null;
    try { parsedJson = JSON.parse(unkApiRes.body); } catch {}
    test(
      'GET /api/nonexistent-endpoint-test -> 404 JSON (NOT index.html)',
      unkApiRes.status === 404 && parsedJson && parsedJson.success === false,
      `Status: ${unkApiRes.status}, Body: ${unkApiRes.body.slice(0, 80)}`
    );

    // ----------------------------------------------------------
    // 5. Static Assets Handling & Missing File Guard
    // ----------------------------------------------------------
    console.log('\n--- 5. Static Assets & File Extension Handling ---');
    // Storefront asset
    const clientAssetRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/assets/index-DlX6imMK.js',
      method: 'GET'
    });
    test(
      'GET /assets/index-DlX6imMK.js -> 200 JavaScript',
      clientAssetRes.status === 200 && clientAssetRes.headers['content-type']?.includes('javascript')
    );

    // Admin asset at root fallback
    const fs = require('fs');
    const path = require('path');
    const adminAssets = fs.readdirSync(path.resolve(__dirname, '../../admin/dist/assets'));
    const adminJs = adminAssets.find(f => f.startsWith('index-') && f.endsWith('.js')) || 'index-ChQlZE6G.js';

    const adminAssetRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: `/assets/${adminJs}`,
      method: 'GET'
    });
    test(
      `GET /assets/${adminJs} -> 200 JavaScript (admin bundle via root fallback)`,
      adminAssetRes.status === 200 && adminAssetRes.headers['content-type']?.includes('javascript')
    );

    // Admin asset with /admin prefix
    const adminPrefixedAssetRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: `/admin/assets/${adminJs}`,
      method: 'GET'
    });
    test(
      `GET /admin/assets/${adminJs} -> 200 JavaScript (admin bundle via /admin prefix)`,
      adminPrefixedAssetRes.status === 200 && adminPrefixedAssetRes.headers['content-type']?.includes('javascript')
    );

    // Nonexistent asset file with extension -> must return 404 JSON (NOT index.html!)
    const missingAssetRes = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/assets/nonexistent-bundle.js',
      method: 'GET'
    });
    test(
      'GET /assets/nonexistent-bundle.js -> 404 (does NOT return HTML to avoid SyntaxError)',
      missingAssetRes.status === 404 && !missingAssetRes.body.includes('<!doctype html>')
    );

  } finally {
    server.close();
  }

  console.log('\n======================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSpaRoutingTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
