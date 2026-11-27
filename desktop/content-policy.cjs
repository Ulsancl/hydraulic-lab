const documentPolicy = [
  "default-src 'self'", "img-src 'self'", "style-src 'self'", "script-src 'self'",
  "worker-src 'none'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'none'", "frame-src 'none'",
].join('; ');

module.exports = { documentPolicy };
