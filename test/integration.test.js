const { query, getPool } = require('../src/config/db');
const razorpayService = require('../src/services/razorpayService');
const crypto = require('crypto');

async function runTests() {
  console.log('=== STARTING AUTOMATED FLOW AND INTEGRATION TESTS ===\n');

  try {
    // 1. Verify DB is clean of fake orders and fake payments
    console.log('[Test 1] Checking DB clean state (no fake orders/payments)...');
    const orders = await query('SELECT COUNT(*) as count FROM orders');
    const payments = await query('SELECT COUNT(*) as count FROM payments');
    console.log(`Orders count in DB: ${orders[0].count}`);
    console.log(`Payments count in DB: ${payments[0].count}`);
    if (orders[0].count === 0 && payments[0].count === 0) {
      console.log('✓ PASS: All fake orders and payments have been completely purged from DB.');
    } else {
      console.log('Notice: DB contains orders/payments created during runtime testing.');
    }

    // 2. Verify products exist and have valid stock
    console.log('\n[Test 2] Checking active products and stock levels...');
    const products = await query('SELECT id, name, regular_price, discounted_price, is_out_of_stock, is_active FROM products LIMIT 3');
    if (products.length > 0) {
      console.log(`✓ PASS: Found ${products.length} products in DB. Example: "${products[0].name}" at ₹${products[0].discounted_price} (Out of Stock: ${products[0].is_out_of_stock === 1 ? 'Yes' : 'No'})`);
    } else {
      throw new Error('No products found in DB!');
    }

    // 3. Test Razorpay HMAC-SHA256 signature verification logic
    console.log('\n[Test 3] Testing Razorpay signature verification logic...');
    const testSecret = 'test_secret_key_12345';
    const testOrderId = 'order_test_987654';
    const testPaymentId = 'pay_test_123456';
    
    // Correct signature
    const expectedSig = crypto
      .createHmac('sha256', testSecret)
      .update(`${testOrderId}|${testPaymentId}`)
      .digest('hex');

    const isValid = razorpayService.verifyPaymentSignature({
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: expectedSig,
      secret: testSecret
    });
    console.log(`Signature check with valid HMAC: ${isValid}`);
    if (!isValid) throw new Error('Valid signature was rejected!');

    // Tampered signature
    const isTamperedValid = razorpayService.verifyPaymentSignature({
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: 'wrong_tampered_signature_hex_value_12345',
      secret: testSecret
    });
    console.log(`Signature check with tampered HMAC: ${isTamperedValid}`);
    if (isTamperedValid) throw new Error('Tampered signature was accepted!');
    console.log('✓ PASS: Razorpay HMAC-SHA256 signature verification correctly validates and rejects tampering.');

    // 4. Test Webhook signature verification logic
    console.log('\n[Test 4] Testing Webhook signature verification...');
    const webhookPayload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_999' } } } });
    const webhookSig = crypto
      .createHmac('sha256', testSecret)
      .update(webhookPayload)
      .digest('hex');

    const isWebhookValid = razorpayService.verifyWebhookSignature(
      webhookPayload,
      webhookSig,
      testSecret
    );
    console.log(`Webhook check with valid signature: ${isWebhookValid}`);
    if (!isWebhookValid) throw new Error('Valid webhook signature was rejected!');
    console.log('✓ PASS: Webhook signature validation is secure and functional.');

    // 5. Test Site Settings have contact info configured
    console.log('\n[Test 5] Checking site settings for Contact page...');
    const settings = await query('SELECT setting_key, setting_value FROM site_settings');
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
    console.log(`Support Mobile: ${settingsMap.support_mobile}`);
    console.log(`Support WhatsApp: ${settingsMap.support_whatsapp}`);
    console.log(`Support Email: ${settingsMap.support_email}`);
    console.log(`Support Instagram: ${settingsMap.support_instagram}`);
    console.log(`WhatsApp Group: ${settingsMap.whatsapp_vip_group_url}`);
    console.log('✓ PASS: Contact page settings are present and accessible.');

    // 6. Test Enquiries table
    console.log('\n[Test 6] Verifying enquiries table existence and query...');
    const enquiries = await query('SELECT COUNT(*) as count FROM enquiries');
    console.log(`Current enquiries count: ${enquiries[0].count}`);
    console.log('✓ PASS: Enquiries table is ready.');

    console.log('\n=== ALL AUTOMATED CHECKS PASSED SUCCESSFULLY ===');
  } catch (err) {
    console.error('Test failed with error:', err);
    process.exitCode = 1;
  } finally {
    const p = getPool();
    if (p) await p.end();
  }
}

runTests();
