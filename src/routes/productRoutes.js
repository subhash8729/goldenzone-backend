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

// Dedicated Product Image Management endpoints
router.get('/:id/images', verifyAdminAuth, productController.getProductImages);
router.post('/:id/images', verifyAdminAuth, productController.addProductImage);
router.delete('/:productId/images/:imageId', verifyAdminAuth, productController.deleteProductImage);
router.patch('/:productId/images/:imageId/primary', verifyAdminAuth, productController.setPrimaryProductImage);
router.put('/:productId/images/reorder', verifyAdminAuth, productController.reorderProductImages);

// Public endpoints. Dynamic routes must be last so they do not shadow /admin/all or sub-resources.
router.get('/', productController.getProducts);
router.get('/:identifier', productController.getProductDetail);

module.exports = router;
