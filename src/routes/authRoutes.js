const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyCustomerAuth, verifyAdminAuth } = require('../middleware/auth');
const { otpLimiter, loginLimiter } = require('../middleware/rateLimiter');

// Customer Auth Routes
router.post('/customer/send-otp', otpLimiter, authController.sendCustomerOtp);
router.post('/customer/verify-otp', loginLimiter, authController.verifyCustomerOtp);
router.get('/customer/profile', verifyCustomerAuth, authController.getCustomerProfile);
router.put('/customer/profile', verifyCustomerAuth, authController.updateCustomerProfile);

// Admin Auth Routes
router.post('/admin/send-otp', otpLimiter, authController.adminSendOtp);
router.post('/admin/login', loginLimiter, authController.adminLogin);
router.get('/admin/profile', verifyAdminAuth, authController.getAdminProfile);
router.put('/admin/change-password', verifyAdminAuth, authController.adminChangePassword);

module.exports = router;
