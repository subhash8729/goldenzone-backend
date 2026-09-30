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
 * Create a new Razorpay Order
 * @param {Object} params - { amount (in INR), receipt, notes }
 * @returns {Promise<Object>} Razorpay Order details
 */
async function createRazorpayOrder({ amount, receipt, notes = {} }) {
  const rzp = getRazorpayInstance();
  const amountInPaise = Math.round(parseFloat(amount) * 100);

  if (!rzp) {
    throw new Error('Razorpay credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured on server.');
  }

  const options = {
    amount: amountInPaise, // amount in smallest currency unit (paise)
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
    notes
  };

  try {
    return await rzp.orders.create(options);
  } catch (error) {
    // The SDK can throw malformed network errors (without response/status). Do not expose
    // those internals or leave callers with an unusable checkout state.
    console.error('[Razorpay Service]: Unable to create order:', error?.message || 'unknown gateway error');
    const gatewayError = new Error('Payment gateway is temporarily unavailable. Please try again shortly.');
    gatewayError.statusCode = 503;
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

  const ordId = razorpay_order_id || orderId;
  const payId = razorpay_payment_id || paymentId;
  const sig = razorpay_signature || signature;
  const sec = secret || config.razorpayKeySecret;

  if (!sec) {
    throw new Error('RAZORPAY_KEY_SECRET is missing on the server.');
  }

  if (!ordId || !payId || !sig) {
    return false;
  }

  const body = ordId + '|' + payId;
  const expectedSignature = crypto
    .createHmac('sha256', sec)
    .update(body.toString())
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(sig, 'utf8');

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

  if (!rawBody || !signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', sec)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Fetch Payment details from Razorpay
 */
async function fetchPaymentDetails(paymentId) {
  const rzp = getRazorpayInstance();
  if (!rzp) return null;

  try {
    return await rzp.payments.fetch(paymentId);
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
