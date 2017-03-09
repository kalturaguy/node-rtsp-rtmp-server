/*
* Usage

    logger = require './logger'
    
    * Set log level to filter out unwanted log messages
    logger.setLevel logger.LEVEL_INFO
    logger.debug 'debug message'
    logger.info 'info message'
    logger.warn 'warn message'
    logger.error 'error message'
    logger.fatal 'fatal message'
    
    * Enable a tag to activate log messages for the tag
    logger.enableTag 'testtag'
    logger.tag 'testtag', 'testtag message'
    logger.tag 'anothertag', 'anothertag message'
    
    * Print raw string. Equivalent of console.log().
    logger.raw "hello\nraw\nstring"
*/

// Current log level
let logLevel = null;

let activeTags = {};

let zeropad = function(columns, num) {
  num += '';
  while (num.length < columns) {
    num = `0${num}`;
  }
  return num;
};

var api = {
  LEVEL_DEBUG: 0,
  LEVEL_INFO: 1,
  LEVEL_WARN: 2,
  LEVEL_ERROR: 3,
  LEVEL_FATAL: 4,
  LEVEL_OFF: 5,

  enableTag(tag) {
    return activeTags[tag] = true;
  },

  disableTag(tag) {
    return delete activeTags[tag];
  },

  print(str, raw) {
    if (raw == null) { raw = false; }
    if (!raw) {
      let d = new Date();
      process.stdout.write(`${d.getFullYear()}-${zeropad(2, d.getMonth()+1)}-` +
        `${zeropad(2, d.getDate())} ${zeropad(2, d.getHours())}:` +
        `${zeropad(2, d.getMinutes())}:${zeropad(2, d.getSeconds())}.` +
        `${zeropad(3, d.getMilliseconds())} `
      );
    }
    return console.log(str);
  },

  tag(tag, str, raw) {
    if (raw == null) { raw = false; }
    if (activeTags[tag] != null) {
      return api.print(str, raw);
    }
  },

  msg(level, str, raw) {
    if (raw == null) { raw = false; }
    if (level >= logLevel) {
      return api.print(str, raw);
    }
  },

  // Prints message without header
  raw(str) {
    return api.print(str, true);
  },

  setLevel(level) {
    return logLevel = level;
  },

  getLevel() {
    return logLevel;
  },

  debug(str, raw) {
    if (raw == null) { raw = false; }
    return api.msg(api.LEVEL_DEBUG, str, raw);
  },

  info(str, raw) {
    if (raw == null) { raw = false; }
    return api.msg(api.LEVEL_INFO, str, raw);
  },

  warn(str, raw) {
    if (raw == null) { raw = false; }
    return api.msg(api.LEVEL_WARN, str, raw);
  },

  error(str, raw) {
    if (raw == null) { raw = false; }
    return api.msg(api.LEVEL_ERROR, str, raw);
  },

  fatal(str, raw) {
    if (raw == null) { raw = false; }
    return api.msg(api.LEVEL_FATAL, str, raw);
  }
};

logLevel = api.LEVEL_INFO;  // default verbosity

export default api;
