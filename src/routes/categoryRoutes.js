const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { verifyAdminAuth } = require('../middleware/auth');

// Admin endpoints
router.get('/admin/all', verifyAdminAuth, categoryController.getAllCategoriesAdmin);
router.post('/', verifyAdminAuth, categoryController.createCategory);
router.put('/:id', verifyAdminAuth, categoryController.updateCategory);
router.delete('/:id', verifyAdminAuth, categoryController.deleteCategory);

// Public endpoint. Keep it after /admin/all so the admin list remains reachable.
router.get('/', categoryController.getCategories);

module.exports = router;
