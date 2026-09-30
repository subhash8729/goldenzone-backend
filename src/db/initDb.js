const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config/env');

async function initializeDatabase() {
  console.log('🔄 Connecting to MySQL server to initialize database...');
  console.log(`   Host: ${config.db.host}:${config.db.port} | User: ${config.db.user} | Database: ${config.db.database}`);

  let connection;
  try {
    // Connect without database first to ensure database exists
    connection = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      multipleStatements: true
    });

    console.log('✅ Connected to MySQL server.');

    const schemaPath = path.resolve(__dirname, '../../../database/schema.sql');
    const seedPath = path.resolve(__dirname, '../../../database/seed.sql');

    if (!fs.existsSync(schemaPath) || !fs.existsSync(seedPath)) {
      throw new Error(`Schema or seed file not found at ${schemaPath}`);
    }

    console.log('📄 Executing database/schema.sql...');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await connection.query(schemaSql);
    console.log('✅ Database schema created successfully.');

    console.log('🌱 Executing database/seed.sql...');
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    await connection.query(seedSql);
    console.log('✅ Database seeded successfully with 26 initial products, admin account, categories, and settings.');

    await connection.end();
    console.log('🎉 Database initialization complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize database:', error.message);
    if (connection) await connection.end();
    process.exit(1);
  }
}

if (require.main === module) {
  initializeDatabase();
}

module.exports = { initializeDatabase };
