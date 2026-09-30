const db = require('../config/db');
const { logAdminAction } = require('./authController');

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\W-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 1. Get active categories for public storefront
exports.getCategories = async (req, res, next) => {
  try {
    const categories = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) 
               FROM products p 
               WHERE p.category_id = c.id AND p.deleted_at IS NULL AND p.is_active = 1) as product_count
       FROM categories c
       WHERE c.is_active = 1
       ORDER BY c.display_order ASC, c.name ASC`
    );

    return res.status(200).json({
      success: true,
      data: categories
    });
  } catch (error) {
    next(error);
  }
};

// 2. Get all categories for Admin (including inactive)
exports.getAllCategoriesAdmin = async (req, res, next) => {
  try {
    const categories = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) 
               FROM products p 
               WHERE p.category_id = c.id AND p.deleted_at IS NULL) as total_products,
              (SELECT COUNT(*) 
               FROM products p 
               WHERE p.category_id = c.id AND p.deleted_at IS NULL AND p.is_active = 1) as active_products
       FROM categories c
       ORDER BY c.display_order ASC, c.id ASC`
    );

    return res.status(200).json({
      success: true,
      data: categories
    });
  } catch (error) {
    next(error);
  }
};

// 3. Admin: Create Category
exports.createCategory = async (req, res, next) => {
  try {
    const { name, description, image_url, is_active = 1, display_order = 0 } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Category name is required' });
    }

    const slug = slugify(name);

    // Check unique slug
    const existing = await db.query('SELECT id FROM categories WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'A category with this name already exists' });
    }

    const result = await db.query(
      `INSERT INTO categories (name, slug, description, image_url, is_active, display_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), slug, description || null, image_url || null, is_active ? 1 : 0, parseInt(display_order, 10) || 0]
    );

    await logAdminAction(req.admin.id, 'CATEGORY_CREATED', 'CATEGORY', result.insertId, { name });

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      categoryId: result.insertId
    });
  } catch (error) {
    next(error);
  }
};

// 4. Admin: Update Category
exports.updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, image_url, is_active, display_order } = req.body;

    const existing = await db.query('SELECT * FROM categories WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const current = existing[0];
    const newName = (name && name.trim()) ? name.trim() : current.name;
    const newSlug = slugify(newName);

    const slugConflict = await db.query('SELECT id FROM categories WHERE slug = ? AND id != ?', [newSlug, id]);
    if (slugConflict.length > 0) {
      return res.status(400).json({ success: false, message: 'A category with this name already exists' });
    }

    await db.query(
      `UPDATE categories
       SET name = ?,
           slug = ?,
           description = ?,
           image_url = ?,
           is_active = ?,
           display_order = ?
       WHERE id = ?`,
      [
        newName,
        newSlug,
        description !== undefined ? description : current.description,
        image_url !== undefined ? image_url : current.image_url,
        is_active !== undefined ? (is_active ? 1 : 0) : current.is_active,
        display_order !== undefined ? parseInt(display_order, 10) : current.display_order,
        id
      ]
    );

    await logAdminAction(req.admin.id, 'CATEGORY_UPDATED', 'CATEGORY', id, { name: newName });

    return res.status(200).json({
      success: true,
      message: 'Category updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 5. Admin: Safe Delete Category (blocks if active products depend on it)
exports.deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if any product references this category
    const activeProducts = await db.query(
      `SELECT COUNT(*) as count FROM products WHERE category_id = ? AND deleted_at IS NULL`,
      [id]
    );

    if (activeProducts[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category: ${activeProducts[0].count} product(s) are assigned to it. Please reassign or delete the products first, or deactivate the category instead.`
      });
    }

    await db.query('DELETE FROM categories WHERE id = ?', [id]);
    await logAdminAction(req.admin.id, 'CATEGORY_DELETED', 'CATEGORY', id);

    return res.status(200).json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
