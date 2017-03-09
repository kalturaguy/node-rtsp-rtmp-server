import ejs from 'ejs';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { spawn } from 'child_process';
import Sequent from 'sequent';

import logger from './logger';

// Directory to store EJS templates
let TEMPLATE_DIR = `${__dirname}/template`;

// Directory to store static files
let STATIC_DIR = `${__dirname}/public`;

// Filename of default file in static directory
let DIRECTORY_INDEX_FILENAME = 'index.html';

// Server name which is embedded in HTTP response header
let DEFAULT_SERVER_NAME = 'node-rtsp-rtmp-server';

// Response larger than this bytes is compressed
let GZIP_SIZE_THRESHOLD = 300;

let DAY_NAMES = [
  'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
];

let MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

let zeropad = function(width, num) {
  num += '';
  while (num.length < width) {
    num = `0${num}`;
  }
  return num;
};

class HTTPHandler {
  constructor(opts) {
    this.serverName = (opts != null ? opts.serverName : undefined) != null ? (opts != null ? opts.serverName : undefined) : DEFAULT_SERVER_NAME;
    this.documentRoot = (opts != null ? opts.documentRoot : undefined) != null ? (opts != null ? opts.documentRoot : undefined) : STATIC_DIR;
  }

  setServerName(name) {
    return this.serverName = name;
  }

  handlePath(filepath, req, callback) {
    // Example implementation
    if (filepath === '/crossdomain.xml') {
      return this.respondCrossDomainXML(req, callback);
    } else if (filepath === '/ping') {
      return this.respondText('pong', req, callback);
    } else if (filepath === '/list') {
      let opts =
        {files: [ 'foo', 'bar', 'baz' ]};
      return fs.readFile(`${TEMPLATE_DIR}/list.ejs`, {
        encoding: 'utf8'
      }, (err, template) => {
        if (err) {
          logger.error(err);
          return this.serverError(req, callback);
        } else {
          let html = ejs.render(template, opts);
          return this.respondHTML(html, req, callback);
        }
      }
      );
    } else if (filepath === '/302') {
      return this.redirect('/new-url', req, callback);
    } else if (filepath === '/404') {
      return this.notFound(req, callback);
    } else if (filepath === '/400') {
      return this.badRequest(req, callback);
    } else if (filepath === '/500') {
      return this.serverError(req, callback);
    } else {
      return this.respondStaticPath(`${this.documentRoot}/${filepath.slice(1)}`, req, callback);
    }
  }

  createHeader(params) {
    let protocol = params.protocol != null ? params.protocol : 'HTTP/1.1';
    let statusMessage = '200 OK';
    if ((params != null ? params.statusCode : undefined) != null) {
      if (params.statusCode === 404) {
        statusMessage = '404 Not Found';
      } else if (params.statusCode === 500) {
        statusMessage = '500 Internal Server Error';
      } else if (params.statusCode === 302) {
        statusMessage = '302 Found';
      } else if (params.statusCode === 301) {
        statusMessage = '301 Moved Permanently';
      } else if (params.statusCode === 206) {
        statusMessage = '206 Partial Content';
      } else if (params.statusCode === 400) {
        statusMessage = '400 Bad Request';
      } else if (params.statusCode === 401) {
        statusMessage = '401 Unauthorized';
      }
    }
    let header = `\
${protocol} ${statusMessage}
Date: ${api.getDateHeader()}
Server: ${this.serverName}
\
`;

    if (__guard__(__guard__(params != null ? params.req : undefined, x1 => x1.headers.connection), x => x.toLowerCase()) === 'keep-alive') {
      header += 'Connection: keep-alive\n';
    } else {
      header += 'Connection: close\n';
    }

    if ((params != null ? params.contentLength : undefined) != null) {
      header += `Content-Length: ${params.contentLength}\n`;
    }
    if ((params != null ? params.location : undefined) != null) {
      header += `Location: ${params.location}\n`;
    }
    if ((params != null ? params.contentType : undefined) != null) {
      header += `Content-Type: ${params.contentType}\n`;
    }
    if ((params != null ? params.contentEncoding : undefined) != null) {
      header += `Content-Encoding: ${params.contentEncoding}\n`;
    }
    if ((params != null ? params.contentRange : undefined) != null) {
      header += `Content-Range: ${params.contentRange}\n`;
    }
    if ((params != null ? params.authenticate : undefined) != null) {
      header += `WWW-Authenticate: ${params.authenticate}\n`;
    }
    return header.replace(/\n/g, '\r\n') + '\r\n';
  }

