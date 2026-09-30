const db = require('../config/db');

async function migrate() {
  console.log('🔄 Running Razorpay database migration & cleanup...');
  const pool = db.getPool();

  try {
    // 1. Check & add columns to orders table
    const [orderCols] = await pool.query(`SHOW COLUMNS FROM orders LIKE 'razorpay_order_id'`);
    if (orderCols.length === 0) {
      console.log('➕ Adding razorpay_order_id to orders table');
      await pool.query(`ALTER TABLE orders ADD COLUMN razorpay_order_id VARCHAR(100) DEFAULT NULL AFTER payment_status`);
      await pool.query(`ALTER TABLE orders ADD INDEX idx_order_razorpay (razorpay_order_id)`);
    }

    // 2. Check & add columns to payments table
    const [payOrderIdCol] = await pool.query(`SHOW COLUMNS FROM payments LIKE 'razorpay_order_id'`);
    if (payOrderIdCol.length === 0) {
      console.log('➕ Adding razorpay_order_id to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN razorpay_order_id VARCHAR(100) DEFAULT NULL AFTER transaction_id`);
      await pool.query(`ALTER TABLE payments ADD INDEX idx_payment_razorpay_order (razorpay_order_id)`);
    }

    const [payPaymentIdCol] = await pool.query(`SHOW COLUMNS FROM payments LIKE 'razorpay_payment_id'`);
    if (payPaymentIdCol.length === 0) {
      console.log('➕ Adding razorpay_payment_id to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN razorpay_payment_id VARCHAR(100) DEFAULT NULL AFTER razorpay_order_id`);
      await pool.query(`ALTER TABLE payments ADD INDEX idx_payment_razorpay_payment (razorpay_payment_id)`);
    }

    const [paySigCol] = await pool.query(`SHOW COLUMNS FROM payments LIKE 'razorpay_signature'`);
    if (paySigCol.length === 0) {
      console.log('➕ Adding razorpay_signature to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN razorpay_signature VARCHAR(255) DEFAULT NULL AFTER razorpay_payment_id`);
    }

    const [payErrCol] = await pool.query(`SHOW COLUMNS FROM payments LIKE 'error_reason'`);
    if (payErrCol.length === 0) {
      console.log('➕ Adding error_reason to payments table');
      await pool.query(`ALTER TABLE payments ADD COLUMN error_reason TEXT DEFAULT NULL AFTER gateway`);
    }

    // Update payment_method length and default
    await pool.query(`ALTER TABLE payments MODIFY COLUMN payment_method VARCHAR(50) NOT NULL DEFAULT 'RAZORPAY'`);
    await pool.query(`ALTER TABLE payments MODIFY COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING'`);
    await pool.query(`ALTER TABLE payments MODIFY COLUMN gateway VARCHAR(50) DEFAULT 'RAZORPAY'`);

    // 3. Create enquiries table for Contact Page
    await pool.query(`
      CREATE TABLE IF NOT EXISTS enquiries (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(120) NOT NULL,
        mobile_number VARCHAR(20) NOT NULL,
        email VARCHAR(120) DEFAULT NULL,
        subject VARCHAR(150) DEFAULT 'General Enquiry',
        message TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'NEW',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_enquiry_status (status),
        INDEX idx_enquiry_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Clean up seeded fake orders, order_items, and payments
    // Requirement 3: "Remove all seeded fake orders, order items, payments and fake transaction history from DB."
    console.log('🧹 Purging fake seeded orders, items, and transactions...');
    await pool.query(`DELETE FROM payments`);
    await pool.query(`DELETE FROM order_items`);
    await pool.query(`DELETE FROM orders`);
    await pool.query(`ALTER TABLE payments AUTO_INCREMENT = 1`);
    await pool.query(`ALTER TABLE order_items AUTO_INCREMENT = 1`);
    await pool.query(`ALTER TABLE orders AUTO_INCREMENT = 1`);

    console.log('✅ Database migration and fake data purge completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
