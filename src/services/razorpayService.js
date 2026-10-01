const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../config/env');

let razorpayInstance = null;

function getRazorpayInstance() {
  if (!razorpayInstance) {
    if (!config.razorpayKeyId || !config.razorpayKeySecret) {
      console.warn('⚠️ [Razorpay]: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set in environment.');
      return null;
    }
    razorpayInstance = new Razorpay({
      key_id: config.razorpayKeyId,
      key_secret: config.razorpayKeySecret
    });
  }
  return razorpayInstance;
}

/**
 * Helper to run a promise with a timeout
 */
function withTimeout(promise, ms, operationName = 'Razorpay Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`${operationName} timed out after ${ms}ms`);
        err.statusCode = 504;
        reject(err);
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    })
  ]);
}

/**
 * Create a new Razorpay Order
 * @param {Object} params - { amount (in INR), receipt, notes }
 * @returns {Promise<Object>} Razorpay Order details
 */
async function createRazorpayOrder({ amount, receipt, notes = {} }) {
  const rzp = getRazorpayInstance();
  const parsedAmount = parseFloat(amount);

  if (isNaN(parsedAmount) || parsedAmount < 1.0) {
    const err = new Error('Order amount must be at least ₹1.00');
    err.statusCode = 400;
    throw err;
  }

  const amountInPaise = Math.round(parsedAmount * 100);

  if (!rzp) {
    throw new Error('Razorpay credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured on server.');
  }

  const options = {
    amount: amountInPaise, // amount in smallest currency unit (paise)
    currency: 'INR',
    receipt: String(receipt || '').slice(0, 40),
    notes: typeof notes === 'object' && notes !== null ? notes : {}
  };

  try {
    return await withTimeout(rzp.orders.create(options), 10000, 'Razorpay order creation');
  } catch (error) {
    console.error('[Razorpay Service]: Unable to create order:', error?.message || 'unknown gateway error');
    const gatewayError = new Error('Payment gateway is temporarily unavailable. Please try again shortly.');
    gatewayError.statusCode = error.statusCode === 400 ? 400 : 503;
    throw gatewayError;
  }
}

/**
 * Verify Razorpay payment signature
 * generated_signature = hmac_sha256(order_id + "|" + razorpay_payment_id, secret)
 */
function verifyPaymentSignature(params) {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    orderId,
    paymentId,
    signature,
    secret
  } = params || {};

  const ordId = (razorpay_order_id || orderId);
  const payId = (razorpay_payment_id || paymentId);
  const sig = (razorpay_signature || signature);
  const sec = secret || config.razorpayKeySecret;

  if (!sec) {
    throw new Error('RAZORPAY_KEY_SECRET is missing on the server.');
  }

  if (typeof ordId !== 'string' || typeof payId !== 'string' || typeof sig !== 'string') {
    return false;
  }

  const cleanOrdId = ordId.trim();
  const cleanPayId = payId.trim();
  const cleanSig = sig.trim();

  if (!cleanOrdId || !cleanPayId || !cleanSig) {
    return false;
  }

  const body = `${cleanOrdId}|${cleanPayId}`;
  const expectedSignature = crypto
    .createHmac('sha256', sec)
    .update(body)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(cleanSig, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Verify Razorpay Webhook signature
 * @param {Buffer|string} rawBody
 * @param {string} signature - from 'x-razorpay-signature' header
 * @param {string} [secretOverride] - optional override for testing
 */
function verifyWebhookSignature(rawBody, signature, secretOverride) {
  const sec = secretOverride || config.razorpayWebhookSecret;
  if (!sec) {
    console.warn('⚠️ [Razorpay Webhook]: RAZORPAY_WEBHOOK_SECRET is not configured.');
    return false;
  }

  if (!rawBody || typeof signature !== 'string') {
    return false;
  }

  const cleanSignature = signature.trim();
  if (!cleanSignature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', sec)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(cleanSignature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Fetch Payment details from Razorpay with timeout
 */
async function fetchPaymentDetails(paymentId, timeoutMs = 6000) {
  const rzp = getRazorpayInstance();
  if (!rzp || !paymentId || typeof paymentId !== 'string') return null;

  try {
    return await withTimeout(rzp.payments.fetch(paymentId.trim()), timeoutMs, `Fetch payment ${paymentId}`);
  } catch (err) {
    console.error(`[Razorpay Service]: Error fetching payment ${paymentId}:`, err.message);
    return null;
  }
}

module.exports = {
  getRazorpayInstance,
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPaymentDetails
};
