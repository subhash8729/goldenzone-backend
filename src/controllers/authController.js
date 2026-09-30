const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const config = require('../config/env');
const otpService = require('../services/otpService');

// Helper to record admin audit logs
async function logAdminAction(adminId, action, targetType, targetId, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [adminId, action, targetType, String(targetId || ''), JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('Audit log failure:', err.message);
  }
}

// ----------------------------------------------------
// CUSTOMER AUTHENTICATION
// ----------------------------------------------------

// 1. Send OTP to customer
exports.sendCustomerOtp = async (req, res, next) => {
  try {
    const { mobile_number } = req.body;
    if (!mobile_number) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }

    const cleanMobile = mobile_number.replace(/\D/g, '').slice(-10);
    if (cleanMobile.length !== 10) {
      return res.status(400).json({ success: false, message: 'Please provide a valid 10-digit mobile number' });
    }

    const result = await otpService.sendOtp(cleanMobile);
    return res.status(200).json({
      success: true,
      message: result.message,
      mobile: cleanMobile
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// 2. Verify OTP for customer
exports.verifyCustomerOtp = async (req, res, next) => {
  try {
    const { mobile_number, otp } = req.body;
    if (!mobile_number || !otp) {
      return res.status(400).json({ success: false, message: 'Mobile number and OTP are required' });
    }

    const cleanMobile = mobile_number.replace(/\D/g, '').slice(-10);
    const verifyResult = await otpService.verifyOtp(cleanMobile, otp);
    if (!verifyResult.success) {
      return res.status(400).json({ success: false, message: verifyResult.message });
    }

    // Check if customer exists in DB
    let customers = await db.query('SELECT * FROM customers WHERE mobile_number = ?', [cleanMobile]);
    let isNewUser = false;
    let customer = null;

    if (customers.length === 0) {
      isNewUser = true;
      const insertResult = await db.query(
        `INSERT INTO customers (mobile_number, full_name) VALUES (?, 'Not Named')`,
        [cleanMobile]
      );
      const newId = insertResult.insertId;
      const newCustomers = await db.query('SELECT * FROM customers WHERE id = ?', [newId]);
      customer = newCustomers[0];
    } else {
      customer = customers[0];
    }

    // Generate JWT
    const token = jwt.sign(
      { id: customer.id, mobile: customer.mobile_number, isAdmin: false },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    return res.status(200).json({
      success: true,
      message: isNewUser ? 'Welcome! Please complete your name or skip.' : 'Logged in successfully',
      isNewUser,
      token,
      customer: {
        id: customer.id,
        mobile_number: customer.mobile_number,
        secondary_mobile: customer.secondary_mobile,
        full_name: customer.full_name,
        address: customer.address,
        state: customer.state,
        district: customer.district,
        city: customer.city,
        village: customer.village,
        pincode: customer.pincode
      }
    });
  } catch (error) {
    next(error);
  }
};

// 3. Update customer profile details
exports.updateCustomerProfile = async (req, res, next) => {
  try {
    const customerId = req.user.id;
    const {
      full_name,
      secondary_mobile,
      address,
      state,
      district,
      city,
      village,
      pincode
    } = req.body;

    const assignedName = (full_name && full_name.trim()) ? full_name.trim() : 'Not Named';

    await db.query(
      `UPDATE customers
       SET full_name = ?,
           secondary_mobile = ?,
           address = ?,
           state = ?,
           district = ?,
           city = ?,
           village = ?,
           pincode = ?
       WHERE id = ?`,
      [
        assignedName,
        secondary_mobile || null,
        address || null,
        state || null,
        district || null,
        city || null,
        village || null,
        pincode || null,
        customerId
      ]
    );

    const updated = await db.query('SELECT * FROM customers WHERE id = ?', [customerId]);

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      customer: updated[0]
    });
  } catch (error) {
    next(error);
  }
};

// 4. Get current customer profile
exports.getCustomerProfile = async (req, res, next) => {
  try {
    const customer = req.user;
    return res.status(200).json({
      success: true,
      customer
    });
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------
// ADMIN AUTHENTICATION
// ----------------------------------------------------

// 1. Send OTP to registered active admin mobile
exports.adminSendOtp = async (req, res, next) => {
  try {
    const { mobile_number } = req.body;
    if (!mobile_number) {
      return res.status(400).json({ success: false, message: 'Admin mobile number is required' });
    }

    const cleanMobile = mobile_number.replace(/\D/g, '').slice(-10);
    if (cleanMobile.length !== 10) {
      return res.status(400).json({ success: false, message: 'Please provide a valid 10-digit mobile number' });
    }

    // Check if mobile belongs to an administrator
    const admins = await db.query('SELECT id, mobile_number FROM admins WHERE mobile_number = ?', [cleanMobile]);
    if (admins.length === 0) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid administrator credentials.' });
    }

    const result = await otpService.sendOtp(cleanMobile);
    return res.status(200).json({
      success: true,
      message: result.message || 'Security OTP sent to registered admin mobile.'
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// 2. Admin login: Mobile + OTP + Password
exports.adminLogin = async (req, res, next) => {
  try {
    const { mobile_number, password, otp } = req.body;
    if (!mobile_number || !password || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number, Password, and OTP are all required for admin access.'
      });
    }

    const cleanMobile = String(mobile_number).replace(/\D/g, '').slice(-10);
    if (cleanMobile.length !== 10) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid 10-digit mobile number.'
      });
    }

    // 1. Check admin existence
    const admins = await db.query('SELECT * FROM admins WHERE mobile_number = ?', [cleanMobile]);
    if (admins.length === 0) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid administrator credentials.' });
    }

    const admin = admins[0];

    // 2. Verify Password Hash using non-blocking async bcrypt before consuming OTP
    const isPasswordValid = await bcrypt.compare(String(password), admin.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid administrator credentials. -password' });
    }

    // 3. Verify OTP cryptographically
    const verifyResult = await otpService.verifyOtp(cleanMobile, String(otp));
    if (!verifyResult.success) {
      return res.status(401).json({ success: false, message: verifyResult.message || 'Invalid or expired OTP code.' });
    }

    // 4. Generate Admin JWT Token (24h expiry)
    const token = jwt.sign(
      { id: admin.id, mobile: admin.mobile_number, isAdmin: true },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    await logAdminAction(admin.id, 'ADMIN_LOGIN', 'ADMIN', admin.id, { ip: req.ip });

    return res.status(200).json({
      success: true,
      message: 'Admin authenticated successfully',
      token,
      admin: {
        id: admin.id,
        mobile_number: admin.mobile_number,
        full_name: admin.full_name
      }
    });
  } catch (error) {
    next(error);
  }
};

// 3. Admin change password
exports.adminChangePassword = async (req, res, next) => {
  try {
    const adminId = req.admin.id;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Both current and new passwords are required' });
    }

    if (String(new_password).length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long' });
    }

    const admins = await db.query('SELECT * FROM admins WHERE id = ?', [adminId]);
    if (admins.length === 0) {
      return res.status(404).json({ success: false, message: 'Admin account not found' });
    }

    const admin = admins[0];
    const isMatch = await bcrypt.compare(String(current_password), admin.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(String(new_password), 10);
    await db.query('UPDATE admins SET password_hash = ? WHERE id = ?', [newHash, adminId]);

    await logAdminAction(adminId, 'PASSWORD_CHANGED', 'ADMIN', adminId);

    return res.status(200).json({
      success: true,
      message: 'Admin password changed successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 3. Get admin profile
exports.getAdminProfile = async (req, res, next) => {
  try {
    const admin = req.admin;
    return res.status(200).json({
      success: true,
      admin
    });
  } catch (error) {
    next(error);
  }
};

module.exports.logAdminAction = logAdminAction;
