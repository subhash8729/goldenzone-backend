const jwt = require('jsonwebtoken');
const config = require('../config/env');
const db = require('../config/db');

// Verify Customer JWT
async function verifyCustomerAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in.'
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwtSecret);

    if (decoded.isAdmin) {
      // Token is admin, not customer
      return res.status(403).json({
        success: false,
        message: 'Invalid customer token.'
      });
    }

    const customers = await db.query('SELECT * FROM customers WHERE id = ?', [decoded.id]);
    if (!customers || customers.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'User session not found or account no longer exists.'
      });
    }

    req.user = customers[0];
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid or corrupted token.' });
  }
}

// Optional Customer Auth (for checkout or reviews where guest or logged in)
async function optionalCustomerAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, config.jwtSecret);
      if (!decoded.isAdmin) {
        const customers = await db.query('SELECT * FROM customers WHERE id = ?', [decoded.id]);
        if (customers && customers.length > 0) {
          req.user = customers[0];
        }
      }
    }
  } catch (err) {
    // Ignore error for optional auth
  }
  next();
}

// Verify Admin JWT
async function verifyAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Admin authorization required. Please log in to admin panel.'
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwtSecret);

    if (!decoded.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Admin credentials required.'
      });
    }

    const admins = await db.query('SELECT id, mobile_number, full_name FROM admins WHERE id = ?', [decoded.id]);
    if (!admins || admins.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Admin account not found or session revoked.'
      });
    }

    req.admin = admins[0];
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Admin session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, message: 'Unauthorized admin request.' });
  }
}

module.exports = {
  verifyCustomerAuth,
  optionalCustomerAuth,
  verifyAdminAuth
};
