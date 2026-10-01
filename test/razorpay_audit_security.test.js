const crypto = require('crypto');
const db = require('../src/config/db');
const env = require('../src/config/env');
const razorpayService = require('../src/services/razorpayService');
const orderService = require('../src/controllers/orderController');
const paymentController = require('../src/controllers/paymentController');

function mockReqRes({ body = {}, headers = {}, rawBody = null, user = { id: 1 } }) {
  let statusCode = 200;
  let responseData = null;

  const req = {
    body,
    headers: { ...headers },
    rawBody,
    user,
    get: (h) => headers[h.toLowerCase()] || headers[h]
  };

  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    }
  };

  const next = (err) => {
    if (err) {
      statusCode = err.statusCode || 500;
      responseData = { success: false, message: err.message, error: err };
    }
  };

  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getData: () => responseData
  };
}

async function runAuditTests() {
  console.log('====================================================');
  console.log('🛡️ RAZORPAY BACKEND COMPREHENSIVE SECURITY AUDIT SUITE');
  console.log('====================================================');

  const customerA = 1;
  const customerB = 2;
  const testCleanup = {
    orderIds: [],
    draftOrderIds: [],
    eventIds: []
  };

  try {
    // 0. Ensure test product exists
    const [products] = await db.query('SELECT * FROM products WHERE is_active = 1 LIMIT 1');
    if (!products) {
      throw new Error('No active products found in DB for testing.');
    }
    const product = products;
    console.log(`[Setup] Using Product ID=${product.id}, Name="${product.name}", Price=₹${product.discounted_price}`);

    // =========================================================================
    // TEST 1: Strict Server Price Calculation & Min Amount
    // =========================================================================
    console.log('\n--- 1. Order Creation & Amount Validation ---');
    const { req: createReq, res: createRes, next: createNext, getStatus: getCreateStatus, getData: getCreateData } = mockReqRes({
      user: { id: customerA },
      body: {
        payment_mode: 'ONLINE',
        primary_mobile: '9876543210',
        full_name: 'Audit Customer A',
        address: '100 Security Boulevard',
        state: 'Rajasthan',
        district: 'Udaipur',
        pincode: '313001',
        items: [{ product_id: product.id, quantity: 1, discounted_price: 1.0, unitPrice: 0.5 }] // Tampered client price
      }
    });

    await orderService.createOrder(createReq, createRes, createNext);
    const orderData = getCreateData();
    if (getCreateStatus() !== 201 || !orderData?.order) {
      throw new Error(`Order creation failed: ${JSON.stringify(orderData)}`);
    }

    const draftOrder = orderData.order;
    testCleanup.draftOrderIds.push(draftOrder.razorpayOrderId);
    console.log(`Created order: ${draftOrder.orderNumber}, Razorpay Order ID: ${draftOrder.razorpayOrderId}`);

    // Verify calculated amount matches DB price exactly
    if (Number(draftOrder.totalAmount) === Number(product.discounted_price)) {
      console.log(`✓ PASS: Server strictly ignored client-tampered price (₹1) and enforced DB price ₹${product.discounted_price}.`);
    } else {
      throw new Error(`Price tampering check failed! Expected ₹${product.discounted_price}, got ₹${draftOrder.totalAmount}`);
    }

    // =========================================================================
    // TEST 2: Rejection of Fake / Forged Payment Signatures
    // =========================================================================
    console.log('\n--- 2. Cryptographic Signature Tampering & Forgery Rejection ---');
    const forgedSig = '0000000000000000000000000000000000000000000000000000000000000000';
    const fakePayId = 'pay_fake_' + Date.now();

    const { req: forgeReq, res: forgeRes, next: forgeNext, getStatus: getForgeStatus, getData: getForgeData } = mockReqRes({
      user: { id: customerA },
      body: {
        razorpay_order_id: draftOrder.razorpayOrderId,
        razorpay_payment_id: fakePayId,
        razorpay_signature: forgedSig
      }
    });

    await paymentController.verifyPayment(forgeReq, forgeRes, forgeNext);
    if (getForgeStatus() === 400 && getForgeData()?.success === false) {
      console.log(`✓ PASS: Forged payment signature was correctly rejected (HTTP 400: "${getForgeData().message}").`);
    } else {
      throw new Error(`Security breach: Forged payment signature was accepted! Status=${getForgeStatus()}`);
    }

    // Check draft was marked FAILED
    const [failedDraft] = await db.query('SELECT status FROM order_drafts WHERE razorpay_order_id = ?', [draftOrder.razorpayOrderId]);
    if (failedDraft?.status === 'FAILED') {
      console.log('✓ PASS: Draft automatically transitioned to FAILED status after signature mismatch.');
    } else {
      throw new Error(`Draft status expected FAILED, found ${failedDraft?.status}`);
    }

    // Restore draft to INITIATED for further tests
    await db.query('UPDATE order_drafts SET status = "INITIATED" WHERE razorpay_order_id = ?', [draftOrder.razorpayOrderId]);

    // =========================================================================
    // TEST 3: Cross-User Verification Attack (Customer B verifies Customer A's order)
    // =========================================================================
    console.log('\n--- 3. Cross-User Authorization Boundary ---');
    const validSig = crypto
      .createHmac('sha256', env.razorpayKeySecret)
      .update(`${draftOrder.razorpayOrderId}|${fakePayId}`)
      .digest('hex');

    const { req: crossReq, res: crossRes, next: crossNext, getStatus: getCrossStatus, getData: getCrossData } = mockReqRes({
      user: { id: customerB }, // Attacker
      body: {
        razorpay_order_id: draftOrder.razorpayOrderId,
        razorpay_payment_id: fakePayId,
        razorpay_signature: validSig
      }
    });

    await paymentController.verifyPayment(crossReq, crossRes, crossNext);
    if (getCrossStatus() === 403) {
      console.log(`✓ PASS: Customer B was blocked from verifying Customer A's payment (HTTP 403 Forbidden).`);
    } else {
      throw new Error(`Security breach: Cross-user verification permitted! Status=${getCrossStatus()}`);
    }

    // =========================================================================
    // TEST 4: Live Payment Status & Details Validation (Anti-Fake Payment)
    // =========================================================================
    console.log('\n--- 4. Live Payment Metadata Validation ---');
    // Test that when razorpayService.fetchPaymentDetails returns an invalid status (e.g. 'failed'), verifyPayment blocks it
    const originalFetch = razorpayService.fetchPaymentDetails;
    try {
      // Mock fetchPaymentDetails returning a failed status
      razorpayService.fetchPaymentDetails = async () => ({
        id: fakePayId,
        order_id: draftOrder.razorpayOrderId,
        status: 'failed',
        amount: Math.round(Number(draftOrder.payableAmount) * 100),
        currency: 'INR'
      });

      const { req: statusFailReq, res: statusFailRes, next: statusFailNext, getStatus: getStatusFailStatus, getData: getStatusFailData } = mockReqRes({
        user: { id: customerA },
        body: {
          razorpay_order_id: draftOrder.razorpayOrderId,
          razorpay_payment_id: fakePayId,
          razorpay_signature: validSig
        }
      });

      await paymentController.verifyPayment(statusFailReq, statusFailRes, statusFailNext);
      if (getStatusFailStatus() === 400 && getStatusFailData()?.message?.includes('failed')) {
        console.log(`✓ PASS: Payment with status="failed" at gateway was rejected before order creation.`);
      } else {
        throw new Error(`Failed payment status was erroneously accepted! Status=${getStatusFailStatus()}`);
      }

      // Restore draft to INITIATED
      await db.query('UPDATE order_drafts SET status = "INITIATED" WHERE razorpay_order_id = ?', [draftOrder.razorpayOrderId]);

      // Mock fetchPaymentDetails returning an amount mismatch (e.g. attacker paid ₹10 instead of ₹600)
      razorpayService.fetchPaymentDetails = async () => ({
        id: fakePayId,
        order_id: draftOrder.razorpayOrderId,
        status: 'captured',
        amount: 1000, // 1000 paise = ₹10
        currency: 'INR'
      });

      const { req: amtFailReq, res: amtFailRes, next: amtFailNext, getStatus: getAmtFailStatus, getData: getAmtFailData } = mockReqRes({
        user: { id: customerA },
        body: {
          razorpay_order_id: draftOrder.razorpayOrderId,
          razorpay_payment_id: fakePayId,
          razorpay_signature: validSig
        }
      });

      await paymentController.verifyPayment(amtFailReq, amtFailRes, amtFailNext);
      if (getAmtFailStatus() === 400 && getAmtFailData()?.message?.includes('mismatch')) {
        console.log(`✓ PASS: Payment with amount mismatch was strictly rejected (${getAmtFailData()?.message}).`);
      } else {
        throw new Error(`Amount mismatch was erroneously accepted! Status=${getAmtFailStatus()}`);
      }

      // Mock fetchPaymentDetails returning currency mismatch
      razorpayService.fetchPaymentDetails = async () => ({
        id: fakePayId,
        order_id: draftOrder.razorpayOrderId,
        status: 'captured',
        amount: Math.round(Number(draftOrder.payableAmount) * 100),
        currency: 'USD'
      });

      const { req: curFailReq, res: curFailRes, next: curFailNext, getStatus: getCurFailStatus, getData: getCurFailData } = mockReqRes({
        user: { id: customerA },
        body: {
          razorpay_order_id: draftOrder.razorpayOrderId,
          razorpay_payment_id: fakePayId,
          razorpay_signature: validSig
        }
      });

      await paymentController.verifyPayment(curFailReq, curFailRes, curFailNext);
      if (getCurFailStatus() === 400 && getCurFailData()?.message?.includes('currency')) {
        console.log(`✓ PASS: Payment with non-INR currency was rejected (${getCurFailData()?.message}).`);
      } else {
        throw new Error(`Currency mismatch was erroneously accepted! Status=${getCurFailStatus()}`);
      }
    } finally {
      razorpayService.fetchPaymentDetails = originalFetch;
    }

    // =========================================================================
    // TEST 5: Legitimate Payment Verification & Atomic Order Placement
    // =========================================================================
    console.log('\n--- 5. Legitimate Payment Verification & Idempotency ---');
    const legitPayId = 'pay_legit_' + Date.now();
    const legitSig = crypto
      .createHmac('sha256', env.razorpayKeySecret)
      .update(`${draftOrder.razorpayOrderId}|${legitPayId}`)
      .digest('hex');

    const { req: legitReq, res: legitRes, next: legitNext, getStatus: getLegitStatus, getData: getLegitData } = mockReqRes({
      user: { id: customerA },
      body: {
        razorpay_order_id: draftOrder.razorpayOrderId,
        razorpay_payment_id: legitPayId,
        razorpay_signature: legitSig
      }
    });

    await paymentController.verifyPayment(legitReq, legitRes, legitNext);
    const legitResult = getLegitData();
    if (getLegitStatus() !== 200 || !legitResult?.orderId) {
      throw new Error(`Legitimate verification failed: ${JSON.stringify(legitResult)}`);
    }

    testCleanup.orderIds.push(legitResult.orderId);
    console.log(`✓ PASS: Payment verified and confirmed Order #${legitResult.orderNumber} created (ID: ${legitResult.orderId}).`);

    // Verify DB order status is PAID
    const [confirmedOrder] = await db.query('SELECT * FROM orders WHERE id = ?', [legitResult.orderId]);
    if (confirmedOrder?.payment_status === 'PAID') {
      console.log('✓ PASS: Order payment_status is PAID.');
    } else {
      throw new Error(`Expected PAID, got: ${confirmedOrder?.payment_status}`);
    }

    // Verify payment record in DB
    const [paymentRow] = await db.query('SELECT * FROM payments WHERE order_id = ?', [legitResult.orderId]);
    if (paymentRow?.razorpay_payment_id === legitPayId && paymentRow?.payment_status === 'PAID') {
      console.log('✓ PASS: Payment record accurately mapped in payments table.');
    } else {
      throw new Error('Payment record not properly stored!');
    }

    // Replay same verification (Idempotency)
    const { req: replayReq, res: replayRes, next: replayNext, getStatus: getReplayStatus, getData: getReplayData } = mockReqRes({
      user: { id: customerA },
      body: {
        razorpay_order_id: draftOrder.razorpayOrderId,
        razorpay_payment_id: legitPayId,
        razorpay_signature: legitSig
      }
    });

    await paymentController.verifyPayment(replayReq, replayRes, replayNext);
    if (getReplayStatus() === 200 && getReplayData()?.orderId === legitResult.orderId) {
      console.log('✓ PASS: Replay verification returned existing order idempotently without duplicate records.');
    } else {
      throw new Error('Idempotent replay failed!');
    }

    const [payCount] = await db.query('SELECT COUNT(*) as c FROM payments WHERE order_id = ?', [legitResult.orderId]);
    if (payCount.c === 1) {
      console.log('✓ PASS: Payments count is exactly 1 (no duplicate rows).');
    } else {
      throw new Error(`Duplicate payment rows found! Count: ${payCount.c}`);
    }

    // =========================================================================
    // TEST 6: Webhook Security, Signature Verification, and Idempotency
    // =========================================================================
    console.log('\n--- 6. Webhook Security & Idempotency ---');
    const hookEventId = 'evt_audit_' + Date.now();
    testCleanup.eventIds.push(hookEventId);

    // 6.1 Forged webhook signature rejection
    const forgedHookPayload = JSON.stringify({ event: 'payment.captured', id: hookEventId });
    const { req: forgeHookReq, res: forgeHookRes, next: forgeHookNext, getStatus: getForgeHookStatus } = mockReqRes({
      headers: {
        'x-razorpay-event-id': hookEventId,
        'x-razorpay-signature': 'invalid_forged_webhook_signature_hex'
      },
      rawBody: Buffer.from(forgedHookPayload, 'utf8'),
      body: JSON.parse(forgedHookPayload)
    });

    await paymentController.handleWebhook(forgeHookReq, forgeHookRes, forgeHookNext);
    if (getForgeHookStatus() === 400) {
      console.log('✓ PASS: Webhook with forged signature rejected (HTTP 400).');
    } else {
      throw new Error(`Forged webhook signature was accepted! Status=${getForgeHookStatus()}`);
    }

    // 6.2 Missing rawBody rejection
    const { req: noBodyReq, res: noBodyRes, next: noBodyNext, getStatus: getNoBodyStatus } = mockReqRes({
      headers: { 'x-razorpay-signature': 'some_sig' },
      rawBody: null,
      body: {}
    });

    await paymentController.handleWebhook(noBodyReq, noBodyRes, noBodyNext);
    if (getNoBodyStatus() === 400) {
      console.log('✓ PASS: Webhook with missing rawBody rejected (HTTP 400).');
    } else {
      throw new Error(`Webhook missing raw body accepted! Status=${getNoBodyStatus()}`);
    }

    // =========================================================================
    // TEST 7: Concurrent Webhook & Verify Race Condition Protection
    // =========================================================================
    console.log('\n--- 7. Concurrent Verify & Webhook Race Condition Safety ---');
    // Create new draft for concurrency test
    const { req: raceReq, res: raceRes, next: raceNext, getData: getRaceData } = mockReqRes({
      user: { id: customerA },
      body: {
        payment_mode: 'ONLINE',
        primary_mobile: '9876543210',
        full_name: 'Race Condition Tester',
        address: '200 Parallel Way',
        state: 'Rajasthan',
        district: 'Udaipur',
        pincode: '313001',
        items: [{ product_id: product.id, quantity: 1 }]
      }
    });

    await orderService.createOrder(raceReq, raceRes, raceNext);
    const raceDraft = getRaceData().order;
    testCleanup.draftOrderIds.push(raceDraft.razorpayOrderId);

    const racePayId = 'pay_race_' + Date.now();
    const raceSig = crypto
      .createHmac('sha256', env.razorpayKeySecret)
      .update(`${raceDraft.razorpayOrderId}|${racePayId}`)
      .digest('hex');

    const raceEventId = 'evt_race_' + Date.now();
    testCleanup.eventIds.push(raceEventId);

    const webhookBodyObj = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: racePayId,
            order_id: raceDraft.razorpayOrderId,
            amount: Math.round(Number(raceDraft.payableAmount) * 100),
            currency: 'INR',
            status: 'captured',
            method: 'netbanking'
          }
        }
      }
    };
    const webhookRaw = Buffer.from(JSON.stringify(webhookBodyObj), 'utf8');
    const validHookSig = crypto
      .createHmac('sha256', env.razorpayWebhookSecret)
      .update(webhookRaw)
      .digest('hex');

    // Run BOTH verifyPayment and handleWebhook concurrently via Promise.all
    const [verifyRaceRes, hookRaceRes] = await Promise.all([
      (async () => {
        const { req, res, next, getStatus, getData } = mockReqRes({
          user: { id: customerA },
          body: {
            razorpay_order_id: raceDraft.razorpayOrderId,
            razorpay_payment_id: racePayId,
            razorpay_signature: raceSig
          }
        });
        await paymentController.verifyPayment(req, res, next);
        return { status: getStatus(), data: getData() };
      })(),
      (async () => {
        const { req, res, next, getStatus, getData } = mockReqRes({
          headers: {
            'x-razorpay-event-id': raceEventId,
            'x-razorpay-signature': validHookSig
          },
          rawBody: webhookRaw,
          body: webhookBodyObj
        });
        await paymentController.handleWebhook(req, res, next);
        return { status: getStatus(), data: getData() };
      })()
    ]);

    console.log(`Verify returned HTTP ${verifyRaceRes.status}, Webhook returned HTTP ${hookRaceRes.status}`);

    // Check how many orders were inserted for this razorpay_order_id
    const ordersCreated = await db.query('SELECT id, order_number, payment_status FROM orders WHERE razorpay_order_id = ?', [raceDraft.razorpayOrderId]);
    console.log(`Total orders created for Razorpay Order ${raceDraft.razorpayOrderId}: ${ordersCreated.length}`);

    if (ordersCreated.length === 1) {
      console.log('✓ PASS: Exactly ONE order created despite simultaneous client verify and webhook execution.');
      testCleanup.orderIds.push(ordersCreated[0].id);
    } else {
      throw new Error(`Race condition failure: ${ordersCreated.length} orders created!`);
    }

    const paymentsCreated = await db.query('SELECT id FROM payments WHERE razorpay_order_id = ?', [raceDraft.razorpayOrderId]);
    if (paymentsCreated.length === 1) {
      console.log('✓ PASS: Exactly ONE payment row created (zero duplicate payments).');
    } else {
      throw new Error(`Race condition failure: ${paymentsCreated.length} payment rows created!`);
    }

    // =========================================================================
    // TEST 8: Refund Synchronization
    // =========================================================================
    console.log('\n--- 8. Refund Webhook Handling & Status Synchronization ---');
    const refundEventId = 'evt_refund_' + Date.now();
    testCleanup.eventIds.push(refundEventId);

    const refundPayload = {
      event: 'refund.processed',
      payload: {
        payment: {
          entity: {
            id: racePayId
          }
        },
        refund: {
          entity: {
            id: 'rfnd_' + Date.now(),
            payment_id: racePayId,
            amount: Math.round(Number(raceDraft.payableAmount) * 100),
            status: 'processed'
          }
        }
      }
    };
    const refundRaw = Buffer.from(JSON.stringify(refundPayload), 'utf8');
    const refundSig = crypto
      .createHmac('sha256', env.razorpayWebhookSecret)
      .update(refundRaw)
      .digest('hex');

    const { req: refReq, res: refRes, next: refNext, getStatus: getRefStatus } = mockReqRes({
      headers: {
        'x-razorpay-event-id': refundEventId,
        'x-razorpay-signature': refundSig
      },
      rawBody: refundRaw,
      body: refundPayload
    });

    await paymentController.handleWebhook(refReq, refRes, refNext);
    if (getRefStatus() === 200) {
      console.log('✓ PASS: Refund webhook processed successfully.');
    }

    // Verify payments table updated to REFUNDED
    const [refundedPayment] = await db.query('SELECT payment_status, refund_id, refund_status FROM payments WHERE razorpay_payment_id = ?', [racePayId]);
    if (refundedPayment?.payment_status === 'REFUNDED' && refundedPayment?.refund_status === 'processed') {
      console.log(`✓ PASS: payments.payment_status updated to REFUNDED (Refund ID: ${refundedPayment.refund_id}).`);
    } else {
      throw new Error(`Refund status not reflected in payments: ${JSON.stringify(refundedPayment)}`);
    }

    // Verify orders table synchronized to REFUNDED
    const [refundedOrder] = await db.query('SELECT payment_status FROM orders WHERE razorpay_order_id = ?', [raceDraft.razorpayOrderId]);
    if (refundedOrder?.payment_status === 'REFUNDED') {
      console.log('✓ PASS: orders.payment_status synchronized to REFUNDED.');
    } else {
      throw new Error(`Order payment_status expected REFUNDED, found ${refundedOrder?.payment_status}`);
    }

    console.log('\n====================================================');
    console.log('🎉 ALL RAZORPAY SECURITY AUDIT CHECKS PASSED PERFECTLY!');
    console.log('====================================================');

  } catch (err) {
    console.error('❌ Audit failure:', err);
    process.exitCode = 1;
  } finally {
    // Cleanup
    console.log('\n[Cleanup] Removing audit test records...');
    for (const oid of testCleanup.orderIds) {
      await db.query('DELETE FROM payments WHERE order_id = ?', [oid]);
      await db.query('DELETE FROM order_items WHERE order_id = ?', [oid]);
      await db.query('DELETE FROM orders WHERE id = ?', [oid]);
    }
    for (const did of testCleanup.draftOrderIds) {
      await db.query('DELETE FROM order_drafts WHERE razorpay_order_id = ?', [did]);
    }
    for (const eid of testCleanup.eventIds) {
      await db.query('DELETE FROM webhook_events WHERE event_id = ?', [eid]);
    }
    console.log('✓ Audit test records cleaned up.');
    const pool = db.getPool();
    if (pool) await pool.end();
  }
}

runAuditTests();