  redirect(path, req, callback) {
    let headerBytes = new Buffer(this.createHeader({
      statusCode: 302,
      location: path,
      req,
      contentLength: 0
    })
    );
    return callback(null, headerBytes);
  }

  notFound(req, callback) {
    let bodyBytes = new Buffer('Not Found', 'utf8');
    let bodyLength = bodyBytes.length;
    let headerBytes = new Buffer(this.createHeader({
      statusCode: 404,
      contentLength: bodyLength,
      req,
      contentType: "text/plain; charset=utf-8"
    }), 'utf8');
    let allBytes = Buffer.concat([headerBytes, bodyBytes], headerBytes.length + bodyLength);
    return callback(null, allBytes);
  }

  respondTextWithHeader(str, req, opts, callback) {
    let textBytes = new Buffer((str+''), 'utf8');
    let textLength = textBytes.length;
    let headerOpts = {
      statusCode: 200,
      contentLength: textLength,
      req,
      contentType: "text/plain; charset=utf-8"
    };
    if (opts != null) {
      for (let name in opts) {
        let value = opts[name];
        headerOpts[name] = value;
      }
    }
    let headerBytes = new Buffer(this.createHeader(headerOpts), 'utf8');
    let allBytes = Buffer.concat([headerBytes, textBytes], headerBytes.length + textLength);
    return callback(null, allBytes);
  }

  respondJavaScript(str, req, callback) {
    return this.respondTextWithHeader(str, req, {contentType: 'application/javascript; charset=utf-8'}, callback);
  }

  respondText(str, req, callback) {
    return this.respondTextWithHeader(str, req, null, callback);
  }

  treatCompress(bytes, req, callback) {
    if (bytes.length < GZIP_SIZE_THRESHOLD) {
      callback(null, bytes, null);
      return;
    }

    let acceptEncoding = req.headers['accept-encoding'];

    if ((acceptEncoding == null)) {
      callback(null, bytes, null);
      return;
    }

    acceptEncoding = acceptEncoding.toLowerCase();

    if (/\bgzip\b/.test(acceptEncoding)) {
      return zlib.gzip(bytes, function(err, compressedBytes) {
        if (err) {
          callback(err);
        } else {
          callback(null, compressedBytes, 'gzip');
        }
      });
    } else if (/\bdeflate\b/.test(acceptEncoding)) {
      return zlib.deflate(bytes, function(err, compressedBytes) {
        if (err) {
          return callback(err);
        } else {
          return callback(null, compressedBytes, 'deflate');
        }
      });
    } else {
      return callback(null, bytes, null);
    }
  }

  respondJS(content, req, callback) {
    let contentBytes = new Buffer(content, 'utf8');
    return this.treatCompress(contentBytes, req, (err, contentBytes, encoding) => {
      if (err) {
        callback(err);
        return;
      }
      let contentLength = contentBytes.length;
      let headerBytes = new Buffer(this.createHeader({
        contentLength,
        req,
        contentEncoding: encoding,
        contentType: 'application/javascript'
      }), 'utf8');
      let allBytes = Buffer.concat([headerBytes, contentBytes], headerBytes.length + contentLength);
      return callback(null, allBytes);
    }
    );
  }

  respondHTML(html, req, callback) {
    let htmlBytes = new Buffer(html, 'utf8');
    return this.treatCompress(htmlBytes, req, (err, htmlBytes, encoding) => {
      if (err) {
        callback(err);
        return;
      }
      let htmlLength = htmlBytes.length;
      let headerBytes = new Buffer(this.createHeader({
        contentLength: htmlLength,
        req,
        contentEncoding: encoding,
        contentType: "text/html; charset=utf-8"
      }), 'utf8');
      let allBytes = Buffer.concat([headerBytes, htmlBytes], headerBytes.length + htmlLength);
      return callback(null, allBytes);
    }
    );
  }

