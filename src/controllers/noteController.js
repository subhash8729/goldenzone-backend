const db = require('../config/db');

// Format full readable date
function formatReadableDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// 1. Admin: Get all notes
exports.getNotes = async (req, res, next) => {
  try {
    const notes = await db.query(
      `SELECT n.*, a.full_name as author_name
       FROM admin_notes n
       LEFT JOIN admins a ON n.admin_id = a.id
       ORDER BY n.is_pinned DESC, n.id DESC`
    );

    const formatted = notes.map((nt) => ({
      ...nt,
      is_pinned: Boolean(nt.is_pinned),
      formatted_created: formatReadableDate(nt.created_at),
      formatted_updated: formatReadableDate(nt.updated_at)
    }));

    return res.status(200).json({
      success: true,
      data: formatted
    });
  } catch (error) {
    next(error);
  }
};

// 2. Admin: Create a note
exports.createNote = async (req, res, next) => {
  try {
    const adminId = req.admin.id;
    const { note_text, is_pinned = 0 } = req.body;

    if (!note_text || !note_text.trim()) {
      return res.status(400).json({ success: false, message: 'Note text cannot be empty' });
    }

    const result = await db.query(
      `INSERT INTO admin_notes (admin_id, note_text, is_pinned) VALUES (?, ?, ?)`,
      [adminId, note_text.trim(), is_pinned ? 1 : 0]
    );

    return res.status(201).json({
      success: true,
      message: 'Note created successfully',
      noteId: result.insertId
    });
  } catch (error) {
    next(error);
  }
};

// 3. Admin: Update a note
exports.updateNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note_text, is_pinned } = req.body;

    if (!note_text || !note_text.trim()) {
      return res.status(400).json({ success: false, message: 'Note text cannot be empty' });
    }

    await db.query(
      `UPDATE admin_notes SET note_text = ?, is_pinned = ? WHERE id = ?`,
      [note_text.trim(), is_pinned ? 1 : 0, id]
    );

    return res.status(200).json({
      success: true,
      message: 'Note updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 4. Admin: Delete a note
exports.deleteNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM admin_notes WHERE id = ?', [id]);

    return res.status(200).json({
      success: true,
      message: 'Note deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
