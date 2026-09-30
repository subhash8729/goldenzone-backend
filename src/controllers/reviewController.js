const db = require('../config/db');
const { logAdminAction } = require('./authController');

// 1. Get reviews for a product
exports.getProductReviews = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const reviews = await db.query(
      `SELECT r.*, p.name as product_name
       FROM reviews r
       LEFT JOIN products p ON r.product_id = p.id
       WHERE r.product_id = ? AND r.is_approved = 1
       ORDER BY r.id DESC`,
      [productId]
    );

    return res.status(200).json({
      success: true,
      data: reviews
    });
  } catch (error) {
    next(error);
  }
};

// 2. Submit a review (Customer/Visitor)
exports.submitReview = async (req, res, next) => {
  try {
    const { product_id, rating, review_text, image_url } = req.body;
    const customer = req.user;

    if (!product_id || !rating || !review_text?.trim()) {
      return res.status(400).json({ success: false, message: 'A rating and review are required' });
    }

    const numRating = Math.max(1, Math.min(5, parseInt(rating, 10)));
    if (Number.isNaN(numRating)) {
      return res.status(400).json({ success: false, message: 'Please choose a rating from 1 to 5.' });
    }

    const purchases = await db.query(
      `SELECT 1
       FROM order_items oi
       INNER JOIN orders o ON o.id = oi.order_id
       WHERE o.user_id = ? AND oi.product_id = ?
         AND o.payment_status = 'PAID' AND o.deleted_at IS NULL
       LIMIT 1`,
      [customer.id, product_id]
    );
    if (purchases.length === 0) {
      return res.status(403).json({ success: false, message: 'Only customers who purchased this item can submit a review.' });
    }

    const customerName = customer.full_name && customer.full_name !== 'Not Named'
      ? customer.full_name
      : `Customer #${customer.id}`;

    const result = await db.query(
      `INSERT INTO reviews (product_id, customer_name, rating, review_text, image_url, is_approved)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [product_id, customerName, numRating, review_text.trim(), image_url || null]
    );

    return res.status(201).json({
      success: true,
      message: 'Review submitted for approval',
      reviewId: result.insertId
    });
  } catch (error) {
    next(error);
  }
};

// 3. Admin: Get all reviews
exports.getAdminReviews = async (req, res, next) => {
  try {
    const reviews = await db.query(
      `SELECT r.*, p.name as product_name, p.sku as product_sku
       FROM reviews r
       LEFT JOIN products p ON r.product_id = p.id
       ORDER BY r.id DESC`
    );

    return res.status(200).json({
      success: true,
      data: reviews
    });
  } catch (error) {
    next(error);
  }
};

// 4. Admin: Toggle approve / hide review
exports.toggleReviewApproval = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_approved } = req.body;

    await db.query('UPDATE reviews SET is_approved = ? WHERE id = ?', [is_approved ? 1 : 0, id]);
    await logAdminAction(req.admin.id, 'REVIEW_VISIBILITY_TOGGLED', 'REVIEW', id, { is_approved });

    return res.status(200).json({
      success: true,
      message: `Review ${is_approved ? 'approved' : 'hidden'} successfully`
    });
  } catch (error) {
    next(error);
  }
};

// 5. Admin: Delete review
exports.deleteReview = async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM reviews WHERE id = ?', [id]);
    await logAdminAction(req.admin.id, 'REVIEW_DELETED', 'REVIEW', id);

    return res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
