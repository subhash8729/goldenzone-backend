const db = require('../config/db');

exports.getDashboardStats = async (req, res, next) => {
  try {
    const { date_filter = 'all', start_date, end_date } = req.query;

    let dateWhereOrders = `WHERE deleted_at IS NULL`;
    const params = [];

    if (date_filter === 'today') {
      dateWhereOrders += ` AND DATE(created_at) = CURDATE()`;
    } else if (date_filter === '7days') {
      dateWhereOrders += ` AND created_at >= NOW() - INTERVAL 7 DAY`;
    } else if (date_filter === '30days') {
      dateWhereOrders += ` AND created_at >= NOW() - INTERVAL 30 DAY`;
    } else if (date_filter === 'this_month') {
      dateWhereOrders += ` AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())`;
    } else if (date_filter === 'custom' && start_date && end_date) {
      dateWhereOrders += ` AND created_at BETWEEN ? AND ?`;
      params.push(start_date, end_date);
    }

    // 1. Product stats
    const prodRows = await db.query(
      `SELECT 
        COUNT(*) as total_products,
        SUM(CASE WHEN is_active = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END) as active_products,
        SUM(CASE WHEN is_out_of_stock = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END) as out_of_stock_products,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) as deleted_products
       FROM products`
    );
    const prodStats = prodRows[0] || {};

    // 2. Customer count
    const custRows = await db.query(`SELECT COUNT(*) as total_customers FROM customers`);
    const custStats = custRows[0] || {};

    // 3. Order counts & revenue (strictly paid non-deleted orders)
    const orderRows = await db.query(
      `SELECT 
        COUNT(CASE WHEN payment_status = 'PAID' THEN 1 END) as total_orders,
        SUM(CASE WHEN payment_status = 'PAID' AND is_shipped = 0 AND is_delivered = 0 THEN 1 ELSE 0 END) as pending_orders,
        SUM(CASE WHEN payment_status = 'PAID' AND is_shipped = 1 AND is_delivered = 0 THEN 1 ELSE 0 END) as shipped_orders,
        SUM(CASE WHEN payment_status = 'PAID' AND is_delivered = 1 THEN 1 ELSE 0 END) as delivered_orders,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN total_amount ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' AND is_delivered = 1 THEN total_amount ELSE 0 END), 0) as delivered_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' AND is_delivered = 0 THEN total_amount ELSE 0 END), 0) as pending_revenue
       FROM orders
       ${dateWhereOrders}`,
      params
    );
    const orderStats = orderRows[0] || {};

    // 4. Deleted orders count
    const deletedRows = await db.query(
      `SELECT COUNT(*) as deleted_orders FROM orders WHERE deleted_at IS NOT NULL`
    );
    const deletedOrdersStats = deletedRows[0] || {};

    // 5. Today's and This Month's Revenue (always calculated for reference)
    const todayRevRows = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) as today_rev 
       FROM orders 
       WHERE deleted_at IS NULL AND payment_status = 'PAID' AND DATE(created_at) = CURDATE()`
    );
    const todayRevenue = todayRevRows[0] || {};

    const monthRevRows = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) as month_rev 
       FROM orders 
       WHERE deleted_at IS NULL AND payment_status = 'PAID' AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())`
    );
    const thisMonthRevenue = monthRevRows[0] || {};

    // 6. Recent 5 orders for dashboard glance
    const recentOrders = await db.query(
      `SELECT id, order_number, full_name, primary_mobile, total_amount, is_shipped, is_delivered, created_at
       FROM orders
       WHERE deleted_at IS NULL
       ORDER BY id DESC
       LIMIT 5`
    );

    return res.status(200).json({
      success: true,
      stats: {
        products: {
          total: parseInt(prodStats.total_products || 0, 10),
          active: parseInt(prodStats.active_products || 0, 10),
          outOfStock: parseInt(prodStats.out_of_stock_products || 0, 10),
          deleted: parseInt(prodStats.deleted_products || 0, 10)
        },
        customers: {
          total: parseInt(custStats.total_customers || 0, 10)
        },
        orders: {
          total: parseInt(orderStats.total_orders || 0, 10),
          pending: parseInt(orderStats.pending_orders || 0, 10),
          shipped: parseInt(orderStats.shipped_orders || 0, 10),
          delivered: parseInt(orderStats.delivered_orders || 0, 10),
          deleted: parseInt(deletedOrdersStats.deleted_orders || 0, 10)
        },
        revenue: {
          total: parseFloat(orderStats.total_revenue || 0),
          delivered: parseFloat(orderStats.delivered_revenue || 0),
          pending: parseFloat(orderStats.pending_revenue || 0),
          today: parseFloat(todayRevenue.today_rev || 0),
          thisMonth: parseFloat(thisMonthRevenue.month_rev || 0)
        },
        recentOrders: (recentOrders || []).map((ro) => ({
          ...ro,
          total_amount: parseFloat(ro.total_amount)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};
