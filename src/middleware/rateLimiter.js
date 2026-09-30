const rateLimit = require('express-rate-limit');

// Limiter for OTP generation / requests (e.g., 10 requests per 15 minutes per IP)
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests from this address. Please try again after 15 minutes.'
  }
});

// Limiter for Admin and Customer Login attempts (e.g., 20 attempts per 15 minutes)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after a few minutes.'
  }
});

// Limiter for Order Placement (e.g., 30 orders per 15 minutes)
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Order rate limit reached. Please wait a moment before trying again.'
  }
});

// Limiter for Contact Enquiries
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many enquiries submitted. Please wait a while before sending another message.'
  }
});

const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many review submissions. Please try again later.'
  }
});

module.exports = {
  otpLimiter,
  loginLimiter,
  orderLimiter,
  contactLimiter,
  reviewLimiter
};
