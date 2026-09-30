const db = require('../config/db');
const { logAdminAction } = require('./authController');

// Calculate discount percentage safely
function calculateDiscount(regularPrice, discountedPrice) {
  const reg = parseFloat(regularPrice);
  const disc = parseFloat(discountedPrice);
  if (isNaN(reg) || isNaN(disc) || reg <= 0 || disc >= reg) {
    return 0;
  }
  return Math.round(((reg - disc) / reg) * 100);
}

// Generate SKU e.g. KAL-CHA-101
function generateSku(categoryName, id) {
  const prefix = (categoryName || 'GEN').substring(0, 3).toUpperCase();
  const randomSuffix = Math.floor(100 + Math.random() * 900);
  return `KAL-${prefix}-${id || randomSuffix}`;
}

// Generate URL slug from title
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\W-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ----------------------------------------------------
// PUBLIC PRODUCT ENDPOINTS
// ----------------------------------------------------

// 1. Get products list (filtered, sorted, paginated)
exports.getProducts = async (req, res, next) => {
  try {
    const {
      category,
      search,
      min_price,
      max_price,
      is_recommended,
      is_bestseller,
      is_new_arrival,
      sort,
      page = 1,
      limit = 20
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNumber - 1) * pageSize;
    const params = [];
    const countParams = [];

    let whereSql = `WHERE p.deleted_at IS NULL AND p.is_active = 1`;

    if (category) {
      whereSql += ` AND (c.slug = ? OR c.id = ?)`;
      params.push(category, category);
      countParams.push(category, category);
    }

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;
      whereSql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.tags LIKE ?)`;
      params.push(searchTerm, searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm, searchTerm);
    }

    if (min_price) {
      whereSql += ` AND p.discounted_price >= ?`;
      params.push(parseFloat(min_price));
      countParams.push(parseFloat(min_price));
    }

    if (max_price) {
      whereSql += ` AND p.discounted_price <= ?`;
      params.push(parseFloat(max_price));
      countParams.push(parseFloat(max_price));
    }

    if (is_recommended === 'true' || is_recommended === '1') {
      whereSql += ` AND p.is_recommended = 1`;
    }

    if (is_bestseller === 'true' || is_bestseller === '1') {
      whereSql += ` AND p.is_bestseller = 1`;
    }

    if (is_new_arrival === 'true' || is_new_arrival === '1') {
      whereSql += ` AND p.is_new_arrival = 1`;
    }

    // Sorting
    let orderSql = `ORDER BY p.id DESC`;
    if (sort === 'price_asc') {
      orderSql = `ORDER BY p.discounted_price ASC`;
    } else if (sort === 'price_desc') {
      orderSql = `ORDER BY p.discounted_price DESC`;
    } else if (sort === 'newest') {
      orderSql = `ORDER BY p.created_at DESC`;
    } else if (sort === 'popular') {
      orderSql = `ORDER BY p.is_bestseller DESC, p.id DESC`;
    }

    // Total count
    const totalCountRows = await db.query(
      `SELECT COUNT(*) as total
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereSql}`,
      countParams
    );
    const totalItems = totalCountRows[0].total;

    // Items with first primary image
    const products = await db.query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              (SELECT pi.image_url 
               FROM product_images pi 
               WHERE pi.product_id = p.id 
               ORDER BY pi.image_order ASC, pi.id ASC 
               LIMIT 1) as primary_image
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereSql}
       ${orderSql}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const formattedProducts = products.map((prod) => ({
      ...prod,
      regular_price: parseFloat(prod.regular_price),
      discounted_price: parseFloat(prod.discounted_price),
      discount_percentage: calculateDiscount(prod.regular_price, prod.discounted_price),
      is_out_of_stock: Boolean(prod.is_out_of_stock),
      is_recommended: Boolean(prod.is_recommended),
      is_bestseller: Boolean(prod.is_bestseller),
      is_new_arrival: Boolean(prod.is_new_arrival)
    }));

    return res.status(200).json({
      success: true,
      data: formattedProducts,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    });
  } catch (error) {
    next(error);
  }
};

// 2. Get single product detail by slug or ID
exports.getProductDetail = async (req, res, next) => {
  try {
    const { identifier } = req.params;

    const products = await db.query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE (p.slug = ? OR p.id = ?) AND p.deleted_at IS NULL AND p.is_active = 1
       LIMIT 1`,
      [identifier, identifier]
    );

    if (products.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const product = products[0];

    // Fetch all gallery images
    const images = await db.query(
      `SELECT id, image_url, image_order 
       FROM product_images 
       WHERE product_id = ? 
       ORDER BY image_order ASC, id ASC`,
      [product.id]
    );

    // Fetch approved customer reviews
    const reviews = await db.query(
      `SELECT id, customer_name, rating, review_text, image_url, created_at
       FROM reviews
       WHERE product_id = ? AND is_approved = 1
       ORDER BY id DESC`,
      [product.id]
    );

    // Fetch related/recommended products from same category
    const related = await db.query(
      `SELECT p.id, p.name, p.slug, p.regular_price, p.discounted_price, p.is_out_of_stock,
              (SELECT pi.image_url 
               FROM product_images pi 
               WHERE pi.product_id = p.id 
               ORDER BY pi.image_order ASC 
               LIMIT 1) as primary_image
       FROM products p
       WHERE p.category_id = ? AND p.id != ? AND p.deleted_at IS NULL AND p.is_active = 1
       LIMIT 8`,
      [product.category_id, product.id]
    );

    const formattedProduct = {
      ...product,
      regular_price: parseFloat(product.regular_price),
      discounted_price: parseFloat(product.discounted_price),
      discount_percentage: calculateDiscount(product.regular_price, product.discounted_price),
      is_out_of_stock: Boolean(product.is_out_of_stock),
      is_recommended: Boolean(product.is_recommended),
      is_bestseller: Boolean(product.is_bestseller),
      is_new_arrival: Boolean(product.is_new_arrival),
      images: images.map((img) => img.image_url),
      image_records: images,
      reviews,
      review_count: reviews.length,
      average_rating: reviews.length > 0 
        ? (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1)
        : '4.9',
      related: related.map((r) => ({
        ...r,
        regular_price: parseFloat(r.regular_price),
        discounted_price: parseFloat(r.discounted_price),
        discount_percentage: calculateDiscount(r.regular_price, r.discounted_price)
      }))
    };

    return res.status(200).json({
      success: true,
      product: formattedProduct
    });
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------
// ADMIN PRODUCT CRUD ENDPOINTS
// ----------------------------------------------------

// 1. Admin: Get all products (including inactive and out of stock)
exports.getAdminProducts = async (req, res, next) => {
  try {
    const { category_id, is_out_of_stock, is_recommended, is_bestseller, is_active, search, page = 1, limit = 50 } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNumber - 1) * pageSize;
    const params = [];
    const countParams = [];

    let whereSql = `WHERE p.deleted_at IS NULL`;

    if (category_id) {
      whereSql += ` AND p.category_id = ?`;
      params.push(parseInt(category_id, 10));
      countParams.push(parseInt(category_id, 10));
    }

    if (is_out_of_stock !== undefined && is_out_of_stock !== '') {
      whereSql += ` AND p.is_out_of_stock = ?`;
      params.push(is_out_of_stock === 'true' || is_out_of_stock === '1' ? 1 : 0);
      countParams.push(is_out_of_stock === 'true' || is_out_of_stock === '1' ? 1 : 0);
    }

    if (is_recommended !== undefined && is_recommended !== '') {
      whereSql += ` AND p.is_recommended = ?`;
      params.push(is_recommended === 'true' || is_recommended === '1' ? 1 : 0);
      countParams.push(is_recommended === 'true' || is_recommended === '1' ? 1 : 0);
    }

    if (is_bestseller !== undefined && is_bestseller !== '') {
      whereSql += ` AND p.is_bestseller = ?`;
      params.push(is_bestseller === 'true' || is_bestseller === '1' ? 1 : 0);
      countParams.push(is_bestseller === 'true' || is_bestseller === '1' ? 1 : 0);
    }

    if (is_active !== undefined && is_active !== '') {
      whereSql += ` AND p.is_active = ?`;
      params.push(is_active === 'true' || is_active === '1' ? 1 : 0);
      countParams.push(is_active === 'true' || is_active === '1' ? 1 : 0);
    }

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;
      whereSql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.tags LIKE ?)`;
      params.push(searchTerm, searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm, searchTerm);
    }

    const totalCountRows = await db.query(
      `SELECT COUNT(*) as total FROM products p ${whereSql}`,
      countParams
    );
    const totalItems = totalCountRows[0].total;

    const products = await db.query(
      `SELECT p.*, c.name as category_name,
              (SELECT pi.image_url 
               FROM product_images pi 
               WHERE pi.product_id = p.id 
               ORDER BY pi.image_order ASC 
               LIMIT 1) as primary_image,
              (SELECT COUNT(*) 
               FROM product_images pi 
               WHERE pi.product_id = p.id) as image_count
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereSql}
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const formatted = products.map((p) => ({
      ...p,
      regular_price: parseFloat(p.regular_price),
      discounted_price: parseFloat(p.discounted_price),
      discount_percentage: calculateDiscount(p.regular_price, p.discounted_price),
      is_out_of_stock: Boolean(p.is_out_of_stock),
      is_recommended: Boolean(p.is_recommended),
      is_bestseller: Boolean(p.is_bestseller),
      is_new_arrival: Boolean(p.is_new_arrival),
      is_active: Boolean(p.is_active)
    }));

    return res.status(200).json({
      success: true,
      data: formatted,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    });
  } catch (error) {
    next(error);
  }
};