  badRequest(req, callback) {
    let bodyBytes = new Buffer('Bad Request', 'utf8');
    let bodyLength = bodyBytes.length;
    let headerBytes = new Buffer(this.createHeader({
      statusCode: 400,
      contentLength: bodyLength,
      req,
      contentType: "text/plain; charset=utf-8"
    }), 'utf8');
    let allBytes = Buffer.concat([headerBytes, bodyBytes], headerBytes.length + bodyLength);
    return callback(null, allBytes);
  }

  serverError(req, callback) {
    let bodyBytes = new Buffer('Server Error', 'utf8');
    let bodyLength = bodyBytes.length;
    let headerBytes = new Buffer(this.createHeader({
      statusCode: 500,
      contentLength: bodyLength,
      req,
      contentType: "text/plain; charset=utf-8"
    }), 'utf8');
    let allBytes = Buffer.concat([headerBytes, bodyBytes], headerBytes.length + bodyLength);
    return callback(null, allBytes);
  }

  respondCrossDomainXML(req, callback) {
    let content = `\
<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
    <site-control permitted-cross-domain-policies="all"/>
    <allow-access-from domain="*" secure="false"/>
    <allow-http-request-headers-from domain="*" headers="*" secure="false"/>
</cross-domain-policy>
\
`;
    let opts = { contentType: 'text/x-cross-domain-policy' };
    return this.respondTextWithHeader(content, req, opts, callback);
  }

  respondStaticPath(filepath, req, callback) {
    if (filepath === '') {
      filepath = DIRECTORY_INDEX_FILENAME;
    } else if (/\/$/.test(filepath)) {
      filepath += DIRECTORY_INDEX_FILENAME;
    }
    if (filepath.indexOf('..') !== -1) {
      this.badRequest(req, callback);
      return;
    }
    return this.respondFile(filepath, req, callback);
  }

