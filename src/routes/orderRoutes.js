const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { verifyCustomerAuth, verifyAdminAuth, optionalCustomerAuth } = require('../middleware/auth');
const { orderLimiter } = require('../middleware/rateLimiter');

// Customer endpoints
router.post('/', verifyCustomerAuth, orderLimiter, orderController.createOrder);
router.get('/customer/saved-address', verifyCustomerAuth, orderController.getSavedAddress);
router.get('/customer/my-orders', verifyCustomerAuth, orderController.getCustomerOrders);
router.get('/track/:orderNumber', optionalCustomerAuth, orderController.getOrderByNumber);

// Admin endpoints
router.get('/admin/all', verifyAdminAuth, orderController.getAdminOrders);
router.get('/admin/:id', verifyAdminAuth, orderController.getAdminOrderDetail);
router.patch('/admin/:id/status', verifyAdminAuth, orderController.updateOrderStatus);
router.patch('/admin/:id/remark', verifyAdminAuth, orderController.updateOrderRemark);
router.delete('/admin/:id', verifyAdminAuth, orderController.softDeleteOrder);

module.exports = router;
