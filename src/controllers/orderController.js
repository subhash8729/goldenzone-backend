const db = require('../config/db');
const config = require('../config/env');
const razorpayService = require('../services/razorpayService');
const { logAdminAction } = require('./authController');

// Format dynamic relative time
function getRelativeTimeString(date) {
  const now = new Date();
  const diffSec = Math.floor((now - new Date(date)) / 1000);

  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min${diffMin > 1 ? 's' : ''} ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
}

// Format full readable date e.g. "18 Sep 2026, 10:45 PM"
function formatReadableDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// ----------------------------------------------------
// CUSTOMER ORDER ENDPOINTS
// ----------------------------------------------------

// 1. Create order & initiate Razorpay payment with full transaction & server-side validation
exports.createOrder = async (req, res, next) => {
  try {
    const customerId = req.user.id;
    const {
      full_name,
      primary_mobile,
      secondary_mobile,
      address,
      state,
      district,
      city,
      village,
      pincode,
      latitude,
      longitude,
      items
    } = req.body;

    // Validate delivery details
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }
    const cleanPrimaryMobile = String(primary_mobile || '').replace(/\D/g, '').slice(-10);
    const cleanSecondaryMobile = secondary_mobile ? String(secondary_mobile).replace(/\D/g, '').slice(-10) : null;
    const cleanPincode = String(pincode || '').trim();

    if (cleanPrimaryMobile.length !== 10) {
      return res.status(400).json({ success: false, message: 'Primary mobile number is required' });
    }
    if (!address || !address.trim()) {
      return res.status(400).json({ success: false, message: 'Delivery address is required' });
    }
    if (!state || !district || !cleanPincode) {
      return res.status(400).json({ success: false, message: 'State, District, and PIN code are required' });
    }
    if (!/^\d{6}$/.test(cleanPincode)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid 6-digit PIN code.' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Your cart is empty' });
    }
    if (items.length > 50) {
      return res.status(400).json({ success: false, message: 'Your cart contains too many different items.' });
    }

    // Prepare Google Maps URL if coordinates provided
    let mapsUrl = null;
    let validLat = null;
    let validLng = null;

    if (latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined && !isNaN(parseFloat(latitude)) && !isNaN(parseFloat(longitude))) {
      validLat = parseFloat(latitude);
      validLng = parseFloat(longitude);
      if (validLat < -90 || validLat > 90 || validLng < -180 || validLng > 180) {
        return res.status(400).json({ success: false, message: 'Location coordinates are invalid.' });
      }
      mapsUrl = `https://www.google.com/maps?q=${validLat},${validLng}`;
    }

    // Unique human-readable Order Number
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    const orderNumber = `GZ-${Date.now().toString().slice(-6)}-${randomPart}`;

    // Execute order creation within a MySQL transaction
    const orderResult = await db.withTransaction(async (conn) => {
      let subtotal = 0;
      const verifiedItems = [];

      // Fetch and validate every product strictly from database (anti-tampering)
      for (const item of items) {
        const prodId = parseInt(item.product_id || item.id, 10);
        const qty = parseInt(item.quantity, 10);

        if (isNaN(qty) || qty <= 0 || qty > 20) {
          throw new Error('Invalid product quantity.');
        }

        const [prodRows] = await conn.execute(
          `SELECT p.*,
                  (SELECT pi.image_url 
                   FROM product_images pi 
                   WHERE pi.product_id = p.id 
                   ORDER BY pi.image_order ASC 
                   LIMIT 1) as primary_image
           FROM products p
           WHERE p.id = ? AND p.deleted_at IS NULL FOR UPDATE`,
          [prodId]
        );

        if (prodRows.length === 0) {
          throw new Error(`Product with ID ${prodId} not found or no longer available.`);
        }

        const product = prodRows[0];

        if (!product.is_active) {
          throw new Error(`Product "${product.name}" is currently unavailable.`);
        }

        if (product.is_out_of_stock) {
          throw new Error(`Product "${product.name}" is out of stock.`);
        }

        const unitPrice = parseFloat(product.discounted_price);
        const itemSubtotal = unitPrice * qty;
        subtotal += itemSubtotal;

        verifiedItems.push({
          productId: product.id,
          name: product.name,
          sku: product.sku,
          image: product.primary_image || '',
          unitPrice,
          quantity: qty,
          subtotalPrice: itemSubtotal
        });
      }

      const shippingAmount = 0.0; // Free delivery across India
      const totalAmount = subtotal + shippingAmount;

      // Determine Payment Mode & Calculate Advance vs COD Balance strictly on server
      const paymentMode = (req.body.payment_mode || 'ONLINE').toUpperCase() === 'COD' ? 'COD' : 'ONLINE';
      let advanceAmount = totalAmount;
      let remainingCodAmount = 0.0;
      let payableAmount = totalAmount;

      if (paymentMode === 'COD') {
        // ₹200 advance applies to every COD order; if order <= ₹200, collect only total amount
        advanceAmount = Math.min(200.0, totalAmount);
        remainingCodAmount = Math.max(0.0, totalAmount - advanceAmount);
        payableAmount = advanceAmount;
      }

      // Create Razorpay Order via official service for the exact payable amount
      const rzpOrder = await razorpayService.createRazorpayOrder({
        amount: payableAmount,
        receipt: orderNumber,
        notes: {
          orderNumber,
          customerId,
        customerMobile: cleanPrimaryMobile,
          payment_mode: paymentMode,
          total_amount: String(totalAmount),
          advance_amount: String(advanceAmount),
          remaining_cod_amount: String(remainingCodAmount)
        }
      });

      // Store checkout draft in order_drafts table (No confirmed order created until payment verification!)
      const deliveryDetails = {
        full_name: full_name.trim(),
        primary_mobile: cleanPrimaryMobile,
        secondary_mobile: cleanSecondaryMobile && cleanSecondaryMobile.length === 10 ? cleanSecondaryMobile : null,
        address: address.trim(),
        state: state.trim(),
        district: district.trim(),
        city: city ? city.trim() : null,
        village: village ? village.trim() : null,
        pincode: cleanPincode,
        validLat,
        validLng,
        mapsUrl
      };

      await conn.execute(
        `INSERT INTO order_drafts (
          razorpay_order_id, user_id, order_number, delivery_details, items_data,
          subtotal, shipping_amount, total_amount, payment_mode, advance_amount,
          remaining_cod_amount, payable_amount, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIATED')`,
        [
          rzpOrder.id,
          customerId,
          orderNumber,
          JSON.stringify(deliveryDetails),
          JSON.stringify(verifiedItems),
          subtotal,
          shippingAmount,
          totalAmount,
          paymentMode,
          advanceAmount,
          remainingCodAmount,
          payableAmount
        ]
      );

      return {
        orderNumber,
        totalAmount,
        advanceAmount,
        remainingCodAmount,
        paymentMode,
        payableAmount,
        itemCount: verifiedItems.length,
        razorpayOrderId: rzpOrder.id,
        razorpayKeyId: config.razorpayKeyId,
        currency: 'INR'
      };
    });

    return res.status(201).json({
      success: true,
      message: 'Checkout initialized. Please complete payment via Razorpay.',
      order: orderResult
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    if (error.message && (error.message.includes('out of stock') || error.message.includes('unavailable') || error.message.includes('not found'))) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// 2. Get customer's saved address for prefill modal
exports.getSavedAddress = async (req, res, next) => {
  try {
    const customerId = req.user.id;
    const rows = await db.query(
      `SELECT full_name, secondary_mobile, address, state, district, city, village, pincode
       FROM customers
       WHERE id = ?`,
      [customerId]
    );

    if (rows.length === 0 || !rows[0].address) {
      return res.status(200).json({
        success: true,
        hasSavedDetails: false,
        details: null
      });
    }

    return res.status(200).json({
      success: true,
      hasSavedDetails: true,
      details: rows[0]
    });
  } catch (error) {
    next(error);
  }
};

// 3. Get customer's orders
exports.getCustomerOrders = async (req, res, next) => {
  try {
    const customerId = req.user.id;

    const orders = await db.query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       WHERE o.user_id = ? AND o.deleted_at IS NULL AND o.payment_status = 'PAID'
       ORDER BY o.created_at DESC`,
      [customerId]
    );

    const formattedOrders = [];
    for (const ord of orders) {
      const items = await db.query(
        `SELECT * FROM order_items WHERE order_id = ?`,
        [ord.id]
      );

      formattedOrders.push({
        ...ord,
        subtotal: parseFloat(ord.subtotal),
        total_amount: parseFloat(ord.total_amount),
        advance_amount: parseFloat(ord.advance_amount || 0),
        remaining_cod_amount: parseFloat(ord.remaining_cod_amount || 0),
        payment_mode: ord.payment_mode || 'ONLINE',
        relative_time: getRelativeTimeString(ord.created_at),
        formatted_date: formatReadableDate(ord.created_at),
        items: items.map((it) => ({
          ...it,
          unit_price: parseFloat(it.unit_price),
          subtotal_price: parseFloat(it.subtotal_price)
        }))
      });
    }

    return res.status(200).json({
      success: true,
      orders: formattedOrders
    });
  } catch (error) {
    next(error);
  }
};

// 4. Get single order tracking details by orderNumber
exports.getOrderByNumber = async (req, res, next) => {
  try {
    const { orderNumber } = req.params;
    const customerId = req.user?.id;

    if (!customerId) {
      return res.status(401).json({ success: false, message: 'Please log in to view order tracking.' });
    }

    const orders = await db.query(
      `SELECT * FROM orders WHERE order_number = ? AND deleted_at IS NULL LIMIT 1`,
      [orderNumber]
    );

    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = orders[0];

    // Tracking data includes address and payment information; it is only visible to the owner.
    if (order.user_id !== customerId) {
      return res.status(403).json({ success: false, message: 'Access denied to this order.' });
    }

    const items = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    const payments = await db.query('SELECT * FROM payments WHERE order_id = ?', [order.id]);

    // Construct Flipkart-style Tracking Status
    let trackingStep = 1; // 1 = ORDERED
    let currentStatusText = 'ORDERED';

    if (order.is_shipped) {
      trackingStep = 2; // 2 = SHIPPED
      currentStatusText = 'SHIPPED';
    }
    if (order.is_delivered) {
      trackingStep = 3; // 3 = DELIVERED
      currentStatusText = 'DELIVERED';
    }

    const trackingTimeline = [
      {
        step: 1,
        title: order.payment_mode === 'COD' ? 'ORDERED & ADVANCE PAID' : 'ORDERED & PAID',
        description: order.payment_status === 'PAID'
          ? (order.payment_mode === 'COD'
              ? `Advance of ₹${parseFloat(order.advance_amount || 0).toLocaleString('en-IN')} confirmed via Razorpay. Remaining balance ₹${parseFloat(order.remaining_cod_amount || 0).toLocaleString('en-IN')} payable on delivery.`
              : 'Payment confirmed via Razorpay. Order received by Golden Zone.')
          : 'Order placed, awaiting Razorpay payment confirmation.',
        isCompleted: true,
        timestamp: order.created_at,
        formattedTimestamp: formatReadableDate(order.created_at)
      },
      {
        step: 2,
        title: 'SHIPPED',
        description: order.is_shipped
          ? 'Your jewellery has been safely packaged and handed over for delivery.'
          : 'Package is being prepared for dispatch.',
        isCompleted: Boolean(order.is_shipped),
        timestamp: order.shipped_at,
        formattedTimestamp: formatReadableDate(order.shipped_at)
      },
      {
        step: 3,
        title: 'DELIVERED',
        description: order.is_delivered
          ? 'Order delivered successfully. Thank you for choosing Golden Zone!'
          : 'Delivery in progress to your designated address.',
        isCompleted: Boolean(order.is_delivered),
        timestamp: order.delivered_at,
        formattedTimestamp: formatReadableDate(order.delivered_at)
      }
    ];

    const { admin_remark: _unused, ...customerSafeOrder } = order;

    return res.status(200).json({
      success: true,
      order: {
        ...customerSafeOrder,
        subtotal: parseFloat(order.subtotal),
        total_amount: parseFloat(order.total_amount),
        advance_amount: parseFloat(order.advance_amount || 0),
        remaining_cod_amount: parseFloat(order.remaining_cod_amount || 0),
        payment_mode: order.payment_mode || 'ONLINE',
        relative_time: getRelativeTimeString(order.created_at),
        formatted_date: formatReadableDate(order.created_at),
        tracking_step: trackingStep,
        current_status: currentStatusText,
        timeline: trackingTimeline,
        payments: payments.map((p) => ({
          id: p.id,
          amount: parseFloat(p.amount),
          payment_method: p.payment_method,
          payment_status: p.payment_status,
          transaction_id: p.transaction_id || p.razorpay_payment_id,
          razorpay_payment_id: p.razorpay_payment_id,
          formatted_date: formatReadableDate(p.created_at)
        })),
        items: items.map((it) => ({
          ...it,
          unit_price: parseFloat(it.unit_price),
          subtotal_price: parseFloat(it.subtotal_price)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------
// ADMIN ORDER MANAGEMENT ENDPOINTS
// ----------------------------------------------------

// 1. Admin: Get all orders with multi-filter, search, and pagination
exports.getAdminOrders = async (req, res, next) => {
  try {
    const {
      status, // 'all', 'ordered', 'shipped', 'delivered', 'deleted'
      date_filter, // 'today', 'yesterday', '7days', '30days', 'custom'
      start_date,
      end_date,
      search,
      page = 1,
      limit = 30
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const offset = (pageNumber - 1) * pageSize;
    const params = [];
    const countParams = [];

    let whereConditions = [];

    // Status filtering
    if (status === 'deleted') {
      whereConditions.push(`o.deleted_at IS NOT NULL`);
    } else {
      whereConditions.push(`o.deleted_at IS NULL`);
      if (status === 'ordered') {
        whereConditions.push(`o.is_shipped = 0 AND o.is_delivered = 0`);
      } else if (status === 'shipped') {
        whereConditions.push(`o.is_shipped = 1 AND o.is_delivered = 0`);
      } else if (status === 'delivered') {
        whereConditions.push(`o.is_delivered = 1`);
      }
    }

    // Date range filtering
    if (date_filter === 'today') {
      whereConditions.push(`DATE(o.created_at) = CURDATE()`);
    } else if (date_filter === 'yesterday') {
      whereConditions.push(`DATE(o.created_at) = SUBDATE(CURDATE(), 1)`);
    } else if (date_filter === '7days') {
      whereConditions.push(`o.created_at >= NOW() - INTERVAL 7 DAY`);
    } else if (date_filter === '30days') {
      whereConditions.push(`o.created_at >= NOW() - INTERVAL 30 DAY`);
    } else if (date_filter === 'custom' && start_date && end_date) {
      whereConditions.push(`o.created_at BETWEEN ? AND ?`);
      params.push(start_date, end_date);
      countParams.push(start_date, end_date);
    }

    // Search query
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      whereConditions.push(`(o.order_number LIKE ? OR o.full_name LIKE ? OR o.primary_mobile LIKE ?)`);
      params.push(term, term, term);
      countParams.push(term, term, term);
    }

    const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const countRows = await db.query(`SELECT COUNT(*) as total FROM orders o ${whereSql}`, countParams);
    const totalItems = countRows[0].total;

    const orders = await db.query(
      `SELECT o.*, c.mobile_number as registered_mobile,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN customers c ON o.user_id = c.id
       ${whereSql}
       ORDER BY o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const formatted = orders.map((o) => ({
      ...o,
      subtotal: parseFloat(o.subtotal),
      total_amount: parseFloat(o.total_amount),
      advance_amount: parseFloat(o.advance_amount || 0),
      remaining_cod_amount: parseFloat(o.remaining_cod_amount || 0),
      payment_mode: o.payment_mode || 'ONLINE',
      relative_time: getRelativeTimeString(o.created_at),
      formatted_date: formatReadableDate(o.created_at),
      formatted_shipped_date: o.shipped_at ? formatReadableDate(o.shipped_at) : null,
      formatted_delivered_date: o.delivered_at ? formatReadableDate(o.delivered_at) : null,
      directions_url: (o.latitude && o.longitude)
        ? `https://www.google.com/maps/dir/?api=1&destination=${o.latitude},${o.longitude}`
        : null
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

// 2. Admin: Get full order details with items for modal
exports.getAdminOrderDetail = async (req, res, next) => {
  try {
    const { id } = req.params;

    const orders = await db.query(
      `SELECT o.*, c.mobile_number as registered_mobile
       FROM orders o
       LEFT JOIN customers c ON o.user_id = c.id
       WHERE o.id = ?`,
      [id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = orders[0];
    const items = await db.query('SELECT * FROM order_items WHERE order_id = ?', [id]);
    const payments = await db.query('SELECT * FROM payments WHERE order_id = ?', [id]);

    return res.status(200).json({
      success: true,
      order: {
        ...order,
        subtotal: parseFloat(order.subtotal),
        total_amount: parseFloat(order.total_amount),
        advance_amount: parseFloat(order.advance_amount || 0),
        remaining_cod_amount: parseFloat(order.remaining_cod_amount || 0),
        payment_mode: order.payment_mode || 'ONLINE',
        relative_time: getRelativeTimeString(order.created_at),
        formatted_date: formatReadableDate(order.created_at),
        directions_url: (order.latitude && order.longitude)
          ? `https://www.google.com/maps/dir/?api=1&destination=${order.latitude},${order.longitude}`
          : null,
        items: items.map((it) => ({
          ...it,
          unit_price: parseFloat(it.unit_price),
          subtotal_price: parseFloat(it.subtotal_price)
        })),
        payments: payments.map((p) => ({
          ...p,
          amount: parseFloat(p.amount)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

// 3. Admin: Update order status (Shipped & Delivered rules enforced)
exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_shipped, is_delivered } = req.body;

    const orders = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const currentOrder = orders[0];
    const targetShipped = is_shipped !== undefined ? Boolean(is_shipped) : Boolean(currentOrder.is_shipped);
    let targetDelivered = is_delivered !== undefined ? Boolean(is_delivered) : Boolean(currentOrder.is_delivered);

    // If Shipped is unticked or false, Delivered must automatically become false
    if (!targetShipped) {
      targetDelivered = false;
    }

    // Rule: Delivered cannot be explicitly set if Shipped is false
    if (Boolean(is_delivered) && !targetShipped) {
      return res.status(400).json({
        success: false,
        message: 'Order must be marked as Shipped before it can be marked as Delivered.'
      });
    }

    const newShipped = targetShipped ? 1 : 0;
    const newDelivered = targetDelivered ? 1 : 0;

    const shippedAt = newShipped ? (currentOrder.shipped_at || new Date()) : null;
    const deliveredAt = newDelivered ? (currentOrder.delivered_at || new Date()) : null;

    await db.query(
      `UPDATE orders
       SET is_shipped = ?,
           shipped_at = ?,
           is_delivered = ?,
           delivered_at = ?
       WHERE id = ?`,
      [newShipped, shippedAt, newDelivered, deliveredAt, id]
    );

    await logAdminAction(req.admin.id, 'ORDER_STATUS_UPDATED', 'ORDER', id, {
      is_shipped: newShipped,
      is_delivered: newDelivered
    });

    return res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      is_shipped: Boolean(newShipped),
      is_delivered: Boolean(newDelivered),
      shipped_at: shippedAt,
      delivered_at: deliveredAt
    });
  } catch (error) {
    next(error);
  }
};

// 4. Admin: Soft delete order
exports.softDeleteOrder = async (req, res, next) => {
  try {
    const { id } = req.params;

    const orders = await db.query('SELECT order_number FROM orders WHERE id = ?', [id]);
    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    await db.query('UPDATE orders SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    await logAdminAction(req.admin.id, 'ORDER_SOFT_DELETED', 'ORDER', id, {
      order_number: orders[0].order_number
    });

    return res.status(200).json({
      success: true,
      message: 'Order moved to Deleted Orders (soft deleted)'
    });
  } catch (error) {
    next(error);
  }
};

// 5. Admin: Save or update admin remark
exports.updateOrderRemark = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    await db.query('UPDATE orders SET admin_remark = ? WHERE id = ?', [remark || '', id]);
    await logAdminAction(req.admin.id, 'ORDER_REMARK_SAVED', 'ORDER', id, { remark });

    return res.status(200).json({
      success: true,
      message: 'Admin remark saved successfully',
      admin_remark: remark
    });
  } catch (error) {
    next(error);
  }
};
