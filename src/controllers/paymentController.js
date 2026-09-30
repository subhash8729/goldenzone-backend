const db = require('../config/db');
const razorpayService = require('../services/razorpayService');
const { logAdminAction } = require('./authController');

// Format full readable date e.g. "18 Sep 2026, 10:45 PM"
function formatReadableDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * 1. Customer: Verify payment signature after checkout modal
 * Verifies Razorpay HMAC SHA256 signature and confirms order idempotently.
 * Rule: NO order is created in `orders` table until payment is verified server-side.
 */
exports.verifyPayment = async (req, res, next) => {
  try {
    const customerId = req.user.id;
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required Razorpay payment verification fields.'
      });
    }

    // Cryptographic HMAC-SHA256 signature check (Server-side verification)
    const isValid = razorpayService.verifyPaymentSignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    });

    if (!isValid) {
      // Mark draft as FAILED
      await db.query(
        `UPDATE order_drafts
         SET status = 'FAILED'
         WHERE razorpay_order_id = ? AND user_id = ? AND status = 'INITIATED'`,
        [razorpay_order_id, customerId]
      );

      return res.status(400).json({
        success: false,
        message: 'Payment signature verification failed. Transaction was not authenticated.'
      });
    }

    // Fetch additional payment metadata from Razorpay API
    let paymentMethod = 'RAZORPAY';
    try {
      const rzpPayment = await razorpayService.fetchPaymentDetails(razorpay_payment_id);
      if (rzpPayment && rzpPayment.method) {
        paymentMethod = rzpPayment.method.toUpperCase();
      }
    } catch (e) {
      console.log('Notice: Could not fetch payment method detail from Razorpay:', e.message);
    }

    // Create confirmed order atomically in MySQL transaction
    const verifyResult = await db.withTransaction(async (conn) => {
      // 1. Idempotency check: Has this order already been confirmed?
      const [existingOrders] = await conn.execute(
        `SELECT id, order_number, payment_status, user_id
         FROM orders WHERE razorpay_order_id = ? FOR UPDATE`,
        [razorpay_order_id]
      );

      if (existingOrders.length > 0) {
        const existing = existingOrders[0];
        if (existing.user_id !== customerId) {
          const error = new Error('This payment does not belong to your account.');
          error.statusCode = 403;
          throw error;
        }
        return {
          alreadyVerified: true,
          orderNumber: existing.order_number,
          orderId: existing.id
        };
      }

      // 2. Load draft from order_drafts
      const [draftRows] = await conn.execute(
        `SELECT * FROM order_drafts WHERE razorpay_order_id = ? FOR UPDATE`,
        [razorpay_order_id]
      );

      if (draftRows.length === 0) {
        throw new Error('Checkout session corresponding to this payment was not found or has expired.');
      }

      const draft = draftRows[0];
      if (draft.user_id !== customerId) {
        const error = new Error('This checkout session does not belong to your account.');
        error.statusCode = 403;
        throw error;
      }
      const delivery = typeof draft.delivery_details === 'string' ? JSON.parse(draft.delivery_details) : draft.delivery_details;
      const items = typeof draft.items_data === 'string' ? JSON.parse(draft.items_data) : draft.items_data;

      // 3. Insert confirmed Order record with PAID payment status ONLY NOW
      const [orderInsert] = await conn.execute(
        `INSERT INTO orders (
          order_number, user_id, full_name, primary_mobile, secondary_mobile,
          address, state, district, city, village, pincode,
          latitude, longitude, maps_url,
          subtotal, shipping_amount, total_amount, payment_mode, advance_amount, remaining_cod_amount,
          payment_status, razorpay_order_id, is_shipped, is_delivered
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, 0, 0)`,
        [
          draft.order_number,
          draft.user_id,
          delivery.full_name,
          delivery.primary_mobile,
          delivery.secondary_mobile || null,
          delivery.address,
          delivery.state,
          delivery.district,
          delivery.city || null,
          delivery.village || null,
          delivery.pincode,
          delivery.validLat || null,
          delivery.validLng || null,
          delivery.mapsUrl || null,
          draft.subtotal,
          draft.shipping_amount,
          draft.total_amount,
          draft.payment_mode,
          draft.advance_amount,
          draft.remaining_cod_amount,
          razorpay_order_id
        ]
      );

      const newOrderId = orderInsert.insertId;

      // 4. Insert Order Items
      for (const it of items) {
        await conn.execute(
          `INSERT INTO order_items (
            order_id, product_id, product_name, product_sku, product_image,
            unit_price, quantity, subtotal_price
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newOrderId,
            it.productId || it.product_id,
            it.name || it.product_name,
            it.sku || it.product_sku,
            it.image || it.product_image || '',
            it.unitPrice || it.unit_price,
            it.quantity,
            it.subtotalPrice || it.subtotal_price
          ]
        );
      }

      // 5. Insert Payment Record
      await conn.execute(
        `INSERT INTO payments (
          order_id, user_id, amount, payment_mode, payment_type, remaining_cod_amount,
          payment_method, transaction_id, razorpay_order_id, razorpay_payment_id,
          razorpay_signature, payment_status, gateway
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', 'RAZORPAY')`,
        [
          newOrderId,
          draft.user_id,
          draft.payable_amount,
          draft.payment_mode,
          draft.payment_mode === 'COD' ? 'COD_ADVANCE' : 'FULL',
          draft.remaining_cod_amount,
          paymentMethod,
          razorpay_payment_id,
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature
        ]
      );

      // 6. Mark draft as COMPLETED
      await conn.execute(
        `UPDATE order_drafts SET status = 'COMPLETED' WHERE id = ?`,
        [draft.id]
      );

      // 7. Update customer saved delivery details
      await conn.execute(
        `UPDATE customers
         SET full_name = ?,
             secondary_mobile = ?,
             address = ?,
             state = ?,
             district = ?,
             city = ?,
             village = ?,
             pincode = ?
         WHERE id = ?`,
        [
          delivery.full_name,
          delivery.secondary_mobile || null,
          delivery.address,
          delivery.state,
          delivery.district,
          delivery.city || null,
          delivery.village || null,
          delivery.pincode,
          draft.user_id
        ]
      );

      return {
        alreadyVerified: false,
        orderNumber: draft.order_number,
        orderId: newOrderId
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully and order placed!',
      orderNumber: verifyResult.orderNumber,
      orderId: verifyResult.orderId,
      paymentId: razorpay_payment_id
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 2. Record payment failure or cancellation from client
 */
exports.handlePaymentFailed = async (req, res, next) => {
  try {
    const customerId = req.user.id;
    const {
      razorpay_order_id,
      error_description,
      error_code
    } = req.body;

    const reason = error_description || error_code || 'Payment cancelled or dismissed by customer';
    const isCancel = reason.toLowerCase().includes('cancel') || reason.toLowerCase().includes('dismiss');
    const newStatus = isCancel ? 'CANCELLED' : 'FAILED';

    if (razorpay_order_id) {
      await db.query(
        `UPDATE order_drafts
         SET status = ?
         WHERE razorpay_order_id = ? AND user_id = ? AND status = 'INITIATED'`,
        [newStatus, razorpay_order_id, customerId]
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Payment failure recorded'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 3. Razorpay Official Webhook Handler
 * Verified via HMAC SHA-256 using RAZORPAY_WEBHOOK_SECRET
 * Strictly processes required payment and refund events idempotently:
 * - payment.captured
 * - payment.failed
 * - refund.created
 * - refund.processed
 * - refund.failed
 */
exports.handleWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody;

    // Cryptographically verify webhook signature
    const isValid = razorpayService.verifyWebhookSignature(rawBody, signature);

    if (!isValid) {
      console.warn('⚠️ [Razorpay Webhook]: Signature mismatch or unauthenticated webhook request.');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const event = req.body.event;
    const payload = req.body.payload;
    const eventId = req.headers['x-razorpay-event-id'] || req.body.event_id || req.body.id;

    console.log(`🔔 [Razorpay Webhook Event]: ${event} (Event ID: ${eventId || 'N/A'})`);

    // Only allow configured relevant events
    const allowedEvents = [
      'payment.captured',
      'payment.failed',
      'refund.created',
      'refund.processed',
      'refund.failed'
    ];

    if (!allowedEvents.includes(event)) {
      console.log(`ℹ️ [Razorpay Webhook]: Ignoring unrelated event "${event}"`);
      return res.status(200).json({ status: 'ignored_unrelated_event' });
    }

    // IDEMPOTENCY CHECK: Ensure this event has not already been processed
    if (eventId) {
      const existingEvents = await db.query(
        'SELECT event_id FROM webhook_events WHERE event_id = ? LIMIT 1',
        [eventId]
      );

      if (existingEvents.length > 0) {
        console.log(`ℹ️ [Razorpay Webhook]: Event ${eventId} was already processed idempotently.`);
        return res.status(200).json({ status: 'ok', already_processed: true });
      }
    }

    // Process event within database transaction
    await db.withTransaction(async (conn) => {
      // Record event ID to guarantee idempotency
      if (eventId) {
        await conn.execute(
          'INSERT INTO webhook_events (event_id, event_type, payload) VALUES (?, ?, ?)',
          [eventId, event, JSON.stringify({ event, eventId, timestamp: Date.now() })]
        );
      }

      if (event === 'payment.captured') {
        const paymentEntity = payload.payment?.entity;
        const rzpOrderId = paymentEntity?.order_id;
        const rzpPaymentId = paymentEntity?.id;
        const method = paymentEntity?.method ? paymentEntity.method.toUpperCase() : 'RAZORPAY';

        if (rzpOrderId) {
          const [orders] = await conn.execute(
            `SELECT id, order_number, payment_status
             FROM orders WHERE razorpay_order_id = ? FOR UPDATE`,
            [rzpOrderId]
          );

          if (orders.length > 0) {
            const order = orders[0];
            if (order.payment_status !== 'PAID') {
              await conn.execute(
                `UPDATE orders SET payment_status = 'PAID' WHERE id = ?`,
                [order.id]
              );
              await conn.execute(
                `UPDATE payments
                 SET payment_status = 'PAID',
                     razorpay_payment_id = COALESCE(?, razorpay_payment_id),
                     transaction_id = COALESCE(?, transaction_id),
                     payment_method = ?,
                     error_reason = NULL
                 WHERE order_id = ? OR razorpay_order_id = ?`,
                [rzpPaymentId, rzpPaymentId, method, order.id, rzpOrderId]
              );
              console.log(`✅ [Razorpay Webhook]: Existing Order #${order.order_number} confirmed & marked as PAID via payment.captured`);
            }
          } else {
            // Order was not yet created via client verify — create from draft
            const [draftRows] = await conn.execute(
              `SELECT * FROM order_drafts WHERE razorpay_order_id = ? FOR UPDATE`,
              [rzpOrderId]
            );

            if (draftRows.length > 0) {
              const draft = draftRows[0];
              const delivery = typeof draft.delivery_details === 'string' ? JSON.parse(draft.delivery_details) : draft.delivery_details;
              const items = typeof draft.items_data === 'string' ? JSON.parse(draft.items_data) : draft.items_data;

              const [orderInsert] = await conn.execute(
                `INSERT INTO orders (
                  order_number, user_id, full_name, primary_mobile, secondary_mobile,
                  address, state, district, city, village, pincode,
                  latitude, longitude, maps_url,
                  subtotal, shipping_amount, total_amount, payment_mode, advance_amount, remaining_cod_amount,
                  payment_status, razorpay_order_id, is_shipped, is_delivered
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, 0, 0)`,
                [
                  draft.order_number,
                  draft.user_id,
                  delivery.full_name,
                  delivery.primary_mobile,
                  delivery.secondary_mobile || null,
                  delivery.address,
                  delivery.state,
                  delivery.district,
                  delivery.city || null,
                  delivery.village || null,
                  delivery.pincode,
                  delivery.validLat || null,
                  delivery.validLng || null,
                  delivery.mapsUrl || null,
                  draft.subtotal,
                  draft.shipping_amount,
                  draft.total_amount,
                  draft.payment_mode,
                  draft.advance_amount,
                  draft.remaining_cod_amount,
                  rzpOrderId
                ]
              );

              const newOrderId = orderInsert.insertId;

              for (const it of items) {
                await conn.execute(
                  `INSERT INTO order_items (
                    order_id, product_id, product_name, product_sku, product_image,
                    unit_price, quantity, subtotal_price
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    newOrderId,
                    it.productId || it.product_id,
                    it.name || it.product_name,
                    it.sku || it.product_sku,
                    it.image || it.product_image || '',
                    it.unitPrice || it.unit_price,
                    it.quantity,
                    it.subtotalPrice || it.subtotal_price
                  ]
                );
              }

              await conn.execute(
                `INSERT INTO payments (
                  order_id, user_id, amount, payment_mode, payment_type, remaining_cod_amount,
                  payment_method, transaction_id, razorpay_order_id, razorpay_payment_id,
                  payment_status, gateway
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', 'RAZORPAY')`,
                [
                  newOrderId,
                  draft.user_id,
                  draft.payable_amount,
                  draft.payment_mode,
                  draft.payment_mode === 'COD' ? 'COD_ADVANCE' : 'FULL',
                  draft.remaining_cod_amount,
                  method,
                  rzpPaymentId,
                  rzpOrderId,
                  rzpPaymentId
                ]
              );

              await conn.execute(
                `UPDATE order_drafts SET status = 'COMPLETED' WHERE id = ?`,
                [draft.id]
              );

              console.log(`✅ [Razorpay Webhook]: Order #${draft.order_number} created from draft and marked PAID via webhook payment.captured`);
            }
          }
        }
      } else if (event === 'payment.failed') {
        const paymentEntity = payload.payment?.entity;
        const rzpOrderId = paymentEntity?.order_id;

        if (rzpOrderId) {
          await conn.execute(
            `UPDATE order_drafts
             SET status = 'FAILED'
             WHERE razorpay_order_id = ? AND status = 'INITIATED'`,
            [rzpOrderId]
          );
          console.log(`ℹ️ [Razorpay Webhook]: Draft for ${rzpOrderId} marked as FAILED`);
        }
      } else if (event === 'refund.created' || event === 'refund.processed') {
        const refundEntity = payload.refund?.entity;
        const paymentEntity = payload.payment?.entity;
        const rzpPaymentId = refundEntity?.payment_id || paymentEntity?.id;
        const refundId = refundEntity?.id;
        const refundAmount = refundEntity?.amount ? refundEntity.amount / 100 : 0.0;
        const refundStatus = refundEntity?.status || (event === 'refund.processed' ? 'processed' : 'created');

        if (rzpPaymentId) {
          await conn.execute(
            `UPDATE payments
             SET refund_id = ?,
                 refund_amount = ?,
                 refund_status = ?,
                 refunded_at = NOW(),
                 payment_status = CASE WHEN ? = 'processed' THEN 'REFUNDED' ELSE payment_status END
             WHERE razorpay_payment_id = ?`,
            [refundId, refundAmount, refundStatus, refundStatus, rzpPaymentId]
          );

          console.log(`↩️ [Razorpay Webhook]: Refund ${refundId} recorded for payment ${rzpPaymentId} (${refundStatus})`);
        }
      } else if (event === 'refund.failed') {
        const refundEntity = payload.refund?.entity;
        const rzpPaymentId = refundEntity?.payment_id;
        const refundId = refundEntity?.id;
        const errReason = refundEntity?.error_description || 'Refund processing failed';

        if (rzpPaymentId) {
          await conn.execute(
            `UPDATE payments
             SET refund_id = ?,
                 refund_status = 'failed',
                 error_reason = ?
             WHERE razorpay_payment_id = ?`,
            [refundId, errReason, rzpPaymentId]
          );
        }
      }
    });

    // Always respond with 200 HTTP status as required by Razorpay webhook specifications
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ [Razorpay Webhook Error]:', error);
    return res.status(200).json({ status: 'error_logged' });
  }
};

/**
 * 4. Admin: Get all real payment records
 * Displays:
 * - order number
 * - customer name
 * - mobile
 * - Razorpay order ID
 * - Razorpay payment ID
 * - amount
 * - payment mode
 * - payment status
 * - payment method
 * - date/time
 * - COD advance / full payment
 * - remaining COD amount where applicable
 * - refund information if available
 */
exports.getPayments = async (req, res, next) => {
  try {
    const { search, payment_status, page = 1, limit = 50 } = req.query;
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNumber - 1) * pageSize;
    const params = [];
    const countParams = [];

    let whereSql = '';
    const conditions = [];

    if (payment_status && payment_status !== 'all') {
      conditions.push('p.payment_status = ?');
      params.push(payment_status);
      countParams.push(payment_status);
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push(
        '(o.order_number LIKE ? OR o.full_name LIKE ? OR o.primary_mobile LIKE ? OR p.transaction_id LIKE ? OR p.razorpay_order_id LIKE ? OR p.razorpay_payment_id LIKE ?)'
      );
      params.push(term, term, term, term, term, term);
      countParams.push(term, term, term, term, term, term);
    }

    if (conditions.length > 0) {
      whereSql = `WHERE ${conditions.join(' AND ')}`;
    }

    const countRows = await db.query(
      `SELECT COUNT(*) as total FROM payments p LEFT JOIN orders o ON p.order_id = o.id ${whereSql}`,
      countParams
    );
    const totalItems = countRows[0].total;

    const payments = await db.query(
      `SELECT p.*,
              o.order_number,
              o.full_name,
              o.primary_mobile,
              o.is_delivered,
              o.is_shipped,
              o.payment_mode as order_payment_mode,
              o.advance_amount as order_advance_amount,
              o.remaining_cod_amount as order_remaining_cod_amount,
              o.created_at as order_created_at
       FROM payments p
       LEFT JOIN orders o ON p.order_id = o.id
       ${whereSql}
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const formatted = payments.map((pm) => {
      const mode = pm.payment_mode || pm.order_payment_mode || 'ONLINE';
      const type = pm.payment_type || (mode === 'COD' ? 'COD_ADVANCE' : 'FULL');
      const remCod = parseFloat(pm.remaining_cod_amount ?? pm.order_remaining_cod_amount ?? 0);
      const advAmt = parseFloat(pm.order_advance_amount || 0);

      return {
        ...pm,
        amount: parseFloat(pm.amount),
        payment_mode: mode,
        payment_type: type,
        remaining_cod_amount: remCod,
        advance_amount: advAmt,
        refund_amount: parseFloat(pm.refund_amount || 0),
        formatted_date: formatReadableDate(pm.created_at),
        order_date: formatReadableDate(pm.order_created_at),
        formatted_refund_date: pm.refunded_at ? formatReadableDate(pm.refunded_at) : null
      };
    });

    return res.status(200).json({
      success: true,
      data: formatted,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    });
  } catch (error) {
    next(error);
  }
};
