const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;
const pretty = process.env.LOG_FORMAT === 'pretty' || process.stdout.isTTY;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  if (pretty) {
    const extra = fields && Object.keys(fields).length
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(' ')
      : '';
    const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    return;
  }
  const record = { time, level, msg, ...fields };
  const line = JSON.stringify(record, replacer);
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

function format(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value, replacer);
}

function replacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code };
  }
  return value;
}

export const logger = {
  trace: (msg, fields) => emit('trace', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  child(base) {
    const wrap = (level) => (msg, fields) => emit(level, msg, { ...base, ...fields });
    return {
      trace: wrap('trace'),
      debug: wrap('debug'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
      child: (more) => logger.child({ ...base, ...more }),
    };
  },
};
