const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');
const config = require('../src/config/env');
const jwt = require('jsonwebtoken');

let server;
let baseUrl;

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          // keep as string
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runMultiImagesTest() {
  console.log('====================================================');
  console.log('🖼️ VERIFYING ADMIN PRODUCT MULTI-IMAGE MANAGEMENT FLOW');
  console.log('====================================================\n');

  let testAdminToken;
  let testProductId;
  let testCategory;
  const uniqueSuffix = Date.now().toString().slice(-6);
  const testSku = `TEST-IMG-${uniqueSuffix}`;
  const testSlug = `test-img-necklace-${uniqueSuffix}`;

  const imgA = 'https://pashupati.co/cdn/shop/files/image_A_front_angle.jpg';
  const imgB = 'https://pashupati.co/cdn/shop/files/image_B_side_angle.jpg';
  const imgC = 'https://pashupati.co/cdn/shop/files/image_C_lifestyle_angle.jpg';

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
    console.log(`✓ Test HTTP server listening on port ${port}`);

    // Generate Admin JWT token
    const [adminRow] = await db.query('SELECT id, mobile_number FROM admins LIMIT 1');
    if (!adminRow) {
      throw new Error('FAIL: No admin found in database for testing.');
    }
    testAdminToken = jwt.sign(
      { id: adminRow.id, mobile_number: adminRow.mobile_number, isAdmin: true },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const authHeaders = { Authorization: `Bearer ${testAdminToken}` };

    // Get an active category
    const [cat] = await db.query('SELECT id, slug FROM categories LIMIT 1');
    testCategory = cat;

    // --- STEP 1: CREATE PRODUCT WITH 2 INITIAL IMAGES (Img A, Img B) ---
    console.log('\n--- 1. CREATE PRODUCT WITH MULTIPLE IMAGES ---');
    const createRes = await request('POST', '/api/products', authHeaders, {
      name: `Test Multi-Image Jewellery ${uniqueSuffix}`,
      category_id: testCategory.id,
      sku: testSku,
      regular_price: 1800,
      discounted_price: 1350,
      description: 'Testing multi-image admin capabilities and customer gallery.',
      images: [imgA, imgB]
    });

    if (createRes.status !== 201) {
      throw new Error(`Failed to create product: ${JSON.stringify(createRes.body)}`);
    }
    testProductId = createRes.body.productId;
    console.log(`✓ [Step 1] Created product ID ${testProductId} with 2 images (SKU: ${testSku})`);

    // --- STEP 2: ADMIN VIEW ALL IMAGES IN CATALOGUE & DETAILS ---
    console.log('\n--- 2. ADMIN: VIEW ALL IMAGES ---');
    const adminListRes = await request('GET', `/api/products/admin/all?search=${testSku}`, authHeaders);
    if (adminListRes.status !== 200 || !adminListRes.body.data || adminListRes.body.data.length === 0) {
      throw new Error(`Admin product list failed: ${JSON.stringify(adminListRes.body)}`);
    }
    const adminProductItem = adminListRes.body.data[0];
    if (!Array.isArray(adminProductItem.images) || adminProductItem.images.length !== 2) {
      throw new Error(`Expected admin product to include 2 images, got ${adminProductItem.images?.length}`);
    }
    if (adminProductItem.primary_image !== imgA) {
      throw new Error(`Expected primary_image to be Image A (${imgA}), got ${adminProductItem.primary_image}`);
    }
    console.log('✓ [Step 2a] PASS: Admin products list includes full images array, image_count = 2, and primary_image.');

    // Fetch images via dedicated endpoint
    const imagesEndpointRes = await request('GET', `/api/products/${testProductId}/images`, authHeaders);
    if (imagesEndpointRes.status !== 200 || !imagesEndpointRes.body.images) {
      throw new Error(`Dedicated images endpoint failed: ${JSON.stringify(imagesEndpointRes.body)}`);
    }
    const fetchedImages = imagesEndpointRes.body.images;
    if (fetchedImages.length !== 2) {
      throw new Error(`Expected 2 images, got ${fetchedImages.length}`);
    }
    if (!fetchedImages[0].is_primary || fetchedImages[1].is_primary) {
      throw new Error('Image #1 should be marked is_primary: true, Image #2 should be is_primary: false');
    }
    const imageAId = fetchedImages[0].id;
    const imageBId = fetchedImages[1].id;
    console.log(`✓ [Step 2b] PASS: Dedicated endpoint returns all images with correct primary status (ImgA ID: ${imageAId}, ImgB ID: ${imageBId}).`);

    // --- STEP 3: CUSTOMER INITIAL VIEW ---
    console.log('\n--- 3. CUSTOMER VIEW: INITIAL VERIFICATION ---');
    const customerInitialRes = await request('GET', `/api/products/${testProductItemSlug(adminProductItem)}`);
    if (customerInitialRes.status !== 200) {
      throw new Error(`Customer product view failed: ${customerInitialRes.status}`);
    }
    const custProd = customerInitialRes.body.product;
    if (custProd.images.length !== 2 || custProd.images[0] !== imgA) {
      throw new Error(`Customer gallery mismatch: ${JSON.stringify(custProd.images)}`);
    }
    console.log('✓ [Step 3] PASS: Customer sees Image A as initial photo and 2 total gallery images.');

    // --- STEP 4: ADMIN ADD NEW IMAGE (Image C) ---
    console.log('\n--- 4. ADMIN: ADD NEW IMAGE (Image C) ---');
    const addImgRes = await request('POST', `/api/products/${testProductId}/images`, authHeaders, {
      image_url: imgC
    });
    if (addImgRes.status !== 201 || !addImgRes.body.image) {
      throw new Error(`Add image failed: ${JSON.stringify(addImgRes.body)}`);
    }
    const imageCId = addImgRes.body.image.id;
    console.log(`✓ [Step 4] PASS: Added Image C to product (Image ID: ${imageCId}).`);

    // Verify customer view has 3 images
    const custAfterAdd = await request('GET', `/api/products/${testProductItemSlug(adminProductItem)}`);
    if (custAfterAdd.body.product.images.length !== 3) {
      throw new Error(`Expected customer gallery to have 3 images, got ${custAfterAdd.body.product.images.length}`);
    }
    console.log('✓ [Step 4b] PASS: Customer gallery updated with 3 images in real time.');

    // --- STEP 5: ADMIN CHANGE PRIMARY IMAGE (Set Image C as Primary) ---
    console.log('\n--- 5. ADMIN: CHANGE PRIMARY IMAGE ---');
    const setPrimaryRes = await request('PATCH', `/api/products/${testProductId}/images/${imageCId}/primary`, authHeaders);
    if (setPrimaryRes.status !== 200) {
      throw new Error(`Set primary image failed: ${JSON.stringify(setPrimaryRes.body)}`);
    }
    console.log('✓ [Step 5a] Admin set primary image endpoint returned HTTP 200 Success.');

    // Verify admin sees Image C as primary
    const adminAfterPrimary = await request('GET', `/api/products/admin/all?search=${testSku}`, authHeaders);
    const updatedAdminProd = adminAfterPrimary.body.data[0];
    if (updatedAdminProd.primary_image !== imgC) {
      throw new Error(`Expected primary_image to be Image C (${imgC}), got ${updatedAdminProd.primary_image}`);
    }
    console.log('✓ [Step 5b] PASS: Admin table reflects new primary image (Image C).');

    // Verify customer sees Image C as primary and first in gallery
    const custAfterPrimary = await request('GET', `/api/products/${testProductItemSlug(adminProductItem)}`);
    if (custAfterPrimary.body.product.images[0] !== imgC) {
      throw new Error(`Expected customer gallery first image to be Image C, got ${custAfterPrimary.body.product.images[0]}`);
    }
    console.log('✓ [Step 5c] PASS: Customer product detail shows Image C as first gallery image!');

    // --- STEP 6: ADMIN DELETE INDIVIDUAL IMAGE (Delete Image B) ---
    console.log('\n--- 6. ADMIN: DELETE INDIVIDUAL IMAGE WITHOUT DELETING PRODUCT ---');
    const deleteImgRes = await request('DELETE', `/api/products/${testProductId}/images/${imageBId}`, authHeaders);
    if (deleteImgRes.status !== 200) {
      throw new Error(`Delete image failed: ${JSON.stringify(deleteImgRes.body)}`);
    }
    console.log(`✓ [Step 6a] Image B (ID: ${imageBId}) deleted successfully.`);

    // Verify the product still exists in DB!
    const [prodCheck] = await db.query('SELECT id, name FROM products WHERE id = ?', [testProductId]);
    if (!prodCheck) {
      throw new Error('FAIL: Product itself was deleted when deleting an image!');
    }
    console.log('✓ [Step 6b] PASS: Product row remains intact in products table.');

    // Verify remaining images in DB are exactly 2 (Image C and Image A)
    const [imgCheck] = await db.query('SELECT COUNT(*) as count FROM product_images WHERE product_id = ?', [testProductId]);
    if (imgCheck.count !== 2) {
      throw new Error(`Expected 2 images remaining, found ${imgCheck.count}`);
    }
    console.log('✓ [Step 6c] PASS: Only target image was removed; remaining 2 images preserved.');

    // --- STEP 7: DELETE PRIMARY IMAGE (Image C) & VERIFY AUTO-PROMOTION ---
    console.log('\n--- 7. DELETE CURRENT PRIMARY IMAGE & TEST AUTO-PROMOTION ---');
    const deletePrimaryImgRes = await request('DELETE', `/api/products/${testProductId}/images/${imageCId}`, authHeaders);
    if (deletePrimaryImgRes.status !== 200) {
      throw new Error(`Delete primary image failed: ${JSON.stringify(deletePrimaryImgRes.body)}`);
    }
    const adminAfterDelPrimary = await request('GET', `/api/products/admin/all?search=${testSku}`, authHeaders);
    const finalAdminProd = adminAfterDelPrimary.body.data[0];
    if (finalAdminProd.primary_image !== imgA) {
      throw new Error(`Expected remaining Image A to become primary, got ${finalAdminProd.primary_image}`);
    }
    console.log('✓ [Step 7] PASS: Deleting primary image promoted remaining Image A to primary smoothly.');

    // --- CLEANUP ---
    console.log('\n--- CLEANUP ---');
    await request('DELETE', `/api/products/${testProductId}`, authHeaders);
    console.log('✓ Cleaned up test product.');

    console.log('\n====================================================');
    console.log('🎉 ALL PRODUCT MULTI-IMAGE TESTS PASSED PERFECTLY!');
    console.log('====================================================\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
  }
}

function testProductItemSlug(item) {
  return item.slug || item.id;
}

runMultiImagesTest().then(() => {
  // Graceful exit
  process.exit(process.exitCode || 0);
});
