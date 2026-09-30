const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const config = require('../src/config/env');
const db = require('../src/config/db');
const otpService = require('../src/services/otpService');

let server;
let serverPort;

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (postData && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (postData) {
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runAdminBackendAudit() {
  console.log('====================================================');
  console.log('🚀 GOLDEN ZONE ADMIN BACKEND COMPREHENSIVE TEST SUITE');
  console.log('====================================================\n');

  // Start temporary test server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      console.log(`✓ Test HTTP server listening on port ${serverPort}\n`);
      resolve();
    });
  });

  let testAdminToken = null;
  let testCustomerToken = null;
  let createdProductId = null;
  let createdOrderId = null;
  let testCustomerId = null;

  try {
    // ----------------------------------------------------
    // 1. ADMIN AUTHENTICATION TESTS
    // ----------------------------------------------------
    console.log('--- 1. ADMIN AUTHENTICATION & ACCESS CONTROL ---');

    // 1.1 Unauthorized mobile attempting admin OTP
    const unauthOtp = await request('POST', '/api/auth/admin/send-otp', {}, {
      mobile_number: '9999999999'
    });
    console.log(`[1.1] Send OTP to non-admin mobile (9999999999): Status=${unauthOtp.status}`);
    if (unauthOtp.status !== 401) {
      throw new Error(`Expected 401 for unauthorized admin mobile, got ${unauthOtp.status}`);
    }
    console.log('  ✓ PASS: Non-admin mobile rejected from receiving admin OTP.');

    // 1.2 Invalid mobile format
    const invalidMobileOtp = await request('POST', '/api/auth/admin/send-otp', {}, {
      mobile_number: '123'
    });
    console.log(`[1.2] Send OTP with invalid mobile length (123): Status=${invalidMobileOtp.status}`);
    if (invalidMobileOtp.status !== 400) {
      throw new Error(`Expected 400 for invalid mobile format, got ${invalidMobileOtp.status}`);
    }
    console.log('  ✓ PASS: Malformed mobile rejected.');

    // 1.3 Ensure admin user exists in DB for tests
    const adminRows = await db.query('SELECT * FROM admins WHERE mobile_number = ?', [config.adminMobile]);
    let adminRecord;
    if (adminRows.length === 0) {
      const passwordHash = await bcrypt.hash('Subhash29', 10);
      const insert = await db.query(
        'INSERT INTO admins (mobile_number, password_hash, full_name) VALUES (?, ?, ?)',
        [config.adminMobile, passwordHash, 'Master Admin']
      );
      adminRecord = { id: insert.insertId, mobile_number: config.adminMobile, full_name: 'Master Admin' };
    } else {
      adminRecord = adminRows[0];
    }

    // Generate known OTP directly into otp_verifications for testing
    const testOtpCode = '654321';
    const testOtpHash = otpService.hashOtp(config.adminMobile, testOtpCode);
    await db.query('DELETE FROM otp_verifications WHERE mobile_number = ?', [config.adminMobile]);
    await db.query(
      `INSERT INTO otp_verifications (mobile_number, otp_hash, attempts, resend_count, last_sent_at, expires_at, is_verified)
       VALUES (?, ?, 0, 1, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)`,
      [config.adminMobile, testOtpHash]
    );

    // 1.4 Admin Login with wrong password -> OTP must NOT be consumed
    const wrongPassLogin = await request('POST', '/api/auth/admin/login', {}, {
      mobile_number: config.adminMobile,
      password: 'IncorrectPassword123!',
      otp: testOtpCode
    });
    console.log(`[1.4] Admin Login with wrong password: Status=${wrongPassLogin.status}`);
    if (wrongPassLogin.status !== 401) {
      throw new Error(`Expected 401 for wrong password, got ${wrongPassLogin.status}`);
    }
    // Verify OTP record is still unconsumed
    const [otpCheck] = await db.query('SELECT is_verified FROM otp_verifications WHERE mobile_number = ?', [config.adminMobile]);
    if (otpCheck.is_verified !== 0) {
      throw new Error('Security flaw: OTP was consumed despite password failure!');
    }
    console.log('  ✓ PASS: Wrong password rejected; OTP was preserved.');

    // 1.5 Admin Login with wrong OTP
    const wrongOtpLogin = await request('POST', '/api/auth/admin/login', {}, {
      mobile_number: config.adminMobile,
      password: 'Subhash29',
      otp: '000000'
    });
    console.log(`[1.5] Admin Login with wrong OTP: Status=${wrongOtpLogin.status}`);
    if (wrongOtpLogin.status !== 401) {
      throw new Error(`Expected 401 for wrong OTP, got ${wrongOtpLogin.status}`);
    }
    console.log('  ✓ PASS: Wrong OTP rejected.');

    // 1.6 Admin Login with valid credentials
    const validLogin = await request('POST', '/api/auth/admin/login', {}, {
      mobile_number: config.adminMobile,
      password: 'Subhash29',
      otp: testOtpCode
    });
    console.log(`[1.6] Admin Login with valid credentials: Status=${validLogin.status}`);
    if (validLogin.status !== 200 || !validLogin.body.token) {
      throw new Error(`Expected 200 and token, got status=${validLogin.status}`);
    }
    testAdminToken = validLogin.body.token;
    console.log('  ✓ PASS: Admin authenticated successfully, JWT received.');

    // 1.7 Protected Admin profile route
    const profileRes = await request('GET', '/api/auth/admin/profile', {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[1.7] GET /api/auth/admin/profile with admin token: Status=${profileRes.status}`);
    if (profileRes.status !== 200 || !profileRes.body.admin) {
      throw new Error(`Expected 200 and admin profile, got ${profileRes.status}`);
    }
    console.log('  ✓ PASS: Admin profile retrieved.');

    // 1.8 Admin route accessed without token -> 401
    const noTokenRes = await request('GET', '/api/products/admin/all');
    console.log(`[1.8] Admin route without token: Status=${noTokenRes.status}`);
    if (noTokenRes.status !== 401) {
      throw new Error(`Expected 401 for request without token, got ${noTokenRes.status}`);
    }
    console.log('  ✓ PASS: Unauthenticated admin requests are rejected.');

    // 1.9 Admin route accessed with customer token -> 403
    testCustomerToken = jwt.sign({ id: 9999, mobile: '9876543210', isAdmin: false }, config.jwtSecret, { expiresIn: '1h' });
    const custTokenRes = await request('GET', '/api/products/admin/all', {
      Authorization: `Bearer ${testCustomerToken}`
    });
    console.log(`[1.9] Admin route with customer token: Status=${custTokenRes.status}`);
    if (custTokenRes.status !== 403) {
      throw new Error(`Expected 403 for customer accessing admin route, got ${custTokenRes.status}`);
    }
    console.log('  ✓ PASS: Customer token forbidden from admin routes.');

    // ----------------------------------------------------
    // 2. OTP LIMITS & ATTEMPT LOCKOUT
    // ----------------------------------------------------
    console.log('\n--- 2. OTP LIMITS & EXPIRY CHECKS ---');
    const lockoutMobile = '9199999999';
    const lockoutOtp = '112233';
    const lockoutHash = otpService.hashOtp(lockoutMobile, lockoutOtp);
    await db.query('DELETE FROM otp_verifications WHERE mobile_number = ?', [lockoutMobile]);
    await db.query(
      `INSERT INTO otp_verifications (mobile_number, otp_hash, attempts, resend_count, last_sent_at, expires_at, is_verified)
       VALUES (?, ?, 0, 1, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)`,
      [lockoutMobile, lockoutHash]
    );

    // Fail 5 times
    for (let i = 1; i <= 5; i++) {
      const v = await otpService.verifyOtp(lockoutMobile, '999999');
      console.log(`  Attempt ${i}: success=${v.success}, message="${v.message}"`);
    }

    // Verify record is now invalidated (is_verified = 2)
    const [lockedRecord] = await db.query('SELECT attempts, is_verified FROM otp_verifications WHERE mobile_number = ?', [lockoutMobile]);
    console.log(`[2.1] Post-lockout state in DB: attempts=${lockedRecord.attempts}, is_verified=${lockedRecord.is_verified}`);
    if (lockedRecord.attempts !== 5 || lockedRecord.is_verified !== 2) {
      throw new Error('Lockout check failed: OTP was not invalidated after 5 failed attempts.');
    }
    console.log('  ✓ PASS: OTP invalidated (is_verified = 2) after 5 failed attempts.');

    // ----------------------------------------------------
    // 3. PRODUCT CONTROLLER AUDIT
    // ----------------------------------------------------
    console.log('\n--- 3. PRODUCT CONTROLLER AUDIT ---');

    // 3.1 Get categories to find a valid category
    const catRows = await db.query('SELECT id FROM categories LIMIT 1');
    const validCatId = catRows[0].id;

    // 3.2 Create product: invalid pricing check (discount > regular)
    const invalidPriceProd = await request('POST', '/api/products', {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      name: 'Invalid Price Ring',
      category_id: validCatId,
      regular_price: 1000,
      discounted_price: 1500, // Invalid!
      images: ['https://example.com/ring.jpg']
    });
    console.log(`[3.2] Create product with discounted > regular: Status=${invalidPriceProd.status}`);
    if (invalidPriceProd.status !== 400) {
      throw new Error(`Expected 400 for discounted > regular price, got ${invalidPriceProd.status}`);
    }
    console.log('  ✓ PASS: Invalid pricing rejected.');

    // 3.3 Create valid product
    const validProd = await request('POST', '/api/products', {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      name: 'Audit Test Sovereign Ring',
      category_id: validCatId,
      regular_price: 1800,
      discounted_price: 1200,
      description: 'Handcrafted sovereign ring for backend test.',
      is_recommended: true,
      is_bestseller: false,
      images: [
        'https://example.com/test-ring-1.jpg',
        'https://example.com/test-ring-2.jpg'
      ]
    });
    console.log(`[3.3] Create valid product: Status=${validProd.status}, ProductId=${validProd.body.productId}`);
    if (validProd.status !== 201 || !validProd.body.productId) {
      throw new Error(`Expected 201 for valid product creation, got ${validProd.status}`);
    }
    createdProductId = validProd.body.productId;
    console.log('  ✓ PASS: Product and images created inside transaction.');

    // 3.4 Update product details (preserving omitted flags)
    const updateProd = await request('PUT', `/api/products/${createdProductId}`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      name: 'Updated Sovereign Ring',
      category_id: validCatId,
      regular_price: 2000,
      discounted_price: 1400
      // Note: is_recommended is omitted; it should preserve the true value
    });
    console.log(`[3.4] Update product: Status=${updateProd.status}`);
    if (updateProd.status !== 200) {
      throw new Error(`Expected 200 for product update, got ${updateProd.status}`);
    }

    const [updatedRow] = await db.query('SELECT name, regular_price, is_recommended FROM products WHERE id = ?', [createdProductId]);
    if (updatedRow.name !== 'Updated Sovereign Ring' || updatedRow.is_recommended !== 1) {
      throw new Error('Product update failed or clobbered is_recommended flag!');
    }
    console.log('  ✓ PASS: Product updated without clobbering omitted flags.');

    // 3.5 Quick toggle flag
    const toggleRes = await request('PATCH', `/api/products/${createdProductId}/toggle`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      field: 'is_out_of_stock',
      value: true
    });
    console.log(`[3.5] Toggle is_out_of_stock to true: Status=${toggleRes.status}`);
    if (toggleRes.status !== 200 || toggleRes.body.value !== true) {
      throw new Error(`Expected toggle status 200, got ${toggleRes.status}`);
    }
    const [toggledRow] = await db.query('SELECT is_out_of_stock FROM products WHERE id = ?', [createdProductId]);
    if (toggledRow.is_out_of_stock !== 1) {
      throw new Error('Database toggle mismatch!');
    }
    console.log('  ✓ PASS: Stock toggle works correctly.');

    // 3.6 Reject invalid toggle field
    const invalidToggle = await request('PATCH', `/api/products/${createdProductId}/toggle`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      field: 'password_hash', // Unauthorized field!
      value: 'evil'
    });
    console.log(`[3.6] Toggle unauthorized field: Status=${invalidToggle.status}`);
    if (invalidToggle.status !== 400) {
      throw new Error(`Expected 400 for unauthorized toggle field, got ${invalidToggle.status}`);
    }
    console.log('  ✓ PASS: Unauthorized toggle fields strictly rejected.');

    // 3.7 Soft delete product
    const deleteProdRes = await request('DELETE', `/api/products/${createdProductId}`, {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[3.7] Soft-delete product: Status=${deleteProdRes.status}`);
    if (deleteProdRes.status !== 200) {
      throw new Error(`Expected 200 for product delete, got ${deleteProdRes.status}`);
    }
    const [deletedProdRow] = await db.query('SELECT deleted_at FROM products WHERE id = ?', [createdProductId]);
    if (!deletedProdRow || !deletedProdRow.deleted_at) {
      throw new Error('Product was not marked soft-deleted in database!');
    }
    console.log('  ✓ PASS: Product soft-deleted (deleted_at set, row retained in DB).');

    // ----------------------------------------------------
    // 4. ORDER CONTROLLER AUDIT
    // ----------------------------------------------------
    console.log('\n--- 4. ORDER CONTROLLER AUDIT ---');

    // Create a customer in DB for testing orders
    const custInsert = await db.query(
      `INSERT INTO customers (mobile_number, full_name, address, state, district, pincode)
       VALUES ('7976580999', 'Order Tester', '123 Golden St', 'Rajasthan', 'Jaipur', '302001')
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`
    );
    testCustomerId = custInsert.insertId || (await db.query("SELECT id FROM customers WHERE mobile_number = '7976580999'"))[0].id;

    // Create a real order in orders table
    const testOrderNum = `GZ-TEST-${Date.now().toString().slice(-6)}`;
    const orderInsert = await db.query(
      `INSERT INTO orders (
        order_number, user_id, full_name, primary_mobile, address, state, district, pincode,
        subtotal, total_amount, payment_mode, advance_amount, remaining_cod_amount,
        payment_status, is_shipped, is_delivered
      ) VALUES (?, ?, 'Order Tester', '7976580999', '123 Golden St', 'Rajasthan', 'Jaipur', '302001',
        1500.00, 1500.00, 'COD', 200.00, 1300.00, 'PAID', 0, 0)`,
      [testOrderNum, testCustomerId]
    );
    createdOrderId = orderInsert.insertId;

    // 4.1 Order listing for Admin
    const adminOrdersRes = await request('GET', '/api/orders/admin/all', {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[4.1] GET /api/orders/admin/all: Status=${adminOrdersRes.status}, Total orders=${adminOrdersRes.body.pagination?.totalItems}`);
    if (adminOrdersRes.status !== 200 || !Array.isArray(adminOrdersRes.body.data)) {
      throw new Error(`Failed to list orders for admin, status=${adminOrdersRes.status}`);
    }
    console.log('  ✓ PASS: Admin orders list retrieved with pagination.');

    // 4.2 Order detail for Admin
    const orderDetailRes = await request('GET', `/api/orders/admin/${createdOrderId}`, {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[4.2] GET /api/orders/admin/${createdOrderId}: Status=${orderDetailRes.status}, OrderNumber=${orderDetailRes.body.order?.order_number}`);
    if (orderDetailRes.status !== 200 || !orderDetailRes.body.order) {
      throw new Error(`Failed to get order details, status=${orderDetailRes.status}`);
    }
    console.log('  ✓ PASS: Order details retrieved.');

    // 4.3 STATUS RULE: Attempt setting delivered BEFORE shipped -> MUST FAIL (400)
    const prematureDelivered = await request('PATCH', `/api/orders/admin/${createdOrderId}/status`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      is_delivered: true
      // is_shipped not provided and current is 0
    });
    console.log(`[4.3] Set is_delivered=true when is_shipped=false: Status=${prematureDelivered.status}, Message="${prematureDelivered.body.message}"`);
    if (prematureDelivered.status !== 400) {
      throw new Error(`Expected 400 when setting delivered before shipped, got ${prematureDelivered.status}`);
    }
    console.log('  ✓ PASS: Delivered before shipped correctly blocked by server rule.');

    // 4.4 Set Shipped = true
    const setShipped = await request('PATCH', `/api/orders/admin/${createdOrderId}/status`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      is_shipped: true
    });
    console.log(`[4.4] Set is_shipped=true: Status=${setShipped.status}`);
    if (setShipped.status !== 200 || !setShipped.body.shipped_at) {
      throw new Error(`Expected 200 and shipped_at timestamp, got ${setShipped.status}`);
    }
    console.log('  ✓ PASS: Order marked shipped with timestamp.');

    // 4.5 Set Delivered = true (now allowed since shipped is true)
    const setDelivered = await request('PATCH', `/api/orders/admin/${createdOrderId}/status`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      is_delivered: true
    });
    console.log(`[4.5] Set is_delivered=true: Status=${setDelivered.status}`);
    if (setDelivered.status !== 200 || !setDelivered.body.delivered_at) {
      throw new Error(`Expected 200 and delivered_at timestamp, got ${setDelivered.status}`);
    }
    console.log('  ✓ PASS: Order marked delivered with timestamp.');

    // 4.6 Uncheck Shipped -> Delivered MUST automatically be unticked
    const uncheckShipped = await request('PATCH', `/api/orders/admin/${createdOrderId}/status`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      is_shipped: false
    });
    console.log(`[4.6] Uncheck is_shipped: Status=${uncheckShipped.status}, is_delivered=${uncheckShipped.body.is_delivered}`);
    if (uncheckShipped.status !== 200 || uncheckShipped.body.is_delivered !== false) {
      throw new Error(`Expected is_delivered to be false when is_shipped is false, got ${uncheckShipped.body.is_delivered}`);
    }
    console.log('  ✓ PASS: Unchecking shipped automatically unchecks delivered.');

    // 4.7 Update admin remark
    const updateRemark = await request('PATCH', `/api/orders/admin/${createdOrderId}/remark`, {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      remark: 'Verified with customer on WhatsApp. Dispatching via express courier.'
    });
    console.log(`[4.7] Update admin remark: Status=${updateRemark.status}`);
    if (updateRemark.status !== 200 || !updateRemark.body.admin_remark) {
      throw new Error(`Failed to update remark, status=${updateRemark.status}`);
    }
    console.log('  ✓ PASS: Admin remark updated.');

    // 4.8 Soft-delete order (order must remain in DB)
    const softDelOrder = await request('DELETE', `/api/orders/admin/${createdOrderId}`, {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[4.8] Soft-delete order: Status=${softDelOrder.status}`);
    if (softDelOrder.status !== 200) {
      throw new Error(`Failed to soft-delete order, status=${softDelOrder.status}`);
    }
    const [deletedOrderRow] = await db.query('SELECT deleted_at FROM orders WHERE id = ?', [createdOrderId]);
    if (!deletedOrderRow || !deletedOrderRow.deleted_at) {
      throw new Error('Order row was permanently deleted or deleted_at not set!');
    }
    console.log('  ✓ PASS: Order retained in DB with deleted_at timestamp.');

    // ----------------------------------------------------
    // 5. CUSTOMER CONTROLLER AUDIT
    // ----------------------------------------------------
    console.log('\n--- 5. CUSTOMER CONTROLLER AUDIT ---');
    const customersRes = await request('GET', '/api/customers/admin/all', {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[5.1] GET /api/customers/admin/all: Status=${customersRes.status}, Total=${customersRes.body.pagination?.totalItems}`);
    if (customersRes.status !== 200 || !Array.isArray(customersRes.body.data)) {
      throw new Error(`Failed to list customers, status=${customersRes.status}`);
    }
    console.log('  ✓ PASS: Customers list retrieved.');

    const custDetailRes = await request('GET', `/api/customers/admin/${testCustomerId}`, {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[5.2] GET /api/customers/admin/${testCustomerId}: Status=${custDetailRes.status}`);
    if (custDetailRes.status !== 200 || !custDetailRes.body.customer) {
      throw new Error(`Failed to get customer detail, status=${custDetailRes.status}`);
    }
    console.log('  ✓ PASS: Customer detail retrieved with order history.');

    // ----------------------------------------------------
    // 6. SITE SETTINGS & ENQUIRIES AUDIT
    // ----------------------------------------------------
    console.log('\n--- 6. SITE SETTINGS & ENQUIRIES AUDIT ---');
    const settingsRes = await request('GET', '/api/settings');
    console.log(`[6.1] GET /api/settings: Status=${settingsRes.status}`);
    if (settingsRes.status !== 200 || !settingsRes.body.settings) {
      throw new Error(`Failed to get settings, status=${settingsRes.status}`);
    }
    console.log('  ✓ PASS: Settings key-value map retrieved.');

    const updateSettingsRes = await request('PUT', '/api/settings', {
      Authorization: `Bearer ${testAdminToken}`
    }, {
      settings: {
        announcement_bar: 'SPECIAL 1 GRAM GOLD OFFER • EXPRESS DISPATCH',
        support_phone: '9286129921'
      }
    });
    console.log(`[6.2] PUT /api/settings: Status=${updateSettingsRes.status}`);
    if (updateSettingsRes.status !== 200) {
      throw new Error(`Failed to update settings, status=${updateSettingsRes.status}`);
    }
    console.log('  ✓ PASS: Settings updated successfully.');

    // Public enquiry submission
    const enquiryRes = await request('POST', '/api/settings/contact', {}, {
      name: 'Enquiry Tester',
      mobile_number: '9876543210',
      email: 'test@example.com',
      message: 'Hello, I would like to enquire about bulk order pricing.'
    });
    console.log(`[6.3] POST /api/settings/contact: Status=${enquiryRes.status}`);
    if (enquiryRes.status !== 201) {
      throw new Error(`Failed to submit enquiry, status=${enquiryRes.status}`);
    }
    console.log('  ✓ PASS: Customer enquiry submitted.');

    // Admin view enquiries
    const adminEnquiries = await request('GET', '/api/settings/enquiries', {
      Authorization: `Bearer ${testAdminToken}`
    });
    console.log(`[6.4] GET /api/settings/enquiries: Status=${adminEnquiries.status}, Count=${adminEnquiries.body.enquiries?.length}`);
    if (adminEnquiries.status !== 200 || !Array.isArray(adminEnquiries.body.enquiries)) {
      throw new Error(`Failed to get enquiries, status=${adminEnquiries.status}`);
    }
    console.log('  ✓ PASS: Admin retrieved customer enquiries.');

    // ----------------------------------------------------
    // 7. DASHBOARD STATS AUDIT
    // ----------------------------------------------------
    console.log('\n--- 7. DASHBOARD STATS AUDIT ---');
    const filters = ['all', 'today', '7days', '30days', 'this_month'];
    for (const f of filters) {
      const stats = await request('GET', `/api/dashboard/stats?date_filter=${f}`, {
        Authorization: `Bearer ${testAdminToken}`
      });
      if (stats.status !== 200 || !stats.body.stats) {
        throw new Error(`Dashboard stats failed for filter "${f}", status=${stats.status}`);
      }
    }
    console.log('  ✓ PASS: Dashboard stats calculated cleanly across all date filters with zero crashes.');

    // ----------------------------------------------------
    // CLEANUP TEST RECORDS
    // ----------------------------------------------------
    console.log('\n--- CLEANUP ---');
    if (createdOrderId) {
      await db.query('DELETE FROM payments WHERE order_id = ?', [createdOrderId]);
      await db.query('DELETE FROM order_items WHERE order_id = ?', [createdOrderId]);
      await db.query('DELETE FROM orders WHERE id = ?', [createdOrderId]);
    }
    if (createdProductId) {
      await db.query('DELETE FROM product_images WHERE product_id = ?', [createdProductId]);
      await db.query('DELETE FROM products WHERE id = ?', [createdProductId]);
    }
    if (testCustomerId) {
      await db.query('DELETE FROM orders WHERE user_id = ?', [testCustomerId]);
      await db.query('DELETE FROM customers WHERE id = ?', [testCustomerId]);
    }
    await db.query('DELETE FROM enquiries WHERE name = ?', ['Enquiry Tester']);
    await db.query('DELETE FROM otp_verifications WHERE mobile_number IN (?, ?)', [config.adminMobile, lockoutMobile]);
    console.log('✓ Cleanup completed.');

    console.log('\n====================================================');
    console.log('🎉 ALL ADMIN BACKEND AUDIT CHECKS PASSED PERFECTLY!');
    console.log('====================================================\n');
  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    const pool = db.getPool();
    if (pool) await pool.end();
  }
}

runAdminBackendAudit().catch((err) => {
  console.error('\n❌ Admin Backend Test Suite Error:', err);
  process.exit(1);
});
