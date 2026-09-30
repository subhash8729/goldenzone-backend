// Centralized Express Error Handling Middleware
function errorHandler(err, req, res, next) {
  console.error('🔥 [Server Error]:', err);

  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error occurred. Please try again.';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    message: `Resource not found at ${req.originalUrl}`
  });
}

module.exports = {
  errorHandler,
  notFoundHandler
};
