const crypto = require('crypto');
const config = require('../config/env');
const db = require('../config/db');

class OtpService {
  /**
   * Compute a secure HMAC/SHA-256 hash for the OTP so plaintext is never permanently stored.
   */
  hashOtp(mobileNumber, otp) {
    return crypto
      .createHash('sha256')
      .update(`${mobileNumber}:${otp}:${config.jwtSecret}`)
      .digest('hex');
  }

  /**
   * Generate a cryptographically secure 6-digit OTP
   */
  generateSecureOtp() {
    return crypto.randomInt(100000, 1000000).toString();
  }

  /**
   * Send OTP via Renflair SMS Gateway (https://sms.renflair.in/V1.php)
   * @param {string} mobileNumber - 10-digit Indian mobile number
   */
  async sendOtp(mobileNumber) {
    if (!mobileNumber) {
      throw new Error('Mobile number is required.');
    }

    const cleanMobile = String(mobileNumber).replace(/\D/g, '').slice(-10);
    if (cleanMobile.length !== 10) {
      throw new Error('Invalid mobile number format. Please provide a 10-digit number.');
    }

    const now = new Date();

    // Check existing active OTP for rate limiting & cooldown
    const existingRows = await db.query(
      `SELECT * FROM otp_verifications 
       WHERE mobile_number = ? AND is_verified = 0 AND expires_at > NOW() 
       ORDER BY id DESC LIMIT 1`,
      [cleanMobile]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];
      const lastSent = new Date(existing.last_sent_at);
      const secondsSinceLast = Math.floor((now.getTime() - lastSent.getTime()) / 1000);

      // Cooldown rule: 60 seconds
      if (secondsSinceLast < 60) {
        const waitTime = 60 - secondsSinceLast;
        const err = new Error(`Please wait ${waitTime} seconds before requesting a new OTP.`);
        err.status = 429;
        throw err;
      }

      // Max resend rule per active session: 5
      if (existing.resend_count >= 5) {
        const err = new Error('Maximum OTP resend limit reached for this session. Please try again after 15 minutes.');
        err.status = 429;
        throw err;
      }
    }

    // Compute resend count across this active session
    const currentResendCount = existingRows.length > 0 ? (existingRows[0].resend_count || 1) + 1 : 1;

    // Generate secure 6-digit random OTP
    const otp = this.generateSecureOtp();
    const otpHash = this.hashOtp(cleanMobile, otp);
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes validity

    // Dispatch SMS via Renflair SMS Gateway API
    const renflairKey = config.renflairApiKey;
    const renflairUrl = config.renflairApiUrl || 'https://sms.renflair.in/V1.php';
    const appDomain = config.appDomain || 'goldenzone.in';
    const appName = config.appName || 'Golden Zone';

    if (!renflairKey) {
      const err = new Error('SMS service is temporarily unconfigured. Please contact support.');
      err.status = 503;
      throw err;
    }

