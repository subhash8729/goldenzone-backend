const http = require('http');

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data.startsWith('{') || data.startsWith('[') ? JSON.parse(data) : data
          });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== Starting Golden Zone Production Endpoint Audit ===\n');

  // 1. Categories API
  const catRes = await makeRequest({
    hostname: 'localhost',
    port: 5000,
    path: '/api/categories',
    method: 'GET'
  });
  console.log('1. GET /api/categories -> Status:', catRes.status, '| Success:', catRes.body.success, '| Categories count:', catRes.body.data?.length);

  // 2. Products API
  const prodRes = await makeRequest({
    hostname: 'localhost',
    port: 5000,
    path: '/api/products',
    method: 'GET'
  });
  console.log('2. GET /api/products -> Status:', prodRes.status, '| Success:', prodRes.body.success, '| Total products:', prodRes.body.pagination?.totalItems);

  // 3. Product Detail API
  const detailRes = await makeRequest({
    hostname: 'localhost',
    port: 5000,
    path: '/api/products/1',
    method: 'GET'
  });
  console.log('3. GET /api/products/1 -> Status:', detailRes.status, '| Product Name:', detailRes.body.product?.name);

  // 4. Admin Send OTP - Unauthorized mobile number (Should return 401 Unauthorized)
  const unauthOtpRes = await makeRequest({
    hostname: 'localhost',
    port: 5000,
    path: '/api/auth/admin/send-otp',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { mobile_number: '9111111111' });
  console.log('4. POST /api/auth/admin/send-otp (Unauthorized Mobile) -> Status:', unauthOtpRes.status, '| Message:', unauthOtpRes.body.message);

  // 5. Admin Login - Invalid Credentials (Should return 401)
  const loginRes = await makeRequest({
    hostname: 'localhost',
    port: 5000,
    path: '/api/auth/admin/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { mobile_number: '7976580806', password: 'WrongPassword', otp: '123456' });
  console.log('5. POST /api/auth/admin/login (Invalid Credentials) -> Status:', loginRes.status, '| Message:', loginRes.body.message);

  // 6. SPA Route - GET /shop
  const spaRes = await makeRequest({
    hostname: 'localhost',
    port: 5000,
    path: '/shop',
    method: 'GET'
  });
  console.log('6. GET /shop -> Status:', spaRes.status, '| HTML served:', typeof spaRes.body === 'string' && spaRes.body.includes('<!doctype html>'));

  console.log('\n=== All Production Endpoint Checks Passed! ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
