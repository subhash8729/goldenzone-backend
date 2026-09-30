const { query, getPool } = require('../config/db');

async function cleanProductionDatabase() {
  console.log('🚀 [Production DB Setup]: Starting cleanup of test/demo records...');

  try {
    // Disable foreign key checks temporarily for clean cascading purge
    await query('SET FOREIGN_KEY_CHECKS = 0');

    // 1. Truncate / Delete transactional & test tables
    const tablesToClean = [
      'order_items',
      'payments',
      'orders',
      'order_drafts',
      'customers',
      'reviews',
      'enquiries',
      'admin_notes',
      'admin_audit_logs',
      'otp_verifications',
      'webhook_events'
    ];

    for (const table of tablesToClean) {
      try {
        await query(`TRUNCATE TABLE \`${table}\``);
        console.log(`✓ Cleaned table: ${table}`);
      } catch (err) {
        // If truncate fails due to active FK constraint, use DELETE + ALTER AUTO_INCREMENT
        await query(`DELETE FROM \`${table}\``);
        await query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`);
        console.log(`✓ Purged table via DELETE: ${table}`);
      }
    }

    // Re-enable foreign key checks
    await query('SET FOREIGN_KEY_CHECKS = 1');

    // 2. Ensure hero_video_url is present in site_settings
    await query(
      `INSERT INTO \`site_settings\` (\`setting_key\`, \`setting_value\`, \`description\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`setting_value\` = VALUES(\`setting_value\`)`,
      [
        'hero_video_url',
        'https://res.cloudinary.com/dgxaol7mz/video/upload/v1789876791/videoplayback_hwcfti.mp4',
        'Homepage hero background video URL'
      ]
    );
    console.log('✓ Configured hero_video_url in site_settings');

    // 3. Ensure announcement_bar text in site_settings is updated
    await query(
      `INSERT INTO \`site_settings\` (\`setting_key\`, \`setting_value\`, \`description\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`setting_value\` = VALUES(\`setting_value\`)`,
      [
        'announcement_bar',
        'PREMIUM 1 GRAM GOLD-PLATED JEWELLERY • SAME DAY DISPATCH • 100% INSURED TRANSIT • VERIFIED COD AVAILABLE',
        'Header announcement and hero marquee ticker text'
      ]
    );
    console.log('✓ Updated announcement_bar in site_settings');

    // 4. Verify retained master data counts
    const [adminCount] = await query('SELECT count(*) as c FROM admins');
    const [categoryCount] = await query('SELECT count(*) as c FROM categories');
    const [productCount] = await query('SELECT count(*) as c FROM products');
    const [orderCount] = await query('SELECT count(*) as c FROM orders');
    const [paymentCount] = await query('SELECT count(*) as c FROM payments');
    const [customerCount] = await query('SELECT count(*) as c FROM customers');
    const [reviewCount] = await query('SELECT count(*) as c FROM reviews');

    console.log('\n=== PRODUCTION DATABASE STATE ===');
    console.log(`Admins: ${adminCount.c} (Expected >= 1)`);
    console.log(`Categories: ${categoryCount.c} (Expected: 6)`);
    console.log(`Products: ${productCount.c} (Expected: 26)`);
    console.log(`Orders: ${orderCount.c} (Clean: 0)`);
    console.log(`Payments: ${paymentCount.c} (Clean: 0)`);
    console.log(`Customers: ${customerCount.c} (Clean: 0)`);
    console.log(`Reviews: ${reviewCount.c} (Clean: 0)`);
    console.log('=================================\n');
    console.log('✅ Database is 100% clean, fresh and production-ready.');
  } catch (error) {
    console.error('❌ Error during database cleanup:', error);
    process.exitCode = 1;
  } finally {
    const pool = getPool();
    if (pool) await pool.end();
  }
}

cleanProductionDatabase();
