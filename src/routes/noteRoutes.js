const express = require('express');
const router = express.Router();
const noteController = require('../controllers/noteController');
const { verifyAdminAuth } = require('../middleware/auth');

router.get('/admin/all', verifyAdminAuth, noteController.getNotes);
router.post('/admin', verifyAdminAuth, noteController.createNote);
router.put('/admin/:id', verifyAdminAuth, noteController.updateNote);
router.delete('/admin/:id', verifyAdminAuth, noteController.deleteNote);

module.exports = router;
