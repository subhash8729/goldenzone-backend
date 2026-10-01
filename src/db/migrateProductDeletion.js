const db = require('../config/db');

async function migrateProductDeletion() {
  console.log('🔄 Checking and applying product deletion schema updates...');
  const pool = db.getPool();

  try {
    // 1. Check order_items.product_id nullability
    const [cols] = await pool.query(
      `SELECT IS_NULLABLE 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'order_items' 
         AND COLUMN_NAME = 'product_id'`
    );

    // 2. Check foreign key delete rule on order_items referencing products
    const [fks] = await pool.query(
      `SELECT CONSTRAINT_NAME, DELETE_RULE 
       FROM information_schema.REFERENTIAL_CONSTRAINTS 
       WHERE CONSTRAINT_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'order_items' 
         AND REFERENCED_TABLE_NAME = 'products'`
    );

    const isNullable = cols.length > 0 && cols[0].IS_NULLABLE === 'YES';
    const hasSetNullFk = fks.length > 0 && fks[0].DELETE_RULE === 'SET NULL';

    if (!isNullable || !hasSetNullFk) {
      console.log('⚙️ Updating order_items foreign key to allow ON DELETE SET NULL...');
      if (fks.length > 0) {
        for (const fk of fks) {
          await pool.query(`ALTER TABLE \`order_items\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
          console.log(`✓ Dropped foreign key ${fk.CONSTRAINT_NAME}`);
        }
      }

      await pool.query(`ALTER TABLE \`order_items\` MODIFY COLUMN \`product_id\` INT UNSIGNED NULL DEFAULT NULL`);
      console.log('✓ Made order_items.product_id nullable');

      await pool.query(
        `ALTER TABLE \`order_items\` 
         ADD CONSTRAINT \`order_items_ibfk_2\` 
         FOREIGN KEY (\`product_id\`) REFERENCES \`products\` (\`id\`) ON DELETE SET NULL`
      );
      console.log('✓ Added order_items foreign key with ON DELETE SET NULL');
    } else {
      console.log('✓ order_items foreign key already configured with ON DELETE SET NULL');
    }

    // 3. Purge any legacy soft-deleted products and drop obsolete deleted_at column if present
    const [prodCols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'deleted_at'`
    );
    if (prodCols.length > 0) {
      const [softDeleted] = await pool.query('SELECT id, name FROM products WHERE deleted_at IS NOT NULL');
      if (softDeleted.length > 0) {
        console.log(`🧹 Found ${softDeleted.length} legacy soft-deleted product(s). Purging completely...`);
        for (const prod of softDeleted) {
          await pool.query('UPDATE order_items SET product_id = NULL WHERE product_id = ?', [prod.id]);
          await pool.query('DELETE FROM product_images WHERE product_id = ?', [prod.id]);
          await pool.query('DELETE FROM reviews WHERE product_id = ?', [prod.id]);
          await pool.query('DELETE FROM products WHERE id = ?', [prod.id]);
          console.log(`✓ Permanently purged product id ${prod.id} (${prod.name})`);
        }
      }

      // Drop obsolete deleted_at column and index
      const [prodIdx] = await pool.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_prod_deleted'`
      );
      if (prodIdx.length > 0) {
        await pool.query('ALTER TABLE `products` DROP INDEX `idx_prod_deleted`');
        console.log('✓ Dropped obsolete idx_prod_deleted index');
      }
      await pool.query('ALTER TABLE `products` DROP COLUMN `deleted_at`');
      console.log('✓ Dropped obsolete deleted_at column from products');
    }

    console.log('✅ Product deletion migration completed successfully.');
    return true;
  } catch (err) {
    console.error('❌ Failed product deletion migration:', err);
    throw err;
  }
}

if (require.main === module) {
  migrateProductDeletion()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrateProductDeletion };
