const mysql = require('mysql2/promise');
const config = require('./env');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: config.db.waitForConnections,
      connectionLimit: config.db.connectionLimit,
      queueLimit: config.db.queueLimit,
      decimalNumbers: true
    });
  }
  return pool;
}

// Execute query helper using parameterized statements
async function query(sql, params = []) {
  const p = getPool();
  const [rows, fields] = await p.execute(sql, params);
  return rows;
}

// Transaction helper
async function withTransaction(callback) {
  const p = getPool();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// Check connection test
async function testConnection() {
  try {
    const p = getPool();
    const connection = await p.getConnection();
    connection.release();
    return { connected: true };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

module.exports = {
  getPool,
  query,
  withTransaction,
  testConnection
};
