const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { verifyCustomerAuth, verifyAdminAuth } = require('../middleware/auth');
const { orderLimiter } = require('../middleware/rateLimiter');

// Customer / Storefront payment verification & failure handling
router.post('/verify', verifyCustomerAuth, orderLimiter, paymentController.verifyPayment);
router.post('/failed', verifyCustomerAuth, paymentController.handlePaymentFailed);

// Official Razorpay Webhook endpoint
router.post('/webhook', paymentController.handleWebhook);

// Admin payment records & transaction logs
router.get('/admin/all', verifyAdminAuth, paymentController.getPayments);

module.exports = router;
