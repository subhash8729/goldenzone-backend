const app = require('./app');
const config = require('./config/env');
const db = require('./config/db');

async function startServer() {
  if (config.nodeEnv === 'production') {
    const required = [
      ['JWT_SECRET', process.env.JWT_SECRET],
      ['RAZORPAY_KEY_ID', config.razorpayKeyId],
      ['RAZORPAY_KEY_SECRET', config.razorpayKeySecret],
      ['RAZORPAY_WEBHOOK_SECRET', config.razorpayWebhookSecret],
      ['RENFLAIR_API_KEY', config.renflairApiKey]
    ].filter(([, value]) => !value);

    if (required.length > 0) {
      throw new Error(`Missing required production environment variables: ${required.map(([key]) => key).join(', ')}`);
    }
  }

  // Test MySQL connection
  const dbStatus = await db.testConnection();
  if (dbStatus.connected) {
    console.log(`✅ [Database]: Successfully connected to MySQL at ${config.db.host}:${config.db.port}/${config.db.database}`);
  } else {
    console.warn(`⚠️ [Database Warning]: Could not connect to MySQL: ${dbStatus.error}`);
    console.warn(`💡 [Hint]: Ensure MySQL is running and check credentials in server/.env.`);
    console.warn(`💡 [Hint]: You can run "npm run db:init" in the server directory once credentials are set.`);
  }

  app.listen(config.port, () => {
    console.log(`======================================================`);
    console.log(`💎 Golden Zone Server running on port ${config.port}`);
    console.log(`🌐 Storefront: http://localhost:${config.port}`);
    console.log(`🔗 API Base: http://localhost:${config.port}/api`);
    console.log(`👑 Admin Mobile: ${config.adminMobile}`);
    console.log(`======================================================`);
  });
}

startServer();
