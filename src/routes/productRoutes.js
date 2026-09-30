const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { verifyAdminAuth } = require('../middleware/auth');

// Admin protected endpoints
router.get('/admin/all', verifyAdminAuth, productController.getAdminProducts);
router.post('/', verifyAdminAuth, productController.createProduct);
router.put('/:id', verifyAdminAuth, productController.updateProduct);
router.delete('/:id', verifyAdminAuth, productController.deleteProduct);
router.patch('/:id/toggle', verifyAdminAuth, productController.toggleProductFlag);

// Public endpoints. Dynamic routes must be last so they do not shadow /admin/all.
router.get('/', productController.getProducts);
router.get('/:identifier', productController.getProductDetail);

module.exports = router;
