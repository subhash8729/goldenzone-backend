const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');
const config = require('../src/config/env');
const jwt = require('jsonwebtoken');

let server;
let baseUrl;

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          // keep as string
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runProductDeletionTest() {
  console.log('====================================================');
  console.log('🧪 VERIFYING PRODUCT PERMANENT DELETION & FK RESOLUTION');
  console.log('====================================================\n');

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
    console.log(`✓ Test HTTP server listening on port ${port}`);

    // Generate admin JWT
    const [adminRow] = await db.query('SELECT * FROM admins LIMIT 1');
    if (!adminRow) {
      throw new Error('No admin found in database');
    }
    const adminToken = jwt.sign(
      { id: adminRow.id, mobile_number: adminRow.mobile_number, isAdmin: true },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    // 1. Create a product with images
    const testSku = `TEST-DEL-${Date.now().toString().slice(-6)}`;
    const testSlug = `test-delete-necklace-${Date.now().toString().slice(-6)}`;
    const createRes = await request('POST', '/api/products', {
      Authorization: `Bearer ${adminToken}`
    }, {
      sku: testSku,
      name: 'Permanent Delete Test Necklace',
      slug: testSlug,
      category_id: 1,
      regular_price: 3499.00,
      discounted_price: 2499.00,
      description: 'Test product designed to verify permanent deletion flow.',
      images: [
        'https://example.com/del-test-1.jpg',
        'https://example.com/del-test-2.jpg'
      ]
    });

    if (createRes.status !== 201 || !createRes.body.productId) {
      throw new Error(`Failed to create test product: ${JSON.stringify(createRes.body)}`);
    }
    const productId = createRes.body.productId;
    console.log(`✓ [Step 1] Created product ID ${productId} (SKU: ${testSku}, Slug: ${testSlug})`);

    // Verify images exist in DB
    const initialImages = await db.query('SELECT * FROM product_images WHERE product_id = ?', [productId]);
    if (initialImages.length !== 2) {
      throw new Error(`Expected 2 images for product, found ${initialImages.length}`);
    }
    console.log(`✓ [Step 2] Verified 2 product images created in DB for product ID ${productId}`);

    // 2. Insert a review for this product
    await db.query(
      `INSERT INTO reviews (product_id, customer_name, rating, review_text) 
       VALUES (?, 'Test Reviewer', 5, 'Exceptional shine and quality.')`,
      [productId]
    );
    const initialReviews = await db.query('SELECT * FROM reviews WHERE product_id = ?', [productId]);
    if (initialReviews.length !== 1) {
      throw new Error('Failed to create review for product');
    }
    console.log(`✓ [Step 3] Created review for product ID ${productId}`);

    // 3. Create a test customer, order, and order_item referencing this product
    const custRes = await db.query(
      `INSERT INTO customers (mobile_number, full_name, address, state, district, pincode)
       VALUES ('9988776655', 'Deletion Flow Tester', '456 Royal Lane', 'Rajasthan', 'Jaipur', '302002')
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`
    );
    const custId = custRes.insertId || (await db.query("SELECT id FROM customers WHERE mobile_number = '9988776655'"))[0].id;

    const orderNum = `GZ-DEL-${Date.now().toString().slice(-6)}`;
    const orderRes = await db.query(
      `INSERT INTO orders (order_number, user_id, full_name, primary_mobile, address, state, district, pincode, subtotal, total_amount, payment_mode, payment_status)
       VALUES (?, ?, 'Deletion Flow Tester', '9988776655', '456 Royal Lane', 'Rajasthan', 'Jaipur', '302002', 2499.00, 2499.00, 'ONLINE', 'PAID')`,
      [orderNum, custId]
    );
    const orderId = orderRes.insertId;

    const orderItemRes = await db.query(
      `INSERT INTO order_items (order_id, product_id, product_name, product_sku, product_image, unit_price, quantity, subtotal_price)
       VALUES (?, ?, 'Permanent Delete Test Necklace', ?, 'https://example.com/del-test-1.jpg', 2499.00, 1, 2499.00)`,
      [orderId, productId, testSku]
    );
    const orderItemId = orderItemRes.insertId;
    console.log(`✓ [Step 4] Created Order ID ${orderId} with Order Item ID ${orderItemId} referencing Product ID ${productId}`);

    // 4. Now execute DELETE product via Admin endpoint
    console.log(`\n⚙️ Executing DELETE /api/products/${productId}...`);
    const deleteRes = await request('DELETE', `/api/products/${productId}`, {
      Authorization: `Bearer ${adminToken}`
    });

    console.log(`Delete response status: ${deleteRes.status}, body:`, deleteRes.body);
    if (deleteRes.status !== 200 || !deleteRes.body.success) {
      throw new Error(`Expected 200 success for deleteProduct, got status ${deleteRes.status}`);
    }
    console.log('✓ [Step 5] Admin product delete endpoint returned HTTP 200 Success.');

    // 5. Verify product row is permanently removed from products table
    const prodInDb = await db.query('SELECT * FROM products WHERE id = ?', [productId]);
    if (prodInDb.length > 0) {
      throw new Error('FAIL: Product still exists in products table!');
    }
    console.log('✓ [Step 6] PASS: Product row permanently removed from products table (0 rows in DB).');

    // 6. Verify product_images are removed
    const imagesInDb = await db.query('SELECT * FROM product_images WHERE product_id = ?', [productId]);
    if (imagesInDb.length > 0) {
      throw new Error('FAIL: Product images still exist in product_images table!');
    }
    console.log('✓ [Step 7] PASS: Product images permanently removed.');

    // 7. Verify reviews are removed
    const reviewsInDb = await db.query('SELECT * FROM reviews WHERE product_id = ?', [productId]);
    if (reviewsInDb.length > 0) {
      throw new Error('FAIL: Reviews still exist in reviews table!');
    }
    console.log('✓ [Step 8] PASS: Product reviews permanently removed.');

    // 8. Verify order and order_item still exist and product_id is NULL (unlinked without FK conflict)
    const [orderItemAfter] = await db.query('SELECT * FROM order_items WHERE id = ?', [orderItemId]);
    if (!orderItemAfter) {
      throw new Error('FAIL: Order item was deleted! Historical order data must be preserved.');
    }
    if (orderItemAfter.product_id !== null) {
      throw new Error(`FAIL: Expected order_items.product_id to be NULL, got ${orderItemAfter.product_id}`);
    }
    if (orderItemAfter.product_name !== 'Permanent Delete Test Necklace' || orderItemAfter.product_sku !== testSku) {
      throw new Error('FAIL: Historical product data on order_item was altered!');
    }
    console.log('✓ [Step 9] PASS: Order item preserved with product_id set to NULL and historical snapshot intact.');

    // 9. Verify re-creating a product with the exact same SKU and slug succeeds without duplicate key error
    const recreateRes = await request('POST', '/api/products', {
      Authorization: `Bearer ${adminToken}`
    }, {
      sku: testSku,
      name: 'Recreated Test Necklace',
      slug: testSlug,
      category_id: 1,
      regular_price: 3499.00,
      discounted_price: 2499.00,
      description: 'Recreated product using previously deleted SKU and slug.',
      images: ['https://example.com/del-test-1.jpg']
    });

    if (recreateRes.status !== 201 || !recreateRes.body.productId) {
      throw new Error(`FAIL: Recreating product with same SKU/slug failed: ${JSON.stringify(recreateRes.body)}`);
    }
    const newProductId = recreateRes.body.productId;
    console.log(`✓ [Step 10] PASS: Re-creating product with freed SKU (${testSku}) & slug succeeded! (New Product ID: ${newProductId})`);

    // Clean up recreated product
    await request('DELETE', `/api/products/${newProductId}`, {
      Authorization: `Bearer ${adminToken}`
    });

    // 10. Calling DELETE on non-existent or already deleted product returns 404
    const notFoundRes = await request('DELETE', `/api/products/${productId}`, {
      Authorization: `Bearer ${adminToken}`
    });
    if (notFoundRes.status !== 404) {
      throw new Error(`Expected 404 for deleting non-existent product, got ${notFoundRes.status}`);
    }
    console.log('✓ [Step 11] PASS: Deleting already-deleted product returns HTTP 404 cleanly.');

    // Clean up test order & customer
    await db.query('DELETE FROM order_items WHERE id = ?', [orderItemId]);
    await db.query('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.query('DELETE FROM customers WHERE id = ?', [custId]);

    console.log('\n====================================================');
    console.log('🎉 ALL PRODUCT DELETION & FK RESOLUTION TESTS PASSED!');
    console.log('====================================================\n');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const pool = db.getPool();
    if (pool) await pool.end();
  }
}

runProductDeletionTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