  respondFile(filepath, req, callback) {
    return fs.exists(filepath, exists => {
      if (exists) {
        return fs.stat(filepath, (err, stat) => {
          if (err) {
            logger.error(`stat error: ${filepath}`);
            this.serverError(req, callback);
            return;
          }
          let seq = new Sequent;
          if (stat.isDirectory()) {
            filepath += `/${DIRECTORY_INDEX_FILENAME}`;
            fs.exists(filepath, exists => {
              if (exists) {
                return seq.done();
              } else {
                return this.notFound(req, callback);
              }
            }
            );
          } else {
            seq.done();
          }
          return seq.wait(1, () => {
            return fs.readFile(filepath, {encoding:null, flag:'r'}, (err, contentBuf) => {
              let header, headerBuf, statusCode;
              if (err) {
                logger.error(`readFile error: ${filepath}`);
                this.serverError(req, callback);
                return;
              }
              let contentRangeHeader = null;
              if (req.headers.range != null) {
                let match;
                if ((match = /^bytes=(\d+)?-(\d+)?$/.exec(req.headers.range)) != null) {
                  let from = (match[1] != null) ? parseInt(match[1]) : null;
                  let to = (match[2] != null) ? parseInt(match[2]) : null;
                  logger.debug(`Range from ${from} to ${to}`);
                  if ((from == null) && (to != null)) {  // last n bytes
                    contentRangeHeader = `bytes ${contentBuf.length-to}-${contentBuf.length-1}/${contentBuf.length}`;
                    contentBuf = contentBuf.slice(contentBuf.length-to, contentBuf.length);
                  } else if ((from != null) && (to == null)) {
                    if (from > 0) {
                      contentRangeHeader = `bytes ${from}-${contentBuf.length-1}/${contentBuf.length}`;
                      contentBuf = contentBuf.slice(from, contentBuf.length);
                    }
                  } else if ((from != null) && (to != null)) {
                    contentRangeHeader = `bytes ${from}-${to}/${contentBuf.length}`;
                    contentBuf = contentBuf.slice(from, to + 1);
                  }
                } else {
                  logger.error(`[Range spec ${req.headers.range} is not supported]`);
                }
              }
              if (err) {
                this.serverError(req, callback);
                return;
              }
              let contentType = 'text/html; charset=utf-8';
              let doCompress = true;
              if (/\.m3u8$/.test(filepath)) {
                contentType = 'application/x-mpegURL';
              } else if (/\.ts$/.test(filepath)) {
                contentType = 'video/MP2T';
                doCompress = false;
              } else if (/\.mp4$/.test(filepath)) {
                contentType = 'video/mp4';
                doCompress = false;
              } else if (/\.3gpp?$/.test(filepath)) {
                contentType = 'video/3gpp';
                doCompress = false;
              } else if (/\.jpg$/.test(filepath)) {
                contentType = 'image/jpeg';
                doCompress = false;
              } else if (/\.gif$/.test(filepath)) {
                contentType = 'image/gif';
                doCompress = false;
              } else if (/\.png$/.test(filepath)) {
                contentType = 'image/png';
                doCompress = false;
              } else if (/\.swf$/.test(filepath)) {
                contentType = 'application/x-shockwave-flash';
                doCompress = false;
              } else if (/\.css$/.test(filepath)) {
                contentType = 'text/css';
              } else if (/\.js$/.test(filepath)) {
                contentType = 'application/javascript';
              } else if (/\.txt$/.test(filepath)) {
                contentType = 'text/plain; charset=utf-8';
              }
              if (contentRangeHeader != null) {
                statusCode = 206;
              } else {
                statusCode = 200;
              }
              if (doCompress) {
                return this.treatCompress(contentBuf, req, (err, compressedBytes, encoding) => {
                  if (err) {
                    callback(err);
                    return;
                  }
                  header = this.createHeader({
                    statusCode,
                    contentType,
                    contentLength: compressedBytes.length,
                    req,
                    contentRange: contentRangeHeader,
                    contentEncoding: encoding
                  });
                  headerBuf = new Buffer(header, 'utf8');
                  return callback(null, [ headerBuf, compressedBytes ]);
                });
              } else {
                header = this.createHeader({
                  statusCode,
                  contentType,
                  contentLength: contentBuf.length,
                  req,
                  contentRange: contentRangeHeader
                });
                headerBuf = new Buffer(header, 'utf8');
                return callback(null, [ headerBuf, contentBuf ]);
              }
            });
          });
        });
      } else {
        logger.warn(`[http] Requested file not found: ${filepath}`);
        return this.notFound(req, callback);
      }
    }
    );
  }
}

var api = {
  HTTPHandler,

  getDateHeader() {
    let d = new Date;
    return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}` +
    ` ${d.getUTCFullYear()} ${zeropad(2, d.getUTCHours())}:${zeropad(2, d.getUTCMinutes())}` +
    `:${zeropad(2, d.getUTCSeconds())} UTC`;
  },

  parseRequest(str) {
    let decodedURI, protocolName, protocolVersion;
    let [headerPart, body] = Array.from(str.split('\r\n\r\n'));

    let lines = headerPart.split(/\r\n/);
    let [method, uri, protocol] = Array.from(lines[0].split(/\s+/));
    if (protocol != null) {
      // Split "HTTP/1.1" to "HTTP" and "1.1"
      let slashPos = protocol.indexOf('/');
      if (slashPos !== -1) {
        protocolName = protocol.slice(0, slashPos);
        protocolVersion = protocol.slice(slashPos+1);
      }
    }
    let headers = {};
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (i === 0) { continue; }
      if (/^\s*$/.test(line)) { continue; }
      let params = line.split(": ");
      headers[params[0].toLowerCase()] = params[1];
    }

    try {
      decodedURI = decodeURIComponent(uri);
    } catch (e) {
      logger.error(`error: failed to decode URI: ${uri}`);
      return null;
    }

    return {
      method,
      uri: decodedURI,
      protocol,
      protocolName,
      protocolVersion,
      headers,
      body,
      headerBytes: Buffer.byteLength(headerPart, 'utf8')
    };
  }
};

export default api;

function __guard__(value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined;
}