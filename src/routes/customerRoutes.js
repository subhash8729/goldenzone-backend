const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const { verifyAdminAuth } = require('../middleware/auth');

router.get('/admin/all', verifyAdminAuth, customerController.getCustomers);
router.get('/admin/:id', verifyAdminAuth, customerController.getCustomerDetail);

module.exports = router;
