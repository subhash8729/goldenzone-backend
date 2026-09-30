const db = require('../config/db');

async function migrate() {
  console.log('🔄 Running Golden Zone Payment & OTP Database Migration...');
  const pool = db.getPool();

  try {
    // 1. Alter orders table
    const [orderCols] = await pool.query(`SHOW COLUMNS FROM orders`);
    const colNames = orderCols.map((c) => c.Field);

    if (!colNames.includes('payment_mode')) {
      console.log('➕ Adding payment_mode to orders table');
      await pool.query(`ALTER TABLE orders ADD COLUMN payment_mode VARCHAR(20) NOT NULL DEFAULT 'ONLINE' AFTER total_amount`);
      await pool.query(`ALTER TABLE orders ADD INDEX idx_order_payment_mode (payment_mode)`);
    }

    if (!colNames.includes('advance_amount')) {
      console.log('➕ Adding advance_amount to orders table');
      await pool.query(`ALTER TABLE orders ADD COLUMN advance_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER payment_mode`);
    }

    if (!colNames.includes('remaining_cod_amount')) {
      console.log('➕ Adding remaining_cod_amount to orders table');
      await pool.query(`ALTER TABLE orders ADD COLUMN remaining_cod_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER advance_amount`);
    }

    // 2. Alter payments table
    const [payCols] = await pool.query(`SHOW COLUMNS FROM payments`);
    const payColNames = payCols.map((c) => c.Field);

    if (!payColNames.includes('payment_mode')) {
      console.log('➕ Adding payment_mode to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN payment_mode VARCHAR(20) NOT NULL DEFAULT 'ONLINE' AFTER amount`);
    }

    if (!payColNames.includes('payment_type')) {
      console.log('➕ Adding payment_type to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN payment_type VARCHAR(30) NOT NULL DEFAULT 'FULL' AFTER payment_mode`);
    }

    if (!payColNames.includes('remaining_cod_amount')) {
      console.log('➕ Adding remaining_cod_amount to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN remaining_cod_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER payment_type`);
    }

    if (!payColNames.includes('refund_id')) {
      console.log('➕ Adding refund_id to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN refund_id VARCHAR(100) DEFAULT NULL AFTER error_reason`);
    }

    if (!payColNames.includes('refund_amount')) {
      console.log('➕ Adding refund_amount to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN refund_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER refund_id`);
    }

    if (!payColNames.includes('refund_status')) {
      console.log('➕ Adding refund_status to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN refund_status VARCHAR(30) DEFAULT NULL AFTER refund_amount`);
    }

    if (!payColNames.includes('refunded_at')) {
      console.log('➕ Adding refunded_at to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN refunded_at TIMESTAMP NULL DEFAULT NULL AFTER refund_status`);
    }

    // 3. Create otp_verifications table
    console.log('➕ Creating otp_verifications table if not exists');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_verifications (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        mobile_number VARCHAR(15) NOT NULL,
        otp_hash VARCHAR(255) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        resend_count INT NOT NULL DEFAULT 1,
        last_sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        is_verified TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_otp_mobile (mobile_number),
        INDEX idx_otp_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Create webhook_events table
    console.log('➕ Creating webhook_events table if not exists');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id VARCHAR(100) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        payload JSON DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id),
        INDEX idx_webhook_type (event_type),
        INDEX idx_webhook_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. Update site_settings with exact contact info
    console.log('⚙️ Updating site_settings with new contact details...');
    const siteSettings = [
      ['contact_email', 'goldenzone676@gmail.com', 'Primary official support email'],
      ['support_email', 'support@goldenzone.in', 'Secondary support email address'],
      ['whatsapp_number', '+91 92861 29921', 'Official WhatsApp customer care number'],
      ['contact_phone', '9286129921', 'Direct calling support telephone number'],
      ['instagram_url', 'https://www.instagram.com/goldenzone.in', 'Official Instagram profile link'],
      ['instagram_username', '@goldenzone.in', 'Instagram handle display'],
      ['company_address', 'Jyoti Nagar, Sanchore, Rajasthan, Jalore', 'Registered office address'],
      ['company_pincode', '343041', 'Office postal PIN code'],
      [
        'whatsapp_chat_url',
        'https://wa.me/919286129921?text=Hello,%20I%20want%20to%20know%20more%20about%20Golden%20Zone%20jewellery.',
        'Direct WhatsApp chat prefilled link'
      ]
    ];

    for (const [key, value, desc] of siteSettings) {
      await pool.query(
        `INSERT INTO site_settings (setting_key, setting_value, description)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), description = VALUES(description)`,
        [key, value, desc]
      );
    }

    console.log('✅ Golden Zone Payment & OTP Database Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };
