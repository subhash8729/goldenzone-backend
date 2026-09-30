const { query, getPool, withTransaction } = require('../src/config/db');
const orderService = require('../src/controllers/orderController');
const paymentController = require('../src/controllers/paymentController');
const razorpayService = require('../src/services/razorpayService');
const crypto = require('crypto');

let testUser = { id: 1, mobile_number: '7976580896' };

// Mock Express req/res
function mockReqRes({ body = {}, params = {}, headers = {}, rawBody = null, user = null }) {
  const req = {
    body,
    params,
    headers,
    rawBody,
    user: user || testUser,
    get: (h) => headers[h.toLowerCase()]
  };

  let responseData = null;
  let responseStatus = 200;

  const res = {
    status: (code) => {
      responseStatus = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    },
    send: (data) => {
      responseData = data;
      return res;
    }
  };

  const next = (err) => {
    if (err) console.error('Next called with error:', err);
  };

  return {
    req,
    res,
    next,
    getStatus: () => responseStatus,
    getData: () => responseData
  };
}

async function runSecurityTests() {
  console.log('=== RUNNING SECURITY & ORDER FLOW INTEGRATION TESTS ===\n');

  try {
    // Ensure test customer exists in DB
    const existingCust = await query("SELECT id, mobile_number FROM customers WHERE mobile_number = '7976580896'");
    if (existingCust.length > 0) {
      testUser = existingCust[0];
    } else {
      const ins = await query(
        `INSERT INTO customers (mobile_number, full_name, address, state, district, pincode)
         VALUES ('7976580896', 'Security Tester', '123 Test Lane', 'Rajasthan', 'Udaipur', '313001')`
      );
      testUser = { id: ins.insertId, mobile_number: '7976580896' };
    }

    // Get an active product from DB
    const [product] = await query('SELECT * FROM products WHERE is_active = 1 AND is_out_of_stock = 0 LIMIT 1');
    if (!product) throw new Error('No active in-stock product found for testing.');

    console.log(`Using test product: ID=${product.id}, Name="${product.name}", DB Price=₹${product.discounted_price}`);

    // TEST 1: Price Tampering Prevention
    console.log('\n[Test 1] Price Tampering Protection...');
    // Attempt to pass price = 1 rupee from client
    const tamperedItems = [
      {
        product_id: product.id,
        quantity: 1,
        price: 1 // Attempt to tamper price!
      }
    ];

    const { req: createReq, res: createRes, next: createNext, getStatus: getCreateStatus, getData: getCreateData } = mockReqRes({
      body: {
        primary_mobile: '9876543210',
        full_name: 'Security Tester',
        address: '123 Test Lane',
        state: 'Rajasthan',
        district: 'Udaipur',
        pincode: '313001',
        items: tamperedItems
      }
    });

    await orderService.createOrder(createReq, createRes, createNext);
    const createStatus = getCreateStatus();
    const createData = getCreateData();

    if (createStatus !== 201 || !createData?.order) {
      throw new Error(`Order creation failed: ${JSON.stringify(createData)}`);
    }

    const createdOrder = createData.order;
    console.log(`Order created: ${createdOrder.orderNumber}`);
    console.log(`Calculated Total Amount: ₹${createdOrder.totalAmount} (Client claimed ₹1)`);

    // Verify amount is calculated strictly from DB price
    if (Number(createdOrder.totalAmount) === Number(product.discounted_price)) {
      console.log('✓ PASS: Server strictly ignored client-provided price and used DB price ₹' + product.discounted_price);
    } else {
      throw new Error(`Price tampering check failed! Total amount: ${createdOrder.totalAmount}`);
    }

    // TEST 2: Out of stock validation
    console.log('\n[Test 2] Out of Stock during checkout validation...');
    // Temporarily set a product as out of stock
    await query('UPDATE products SET is_out_of_stock = 1 WHERE id = ?', [product.id]);

    const { req: oosReq, res: oosRes, next: oosNext, getStatus: getOosStatus, getData: getOosData } = mockReqRes({
      body: {
        primary_mobile: '9876543210',
        full_name: 'Security Tester',
        address: '123 Test Lane',
        state: 'Rajasthan',
        district: 'Udaipur',
        pincode: '313001',
        items: [{ product_id: product.id, quantity: 1 }]
      }
    });

    await orderService.createOrder(oosReq, oosRes, oosNext);
    const oosStatus = getOosStatus();
    const oosData = getOosData();

    console.log(`OOS Response Code: ${oosStatus}, Message: ${oosData?.message}`);
    if (oosStatus === 400 && oosData?.message?.includes('out of stock')) {
      console.log('✓ PASS: Out of stock product was properly rejected before order was placed.');
    } else {
      throw new Error('Out of stock validation failed!');
    }

    // Restore product stock
    await query('UPDATE products SET is_out_of_stock = 0 WHERE id = ?', [product.id]);

    // TEST 3: Payment Verification & Idempotency
    console.log('\n[Test 3] Payment Verification & Idempotent Confirmation...');
    const fakePaymentId = 'pay_test_' + Date.now();
    const rzpOrderId = createdOrder.razorpayOrderId;
    const env = require('../src/config/env');

    // Generate valid HMAC signature matching server's configured secret
    const validPaymentSig = crypto
      .createHmac('sha256', env.razorpayKeySecret)
      .update(`${rzpOrderId}|${fakePaymentId}`)
      .digest('hex');

    const { req: verifyReq, res: verifyRes, next: verifyNext, getStatus: getVerifyStatus, getData: getVerifyData } = mockReqRes({
      body: {
        order_number: createdOrder.orderNumber,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: fakePaymentId,
        razorpay_signature: validPaymentSig,
        method: 'upi'
      }
    });

    await paymentController.verifyPayment(verifyReq, verifyRes, verifyNext);
    console.log(`Verification status: ${getVerifyStatus()}, response: ${getVerifyData()?.message}`);

    // Verify DB order state is now PAID
    const [paidOrder] = await query('SELECT id, payment_status, total_amount FROM orders WHERE order_number = ?', [createdOrder.orderNumber]);
    console.log(`Order status in DB: ${paidOrder.payment_status}`);
    if (paidOrder.payment_status === 'PAID') {
      console.log('✓ PASS: Order marked PAID after payment verification.');
    } else {
      throw new Error(`Order status was not PAID! Actual: ${paidOrder.payment_status}`);
    }

    // Check payment record
    const [paymentRecord] = await query('SELECT * FROM payments WHERE order_id = ?', [paidOrder.id]);
    console.log(`Payment record created: Razorpay ID = ${paymentRecord.razorpay_payment_id}, Status = ${paymentRecord.payment_status}`);
    if (paymentRecord.payment_status === 'PAID') {
      console.log('✓ PASS: Payment successfully recorded in DB.');
    }

    // TEST 4: Duplicate Callback / Idempotency Check
    console.log('\n[Test 4] Duplicate verification callback (Idempotency test)...');
    const { req: dupReq, res: dupRes, next: dupNext, getStatus: getDupStatus, getData: getDupData } = mockReqRes({
      body: {
        order_number: createdOrder.orderNumber,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: fakePaymentId,
        razorpay_signature: validPaymentSig,
        method: 'upi'
      }
    });

    await paymentController.verifyPayment(dupReq, dupRes, dupNext);
    console.log(`Duplicate verification status: ${getDupStatus()}, response: ${getDupData()?.message}`);
    
    // Check how many payment records exist for this order (should still be 1, never duplicated)
    const [paymentsCount] = await query('SELECT COUNT(*) as count FROM payments WHERE order_id = ?', [paidOrder.id]);
    console.log(`Payments count for order ${paidOrder.id}: ${paymentsCount.count}`);
    if (paymentsCount.count === 1) {
      console.log('✓ PASS: Duplicate verification processed idempotently without creating duplicate payment records.');
    } else {
      throw new Error(`Duplicate payment records created! Count: ${paymentsCount.count}`);
    }

    // TEST 5: Payment Failure handling
    console.log('\n[Test 5] Payment failure handling...');
    // Create another order to fail
    const { req: failOrderReq, res: failOrderRes, next: failOrderNext, getData: getFailOrderData } = mockReqRes({
      body: {
        primary_mobile: '9876543210',
        full_name: 'Fail Tester',
        address: '456 Fail St',
        state: 'Rajasthan',
        district: 'Udaipur',
        pincode: '313001',
        items: [{ product_id: product.id, quantity: 1 }]
      }
    });
    await orderService.createOrder(failOrderReq, failOrderRes, failOrderNext);
    const failOrder = getFailOrderData().order;

    // Report failure
    const { req: reportFailReq, res: reportFailRes, next: reportFailNext, getStatus: getFailStatus, getData: getFailData } = mockReqRes({
      body: {
        order_number: failOrder.orderNumber,
        razorpay_order_id: failOrder.razorpayOrderId,
        razorpay_payment_id: 'pay_failed_123',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Customer cancelled transaction at gateway',
        error_reason: 'payment_cancelled'
      }
    });

    await paymentController.handlePaymentFailed(reportFailReq, reportFailRes, reportFailNext);
    console.log(`Report fail status: ${getFailStatus()}, message: ${getFailData()?.message}`);

    const [failedDraftInDb] = await query('SELECT status FROM order_drafts WHERE razorpay_order_id = ?', [failOrder.razorpayOrderId]);
    console.log(`Failed draft status in DB: ${failedDraftInDb?.status}`);
    if (failedDraftInDb?.status === 'CANCELLED' || failedDraftInDb?.status === 'FAILED') {
      console.log('✓ PASS: Checkout draft correctly marked FAILED/CANCELLED without creating confirmed order.');
    }

    // TEST 6: Cash on Delivery (COD) ₹200 Advance Calculation
    console.log('\n[Test 6] Cash on Delivery (COD) ₹200 Advance Calculation...');
    const { req: codReq, res: codRes, next: codNext, getStatus: getCodStatus, getData: getCodData } = mockReqRes({
      body: {
        payment_mode: 'COD',
        primary_mobile: '9876543210',
        full_name: 'COD Tester',
        address: '789 COD Road',
        state: 'Rajasthan',
        district: 'Sanchore',
        pincode: '343041',
        items: [{ product_id: product.id, quantity: 1 }]
      }
    });

    await orderService.createOrder(codReq, codRes, codNext);
    const codOrderData = getCodData();
    if (getCodStatus() !== 201 || !codOrderData?.order) {
      throw new Error(`COD Order creation failed: ${JSON.stringify(codOrderData)}`);
    }

    const codOrder = codOrderData.order;
    const expectedAdvance = Math.min(Number(product.discounted_price), 200);
    const expectedRemaining = Math.max(0, Number(product.discounted_price) - expectedAdvance);

    console.log(`COD Order: Total=₹${codOrder.totalAmount}, Advance=₹${codOrder.advanceAmount}, Remaining=₹${codOrder.remainingCodAmount}, Payable=₹${codOrder.payableAmount}`);

    if (
      Number(codOrder.advanceAmount) === expectedAdvance &&
      Number(codOrder.remainingCodAmount) === expectedRemaining &&
      Number(codOrder.payableAmount) === expectedAdvance &&
      codOrder.paymentMode === 'COD'
    ) {
      console.log(`✓ PASS: Server correctly enforced COD ₹200 advance (Advance: ₹${expectedAdvance}, Remaining: ₹${expectedRemaining})`);
    } else {
      throw new Error(`COD calculation failed! Advance: ${codOrder.advanceAmount}, Remaining: ${codOrder.remainingCodAmount}`);
    }

    // Verify DB stored correctly in order_drafts
    const [dbCodDraft] = await query('SELECT payment_mode, advance_amount, remaining_cod_amount, status FROM order_drafts WHERE razorpay_order_id = ?', [codOrder.razorpayOrderId]);
    if (dbCodDraft.payment_mode === 'COD' && Number(dbCodDraft.advance_amount) === expectedAdvance) {
      console.log('✓ PASS: COD details verified in database schema.');
    } else {
      throw new Error('Database COD fields mismatch!');
    }

    // TEST 7: Webhook Idempotency with webhook_events table
    console.log('\n[Test 7] Webhook idempotency test...');
    const testEventId = 'evt_test_' + Date.now();
    const webhookPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_hook_test_' + Date.now(),
            order_id: codOrder.razorpayOrderId,
            amount: Math.round(expectedAdvance * 100),
            status: 'captured',
            method: 'upi'
          }
        }
      }
    };

    const webhookRawBody = JSON.stringify(webhookPayload);
    const validWebhookSig = crypto
      .createHmac('sha256', env.razorpayWebhookSecret)
      .update(webhookRawBody)
      .digest('hex');

    const { req: hookReq1, res: hookRes1, next: hookNext1, getStatus: getHookStatus1, getData: getHookData1 } = mockReqRes({
      headers: {
        'x-razorpay-event-id': testEventId,
        'x-razorpay-signature': validWebhookSig
      },
      rawBody: webhookRawBody,
      body: webhookPayload
    });

    await paymentController.handleWebhook(hookReq1, hookRes1, hookNext1);
    console.log(`First webhook status: ${getHookStatus1()}, message: ${getHookData1()?.message}`);

    // Deliver same webhook again (simulating duplicate webhook retry from Razorpay)
    const { req: hookReq2, res: hookRes2, next: hookNext2, getStatus: getHookStatus2, getData: getHookData2 } = mockReqRes({
      headers: {
        'x-razorpay-event-id': testEventId,
        'x-razorpay-signature': validWebhookSig
      },
      rawBody: webhookRawBody,
      body: webhookPayload
    });

    await paymentController.handleWebhook(hookReq2, hookRes2, hookNext2);
    console.log(`Duplicate webhook status: ${getHookStatus2()}, response: ${getHookData2()?.message}`);

    const [recordedEvent] = await query('SELECT * FROM webhook_events WHERE event_id = ?', [testEventId]);
    if (recordedEvent && getHookData2()?.already_processed === true) {
      console.log('✓ PASS: Webhook processed idempotently and recorded in webhook_events table.');
    } else {
      throw new Error('Webhook idempotency failed!');
    }

    // TEST 8: Real OTP Security (Rejection of demo OTP 987654)
    console.log('\n[Test 8] OTP Security & Removal of Demo OTP 987654...');
    const otpService = require('../src/services/otpService');
    const testMobile = '9286129921';
    
    // Clean prior OTP test records
    await query('DELETE FROM otp_verifications WHERE mobile_number = ?', [testMobile]);

    // Generate real OTP
    const sendResult = await otpService.sendOtp(testMobile);
    console.log(`Real OTP created & dispatched: success=${sendResult.success}, message="${sendResult.message}"`);

    // Try demo OTP 987654 (must fail)
    const demoVerify = await otpService.verifyOtp(testMobile, '987654');
    if (!demoVerify.success) {
      console.log('✓ PASS: Universal demo OTP 987654 is rejected as expected.');
    } else {
      throw new Error('Security flaw: Demo OTP 987654 was accepted!');
    }

    console.log('\n[Cleanup] Cleaning up test records...');
    await query('DELETE FROM payments WHERE order_id = ?', [paidOrder.id]);
    await query('DELETE FROM order_items WHERE order_id = ?', [paidOrder.id]);
    await query('DELETE FROM orders WHERE id = ?', [paidOrder.id]);
    await query('DELETE FROM order_drafts WHERE razorpay_order_id IN (?, ?, ?)', [createdOrder.razorpayOrderId, failOrder.razorpayOrderId, codOrder.razorpayOrderId]);
    await query('DELETE FROM webhook_events WHERE event_id = ?', [testEventId]);
    await query('DELETE FROM otp_verifications WHERE mobile_number = ?', [testMobile]);
    console.log('✓ Test records cleaned up.');

    console.log('\n=== ALL SECURITY AND INTEGRATION TESTS COMPLETED SUCCESSFULLY! ===');
  } catch (err) {
    console.error('Test error:', err);
    process.exitCode = 1;
  } finally {
    const p = getPool();
    if (p) await p.end();
  }
}

runSecurityTests();
