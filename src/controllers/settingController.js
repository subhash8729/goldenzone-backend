const db = require('../config/db');
const { logAdminAction } = require('./authController');

// 1. Get all public settings as an easy-to-use key-value map
exports.getSettings = async (req, res, next) => {
  try {
    const rows = await db.query('SELECT setting_key, setting_value, description FROM site_settings');
    const settings = {};
    rows.forEach((r) => {
      settings[r.setting_key] = r.setting_value;
    });

    return res.status(200).json({
      success: true,
      settings,
      list: rows
    });
  } catch (error) {
    next(error);
  }
};

// 2. Admin: Update settings in bulk or individually
exports.updateSettings = async (req, res, next) => {
  try {
    const { settings } = req.body; // { hero_title: '...', hero_subtitle: '...', ... }

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, message: 'Settings object required' });
    }

    const keys = Object.keys(settings);
    for (const key of keys) {
      const val = String(settings[key]);
      await db.query(
        `INSERT INTO site_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, val]
      );
    }

    await logAdminAction(req.admin.id, 'SETTINGS_UPDATED', 'SETTINGS', 'site_settings', {
      updatedKeys: keys
    });

    return res.status(200).json({
      success: true,
      message: 'Site settings updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 3. Customer: Submit enquiry from /contact page
exports.submitEnquiry = async (req, res, next) => {
  try {
    const { name, mobile_number, email, subject, message } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Your name is required.' });
    }
    if (!mobile_number || !mobile_number.trim()) {
      return res.status(400).json({ success: false, message: 'Contact mobile number is required.' });
    }
    const cleanMobile = mobile_number.replace(/\D/g, '').slice(-10);
    if (cleanMobile.length !== 10) {
      return res.status(400).json({ success: false, message: 'Please provide a valid 10-digit contact mobile number.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Enquiry message is required.' });
    }

    await db.query(
      `INSERT INTO enquiries (name, mobile_number, email, subject, message)
       VALUES (?, ?, ?, ?, ?)`,
      [
        name.trim(),
        cleanMobile,
        email ? email.trim() : null,
        subject ? subject.trim() : 'General Customer Enquiry',
        message.trim()
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Thank you! Your enquiry has been received. Our team will contact you shortly.'
    });
  } catch (error) {
    next(error);
  }
};

// 4. Admin: Get all customer enquiries
exports.getEnquiries = async (req, res, next) => {
  try {
    const rows = await db.query('SELECT * FROM enquiries ORDER BY id DESC LIMIT 100');
    return res.status(200).json({
      success: true,
      enquiries: rows
    });
  } catch (error) {
    next(error);
  }
};
