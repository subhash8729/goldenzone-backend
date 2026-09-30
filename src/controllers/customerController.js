const db = require('../config/db');

// Format relative date
function getRelativeTimeString(date) {
  const now = new Date();
  const diffSec = Math.floor((now - new Date(date)) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffDays = Math.floor(diffSec / 86400);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
}

// 1. Admin: Get customers list with stats
exports.getCustomers = async (req, res, next) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNumber - 1) * pageSize;
    const params = [];
    const countParams = [];

    let whereSql = '';
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      whereSql = `WHERE c.full_name LIKE ? OR c.mobile_number LIKE ? OR c.city LIKE ? OR c.state LIKE ?`;
      params.push(term, term, term, term);
      countParams.push(term, term, term, term);
    }

    const countRows = await db.query(`SELECT COUNT(*) as total FROM customers c ${whereSql}`, countParams);
    const totalItems = countRows[0].total;

    const customers = await db.query(
      `SELECT c.*,
              COUNT(CASE WHEN o.deleted_at IS NULL AND o.payment_status = 'PAID' THEN o.id END) as total_orders,
              COALESCE(SUM(CASE WHEN o.deleted_at IS NULL AND o.payment_status = 'PAID' THEN o.total_amount ELSE 0 END), 0) as total_spent,
              MAX(CASE WHEN o.deleted_at IS NULL AND o.payment_status = 'PAID' THEN o.created_at END) as last_order_date
       FROM customers c
       LEFT JOIN orders o ON o.user_id = c.id
       ${whereSql}
       GROUP BY c.id
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const formatted = customers.map((c) => ({
      ...c,
      total_orders: parseInt(c.total_orders, 10),
      total_spent: parseFloat(c.total_spent),
      relative_registered: getRelativeTimeString(c.created_at)
    }));

    return res.status(200).json({
      success: true,
      data: formatted,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    });
  } catch (error) {
    next(error);
  }
};

// 2. Admin: Get single customer detail and their complete order history
exports.getCustomerDetail = async (req, res, next) => {
  try {
    const { id } = req.params;
    const customerId = parseInt(id, 10);
    if (isNaN(customerId) || customerId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid customer ID' });
    }

    const customers = await db.query('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (customers.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const customer = customers[0];

    const orders = await db.query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       WHERE o.user_id = ? AND o.deleted_at IS NULL
       ORDER BY o.id DESC`,
      [customerId]
    );

    return res.status(200).json({
      success: true,
      customer: {
        ...customer,
        relative_registered: getRelativeTimeString(customer.created_at)
      },
      orders: orders.map((o) => ({
        ...o,
        subtotal: parseFloat(o.subtotal),
        total_amount: parseFloat(o.total_amount),
        advance_amount: parseFloat(o.advance_amount || 0),
        remaining_cod_amount: parseFloat(o.remaining_cod_amount || 0),
        payment_mode: o.payment_mode || 'ONLINE',
        is_shipped: Boolean(o.is_shipped),
        is_delivered: Boolean(o.is_delivered)
      }))
    });
  } catch (error) {
    next(error);
  }
};
