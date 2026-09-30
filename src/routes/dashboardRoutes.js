const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { verifyAdminAuth } = require('../middleware/auth');

router.get('/stats', verifyAdminAuth, dashboardController.getDashboardStats);

module.exports = router;
