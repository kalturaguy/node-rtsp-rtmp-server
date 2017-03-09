import crypto from 'crypto';

export default {
  // Calculate the digest of data and return a buffer
  calcHmac(data, key) {
    let hmac = crypto.createHmac('sha256', key);
    hmac.update(data);
    return hmac.digest();
  }
};
