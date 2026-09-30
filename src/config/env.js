const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'kalyani_jewellers',
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    decimalNumbers: true
  },
  jwtSecret: process.env.JWT_SECRET || 'kalyani_jewellers_secure_jwt_secret_2026',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  adminMobile: process.env.ADMIN_MOBILE || '7976580806',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  adminUrl: process.env.ADMIN_URL || 'http://localhost:5174',
  googleMapsBaseUrl: process.env.GOOGLE_MAPS_BASE_URL || 'https://www.google.com/maps',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  renflairApiKey: process.env.RENFLAIR_API_KEY || '',
  renflairApiUrl: process.env.RENFLAIR_API_URL || 'https://sms.renflair.in/V1.php',
  appDomain: process.env.APP_DOMAIN || 'goldenzone.in',
  appName: process.env.APP_NAME || 'Golden Zone'
};

