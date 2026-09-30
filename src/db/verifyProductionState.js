const db = require('../config/db');

async function verifyState() {
  console.log('=== Golden Zone Production State Verification ===');
  const orders = await db.query('SELECT COUNT(*) as c FROM orders');
  const payments = await db.query('SELECT COUNT(*) as c FROM payments');
  const customers = await db.query('SELECT COUNT(*) as c FROM customers');
  const reviews = await db.query('SELECT COUNT(*) as c FROM reviews');
  const otps = await db.query('SELECT COUNT(*) as c FROM otp_verifications');
  const webhooks = await db.query('SELECT COUNT(*) as c FROM webhook_events');
  const products = await db.query('SELECT COUNT(*) as c FROM products');
  const categories = await db.query('SELECT COUNT(*) as c FROM categories');
  const admins = await db.query('SELECT COUNT(*) as c FROM admins');
  const heroSetting = await db.query('SELECT * FROM site_settings WHERE setting_key = "hero_video_url"');

  console.log({
    orders: orders[0].c,
    payments: payments[0].c,
    customers: customers[0].c,
    reviews: reviews[0].c,
    otp_verifications: otps[0].c,
    webhook_events: webhooks[0].c,
    products: products[0].c,
    categories: categories[0].c,
    admins: admins[0].c,
    hero_video_url: heroSetting[0] ? heroSetting[0].setting_value : 'NOT SET'
  });

  const isClean = 
    orders[0].c === 0 && 
    payments[0].c === 0 && 
    customers[0].c === 0 && 
    reviews[0].c === 0 &&
    products[0].c === 26 &&
    admins[0].c === 1;

  if (isClean) {
    console.log('✅ PRODUCTION STATE VERIFIED: Fresh database with 0 test transactions, 26 active products, and 1 admin account.');
  } else {
    console.warn('⚠️ WARNING: State does not match clean production criteria.');
  }
  process.exit(0);
}

verifyState().catch(err => {
  console.error(err);
  process.exit(1);
});