    try {
      const requestUrl = new URL(renflairUrl);
      requestUrl.searchParams.append('API', renflairKey);
      requestUrl.searchParams.append('PHONE', cleanMobile);
      requestUrl.searchParams.append('OTP', otp);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(requestUrl.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': `${appName}-Backend/1.0 (${appDomain})`
        }
      });
      clearTimeout(timeoutId);

      const responseText = await response.text();
      let isSuccess = response.ok;

      if (!response.ok) {
        isSuccess = false;
      } else {
        try {
          const parsed = JSON.parse(responseText);
          if (parsed && (
            (parsed.status && /fail|error/i.test(String(parsed.status))) ||
            (parsed.type && /fail|error/i.test(String(parsed.type)))
          )) {
            isSuccess = false;
          }
        } catch {
          if (/invalid|error|failed/i.test(responseText)) {
            isSuccess = false;
          }
        }
      }

      if (!isSuccess) {
        const err = new Error('SMS service temporarily unavailable. Please try again shortly.');
        err.status = 503;
        throw err;
      }
    } catch (smsErr) {
      if (smsErr.status) throw smsErr;
      // Never log the raw URL, API key or OTP secret!
      console.error('❌ [Renflair SMS Gateway Error]:', smsErr.name === 'AbortError' ? 'Request timed out after 8s' : 'Network dispatch failed');
      const err = new Error('SMS service temporarily unavailable. Please try again shortly.');
      err.status = 503;
      throw err;
    }

    // Invalidate prior unverified OTPs for this number
    await db.query(
      `UPDATE otp_verifications SET is_verified = 2 WHERE mobile_number = ? AND is_verified = 0`,
      [cleanMobile]
    );

    // Store new hashed OTP in database with incremented resend count
    await db.query(
      `INSERT INTO otp_verifications (
        mobile_number, otp_hash, attempts, resend_count, last_sent_at, expires_at, is_verified
      ) VALUES (?, ?, 0, ?, NOW(), ?, 0)`,
      [cleanMobile, otpHash, currentResendCount, expiresAt]
    );

    return {
      success: true,
      message: `OTP sent successfully to +91 ${cleanMobile}`,
      mobile: cleanMobile,
      expiresInSeconds: 300
    };
  }

  /**
   * Verify provided OTP securely against stored hash.
   * @param {string} mobileNumber
   * @param {string} otp
   */
  async verifyOtp(mobileNumber, otp) {
    if (!mobileNumber || !otp) {
      return { success: false, message: 'Mobile number and OTP are required' };
    }

    const cleanMobile = String(mobileNumber).replace(/\D/g, '').slice(-10);
    const providedOtp = String(otp).trim();

    if (cleanMobile.length !== 10 || !/^\d{6}$/.test(providedOtp)) {
      return { success: false, message: 'Please enter a valid 6-digit OTP' };
    }

    // Look up latest active unverified OTP for this number
    const rows = await db.query(
      `SELECT * FROM otp_verifications 
       WHERE mobile_number = ? AND is_verified = 0 
       ORDER BY id DESC LIMIT 1`,
      [cleanMobile]
    );

    if (rows.length === 0) {
      return { success: false, message: 'No active OTP found or code has expired. Please request a new OTP.' };
    }

    const record = rows[0];

    // Check expiry
    const now = new Date();
    const expiresAt = new Date(record.expires_at);
    if (now > expiresAt) {
      await db.query(`UPDATE otp_verifications SET is_verified = 2 WHERE id = ?`, [record.id]);
      return { success: false, message: 'OTP has expired. Please request a new code.' };
    }

    // Check maximum attempts limit (max 5)
    if (record.attempts >= 5) {
      await db.query(`UPDATE otp_verifications SET is_verified = 2 WHERE id = ?`, [record.id]);
      return {
        success: false,
        message: 'Maximum verification attempts exceeded. For your security, this OTP is invalidated. Please request a new one.'
      };
    }

    // Check hash
    const expectedHash = this.hashOtp(cleanMobile, providedOtp);
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(record.otp_hash, 'utf8'),
      Buffer.from(expectedHash, 'utf8')
    );

    if (!isMatch) {
      // Increment failed attempts counter and invalidate if max reached
      const newAttempts = record.attempts + 1;
      const isMaxReached = newAttempts >= 5;
      await db.query(
        `UPDATE otp_verifications SET attempts = ?, is_verified = ? WHERE id = ?`,
        [newAttempts, isMaxReached ? 2 : 0, record.id]
      );

      const remaining = Math.max(0, 5 - newAttempts);
      return {
        success: false,
        message: remaining > 0
          ? `Incorrect OTP. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`
          : 'Incorrect OTP. Maximum attempts reached. This OTP has been invalidated.'
      };
    }

    // Invalidate OTP immediately upon successful verification (atomic mark as verified)
    await db.query(
      `UPDATE otp_verifications SET is_verified = 1 WHERE id = ?`,
      [record.id]
    );

    return { success: true, message: 'OTP verified successfully' };
  }
}

module.exports = new OtpService();