// 2. Admin: Create new product with up to 10 images
exports.createProduct = async (req, res, next) => {
  try {
    const {
      name,
      category_id,
      description,
      regular_price,
      discounted_price,
      is_recommended = 0,
      is_bestseller = 0,
      is_new_arrival = 0,
      is_out_of_stock = 0,
      is_active = 1,
      tags = '',
      images = []
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Product name is required' });
    }

    if (!category_id) {
      return res.status(400).json({ success: false, message: 'Category is required' });
    }

    const regPrice = parseFloat(regular_price);
    const discPrice = parseFloat(discounted_price);

    if (isNaN(regPrice) || regPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Regular price must be a positive number' });
    }

    if (isNaN(discPrice) || discPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Discounted price must be a positive number' });
    }

    if (discPrice > regPrice) {
      return res.status(400).json({ success: false, message: 'Discounted price cannot be greater than regular price' });
    }

    // Filter valid image URLs (up to 10 max)
    const validImages = (Array.isArray(images) ? images : [])
      .map((url) => (typeof url === 'string' ? url.trim() : ''))
      .filter((url) => url.length > 0 && /^https?:\/\//i.test(url))
      .slice(0, 10);

    if (validImages.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid product image URL is required' });
    }

    // Verify category exists
    const categories = await db.query('SELECT name FROM categories WHERE id = ?', [category_id]);
    if (categories.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid category selected' });
    }

    const categoryName = categories[0].name;
    const baseSlug = slugify(name);
    const uniqueSlug = `${baseSlug}-${Date.now().toString().slice(-4)}`;
    const sku = req.body.sku && req.body.sku.trim() ? req.body.sku.trim() : generateSku(categoryName);

    const skuConflict = await db.query('SELECT id FROM products WHERE sku = ?', [sku]);
    if (skuConflict.length > 0) {
      return res.status(400).json({ success: false, message: 'This SKU is already in use.' });
    }

    // Run transaction
    const result = await db.withTransaction(async (conn) => {
      const [prodInsert] = await conn.execute(
        `INSERT INTO products (
          sku, name, slug, category_id, description, regular_price, discounted_price,
          is_recommended, is_bestseller, is_new_arrival, is_out_of_stock, is_active, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sku,
          name.trim(),
          uniqueSlug,
          category_id,
          description || '',
          regPrice,
          discPrice,
          is_recommended ? 1 : 0,
          is_bestseller ? 1 : 0,
          is_new_arrival ? 1 : 0,
          is_out_of_stock ? 1 : 0,
          is_active ? 1 : 0,
          tags || ''
        ]
      );

      const productId = prodInsert.insertId;

      // Insert product images
      for (let i = 0; i < validImages.length; i++) {
        await conn.execute(
          `INSERT INTO product_images (product_id, image_url, image_order) VALUES (?, ?, ?)`,
          [productId, validImages[i], i + 1]
        );
      }

      return productId;
    });

    await logAdminAction(req.admin.id, 'PRODUCT_CREATED', 'PRODUCT', result, { name, sku });

    return res.status(201).json({
      success: true,
      message: 'Product created successfully',
      productId: result,
      sku
    });
  } catch (error) {
    next(error);
  }
};

// 3. Admin: Update product details
exports.updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name,
      category_id,
      description,
      regular_price,
      discounted_price,
      is_recommended,
      is_bestseller,
      is_new_arrival,
      is_out_of_stock,
      is_active,
      tags,
      images
    } = req.body;

    const existing = await db.query('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const current = existing[0];
    const regPrice = parseFloat(regular_price !== undefined ? regular_price : current.regular_price);
    const discPrice = parseFloat(discounted_price !== undefined ? discounted_price : current.discounted_price);

    const updatedName = (name && name.trim()) ? name.trim() : current.name;
    const targetCategoryId = category_id !== undefined ? parseInt(category_id, 10) : current.category_id;

    const categories = await db.query('SELECT id FROM categories WHERE id = ?', [targetCategoryId]);
    if (categories.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid category selected' });
    }

    if (isNaN(regPrice) || regPrice <= 0 || isNaN(discPrice) || discPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Valid positive prices are required' });
    }

    if (discPrice > regPrice) {
      return res.status(400).json({ success: false, message: 'Discounted price cannot be greater than regular price' });
    }

    // Preserve existing boolean flags if omitted in request
    const recVal = is_recommended !== undefined ? (is_recommended ? 1 : 0) : current.is_recommended;
    const bestVal = is_bestseller !== undefined ? (is_bestseller ? 1 : 0) : current.is_bestseller;
    const newArrivalVal = is_new_arrival !== undefined ? (is_new_arrival ? 1 : 0) : current.is_new_arrival;
    const outOfStockVal = is_out_of_stock !== undefined ? (is_out_of_stock ? 1 : 0) : current.is_out_of_stock;
    const activeVal = is_active !== undefined ? (is_active ? 1 : 0) : current.is_active;

    // Filter valid image URLs if provided (up to 10 max)
    let validImages = null;
    if (Array.isArray(images) && images.length > 0) {
      validImages = images
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter((url) => url.length > 0 && /^https?:\/\//i.test(url))
        .slice(0, 10);
    }

    await db.withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE products
         SET name = ?,
             category_id = ?,
             description = ?,
             regular_price = ?,
             discounted_price = ?,
             is_recommended = ?,
             is_bestseller = ?,
             is_new_arrival = ?,
             is_out_of_stock = ?,
             is_active = ?,
             tags = ?
         WHERE id = ?`,
        [
          updatedName,
          targetCategoryId,
          description !== undefined ? description : current.description,
          regPrice,
          discPrice,
          recVal,
          bestVal,
          newArrivalVal,
          outOfStockVal,
          activeVal,
          tags !== undefined ? tags : current.tags,
          id
        ]
      );

      // If valid images are supplied, replace product images
      if (validImages && validImages.length > 0) {
        await conn.execute('DELETE FROM product_images WHERE product_id = ?', [id]);
        for (let i = 0; i < validImages.length; i++) {
          await conn.execute(
            'INSERT INTO product_images (product_id, image_url, image_order) VALUES (?, ?, ?)',
            [id, validImages[i], i + 1]
          );
        }
      }
    });

    await logAdminAction(req.admin.id, 'PRODUCT_UPDATED', 'PRODUCT', id, { name: updatedName });

    return res.status(200).json({
      success: true,
      message: 'Product updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 4. Admin: Soft delete product
exports.deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await db.query('SELECT name FROM products WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    await db.query('UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    await logAdminAction(req.admin.id, 'PRODUCT_DELETED', 'PRODUCT', id, { name: existing[0].name });

    return res.status(200).json({
      success: true,
      message: 'Product deleted successfully (soft deleted)'
    });
  } catch (error) {
    next(error);
  }
};

// 5. Admin: Quick toggle status (Out of stock, recommended, bestseller, active)
exports.toggleProductFlag = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { field, value } = req.body;

    const allowedFields = ['is_out_of_stock', 'is_recommended', 'is_bestseller', 'is_new_arrival', 'is_active'];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ success: false, message: 'Invalid toggle field' });
    }

    const existing = await db.query('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const boolVal = value ? 1 : 0;
    await db.query(`UPDATE products SET ${field} = ? WHERE id = ?`, [boolVal, id]);

    await logAdminAction(req.admin.id, 'PRODUCT_FLAG_TOGGLED', 'PRODUCT', id, { field, value: boolVal });

    return res.status(200).json({
      success: true,
      message: `Product ${field} updated successfully`,
      field,
      value: Boolean(boolVal)
    });
  } catch (error) {
    next(error);
  }
};
