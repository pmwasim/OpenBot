const LOOPBACK_V4 = /^127(?:\.(?:\d{1,3})){3}$/;

export function isLoopbackHost(host) {
  if (host == null || host === '') return false;
  const value = String(host).trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  return LOOPBACK_V4.test(value);
}

export function assertBindHost(host, env = process.env) {
  const value = host == null || host === '' ? '127.0.0.1' : String(host);
  if (isLoopbackHost(value)) return { host: value, allowed: true, overridden: false };
  if (String(env.OPENBOT_ALLOW_NON_LOOPBACK || '') === '1') {
    return { host: value, allowed: true, overridden: true };
  }
  const error = new Error(
    `Refusing to bind HOST=${value}. OpenBot preview has no authentication and must stay on loopback. Set OPENBOT_ALLOW_NON_LOOPBACK=1 to override.`
  );
  error.code = 'OPENBOT_NON_LOOPBACK';
  throw error;
}
