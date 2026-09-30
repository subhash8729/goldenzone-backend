const express = require('express');
const router = express.Router();
const settingController = require('../controllers/settingController');
const { verifyAdminAuth } = require('../middleware/auth');
const { contactLimiter } = require('../middleware/rateLimiter');

router.get('/', settingController.getSettings);
router.put('/', verifyAdminAuth, settingController.updateSettings);

// Public Contact Page enquiry submission
router.post('/contact', contactLimiter, settingController.submitEnquiry);

// Admin: View customer enquiries
router.get('/enquiries', verifyAdminAuth, settingController.getEnquiries);

module.exports = router;
