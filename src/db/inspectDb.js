const db = require('../config/db');

async function inspect() {
  console.log('--- CONNECTING & INSPECTING LIVE MYSQL DATABASE ---');
  try {
    const status = await db.testConnection();
    console.log('Connection status:', status);

    const [dbNameRow] = await db.query('SELECT DATABASE() as db');
    console.log('Current Database:', dbNameRow.db);

    const tables = await db.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'
    );
    console.log('Tables found:', tables.map(t => t.TABLE_NAME));

    console.log('\n--- DETAILED TABLE SCHEMAS & ROW COUNTS ---');
    for (const t of tables) {
      const tableName = t.TABLE_NAME;
      const createTable = await db.query(`SHOW CREATE TABLE \`${tableName}\``);
      const [cnt] = await db.query(`SELECT COUNT(*) as c FROM \`${tableName}\``);
      console.log(`\n================== [ ${tableName} ] (Rows: ${cnt.c}) ==================`);
      console.log(createTable[0]['Create Table']);
    }

    console.log('\n--- ALL FOREIGN KEY CONSTRAINTS ---');
    const fks = await db.query(`
      SELECT 
        TABLE_NAME, 
        CONSTRAINT_NAME, 
        COLUMN_NAME, 
        REFERENCED_TABLE_NAME, 
        REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME
    `);
    console.table(fks);

    console.log('\n--- ALL REFERENTIAL CONSTRAINTS (DELETE RULES) ---');
    const refRules = await db.query(`
      SELECT 
        TABLE_NAME, 
        CONSTRAINT_NAME, 
        REFERENCED_TABLE_NAME, 
        UPDATE_RULE, 
        DELETE_RULE
      FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, CONSTRAINT_NAME
    `);
    console.table(refRules);

  } catch (err) {
    console.error('Inspection failed:', err);
  } finally {
    const pool = db.getPool();
    if (pool) await pool.end();
  }
}

inspect();
