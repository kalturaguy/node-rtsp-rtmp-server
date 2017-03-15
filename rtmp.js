// RTMP/RTMPE/RTMPT/RTMPTE server
//
// RTMP specification is available at:
// http://wwwimages.adobe.com/content/dam/Adobe/en/devnet/rtmp/pdf/rtmp_specification_1.0.pdf

import net from 'net';
import url from 'url';
import crypto from 'crypto';
import Sequent from 'sequent';

import rtmp_handshake from './rtmp_handshake';
import codec_utils from './codec_utils';
import config from './config';
import h264 from './h264';
import aac from './aac';
import flv from './flv';
import avstreams from './avstreams';
import logger from './logger';
import Bits from './bits';

// enum
let SESSION_STATE_NEW               = 1;
let SESSION_STATE_HANDSHAKE_ONGOING = 2;
let SESSION_STATE_HANDSHAKE_DONE    = 3;

let AVC_PACKET_TYPE_SEQUENCE_HEADER = 0;
let AVC_PACKET_TYPE_NALU            = 1;
let AVC_PACKET_TYPE_END_OF_SEQUENCE = 2;

let TIMESTAMP_ROUNDOFF = 4294967296;  // 32 bits

let DEBUG_INCOMING_STREAM_DATA = false;
let DEBUG_INCOMING_RTMP_PACKETS = false;
let DEBUG_OUTGOING_RTMP_PACKETS = false;

let RTMPT_SEND_REQUEST_BUFFER_SIZE = 10;

// Number of active sessions
let sessionsCount = 0;

// Active sessions
let sessions = {};

// Number of active RTMPT sessions
let rtmptSessionsCount = 0;

// Active RTMPT sessions
let rtmptSessions = {};

// The newest client ID
let clientMaxId = 0;

let queuedRTMPMessages = {};

// Generate a new client ID without collision
let generateNewClientID = function() {
  let clientID = generateClientID();
  while (sessions[clientID] != null) {
    clientID = generateClientID();
  }
  return clientID;
};

// Generate a new random client ID (like Cookie)
var generateClientID = function() {
  let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let numPossible = possible.length;
  let clientID = '';
  for (let i = 0; i <= 7; i++) {
    clientID += possible.charAt((Math.random() * numPossible) | 0);
  }
  return clientID;
};

let parseAcknowledgementMessage = function(buf) {
  let sequenceNumber = (buf[0] * Math.pow(256, 3)) + (buf[1] << 16) + (buf[2] << 8) + buf[3];
  return {
    sequenceNumber
  };
};

let convertPTSToMilliseconds = pts => Math.floor(pts / 90);

let createAudioMessage = function(params) {
  // TODO: Use type 1/2/3
  let audioMessage;
  return audioMessage = createRTMPMessage({
    chunkStreamID: 4,
    timestamp: params.timestamp,
    messageTypeID: 0x08,  // Audio Data
    messageStreamID: 1,
    body: params.body
  }
  , params.chunkSize);
};

let clearQueuedRTMPMessages = function(stream) {
  if (queuedRTMPMessages[stream.id] != null) {
    return queuedRTMPMessages[stream.id] = [];
  }
};

let queueRTMPMessages = function(stream, messages, params) {
  for (let message of Array.from(messages)) {
    message.originalTimestamp = message.timestamp;
  }
  if (queuedRTMPMessages[stream.id] != null) {
    queuedRTMPMessages[stream.id].push(...messages);
  } else {
    queuedRTMPMessages[stream.id] = [ ...messages ]; // Prevent copying array as reference
  }

  return flushRTMPMessages(stream, params);
};

let queueVideoMessage = function(stream, params) {
  params.avType = 'video';
  params.chunkStreamID = 4;
  params.messageTypeID = 0x09;  // Video Data
  params.messageStreamID = 1;
  params.originalTimestamp = params.timestamp;
  if (queuedRTMPMessages[stream.id] != null) {
    queuedRTMPMessages[stream.id].push(params);
  } else {
    queuedRTMPMessages[stream.id] = [ params ];
  }

  return setImmediate(() => flushRTMPMessages(stream));
};

let queueAudioMessage = function(stream, params) {
  params.avType = 'audio';
  params.chunkStreamID = 4;
  params.messageTypeID = 0x08;  // Audio Data
  params.messageStreamID = 1;
  params.originalTimestamp = params.timestamp;
  if (queuedRTMPMessages[stream.id] != null) {
    queuedRTMPMessages[stream.id].push(params);
  } else {
    queuedRTMPMessages[stream.id] = [ params ];
  }

  return setImmediate(() => flushRTMPMessages(stream));
};

let createVideoMessage = function(params) {
  // TODO: Use type 1/2/3
  let videoMessage;
  return videoMessage = createRTMPMessage({
    chunkStreamID: 4,
    timestamp: params.timestamp,
    messageTypeID: 0x09,  // Video Data
    messageStreamID: 1,
    body: params.body
  }
  , params.chunkSize);
};

let parseUserControlMessage = function(buf) {
  let eventType = (buf[0] << 8) + buf[1];
  let eventData = buf.slice(2);
  let message = {
    eventType,
    eventData
  };
  if (eventType === 3) {  // SetBufferLength
    // first 4 bytes: stream ID
    message.streamID = (eventData[0] << 24) + (eventData[1] << 16) +
      (eventData[2] << 8) + eventData[3];
    // next 4 bytes: buffer length in milliseconds
    message.bufferLength = (eventData[4] << 24) + (eventData[5] << 16) +
      (eventData[6] << 8) + eventData[7];
  }
  return message;
};

let parseIEEE754Double = function(buf) {
  let sign = buf[0] >> 7;  // 1 == negative
  let exponent = ((buf[0] & 0b1111111) << 4) + (buf[1] >> 4);
  exponent -= 1023;  // because 1023 means zero
  let fraction = 1;
  for (let i = 0; i <= 51; i++) {
    let byteIndex = 1 + parseInt((i + 4) / 8);
    let bitIndex = 7 - ((i + 4) % 8);
    let bitValue = (buf[byteIndex] >> bitIndex) & 0b1;
    if (bitValue > 0) {
      fraction += Math.pow(2, -(i+1));
    }
  }
  let value = fraction * Math.pow(2, exponent);
  if (sign === 1) {
    value = -value;
  }
  return value;
};

let parseAMF0StrictArray = function(buf) {
  let arr = [];
  let len = (buf[0] << 24) + (buf[1] << 16) + (buf[2] << 8) + buf[3];
  let readLen = 4;
  while (--len >= 0) {
    let result = parseAMF0Data(buf.slice(readLen));
    arr.push(result.value);
    readLen += result.readLen;
  }
  return { value: arr, readLen };
};

let parseAMF0ECMAArray = function(buf) {
  // associative-count
  let count = (buf[0] << 24) + (buf[1] << 16) + (buf[2] << 8) + buf[3];
  let result = parseAMF0Object(buf.slice(4), count);
  result.readLen += 4;
  return result;
};

var parseAMF0Object = function(buf, maxItems) {
  if (maxItems == null) { maxItems = null; }
  let obj = {};
  let bufLen = buf.length;
  let readLen = 0;
  let items = 0;
  if (((maxItems == null)) || (maxItems > 0)) {
    while (readLen < bufLen) {
      var name;
      let nameLen = (buf[readLen++] << 8) + buf[readLen++];
      if (nameLen > 0) {  // object-end-marker will follow
        name = buf.toString('utf8', readLen, readLen + nameLen);
        readLen += nameLen;
      } else {
        name = null;
      }
      let result = parseAMF0Data(buf.slice(readLen));
      readLen += result.readLen;
      if (result.type === 'object-end-marker') {
        break;
      } else {
        items++;
        if ((maxItems != null) && (items > maxItems)) {
          logger.warn(`warn: illegal AMF0 data: force break because items (${items}) > maxItems (${maxItems})`);
          break;
        }
      }
      if (name != null) {
        obj[name] = result.value;
      } else {
        logger.warn(`warn: illegal AMF0 data: object key for value ${result.value} is zero length`);
      }
    }
  }
  return { value: obj, readLen };
};

// Do opposite of parseAMF0DataMessage()
let serializeAMF0DataMessage = function(parsedObject) {
  let bufs = [];
  for (let object of Array.from(parsedObject.objects)) {
    bufs.push(createAMF0Data(object.value));
  }
  return Buffer.concat(bufs);
};

// Decode AMF0 data message buffer into AMF0 packets
let parseAMF0DataMessage = function(buf) {
  let amf0Packets = [];
  let remainingLen = buf.length;
  while (remainingLen > 0) {
    let result = parseAMF0Data(buf);
    amf0Packets.push(result);
    remainingLen -= result.readLen;
    buf = buf.slice(result.readLen);
  }
  return {
    objects: amf0Packets
  };
};

// Decode buffer into AMF0 packets
let parseAMF0CommandMessage = function(buf) {
  let amf0Packets = [];
  let remainingLen = buf.length;
  while (remainingLen > 0) {
    var result;
    try {
      result = parseAMF0Data(buf);
    } catch (e) {
      logger.error("[rtmp] error parsing AMF0 command (maybe a bug); buf:");
      logger.error(buf);
      throw e;
    }
    amf0Packets.push(result);
    remainingLen -= result.readLen;
    buf = buf.slice(result.readLen);
  }
  return {
    command: amf0Packets[0].value,
    transactionID: amf0Packets[1].value,
    objects: amf0Packets.slice(2)
  };
};

var parseAMF0Data = function(buf) {
  let result, value;
  let i = 0;
  let type = buf[i++];
  if (type === 0x00) {  // number-marker
    value = buf.readDoubleBE(i);
    return { type: 'number', value, readLen: i + 8 };
  } else if (type === 0x01) {  // boolean-marker
    value = buf[i] === 0x00 ? false : true;
    return { type: 'boolean', value, readLen: i + 1 };
  } else if (type === 0x02) {  // string-marker
    let strLen = (buf[i++] << 8) + buf[i++];
    value = buf.toString('utf8', i, i+strLen);
    return { type: 'string', value, readLen: i + strLen };
  } else if (type === 0x03) {  // object-marker
    result = parseAMF0Object(buf.slice(i));
    return { type: 'object', value: result.value, readLen: i + result.readLen };
  } else if (type === 0x05) {  // null-marker
    return { type: 'null', value: null, readLen: i };
  } else if (type === 0x06) {  // undefined-marker
    return { type: 'undefined', value: undefined, readLen: i };
  } else if (type === 0x08) {  // ecma-array-marker
    result = parseAMF0ECMAArray(buf.slice(i));
    return { type: 'array', value: result.value, readLen: i + result.readLen };
  } else if (type === 0x09) {  // object-end-marker
    return { type: 'object-end-marker', readLen: i };
  } else if (type === 0x0a) {  // strict-array-marker
    result = parseAMF0StrictArray(buf.slice(i));
    return { type: 'strict-array', value: result.value, readLen: i + result.readLen };
  } else if (type === 0x0b) {  // date-marker
    let time = buf.readDoubleBE(i);
    let date = new Date(time);
    return { type: 'date', value: date, readLen: i + 10 };  // 8 (time) + 2 (time-zone)
  } else {
    throw new Error(`Unknown AMF0 data type: ${type}`);
  }
};

var createAMF0Data = function(data) {
  let type = typeof data;
  let buf = null;
  if (type === 'number') {
    buf = new Buffer(9);
    buf[0] = 0x00;  // number-marker
    buf.writeDoubleBE(data, 1);
  } else if (type === 'boolean') {
    buf = new Buffer(2);
    buf[0] = 0x01;  // boolean-marker
    buf[1] = data ? 0x01 : 0x00;
  } else if (type === 'string') {
    buf = new Buffer(3);
    buf[0] = 0x02;  // string-marker
    let strBytes = new Buffer(data, 'utf8');
    let strLen = strBytes.length;
    buf[1] = (strLen >> 8) & 0xff;
    buf[2] = strLen & 0xff;
    buf = Buffer.concat([buf, strBytes], 3 + strLen);
  } else if (data === null) {
    buf = new Buffer([ 0x05 ]);  // null-marker
  } else if (type === 'undefined') {
    buf = new Buffer([ 0x06 ]);  // undefined-marker
  } else if (data instanceof Date) {
    buf = new Buffer(11);
    buf[0] = 0x0b;  // date-marker
    buf.writeDoubleBE(data.getTime(), 1);
    // Time-zone should be 0x0000
    buf[9] = 0;
    buf[10] = 0;
  } else if (data instanceof Array) {
    buf = new Buffer([ 0x0a ]);  // strict-array-marker
    buf = createAMF0StrictArray(data, buf);
  } else if (type === 'object') {
    buf = createAMF0Object(data);
  } else {
    throw new Error(`Unknown data type \"${type}\" for data ${data}`);
  }
  return buf;
};

var createAMF0StrictArray = function(arr, buf) {
  if (buf == null) { buf = null; }
  let bufs = [];
  let totalLength = 0;
  if (buf != null) {
    bufs.push(buf);
    totalLength += buf.length;
  }

  // array-count (U32)
  let arrLen = arr.length;
  bufs.push(new Buffer([
    (arrLen >>> 24) & 0xff,
    (arrLen >>> 16) & 0xff,
    (arrLen >>> 8) & 0xff,
    arrLen & 0xff
  ]));
  totalLength += 4;

  for (let i = 0; i < arr.length; i++) {
    let value = arr[i];
    let valueBytes = createAMF0Data(value);
    bufs.push(valueBytes);
    totalLength += valueBytes.length;
  }
  return Buffer.concat(bufs, totalLength);
};

var createAMF0Object = function(obj) {
  let buf = new Buffer([ 0x03 ]);  // object-marker
  return createAMF0PropertyList(obj, buf);
};

let createAMF0ECMAArray = function(obj) {
  let count = Object.keys(obj).length;
  let buf = new Buffer([
    // ecma-array-marker
    0x08,
    // array-count
    (count >>> 24) & 0xff,
    (count >>> 16) & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff
  ]);
  return createAMF0PropertyList(obj, buf);
};

var createAMF0PropertyList = function(obj, buf) {
  if (buf == null) { buf = null; }
  let bufs = [];
  let totalLength = 0;
  if (buf != null) {
    bufs.push(buf);
    totalLength += buf.length;
  }
  for (let name in obj) {
    let value = obj[name];
    let nameBytes = new Buffer(name, 'utf8');
    let nameLen = nameBytes.length;
    let nameLenBytes = new Buffer(2);
    nameLenBytes[0] = (nameLen >> 8) & 0xff;
    nameLenBytes[1] = nameLen & 0xff;
    let dataBytes = createAMF0Data(value);
    bufs.push(nameLenBytes, nameBytes, dataBytes);
    totalLength += 2 + nameLen + dataBytes.length;
  }

  // Add object-end-marker
  bufs.push(new Buffer([0x00, 0x00, 0x09]));
  totalLength += 3;

  return Buffer.concat(bufs, totalLength);
};

let counter = 0;

var flushRTMPMessages = function(stream, params) {
  let i, rtmpMessage, session;
  if ((stream == null)) {
    logger.error("[rtmp] error: flushRTMPMessages: Invalid stream");
    return;
  }

  if (((params != null ? params.forceFlush : undefined) !== true) &&
  (queuedRTMPMessages[stream.id].length < config.rtmpMessageQueueSize)) {
    // not enough buffer
    return;
  }

  let rtmpMessagesToSend = queuedRTMPMessages[stream.id];
  queuedRTMPMessages[stream.id] = [];

  for (i = 0; i < rtmpMessagesToSend.length; i++) {
    rtmpMessage = rtmpMessagesToSend[i];
    rtmpMessage.index = i;
  }

  // Move audio before video if the PTS are the same
  rtmpMessagesToSend.sort(function(a, b) {
    let cmp = a.originalTimestamp - b.originalTimestamp;
    if (cmp === 0) {
      if (((a.avType == null)) || ((b.avType == null))) {
        cmp = 0;
      } else if (a.avType === b.avType) {
        cmp = 0;
      } else if (a.avType === 'audio') {  // a=audio b=video
        cmp = -1;
      } else if (b.avType === 'audio') {  // a=video b=audio
        cmp = 1;
      }
    }
    if (cmp === 0) {
      cmp = a.index - b.index;  // keep the original order
    }
    return cmp;
  });

  if (rtmpMessagesToSend.length === 0) {
    // nothing to send
    return;
  }

  let allSessions = [];
  for (var clientID in rtmptSessions) {
    session = rtmptSessions[clientID];
    allSessions.push(session.rtmpSession);
  }

  for (clientID in sessions) {
    session = sessions[clientID];
    allSessions.push(session);
  }

  for (session of Array.from(allSessions)) {
    if ((session.stream != null ? session.stream.id : undefined) !== stream.id) {  // The session is not associated with current stream
      continue;
    }
    let msgs = null;

    // If video starts with an inter frame, Flash Player might
    // shows images looks like a glitch until the first keyframe.
    if (session.isWaitingForKeyFrame) {
      if (config.rtmpWaitForKeyFrame) {
        if (stream.isVideoStarted) {  // has video stream
          for (i = 0; i < rtmpMessagesToSend.length; i++) {
            rtmpMessage = rtmpMessagesToSend[i];
            if ((rtmpMessage.avType === 'video') && rtmpMessage.isKeyFrame) {
              logger.info(`[rtmp:client=${session.clientid}] started playing stream ${stream.id}`);
              session.startPlaying();
              session.playStartTimestamp = rtmpMessage.originalTimestamp;
              session.playStartDateTime = Date.now();  // TODO: Should we use slower process.hrtime()?
              session.isWaitingForKeyFrame = false;
              msgs = rtmpMessagesToSend.slice(i);
              break;
            }
          }
        } else {  // audio only
          logger.info(`[rtmp:client=${session.clientid}] started playing stream ${stream.id}`);
          session.startPlaying();
          session.playStartTimestamp = rtmpMessagesToSend[0].originalTimestamp;
          session.playStartDateTime = Date.now();
          session.isWaitingForKeyFrame = false;
          msgs = rtmpMessagesToSend;
        }
      } else {  // Do not wait for a keyframe
        logger.info(`[rtmp:client=${session.clientid}] started playing stream ${stream.id}`);
        session.startPlaying();
        session.playStartTimestamp = rtmpMessagesToSend[0].originalTimestamp;
        session.playStartDateTime = Date.now();
        session.isWaitingForKeyFrame = false;
        msgs = rtmpMessagesToSend;
      }
    } else {
      msgs = rtmpMessagesToSend;
    }

    if ((msgs == null)) {
      continue;
    }

    if (session.isPlaying) {
      var buf, filteredMsgs;
      for (rtmpMessage of Array.from(msgs)) {
        // get milliseconds elapsed since play start
        rtmpMessage.timestamp = session.getScaledTimestamp(rtmpMessage.originalTimestamp) % TIMESTAMP_ROUNDOFF;
      }
      if (session.isResuming) {
        // Remove audio messages which are already sent until
        // the first video message comes
        filteredMsgs = [];
        for (i = 0; i < msgs.length; i++) {
          rtmpMessage = msgs[i];
          if ((rtmpMessage.avType == null)) {
            filteredMsgs.push(rtmpMessage);
          } else if (rtmpMessage.avType === 'video') {
            filteredMsgs.push(...msgs.slice(i));
            session.isResuming = false;
            break;
          } else if (rtmpMessage.timestamp > session.lastSentTimestamp) {
            filteredMsgs.push(rtmpMessage);
          } else {
            logger.debug(`[rtmp:client=${session.clientid}] skipped message (timestamp=${rtmpMessage.timestamp} <= lastSentTimestamp=${session.lastSentTimestamp})`);
          }
        }
      } else {
        filteredMsgs = msgs;
      }

      if (((params != null ? params.hasControlMessage : undefined) !== true) && (filteredMsgs.length > 1)) {
        buf = createRTMPAggregateMessage(filteredMsgs, session.chunkSize);
        if (DEBUG_OUTGOING_RTMP_PACKETS) {
          logger.info(`send RTMP agg msg: ${buf.length} bytes; time=` + filteredMsgs.map(item => `${(item.avType != null ? item.avType[0] : undefined) != null ? (item.avType != null ? item.avType[0] : undefined) : 'other'}${(item.avType === 'video') && item.isKeyFrame ? '(key)' : ''}:${item.timestamp}${(item.avType === 'video') && (item.compositionTime !== 0) ? `(cmp=${item.timestamp+item.compositionTime})` : ''}`).join(','));
        }
        session.sendData(buf);
      } else {
        let bufs = [];
        for (rtmpMessage of Array.from(filteredMsgs)) {
          bufs.push(createRTMPMessage(rtmpMessage, session.chunkSize));
        }
        buf = Buffer.concat(bufs);
        if (DEBUG_OUTGOING_RTMP_PACKETS) {
          logger.info(`send RTMP msg: ${buf.length} bytes; time=` + filteredMsgs.map(item => `${(item.avType != null ? item.avType[0] : undefined) != null ? (item.avType != null ? item.avType[0] : undefined) : 'other'}:${item.timestamp}`).join(','));
        }
        session.sendData(buf);
      }

      session.lastSentTimestamp = filteredMsgs[filteredMsgs.length-1].timestamp;
    }
  }

};

// RTMP Message Header used in Aggregate Message
let createMessageHeader = function(params) {
  let payloadLength = params.body.length;
  if ((params.messageTypeID == null)) {
    logger.warn("[rtmp] warning: createMessageHeader(): messageTypeID is not set");
  }
  if ((params.timestamp == null)) {
    logger.warn("[rtmp] warning: createMessageHeader(): timestamp is not set");
  }
  if ((params.messageStreamID == null)) {
    logger.warn("[rtmp] warning: createMessageHeader(): messageStreamID is not set");
  }
  // 6.1.1.  Message Header
  return new Buffer([
    params.messageTypeID,
    // Payload length (3 bytes) big-endian
    (payloadLength >> 16) & 0xff,
    (payloadLength >> 8) & 0xff,
    payloadLength & 0xff,
    // Timestamp (4 bytes) big-endian (unusual format; not sure)
    (params.timestamp >>> 16) & 0xff,
    (params.timestamp >>> 8) & 0xff,
    params.timestamp & 0xff,
    (params.timestamp >>> 24) & 0xff,
    // Stream ID (3 bytes) big-endian
    (params.messageStreamID >> 16) & 0xff,
    (params.messageStreamID >> 8) & 0xff,
    params.messageStreamID & 0xff,
  ]);
};

// All sub-messages must have the same chunk stream ID
var createRTMPAggregateMessage = function(rtmpMessages, chunkSize) {
  let bufs = [];
  let totalLength = 0;
  let aggregateTimestamp = null;
  for (let rtmpMessage of Array.from(rtmpMessages)) {
    if ((aggregateTimestamp == null)) {
      aggregateTimestamp = rtmpMessage.timestamp;
    }

    let header = createMessageHeader(rtmpMessage);
    let len = header.length + rtmpMessage.body.length;
    bufs.push(header, rtmpMessage.body, new Buffer([
      // Back pointer (UI32)
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff
    ]));
    totalLength += len + 4;
  }
  let aggregateBody = Buffer.concat(bufs, totalLength);

  return createRTMPMessage({
    chunkStreamID: 4,
    timestamp: aggregateTimestamp,
    messageTypeID: 22,  // Aggregate Message
    messageStreamID: 1,
    body: aggregateBody
  }
  , chunkSize);
};

let createRTMPType1Message = function(params) {
  let ordinaryTimestampBytes;
  let bodyLength = params.body.length;
  let formatTypeID = 1;
  if ((params.body == null)) {
    logger.warn("[rtmp] warning: createRTMPType1Message(): body is not set for RTMP message");
  }
  if ((params.chunkStreamID == null)) {
    logger.warn("[rtmp] warning: createRTMPType1Message(): chunkStreamID is not set for RTMP message");
  }
  if ((params.timestampDelta == null)) {
    logger.warn("[rtmp] warning: createRTMPType1Message(): timestampDelta is not set for RTMP message");
  }
  if ((params.messageStreamID == null)) {
    logger.warn("[rtmp] warning: createRTMPType1Message(): messageStreamID is not set for RTMP message");
  }
  let useExtendedTimestamp = false;
  if (params.timestampDelta >= 0xffffff) {
    useExtendedTimestamp = true;
    ordinaryTimestampBytes = [ 0xff, 0xff, 0xff ];
  } else {
    ordinaryTimestampBytes = [
      (params.timestampDelta >> 16) & 0xff,
      (params.timestampDelta >> 8) & 0xff,
      params.timestampDelta & 0xff,
    ];
  }

  // Header for Type 1 Chunk Message Header
  let header = new Buffer([
    // Format (2 bits), Chunk Stream ID (6 bits)
    (formatTypeID << 6) | params.chunkStreamID,
    // Timestamp Delta (3 bytes)
    ordinaryTimestampBytes[0],
    ordinaryTimestampBytes[1],
    ordinaryTimestampBytes[2],
    // Message Length (3 bytes)
    (bodyLength >> 16) & 0xff,
    (bodyLength >> 8) & 0xff,
    bodyLength & 0xff,
    // Message Type ID (1 byte)
    params.messageTypeID,
  ]);
  if (useExtendedTimestamp) {
    let extendedTimestamp = new Buffer([
      (params.timestampDelta >> 24) & 0xff,
      (params.timestampDelta >> 16) & 0xff,
      (params.timestampDelta >> 8) & 0xff,
      params.timestampDelta & 0xff,
    ]);
    header = Buffer.concat([
      header, extendedTimestamp
    ], 12);
  }
  let { body } = params;
  return Buffer.concat([header, body], 8 + bodyLength);
};

var createRTMPMessage = function(params, chunkSize) {
  let timestamp;
  if (chunkSize == null) { chunkSize = 128; }
  let bodyLength = params.body.length;
  // TODO: Use format type ID 1 and 2
  let formatTypeID = 0;
  if ((params.body == null)) {
    logger.warn("[rtmp] warning: createRTMPMessage(): body is not set for RTMP message");
  }
  if ((params.chunkStreamID == null)) {
    logger.warn("[rtmp] warning: createRTMPMessage(): chunkStreamID is not set for RTMP message");
  }
  if ((params.timestamp == null)) {
    logger.warn("[rtmp] warning: createRTMPMessage(): timestamp is not set for RTMP message");
  }
  if ((params.messageStreamID == null)) {
    logger.warn("[rtmp] warning: createRTMPMessage(): messageStreamID is not set for RTMP message");
  }
  let useExtendedTimestamp = false;
  if (params.timestamp >= 0xffffff) {
    useExtendedTimestamp = true;
    timestamp = [ 0xff, 0xff, 0xff ];
  } else {
    timestamp = [
      (params.timestamp >> 16) & 0xff,
      (params.timestamp >> 8) & 0xff,
      params.timestamp & 0xff,
    ];
  }

  let bufs = [
    // Header for Type 0 Chunk Message Header
    new Buffer([
      // Format (2 bits), Chunk Stream ID (6 bits)
      (formatTypeID << 6) | params.chunkStreamID,
      // Timestamp (3 bytes)
      timestamp[0],
      timestamp[1],
      timestamp[2],
      // Message Length (3 bytes)
      (bodyLength >> 16) & 0xff,
      (bodyLength >> 8) & 0xff,
      bodyLength & 0xff,
      // Message Type ID (1 byte)
      params.messageTypeID,
      // Message Stream ID (4 bytes) little-endian
      params.messageStreamID & 0xff,
      (params.messageStreamID >>> 8) & 0xff,
      (params.messageStreamID >>> 16) & 0xff,
      (params.messageStreamID >>> 24) & 0xff,
    ])
  ];
  let totalLength = 12;
  if (useExtendedTimestamp) {
    bufs.push(new Buffer([
      (params.timestamp >> 24) & 0xff,
      (params.timestamp >> 16) & 0xff,
      (params.timestamp >> 8) & 0xff,
      params.timestamp & 0xff,
    ]));
    totalLength += 4;
  }
  let { body } = params;
  if (bodyLength > chunkSize) {
    bufs.push(body.slice(0, chunkSize));
    totalLength += chunkSize;
    body = body.slice(chunkSize);
    bodyLength -= chunkSize;

    // Use Format Type 3 for remaining chunks
    let type3Header = new Buffer([
      (3 << 6) | params.chunkStreamID
    ]);
    while (true) {
      let bodyChunk = body.slice(0, chunkSize);
      let bodyChunkLen = bodyChunk.length;
      bufs.push(type3Header, bodyChunk);
      totalLength += 1 + bodyChunkLen;
      body = body.slice(bodyChunkLen);
      bodyLength -= bodyChunkLen;
      if (bodyLength === 0) {
        break;
      }
    }
  } else {
    bufs.push(body);
    totalLength += bodyLength;
  }

  return Buffer.concat(bufs, totalLength);
};

let createAMF0DataMessage = (params, chunkSize) => createRTMPMessage(createAMF0DataMessageParams(params), chunkSize);

var createAMF0DataMessageParams = function(params) {
  let len = 0;
  for (let obj of Array.from(params.objects)) {
    len += obj.length;
  }
  let amf0Bytes = Buffer.concat(params.objects, len);
  return {
    chunkStreamID: params.chunkStreamID,
    timestamp: params.timestamp,
    messageTypeID: 0x12,  // AMF0 Data
    messageStreamID: params.messageStreamID,
    body: amf0Bytes
  };
};

let createAMF0CommandMessage = (params, chunkSize) => createRTMPMessage(createAMF0CommandMessageParams(params), chunkSize);

var createAMF0CommandMessageParams = function(params) {
  let commandBuf = createAMF0Data(params.command);
  let transactionIDBuf = createAMF0Data(params.transactionID);
  let len = commandBuf.length + transactionIDBuf.length;
  for (let obj of Array.from(params.objects)) {
    len += obj.length;
  }
  let amf0Bytes = Buffer.concat([commandBuf, transactionIDBuf, ...params.objects], len);
  return {
    chunkStreamID: params.chunkStreamID,
    timestamp: params.timestamp,
    messageTypeID: 0x14,  // AMF0 Command
    messageStreamID: params.messageStreamID,
    body: amf0Bytes
  };
};

class RTMPSession {
  constructor(socket) {
    logger.debug("[rtmp] created a new session");
    this.listeners = {};
    this.state = SESSION_STATE_NEW;
    this.socket = socket;
    this.chunkSize = 128;
    this.receiveChunkSize = 128;
    this.previousChunkMessage = {};
    this.isPlaying = false;
    this.clientid = generateNewClientID();
    this.useEncryption = false;
    this.receiveTimestamp = null;
    this.lastSentAckBytes = 0;
    this.receivedBytes = 0;
    this.stream = null; // AVStream
    this.seekedDuringPause = false;
    this.lastSentTimestamp = null;
    this.isResuming = false;

    // Some broadcaster software like Wirecast does not send Window Acknowledgement Size,
    // so it seems we have to set a default value.
    this.windowAckSize = 2500000;
  }

  toString() {
    return `${this.clientid}: addr=${this.socket.remoteAddress} port=${this.socket.remotePort}`;
  }

  startPlaying() {
    this.isPlaying = true;
    return this.isResuming = false;
  }

  parseVideoMessage(buf) {
    let info = flv.parseVideo(buf);
    let nalUnitGlob = null;
    let isEOS = false;
    switch (info.videoDataTag.avcPacketType) {
      case flv.AVC_PACKET_TYPE_SEQUENCE_HEADER:
        // Retain AVC configuration
        this.avcInfo = info.avcDecoderConfigurationRecord;
        if (this.avcInfo.numOfSPS > 1) {
          logger.warn(`warn: flv:parseVideo(): numOfSPS is ${numOfSPS} > 1 (may not work)`);
        }
        if (this.avcInfo.numOfPPS > 1) {
          logger.warn(`warn: flv:parseVideo(): numOfPPS is ${numOfPPS} > 1 (may not work)`);
        }
        let sps = h264.concatWithStartCodePrefix(this.avcInfo.sps);
        let pps = h264.concatWithStartCodePrefix(this.avcInfo.pps);
        nalUnitGlob = Buffer.concat([sps, pps]);
        break;
      case flv.AVC_PACKET_TYPE_NALU:
        if ((this.avcInfo == null)) {
          throw new Error("[rtmp:publish] malformed video data: avcInfo is missing");
        }
        // TODO: This must be too heavy and needs better alternative.
        let nalUnits = flv.splitNALUnits(info.nalUnits, this.avcInfo.nalUnitLengthSize);
        nalUnitGlob = h264.concatWithStartCodePrefix(nalUnits);
        break;
      case flv.AVC_PACKET_TYPE_EOS:
        isEOS = true;
        break;
      default:
        throw new Error(`unknown AVCPacketType: ${flv.AVC_PACKET_TYPE_SEQUENCE_HEADER}`);
    }
    return {
      info,
      nalUnitGlob,
      isEOS
    };
  }

  parseAudioMessage(buf) {
    let info = flv.parseAudio(buf);
    let adtsFrame = null;
    let { stream } = this;
    if ((stream == null)) {
      throw new Error("[rtmp] Stream not set for this session");
    }
    switch (info.audioDataTag.aacPacketType) {
      case flv.AAC_PACKET_TYPE_SEQUENCE_HEADER:
        if (info.audioSpecificConfig != null) {
          stream.updateConfig({
            audioSpecificConfig: info.audioSpecificConfig,
            audioASCInfo: info.ascInfo
          });
        } else {
          logger.warn("[rtmp] skipping empty AudioSpecificConfig");
        }
        break;
      case flv.AAC_PACKET_TYPE_RAW:
        if ((stream.audioASCInfo == null)) {
          logger.error("[rtmp:publish] malformed audio data: AudioSpecificConfig is missing");
        }

        // TODO: This must be a little heavy and needs better alternative.
        let adtsHeader = new Buffer(aac.createADTSHeader(stream.audioASCInfo, info.rawDataBlock.length));
        adtsFrame = Buffer.concat([ adtsHeader, info.rawDataBlock ]);
        break;
      default:
        throw new Error(`[rtmp:publish] unknown AAC_PACKET_TYPE: ${info.audioDataTag.aacPacketType}`);
    }
    return {
      info,
      adtsFrame
    };
  }

  clearTimeout() {
    if (this.timeoutTimer != null) {
      clearTimeout(this.timeoutTimer);
      return this.timeoutTimer = null;
    }
  }

  scheduleTimeout() {
    if (this.isTearedDown) {
      return;
    }
    this.clearTimeout();
    this.lastTimeoutScheduledTime = Date.now();
    return this.timeoutTimer = setTimeout(() => {
      if (this.isTearedDown) {
        return;
      }
      if ((this.timeoutTimer == null)) {
        return;
      }
      if ((Date.now() - this.lastTimeoutScheduledTime) < config.rtmpSessionTimeoutMs) {
        return;
      }
      logger.info(`[rtmp:client=${this.clientid}] session timeout`);
      return this.teardown();
    }
    , config.rtmpSessionTimeoutMs);
  }

  schedulePing() {
    this.lastPingScheduledTime = Date.now();
    if (this.pingTimer != null) {
      clearTimeout(this.pingTimer);
    }
    return this.pingTimer = setTimeout(() => {
      if ((Date.now() - this.lastPingScheduledTime) < config.rtmpPingTimeoutMs) {
        logger.debug("[rtmp] ping timeout canceled");
      }
      return this.ping();
    }
    , config.rtmpPingTimeoutMs);
  }

  ping() {
    let currentTimestamp = this.getCurrentTimestamp();
    let pingRequest = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: currentTimestamp,
      messageTypeID: 0x04,  // User Control Message
      messageStreamID: 0,
      body: new Buffer([
        // Event Type: 6=PingRequest
        0, 6,
        // Server Timestamp
        (currentTimestamp >> 24) & 0xff,
        (currentTimestamp >> 16) & 0xff,
        (currentTimestamp >> 8) & 0xff,
        currentTimestamp & 0xff
      ])});

    return this.sendData(pingRequest);
  }

  stopPlaying() {
    this.isPlaying = false;
    return this.isWaitingForKeyFrame = false;
  }

  teardown() {
    if (this.isTearedDown) {
      logger.debug("[rtmp] already teared down");
      return;
    }
    this.isTearedDown = true;
    this.clearTimeout();
    this.stopPlaying();
    if ((this.stream != null ? this.stream.type : undefined) === avstreams.STREAM_TYPE_RECORDED) {
      if (typeof this.stream.teardown === 'function') {
        this.stream.teardown();
      }
    }
    if (this.cipherIn != null) {
      this.cipherIn.final();
      this.cipherIn = null;
    }
    if (this.cipherOut != null) {
      this.cipherOut.final();
      this.cipherOut = null;
    }
    try {
      this.socket.end();
    } catch (e) {
      logger.error(`[rtmp] socket.end error: ${e}`);
    }
    return this.emit('teardown');
  }

  getCurrentTimestamp() {
    return Date.now() - this.playStartDateTime;
  }

  getScaledTimestamp(timestamp) {
    let ts = timestamp - this.playStartTimestamp;
    if (ts < 0) {
      ts = 0;
    }
    return ts;
  }

  createVideoMessage(params) {
    params.chunkStreamID = 4;
    params.messageTypeID = 0x09;  // Video Data
    params.messageStreamID = 1;
    return this.createAVMessage(params);
  }

  createAudioMessage(params) {
    params.chunkStreamID = 4;
    params.messageTypeID = 0x08;  // Audio Data
    params.messageStreamID = 1;
    return this.createAVMessage(params);
  }

  createAVMessage(params) {
    let msg;
    let thisTimestamp = this.getScaledTimestamp(params.timestamp);
    if ((this.lastAVTimestamp != null) && (params.body.length <= this.chunkSize)) {
      // Use Type 1 if chunking is not needed
      params.timestampDelta = (thisTimestamp - this.lastAVTimestamp) % TIMESTAMP_ROUNDOFF;
      msg = createRTMPType1Message(params);
    } else {
      // Use Type 0
      msg = createRTMPMessage(params, this.chunkSize);
    }

    this.lastAVTimestamp = thisTimestamp;

    return msg;
  }

  concatenate(arr) {
    if (Buffer.isBuffer(arr)) {
      return arr;
    }
    if (!(arr instanceof Array)) {
      return;
    }

    let len = 0;
    for (let i = 0; i < arr.length; i++) {
      let item = arr[i];
      if (item != null) {
        len += item.length;
      } else {
        arr[i] = new Buffer(0);
      }
    }
    return Buffer.concat(arr, len);
  }

  emit(event, ...args) {
    if ((this.listeners[event] == null)) {
      return;
    }
    for (let listener of Array.from(this.listeners[event])) {
      listener(...args);
    }
  }

  on(event, listener) {
    if ((this.listeners[event] == null)) {
      this.listeners[event] = [listener];
    } else {
      this.listeners[event].push(listener);
    }
  }

  removeListener(event, listener) {
    let listeners = this.listeners[event];
    if ((listeners == null)) {
      return;
    }
    let removedCount = 0;
    for (let i = 0; i < listeners.length; i++) {
      let _listener = listeners[i];
      if (_listener === listener) {
        logger.debug(`[rtmp] removed listener for ${event}`);
        let actualIndex = i - removedCount;
        listeners.splice(actualIndex, actualIndex - actualIndex + 1, ...[].concat([]));  // Remove element
        removedCount++;
      }
    }
  }

  sendData(arr) {
    let buf;
    if ((arr == null)) {
      return;
    }
    if (Buffer.isBuffer(arr)) {
      buf = arr;
    } else {
      let len = 0;
      for (let item of Array.from(arr)) {
        len += item.length;
      }
      buf = Buffer.concat(arr, len);
    }
    if (this.useEncryption) {
      buf = this.encrypt(buf);
    }
    return this.emit('data', buf);
  }

  rejectConnect(commandMessage, callback) {
    let streamBegin0 = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x04,  // User Control Message
      messageStreamID: 0,
      body: new Buffer([
        // Stream Begin (see 7.1.7. User Control Message Events)
        0, 0,
        // Stream ID of the stream that became functional
        0, 0, 0, 0
      ])});

    let _error = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_error',
      transactionID: 1,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'error',
          code: 'NetConnection.Connect.Rejected',
          description: `[ Server.Reject ] : (_defaultRoot_, ) : Invalid application name(/${this.app}).`
        })
      ]});

    let close = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: 'close',
      transactionID: 0,
      objects: [
        createAMF0Data(null)
      ]});

    return callback(null, this.concatenate([ streamBegin0, _error, close ]));
  }

  respondConnect(commandMessage, callback) {
    let { app } = commandMessage.objects[0].value;
    app = app.replace(/\/$/, '');  // JW Player adds / at the end
    this.app = app;

    if ((app !== config.liveApplicationName) && (app !== config.recordedApplicationName)) {
      logger.warn(`[rtmp:client=${this.clientid}] requested invalid app name: ${app}`);
      this.rejectConnect(commandMessage, callback);
      return;
    }

    // TODO: use @chunkSize for createRTMPMessage()?

    let windowAck = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x05,  // Window Acknowledgement Size
      messageStreamID: 0,
      // 0x140000 == 1310720
      // 0x2625a0 == 2500000
      body: new Buffer([
        // Acknowledgement Window Size (4 bytes)
//        0, 0x14, 0, 0
        0, 0x26, 0x25, 0xa0
      ])});

    let setPeerBandwidth = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x06,  // Set Peer Bandwidth
      messageStreamID: 0,
      body: new Buffer([
        // Window acknowledgement size (4 bytes)
        0, 0x26, 0x25, 0xa0,
        // Limit Type
        0x02
      ])});

    let streamBegin0 = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x04,  // User Control Message
      messageStreamID: 0,
      body: new Buffer([
        // Stream Begin (see 7.1.7. User Control Message Events)
        0, 0,
        // Stream ID of the stream that became functional
        0, 0, 0, 0
      ])});

    // 7.2.1.1.  connect
    let connectResult = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_result',
      transactionID: 1,  // Always 1
      objects: [
        createAMF0Object({
          fmsVer: 'FMS/3,0,4,423',
          capabilities: 31
        }),
        createAMF0Object({
          level: 'status',
          code: 'NetConnection.Connect.Success',
          description: 'Connection succeeded.',
          objectEncoding: this.objectEncoding != null ? this.objectEncoding : 0
        })
      ]});

    let onBWDone = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: 'onBWDone',
      transactionID: 0,
      objects: [ createAMF0Data(null) ]});

    return callback(null, this.concatenate([
      windowAck, setPeerBandwidth, streamBegin0, connectResult,
      onBWDone
    ]));
  }

  encrypt(data) {
    let isSingleByte = typeof(data) === 'number';
    if (isSingleByte) {
      data = new Buffer([ data ]);
    }
    let result = this.cipherIn.update(data);
    if (isSingleByte) {
      return result[0];
    } else {
      return result;
    }
  }

  decrypt(data) {
    let isSingleByte = typeof(data) === 'number';
    if (isSingleByte) {
      data = new Buffer([ data ]);
    }
    let result = this.cipherOut.update(data);
    if (isSingleByte) {
      return result[0];
    } else {
      return result;
    }
  }

  respondHandshake(c0c1, callback) {
    return rtmp_handshake.generateS0S1S2(c0c1, (err, s0s1s2, keys) => {
      let type = s0s1s2[0];
      if (type === 6) {
        this.useEncryption = true;
        logger.info(`[rtmp:client=${this.clientid}] enabled encryption`);

        this.clientPublicKey  = keys.clientPublicKey;
        this.dh = keys.dh;
        this.sharedSecret = this.dh.computeSecret(this.clientPublicKey);
        this.keyOut = codec_utils.calcHmac(this.dh.getPublicKey(), this.sharedSecret).slice(0, 16);
        this.keyIn = codec_utils.calcHmac(this.clientPublicKey, this.sharedSecret).slice(0, 16);

        this.cipherOut = crypto.createCipheriv('rc4', this.keyOut, '');
        this.cipherIn  = crypto.createCipheriv('rc4', this.keyIn, '');
        let zeroBytes = new Buffer(1536);
        zeroBytes.fill(0);
        this.encrypt(zeroBytes);
        this.decrypt(zeroBytes);
      }

      return callback(null, s0s1s2);
    }
    );
  }

  parseRTMPMessages(rtmpMessage) {
    let messages = [];
    let consumedLen = 0;

    while (rtmpMessage.length > 1) {
      var chunkBody, chunkMessageHeader, previousChunk, remainingMessageLen;
      let headerLen = 0;
      let message = {};

      // RTMP Chunk Format
      //
      // ------------------
      // Basic Header (1-3 bytes)
      // ------------------
      // Message Header (0/3/7/11 bytes)
      // ------------------
      // Extended Timestamp (0/4 bytes)
      // ------------------
      // Chunk Data (variable size)
      // ------------------

      // 5.3.1.1. Chunk Basic Header
      //
      // Chunk basic header 1 (1 byte)
      // For chunk stream IDs 2-63
      // ---------------
      // fmt (2 bits)
      // chunk stream id (6 bits)
      // ---------------
      //
      // Chunk basic header 2 (2 bytes)
      // For chunk stream IDs 64-319
      // ---------------
      // fmt (2 bits)
      // 0 (6 bits)
      // chunk stream id - 64 (8 bits)
      // ---------------
      //
      // Chunk basic header 3 (3 bytes)
      // For chunk stream IDs 64-65599
      // ---------------
      // fmt (2 bits)
      // 1 (6 bits)
      // chunk stream id - 64 (16 bits)
      // ---------------
      let chunkBasicHeader = rtmpMessage[0];
      message.formatType = chunkBasicHeader >> 6;
      message.chunkStreamID = chunkBasicHeader & 0b111111;
      if (message.chunkStreamID === 0) {  // Chunk basic header 2
        if (rtmpMessage.length < 2) {  // buffer is incomplete
          break;
        }
        message.chunkStreamID = rtmpMessage[1] + 64;
        chunkMessageHeader = rtmpMessage.slice(2);
        headerLen += 2;
      } else if (message.chunkStreamID === 1) {  // Chunk basic header 3
        if (rtmpMessage.length < 3) {  // buffer is incomplete
          break;
        }
        message.chunkStreamID = (rtmpMessage[1] << 8) + rtmpMessage[2] + 64;
        chunkMessageHeader = rtmpMessage.slice(3);
        headerLen += 3;
      } else {  // Chunk basic header 1
        chunkMessageHeader = rtmpMessage.slice(1);
        headerLen += 1;
      }

      // 5.3.1.2. Chunk Message Header
      //
      // 5.3.1.2.1 Type 0 chunk header (11 bytes)
      // ---------------
      // timestamp (3 bytes)
      //   Absolute timestamp of the message.
      //   The value of 0xffffff indicates the presence of
      //   Extended Timestamp field.
      // message length (3 bytes)
      // message type id (1 byte)
      // message stream id (4 bytes) - little endian
      // ---------------
      //
      // 5.3.1.2.2 Type 1 chunk header (7 bytes)
      // This chunk has the same stream ID as the preceding chunk.
      // ---------------
      // timestamp delta (3 bytes)
      // message length (3 bytes)
      // message type id (1 byte)
      // ---------------
      //
      // 5.3.1.2.3. Type 2 chunk header (3 bytes)
      // This chunk has the same stream ID and message length as
      // the preceding chunk.
      // ---------------
      // timestamp delta (3 bytes)
      // ---------------
      //
      // 5.3.1.2.4. Type 3 chunk header (0 byte)
      // This chunk has the same stream ID, message length, and
      // timestamp delta as the preceding chunk.
      // ---------------
      // ---------------

      if (message.formatType === 0) {  // Type 0 (11 bytes)
        if (chunkMessageHeader.length < 11) {  // buffer is incomplete
          break;
        }
        message.timestamp = (chunkMessageHeader[0] << 16) +
          (chunkMessageHeader[1] << 8) + chunkMessageHeader[2];
        message.timestampDelta = 0;
        message.messageLength = (chunkMessageHeader[3] << 16) +
          (chunkMessageHeader[4] << 8) + chunkMessageHeader[5];
        message.messageTypeID = chunkMessageHeader[6];
        message.messageStreamID = chunkMessageHeader.readInt32LE(7);  // TODO: signed or unsigned?
        chunkBody = chunkMessageHeader.slice(11);
        headerLen += 11;
      } else if (message.formatType === 1) {  // Type 1 (7 bytes)
        if (chunkMessageHeader.length < 7) {  // buffer is incomplete
          break;
        }
        message.timestampDelta = (chunkMessageHeader[0] << 16) +
          (chunkMessageHeader[1] << 8) + chunkMessageHeader[2];
        message.messageLength = (chunkMessageHeader[3] << 16) +
          (chunkMessageHeader[4] << 8) + chunkMessageHeader[5];
        message.messageTypeID = chunkMessageHeader[6];
        previousChunk = this.previousChunkMessage[message.chunkStreamID];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
        } else {
          throw new Error(`${this.clientid}: Chunk reference error for type 1: previous chunk for id ${message.chunkStreamID} is not found (possibly a bug)`);
        }
        chunkBody = chunkMessageHeader.slice(7);
        headerLen += 7;
      } else if (message.formatType === 2) {  // Type 2 (3 bytes)
        if (chunkMessageHeader.length < 3) {  // buffer is incomplete
          break;
        }
        message.timestampDelta = (chunkMessageHeader[0] << 16) +
        (chunkMessageHeader[1] << 8) + chunkMessageHeader[2];
        previousChunk = this.previousChunkMessage[message.chunkStreamID];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.messageLength = previousChunk.messageLength;
          message.messageTypeID = previousChunk.messageTypeID;
        } else {
          throw new Error(`${this.clientid}: Chunk reference error for type 2: previous chunk for id ${message.chunkStreamID} is not found (possibly a bug)`);
        }
        chunkBody = chunkMessageHeader.slice(3);
        headerLen += 3;
      } else if (message.formatType === 3) {  // Type 3 (0 byte)
        previousChunk = this.previousChunkMessage[message.chunkStreamID];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.messageLength = previousChunk.messageLength;
          message.timestampDelta = previousChunk.timestampDelta;
          message.messageTypeID = previousChunk.messageTypeID;
        } else {
          throw new Error(`${this.clientid}: Chunk reference error for type 3: previous chunk for id ${message.chunkStreamID} is not found (possibly a bug)`);
        }
        chunkBody = chunkMessageHeader;
      } else {
        throw new Error(`Unknown format type: ${formatType}`);
      }

      // 5.3.1.3. Extended Timestamp
      if (message.formatType === 0) {
        if (message.timestamp === 0xffffff) {
          if (chunkBody.length < 4) {  // buffer is incomplete
            break;
          }
          message.timestamp = (chunkBody[0] * Math.pow(256, 3)) +
            (chunkBody[1] << 16) + (chunkBody[2] << 8) + chunkBody[3];
          chunkBody = chunkBody.slice(4);
          headerLen += 4;
        }
      } else if (message.timestampDelta === 0xffffff) {
        if (chunkBody.length < 4) {  // buffer is incomplete
          break;
        }
        message.timestampDelta = (chunkBody[0] * Math.pow(256, 3)) +
          (chunkBody[1] << 16) + (chunkBody[2] << 8) + chunkBody[3];
        chunkBody = chunkBody.slice(4);
        headerLen += 4;
      }

      previousChunk = this.previousChunkMessage[message.chunkStreamID];
      if ((previousChunk != null) && previousChunk.isIncomplete) {
        remainingMessageLen = message.messageLength - previousChunk.body.length;
      } else {
        remainingMessageLen = message.messageLength;
      }
      let chunkPayloadSize = Math.min(this.receiveChunkSize, remainingMessageLen);

      if (chunkBody.length < chunkPayloadSize) {  // buffer is incomplete
        break;
      }

      // We have enough buffer for this chunk

      rtmpMessage = chunkBody.slice(chunkPayloadSize);
      chunkBody = chunkBody.slice(0, chunkPayloadSize);
      consumedLen += headerLen + chunkPayloadSize;

      if ((previousChunk != null) && previousChunk.isIncomplete) {
        // Do not count timestampDelta
        message.body = Buffer.concat([ previousChunk.body, chunkBody ]);
      } else {
        message.body = chunkBody;

        // Calculate timestamp for this message
        if (message.timestampDelta != null) {
          if ((message.timestamp == null)) {
            throw new Error("timestamp delta is given, but base timestamp is not known");
          }
          message.timestamp += message.timestampDelta;
        }
      }

      if (message.body.length >= message.messageLength) { // message is completed
        // TODO: Is this check redundant?
        if (message.body.length !== message.messageLength) {
          logger.warn("[rtmp] warning: message lengths don't match: " +
            `got=${message.body.length} expected=${message.messageLength}`
          );
        }

        messages.push(message);
      } else {
        message.isIncomplete = true;
      }
      this.previousChunkMessage[message.chunkStreamID] = message;
      if (messages.length === 1) {
        break;
      }
    }

    return {
      consumedLen,
      rtmpMessages: messages
    };
  }

  // releaseStream()
  respondReleaseStream(requestCommand, callback) {
    let streamName = requestCommand.objects[1] != null ? requestCommand.objects[1].value : undefined;
    logger.debug(`[rtmp] releaseStream: ${this.app}/${streamName}`);

    // TODO: Destroy stream here?

    let _result = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_result',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Data(null)
      ]});
    return callback(null, _result);
  }

  // @setDataFrame
  receiveSetDataFrame(requestData) {
    if (requestData.objects[1].value === 'onMetaData') {
      return logger.debug("[rtmp:receive] received @setDataFrame onMetaData");
    } else {
      throw new Error(`Unknown @setDataFrame: ${requestData.objects[1].value}`);
    }
  }

  respondFCUnpublish(requestCommand, callback) {
    let streamName = requestCommand.objects[1] != null ? requestCommand.objects[1].value : undefined;
    logger.info(`[rtmp] FCUnpublish: ${streamName}`);
    let _result = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_result',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Data(null)
      ]});

    let unpublishSuccess = createAMF0CommandMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      command: 'onStatus',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'status',
          code: 'NetStream.Unpublish.Success',
          description: '',
          details: streamName,
          clientid: this.clientid
        })
      ]
    }
    , this.chunkSize);

    return callback(null, this.concatenate([
      _result,
      unpublishSuccess
    ]));
  }

  // 7.2.2.6. publish
  respondPublish(requestCommand, callback) {
    let match, publishStart, streamName;
    this.receiveTimestamp = null;
    let publishingName = requestCommand.objects[1] != null ? requestCommand.objects[1].value : undefined;

    if (typeof publishingName !== 'string') {
      publishStart = createAMF0CommandMessage({
        chunkStreamID: 4,
        timestamp: 0,
        messageStreamID: 1,
        command: 'onStatus',
        transactionID: requestCommand.transactionID,
        objects: [
          createAMF0Data(null),
          createAMF0Object({
            level: 'error',
            code: 'NetStream.Publish.Start',
            description: 'Publishing Name parameter is invalid.',
            details: this.app,
            clientid: this.clientid
          })
        ]
      }
      , this.chunkSize);
      return callback(null, publishStart);
    }

    // Strip query string part from a string like:
    // "livestream?videoKeyframeFrequency=5&totalDatarate=248"
    let urlInfo = url.parse(publishingName);
    if (urlInfo.query != null) {
      let pairs = urlInfo.query.split('&');
      let params = {};
      for (let pair of Array.from(pairs)) {
        let kv = pair.split('=');
        params[ kv[0] ] = kv[1];
      }
      // TODO: Use this information for something
      // totalDatarate: Total kbps for video + audio
      logger.info(JSON.stringify(params));
    }

    publishingName = this.app + '/' + urlInfo.pathname;
    this.streamId = publishingName;
    let stream = avstreams.get(this.streamId);
    if (stream != null) {
      stream.reset();
    } else {
      stream = avstreams.create(this.streamId);
      stream.type = avstreams.STREAM_TYPE_LIVE;
    }
    this.stream = stream;
    // TODO: Check if streamId is already used
    let publishingType = requestCommand.objects[2] != null ? requestCommand.objects[2].value : undefined;
    // publishingType should be lowercase ('live') but Wirecast uses uppercase ('LIVE')
    if (publishingType.toLowerCase() !== 'live') {
      logger.warn(`[rtmp] warn: publishing type other than 'live' is not supported (got ${publishingType}); assuming 'live'`);
    }
    logger.info(`[rtmp] publish: stream=${publishingName} publishingType=${publishingType}`);
    // strip query string from publishingName
    if ((match = /^(.*?)\?/.exec(publishingName)) != null) {
      streamName = match[1];
    } else {
      streamName = publishingName;
    }

    this.isFirstVideoReceived = false;
    this.isFirstAudioReceived = false;

    publishStart = createAMF0CommandMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      command: 'onStatus',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'status',
          code: 'NetStream.Publish.Start',
          description: '',
          details: streamName,
          clientid: this.clientid
        })
      ]
    }
    , this.chunkSize);
    return callback(null, publishStart);
  }

  respondWithError(requestCommand, callback) {
    let _error = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_error',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'error',
          code: '',
          description: 'Request failed.',
          details: this.app,
          clientid: this.clientid
        })
      ]});
    return callback(null, _error);
  }

  // FCPublish()
  respondFCPublish(requestCommand, callback) {
    let streamName = requestCommand.objects[1] != null ? requestCommand.objects[1].value : undefined;
    logger.debug(`[rtmp] FCPublish: ${this.app}/${streamName}`);
    let _result = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_result',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Data(null)
      ]});
    return callback(null, _result);
  }

  respondCreateStream(requestCommand, callback) {
    let _result = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_result',
      transactionID: requestCommand.transactionID,  // may be 2
      objects: [
        createAMF0Data(null),
        createAMF0Data(1)  // stream id
      ]});
    return callback(null, _result);
  }

  respondPlay(commandMessage, callback, streamId) {
    let stream, streamIsRecorded;
    if (streamId == null) { streamId = null; }
    if ((streamId == null)) {
      streamId = this.app + '/' + (commandMessage.objects[1] != null ? commandMessage.objects[1].value : undefined);
    }
    logger.info(`[rtmp:client=${this.clientid}] requested stream ${streamId}`);
    this.chunkSize = config.rtmpPlayChunkSize;
    this.stream = avstreams.get(streamId);
    if ((this.stream == null)) {
      logger.error(`[rtmp:client=${this.clientid}] error: stream not found: ${streamId}`);
      let _error = createAMF0CommandMessage({
        chunkStreamID: 3,
        timestamp: 0,
        messageStreamID: 0,
        command: '_error',
        transactionID: commandMessage.transactionID,
        objects: [
          createAMF0Data(null),
          createAMF0Object({
            level: 'error',
            code: 'NetStream.Play.StreamNotFound',
            description: '',
            details: streamId,
            clientid: this.clientid
          })
        ]});

      let close = createAMF0CommandMessage({
        chunkStreamID: 3,
        timestamp: 0,
        messageStreamID: 0,
        command: 'close',
        transactionID: 0,
        objects: [
          createAMF0Data(null)
        ]});

      callback(null, this.concatenate([ _error, close ]));
      return;
    }

    // 5.4.1.  Set Chunk Size (1)
    let setChunkSize = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x01,  // Set Chunk Size
      messageStreamID: 0,
      body: new Buffer([
        (this.chunkSize >>> 24) & 0x7f,  // top bit must be zero
        (this.chunkSize >>> 16) & 0xff,
        (this.chunkSize >>> 8) & 0xff,
        this.chunkSize & 0xff
      ])});

    logger.debug(`[rtmp:client=${this.clientid}] stream type: ${this.stream.type}`);
    if (this.stream.isRecorded()) {
      streamIsRecorded = createRTMPMessage({
        chunkStreamID: 2,
        timestamp: 0,
        messageTypeID: 0x04,  // User Control Message
        messageStreamID: 0,
        body: new Buffer([
          // StreamIsRecorded (see 7.1.7. User Control Message Events)
          0, 4,
          // Stream ID of the recorded stream
          0, 0, 0, 1
        ])
      }
      , this.chunkSize);
    }

    let streamBegin1 = createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x04,  // User Control Message
      messageStreamID: 0,
      body: new Buffer([
        // Stream Begin (see 7.1.7. User Control Message Events)
        0, 0,
        // Stream ID of the stream that became functional
        0, 0, 0, 1
      ])
    }
    , this.chunkSize);

    let playReset = createAMF0CommandMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      command: 'onStatus',
      transactionID: 0,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'status',
          code: 'NetStream.Play.Reset',
          description: `Playing and resetting ${streamId}.`,
          details: streamId,
          clientid: this.clientid
        })
      ]
    }
    , this.chunkSize);

    let playStart = createAMF0CommandMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      command: 'onStatus',
      transactionID: 0,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'status',
          code: 'NetStream.Play.Start',
          description: `Started playing ${streamId}.`,
          details: streamId,
          clientid: this.clientid
        })
      ]
    }
    , this.chunkSize);

    let rtmpSampleAccess = createAMF0DataMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      objects: [
        createAMF0Data('|RtmpSampleAccess'),
        createAMF0Data(false),
        createAMF0Data(false)
      ]
    }
    , this.chunkSize);

    let dataStart = createAMF0DataMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      objects: [
        createAMF0Data('onStatus'),
        createAMF0Object({
          code: 'NetStream.Data.Start'
        })
      ]
    }
    , this.chunkSize);

    let metadata = {
      canSeekToEnd: false,
      cuePoints   : [],
      hasMetadata : true,
      hasCuePoints: false
    };

    if (this.stream != null) {
      ({ stream } = this);

      if (stream != null) {
        if (stream.isVideoStarted) {
          metadata.hasVideo      = true;
          metadata.framerate     = stream.videoFrameRate;
          metadata.height        = stream.videoHeight;
          metadata.videocodecid  = config.flv.videocodecid; // TODO
          metadata.videodatarate = config.videoBitrateKbps; // TODO
          metadata.width         = stream.videoWidth;
          metadata.avclevel      = stream.videoAVCLevel;
          metadata.avcprofile    = stream.videoAVCProfile;
        }

        if (stream.isAudioStarted) {
          metadata.hasAudio        = true;
          metadata.audiocodecid    = config.flv.audiocodecid; // TODO
          metadata.audiodatarate   = config.audioBitrateKbps; // TODO
          metadata.audiodelay      = 0;
          metadata.audiosamplerate = stream.audioSampleRate;
          metadata.stereo          = stream.audioChannels > 1;
          metadata.audiochannels   = stream.audioChannels;
          metadata.aacaot          = stream.audioObjectType;
        }

        if (stream.isRecorded()) {
          metadata.duration = stream.durationSeconds;
          // timestamp of the last tag in the recorded stream
          metadata.lasttimestamp = stream.lastTagTimestamp;
        }
      } else {
        logger.error(`[rtmp] error: respondPlay: no such stream: ${stream.id}`);
      }
    } else {
      logger.error("[rtmp] error: respondPlay: stream not set for this session");
    }

    logger.debug("[rtmp] metadata:");
    logger.debug(metadata);

    let onMetaData = createAMF0DataMessage({
      chunkStreamID: 4,
      timestamp: 0,
      messageStreamID: 1,
      objects: [
        createAMF0Data('onMetaData'),
        createAMF0Data(metadata)
      ]
    }
    , this.chunkSize);

    let codecConfigs = this.getCodecConfigs(0);

    let messages = [ setChunkSize ];
    if (this.stream.isRecorded()) {
      messages.push(streamIsRecorded);
    }
    messages.push(streamBegin1, playReset, playStart, rtmpSampleAccess, dataStart, onMetaData, codecConfigs);

    callback(null, this.concatenate(messages));

    if (this.stream.isRecorded()) {
      this.stream.play();
    }

    // ready for playing
    this.isWaitingForKeyFrame = true;
    this.seekedDuringPause = false;
    if (config.rtmpWaitForKeyFrame) {
      return logger.info(`[rtmp:client=${this.clientid}] waiting for keyframe`);
    }
  }

  // Returns a Buffer contains both SPS and PPS
  getCodecConfigs(timestamp) {
    let buf;
    if (timestamp == null) { timestamp = 0; }
    let configMessages = [];

    let { stream } = this;
    if ((stream == null)) {
      logger.error("[rtmp] error: getCodecConfigs: stream not set for this session");
      return new Buffer([]);
    }

    if (stream.isVideoStarted) {
      if ((stream.spsNALUnit == null) || (stream.ppsNALUnit == null)) {
        logger.error("[rtmp] error: getCodecConfigs: SPS or PPS is not present");
        return new Buffer([]);
      }

      // video
      let spsLen = stream.spsNALUnit.length;
      let ppsLen = stream.ppsNALUnit.length;
      buf = new Buffer([
        // VIDEODATA tag (Appeared in Adobe's Video File Format Spec v10.1 E.4.3.1 VIDEODATA
        (1 << 4) | config.flv.videocodecid, // 1=key frame
        0x00,  // 0=AVC sequence header (configuration data)
        0x00,  // composition time
        0x00,  // composition time
        0x00,  // composition time

        // AVC decoder configuration: described in ISO 14496-15 5.2.4.1.1 Syntax
        0x01,  // version
        ...stream.spsNALUnit.slice(1, 4),
        0xff, // 6 bits reserved (0b111111) + 2 bits nal size length - 1 (0b11)
        0xe1, // 3 bits reserved (0b111) + 5 bits number of sps (0b00001)

        (spsLen >> 8) & 0xff,
        spsLen & 0xff,
        ...stream.spsNALUnit,

        0x01,  // number of PPS (1)

        (ppsLen >> 8) & 0xff,
        ppsLen & 0xff,
        ...stream.ppsNALUnit
      ]);
      let videoConfigMessage = createVideoMessage({
        body: buf,
        timestamp,
        chunkSize: this.chunkSize
      });
      configMessages.push(videoConfigMessage);
    }

    if (stream.isAudioStarted) {
      // audio
      // TODO: support other than AAC too?
      buf = flv.createAACAudioDataTag({
        aacPacketType: flv.AAC_PACKET_TYPE_SEQUENCE_HEADER});
      let ascInfo = stream.audioASCInfo;
      if (ascInfo != null) {
        // Flash Player won't play audio if explicit hierarchical
        // signaling of SBR is used
        if (ascInfo.explicitHierarchicalSBR && config.rtmpDisableHierarchicalSBR) {
          logger.debug("[rtmp] converting hierarchical signaling of SBR" +
            ` (AudioSpecificConfig=0x${stream.audioSpecificConfig.toString('hex')})` +
            " to backward compatible signaling"
          );
          buf = buf.concat(aac.createAudioSpecificConfig(ascInfo));
          buf = new Buffer(buf);
        } else {
          buf = Buffer.concat([
            new Buffer(buf),
            stream.audioSpecificConfig
          ]);
        }
        logger.debug(`[rtmp] sending AudioSpecificConfig: 0x${buf.toString('hex')}`);
      } else {
        buf = buf.concat(aac.createAudioSpecificConfig({
          audioObjectType: stream.audioObjectType,
          samplingFrequency: stream.audioSampleRate,
          channels: stream.audioChannels,
          frameLength: 1024
        })
        );  // TODO: How to detect 960?
        // Convert buf from array to Buffer
        buf = new Buffer(buf);
      }

      let audioConfigMessage = createAudioMessage({
        body: buf,
        timestamp,
        chunkSize: this.chunkSize
      });
      configMessages.push(audioConfigMessage);
    }

    return this.concatenate(configMessages);
  }

//  respondPauseRaw: (requestCommand, callback) ->
//    lastTimestamp = @stream.rtmpLastTimestamp ? 0
//
//    _result = createAMF0CommandMessage
//      chunkStreamID: 3
//      timestamp: lastTimestamp
//      messageStreamID: 0
//      command: '_result'
//      transactionID: requestCommand.transactionID
//      objects: [
//        createAMF0Data(null)
//        createAMF0Data(null)
//      ]
//
//    callback null, _result

  respondSeek(requestCommand, callback) {
    let msec = requestCommand.objects[1].value;
    logger.info(`[rtmp:client=${this.clientid}] seek to ${msec / 1000} sec`);
    msec = Math.floor(msec);

    this.lastSentTimestamp = null;

    if ((this.stream != null ? this.stream.type : undefined) === avstreams.STREAM_TYPE_RECORDED) {
      clearQueuedRTMPMessages(this.stream);
      let _isPlaying = this.isPlaying;
      this.isPlaying = false;
      let _isPaused = this.stream.isPaused();
      if (!_isPaused) {
        this.stream.pause();
      }
      return this.stream.seek(msec / 1000, (err, actualStartTime) => {
        if (err) {
          logger.error(`seek failed: ${err}`);
          return;
        }

        // restore the value of @isPlaying
        this.isPlaying = _isPlaying;

        let seq = new Sequent;

        // If the stream had not been paused, start playing
        if (!_isPaused) {
          this.stream.sendVideoPacketsSinceLastKeyFrame(msec / 1000, () => {
            this.stream.resume();
            this.seekedDuringPause = false;
            return seq.done();
          }
          );
        } else {
          this.seekedDuringPause = true;
          seq.done();
        }

        return seq.wait(1, () => {
          let streamEOF1 = createRTMPMessage({
            chunkStreamID: 2,
            timestamp: 0,
            messageTypeID: 0x04,  // User Control Message
            messageStreamID: 0,
            body: new Buffer([
              // Stream EOF (see 7.1.7. User Control Message Events)
              0, 1,
              // Stream ID of the stream that reaches EOF
              0, 0, 0, 1
            ])});

          // 5.4.1.  Set Chunk Size (1)
          let setChunkSize = createRTMPMessage({
            chunkStreamID: 2,
            timestamp: 0,
            messageTypeID: 0x01,  // Set Chunk Size
            messageStreamID: 0,
            body: new Buffer([
              (this.chunkSize >>> 24) & 0x7f,  // top bit must be zero
              (this.chunkSize >>> 16) & 0xff,
              (this.chunkSize >>> 8) & 0xff,
              this.chunkSize & 0xff
            ])});

          let streamIsRecorded = createRTMPMessage({
            chunkStreamID: 2,
            timestamp: 0,
            messageTypeID: 0x04,  // User Control Message
            messageStreamID: 0,
            body: new Buffer([
              // StreamIsRecorded (see 7.1.7. User Control Message Events)
              0, 4,
              // Stream ID of the recorded stream
              0, 0, 0, 1
            ])
          }
          , this.chunkSize);

          let streamBegin1 = createRTMPMessage({
            chunkStreamID: 2,
            timestamp: 0,
            messageTypeID: 0x04,  // User Control Message
            messageStreamID: 0,
            body: new Buffer([
              // Stream Begin (see 7.1.7. User Control Message Events)
              0, 0,
              // Stream ID of the stream that became functional
              0, 0, 0, 1
            ])
          }
          , this.chunkSize);

          let seekNotify = createAMF0CommandMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            command: 'onStatus',
            transactionID: requestCommand.transactionID,
            objects: [
              createAMF0Data(null),
              createAMF0Object({
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking ${msec} (stream ID: 1).`,
                details: this.stream.id,
                clientid: this.clientid
              })
            ]
          }
          , this.chunkSize);

          let playStart = createAMF0CommandMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            command: 'onStatus',
            transactionID: 0,
            objects: [
              createAMF0Data(null),
              createAMF0Object({
                level: 'status',
                code: 'NetStream.Play.Start',
                description: `Started playing ${this.stream.id}.`,
                details: this.stream.id,
                clientid: this.clientid
              })
            ]
          }
          , this.chunkSize);

          let rtmpSampleAccess = createAMF0DataMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            objects: [
              createAMF0Data('|RtmpSampleAccess'),
              createAMF0Data(false),
              createAMF0Data(false)
            ]
          }
          , this.chunkSize);

          // TODO: onStatus('NetStream.Data.Start')
          let dataStart = createAMF0DataMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            objects: [
              createAMF0Data('onStatus'),
              createAMF0Object({
                code: 'NetStream.Data.Start'
              })
            ]
          }
          , this.chunkSize);

          let metadata = {
            canSeekToEnd: false,
            cuePoints   : [],
            hasMetadata : true,
            hasCuePoints: false
          };

          let { stream } = this;

          if (stream.isVideoStarted) {
            metadata.hasVideo      = true;
            metadata.framerate     = stream.videoFrameRate;
            metadata.height        = stream.videoHeight;
            metadata.videocodecid  = config.flv.videocodecid; // TODO
            metadata.videodatarate = config.videoBitrateKbps; // TODO
            metadata.width         = stream.videoWidth;
            metadata.avclevel      = stream.videoAVCLevel;
            metadata.avcprofile    = stream.videoAVCProfile;
          }

          if (stream.isAudioStarted) {
            metadata.hasAudio        = true;
            metadata.audiocodecid    = config.flv.audiocodecid; // TODO
            metadata.audiodatarate   = config.audioBitrateKbps; // TODO
            metadata.audiodelay      = 0;
            metadata.audiosamplerate = stream.audioSampleRate;
            metadata.stereo          = stream.audioChannels > 1;
            metadata.audiochannels   = stream.audioChannels;
            metadata.aacaot          = stream.audioObjectType;
          }

          metadata.duration = stream.durationSeconds;
          // timestamp of the last tag in the recorded file
          metadata.lasttimestamp = stream.lastTagTimestamp;
          // timestamp of the last video key frame

          logger.debug("[rtmp] metadata:");
          logger.debug(metadata);

          let onMetaData = createAMF0DataMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            objects: [
              createAMF0Data('onMetaData'),
              createAMF0Data(metadata)
            ]
          }
          , this.chunkSize);

          let codecConfigs = this.getCodecConfigs(msec);

          // TODO: Should we send all video packets since last key frame?

          // Send all suite regardless of _isPaused
          return callback(null, this.concatenate([
            streamEOF1, setChunkSize, streamIsRecorded,
            streamBegin1, seekNotify, playStart,
            rtmpSampleAccess, dataStart, onMetaData, codecConfigs
          ]));
        });
      });
    } else { // live
      return this.respondPlay(requestCommand, callback);
    }
  }

  respondPause(requestCommand, callback) {
    let doPause = requestCommand.objects[1].value === true;
    let msec = requestCommand.objects[2].value;

    if (doPause) { // playing -> pause
      this.isPlaying = false;
      this.isWaitingForKeyFrame = false;
      if ((this.stream != null ? this.stream.type : undefined) === avstreams.STREAM_TYPE_RECORDED) {
        if (typeof this.stream.pause === 'function') {
          this.stream.pause();
        }
        logger.info(`[rtmp:client=${this.clientid}] stream ${this.stream.id} paused at ${msec / 1000} sec (client player time)`);

        let streamEOF1 = createRTMPMessage({
          chunkStreamID: 2,
          timestamp: 0,
          messageTypeID: 0x04,  // User Control Message
          messageStreamID: 0,
          body: new Buffer([
            // Stream EOF (see 7.1.7. User Control Message Events)
            0, 1,
            // Stream ID of the stream that reaches EOF
            0, 0, 0, 1
          ])});

        let pauseNotify = createAMF0CommandMessage({
          chunkStreamID: 4,
          timestamp: msec,
          messageStreamID: 1,
          command: 'onStatus',
          transactionID: requestCommand.transactionID,
          objects: [
            createAMF0Data(null),
            createAMF0Object({
              level: 'status',
              code: 'NetStream.Pause.Notify',
              description: `Pausing ${this.stream.id}.`,
              details: this.stream.id,
              clientid: this.clientid
            })
          ]
        }
        , this.chunkSize);

        return callback(null, this.concatenate([ streamEOF1, pauseNotify ]));
      } else { // live stream
        return callback(null);
      }
    } else { // pausing -> resume
      let stream;
      if ((this.stream != null ? this.stream.type : undefined) === avstreams.STREAM_TYPE_RECORDED) {
        let seekMsec;
        clearQueuedRTMPMessages(this.stream);
        // RTMP 1.0 spec says that the server only sends messages with timestamps
        // greater than the specified msec, but it appears that Flash Player expects
        // to include the specified msec when msec is 0.
        if (msec === 0) {
          seekMsec = 0;
        } else {
          seekMsec = msec + 1;
        }
        return this.stream.seek(seekMsec / 1000, (err, actualStartTime) => {
          let streamIsRecorded;
          if (err) {
            logger.error(`[rtmp] seek failed: ${err}`);
            return;
          }

          // 5.4.1.  Set Chunk Size (1)
          let setChunkSize = createRTMPMessage({
            chunkStreamID: 2,
            timestamp: 0,
            messageTypeID: 0x01,  // Set Chunk Size
            messageStreamID: 0,
            body: new Buffer([
              (this.chunkSize >>> 24) & 0x7f,  // top bit must be zero
              (this.chunkSize >>> 16) & 0xff,
              (this.chunkSize >>> 8) & 0xff,
              this.chunkSize & 0xff
            ])});

          if (this.stream.isRecorded()) {
            streamIsRecorded = createRTMPMessage({
              chunkStreamID: 2,
              timestamp: 0,
              messageTypeID: 0x04,  // User Control Message
              messageStreamID: 0,
              body: new Buffer([
                // StreamIsRecorded (see 7.1.7. User Control Message Events)
                0, 4,
                // Stream ID of the recorded stream
                0, 0, 0, 1
              ])
            }
            , this.chunkSize);
          }

          let streamBegin1 = createRTMPMessage({
            chunkStreamID: 2,
            timestamp: 0,
            messageTypeID: 0x04,  // User Control Message
            messageStreamID: 0,
            body: new Buffer([
              // Stream Begin (see 7.1.7. User Control Message Events)
              0, 0,
              // Stream ID of the stream that became functional
              0, 0, 0, 1
            ])
          }
          , this.chunkSize);

          let unpauseNotify = createAMF0CommandMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            command: 'onStatus',
            transactionID: requestCommand.transactionID,
            objects: [
              createAMF0Data(null),
              createAMF0Object({
                level: 'status',
                code: 'NetStream.Unpause.Notify',
                description: `Unpausing ${this.stream.id}.`,
                details: this.stream.id,
                clientid: this.clientid
              })
            ]
          }
          , this.chunkSize);

          let playStart = createAMF0CommandMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            command: 'onStatus',
            transactionID: 0,
            objects: [
              createAMF0Data(null),
              createAMF0Object({
                level: 'status',
                code: 'NetStream.Play.Start',
                description: `Started playing ${this.stream.id}.`,
                details: this.stream.id,
                clientid: this.clientid
              })
            ]
          }
          , this.chunkSize);

          let rtmpSampleAccess = createAMF0DataMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            objects: [
              createAMF0Data('|RtmpSampleAccess'),
              createAMF0Data(false),
              createAMF0Data(false)
            ]
          }
          , this.chunkSize);

          // TODO: onStatus('NetStream.Data.Start')
          let dataStart = createAMF0DataMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            objects: [
              createAMF0Data('onStatus'),
              createAMF0Object({
                code: 'NetStream.Data.Start'
              })
            ]
          }
          , this.chunkSize);

          let metadata = {
            canSeekToEnd: false,
            cuePoints   : [],
            hasMetadata : true,
            hasCuePoints: false
          };

          ({ stream } = this);

          if (stream.isVideoStarted) {
            metadata.hasVideo      = true;
            metadata.framerate     = stream.videoFrameRate;
            metadata.height        = stream.videoHeight;
            metadata.videocodecid  = config.flv.videocodecid; // TODO
            metadata.videodatarate = config.videoBitrateKbps; // TODO
            metadata.width         = stream.videoWidth;
            metadata.avclevel      = stream.videoAVCLevel;
            metadata.avcprofile    = stream.videoAVCProfile;
          }

          if (stream.isAudioStarted) {
            metadata.hasAudio        = true;
            metadata.audiocodecid    = config.flv.audiocodecid; // TODO
            metadata.audiodatarate   = config.audioBitrateKbps; // TODO
            metadata.audiodelay      = 0;
            metadata.audiosamplerate = stream.audioSampleRate;
            metadata.stereo          = stream.audioChannels > 1;
            metadata.audiochannels   = stream.audioChannels;
            metadata.aacaot          = stream.audioObjectType;
          }

          metadata.duration = stream.durationSeconds;
          // timestamp of the last tag in the recorded file
          metadata.lasttimestamp = stream.lastTagTimestamp;
          // timestamp of the last video key frame

          logger.debug("[rtmp] metadata:");
          logger.debug(metadata);

          let onMetaData = createAMF0DataMessage({
            chunkStreamID: 4,
            timestamp: msec,
            messageStreamID: 1,
            objects: [
              createAMF0Data('onMetaData'),
              createAMF0Data(metadata)
            ]
          }
          , this.chunkSize);

          let codecConfigs = this.getCodecConfigs(msec);

          callback(null, this.concatenate([
            setChunkSize, streamIsRecorded, streamBegin1,
            unpauseNotify, playStart, rtmpSampleAccess,
            dataStart, onMetaData, codecConfigs
          ]));

          let seq = new Sequent;
          this.startPlaying();
          if (this.seekedDuringPause) {
            this.stream.sendVideoPacketsSinceLastKeyFrame(seekMsec / 1000, () => {
              return seq.done();
            }
            );
          } else {
            this.isResuming = true;
            seq.done();
          }

          return seq.wait(1, () => {
            let isResumed = this.stream.resume();
            this.seekedDuringPause = false;

            if (!isResumed) {
              return logger.debug(`[rtmp:client=${this.clientid}] cannot resume (EOF reached)`);
            } else {
              return logger.info(`[rtmp:client=${this.clientid}] resumed at ${msec / 1000} sec (client player time)`);
            }
          }
          );
        }
        );

      } else { // live
        this.startPlaying();
        return this.respondPlay(requestCommand, callback, this.stream != null ? this.stream.id : undefined);
      }
    }
  }

  closeStream(callback) {
    this.isPlaying = false;
    this.isWaitingForKeyFrame = false;
    return callback(null);
  }

  deleteStream(requestCommand, callback) {
    this.isPlaying = false;
    this.isWaitingForKeyFrame = false;

    let _result = createAMF0CommandMessage({
      chunkStreamID: 3,
      timestamp: 0,
      messageStreamID: 0,
      command: '_result',
      transactionID: requestCommand.transactionID,
      objects: [
        createAMF0Data(null),
        createAMF0Data(null)
      ]});
    return callback(null, _result);
  }

  handleAMFDataMessage(dataMessage, callback) {
    callback(null);
    if (dataMessage.objects.length === 0) {
      logger.warn("[rtmp:receive] empty AMF data");
    }
    switch (dataMessage.objects[0].value) {
      case '@setDataFrame':
        this.receiveSetDataFrame(dataMessage);
        break;
      default:
        logger.warn(`[rtmp:receive] unknown (not implemented) AMF data: ${dataMessage.objects[0].value}`);
        logger.debug(dataMessage);
    }
  }

  handleAMFCommandMessage(commandMessage, callback) {
    switch (commandMessage.command) {
      case 'connect':
        // Retain objectEncoding for later use
        //   3=AMF3, 0=AMF0
        this.objectEncoding = __guard__(commandMessage.objects[0] != null ? commandMessage.objects[0].value : undefined, x => x.objectEncoding);

        return this.respondConnect(commandMessage, callback);
      case 'createStream':
        return this.respondCreateStream(commandMessage, callback);
      case 'play':
        let streamId = commandMessage.objects[1] != null ? commandMessage.objects[1].value : undefined;
        return this.respondPlay(commandMessage, callback);
      case 'closeStream':
        return this.closeStream(callback);
      case 'deleteStream':
        return this.deleteStream(commandMessage, callback);
      case 'pause':
        return this.respondPause(commandMessage, callback);
      case 'pauseRaw':
        logger.debug("[rtmp] ignoring pauseRaw");
        return callback(null);
//        @respondPauseRaw commandMessage, callback
      // Methods used for publishing from the client
      case 'seek':
        return this.respondSeek(commandMessage, callback);
      case 'releaseStream':
        return this.respondReleaseStream(commandMessage, callback);
      case 'FCPublish':
        return this.respondFCPublish(commandMessage, callback);
      case 'publish':
        return this.respondPublish(commandMessage, callback);
      case 'FCUnpublish':
        return this.respondFCUnpublish(commandMessage, callback);
      default:
        logger.warn(`[rtmp:receive] unknown (not implemented) AMF command: ${commandMessage.command}`);
        logger.debug(commandMessage);
//        @respondWithError commandMessage, callback
        return callback(null);  // ignore
    }
  }

  createAck() {
    if (DEBUG_OUTGOING_RTMP_PACKETS) {
      logger.info("createAck");
    }
    return createRTMPMessage({
      chunkStreamID: 2,
      timestamp: 0,  // TODO: Is zero OK?
      messageTypeID: 3,  // Acknowledgement
      messageStreamID: 0,
      body: new Buffer([
        // number of bytes received so far (4 bytes)
        (this.receivedBytes >>> 24) & 0xff,
        (this.receivedBytes >>> 16) & 0xff,
        (this.receivedBytes >>> 8) & 0xff,
        this.receivedBytes & 0xff
      ])});
  }

  handleData(buf, callback) {
    this.scheduleTimeout();

    let outputs = [];
    let seq = new Sequent;

    if (this.windowAckSize != null) {
      this.receivedBytes += buf.length;
      if ((this.receivedBytes - this.lastSentAckBytes) > (this.windowAckSize / 2)) {
        outputs.push(this.createAck());
        this.lastSentAckBytes = this.receivedBytes;
      }
    }

    if (this.state === SESSION_STATE_NEW) {
      if (this.tmpBuf != null) {
        buf = Buffer.concat([this.tmpBuf, buf], this.tmpBuf.length + buf.length);
        this.tmpBuf = null;
      }
      if (buf.length < 1537) {
        logger.debug("[rtmp] waiting for C0+C1");
        this.tmpBuf = buf;
        return;
      }
      this.tmpBuf = null;
      this.state = SESSION_STATE_HANDSHAKE_ONGOING;
      this.respondHandshake(buf, callback);
      return;
    } else if (this.state === SESSION_STATE_HANDSHAKE_ONGOING) {
      if (this.tmpBuf != null) {
        buf = Buffer.concat([this.tmpBuf, buf], this.tmpBuf.length + buf.length);
        this.tmpBuf = null;
      }
      if (buf.length < 1536) {
        logger.debug("[rtmp] waiting for C2");
        this.tmpBuf = buf;
        return;
      }
      this.tmpBuf = null;

      // TODO: should we validate C2?
//      c2Message = buf[0..1535]

      this.state = SESSION_STATE_HANDSHAKE_DONE;
      logger.debug("[rtmp] handshake success");

      if (buf.length <= 1536) {
        callback(null);
        return;
      }

      buf = buf.slice(1536);
    }

    if (this.state !== SESSION_STATE_HANDSHAKE_DONE) {
      logger.error(`[rtmp:receive] unknown session state: ${this.state}`);
      return callback(new Error("Unknown session state"));
    } else {
      if (this.useEncryption) {
        buf = this.decrypt(buf);
      }

      if (this.tmpBuf != null) {
        buf = Buffer.concat([this.tmpBuf, buf], this.tmpBuf.length + buf.length);
        this.tmpBuf = null;
      }

      let onConsumeAllPackets = () => {
        let outbuf = this.concatenate(outputs);
        if (this.useEncryption) {
          outbuf = this.encrypt(outbuf);
        }
        return callback(null, outbuf);
      };

      var consumeNextRTMPMessage = () => {
        if ((buf == null)) {
          onConsumeAllPackets();
          return;
        }
        let parseResult = this.parseRTMPMessages(buf);
        if (parseResult.consumedLen === 0) {  // not consumed at all
          this.tmpBuf = buf;
          // no message to process
          onConsumeAllPackets();
          return;
        } else if (parseResult.consumedLen < buf.length) {  // consumed a part of buffer
          buf = buf.slice(parseResult.consumedLen);
        } else {  // consumed all buffers
          buf = null;
        }

        seq.reset();

        seq.wait(parseResult.rtmpMessages.length, function(err, output) {
          if (err != null) {
            logger.error(`[rtmp:receive] ignoring invalid packet (${err})`);
          }
          if (output != null) {
            outputs.push(output);
          }
          return consumeNextRTMPMessage();
        });

        return Array.from(parseResult.rtmpMessages).map((rtmpMessage) =>
          (() => { let dataMessage, dts, pts, timestamp;
          switch (rtmpMessage.messageTypeID) {
            case 1:  // Set Chunk Size
              let newChunkSize = (rtmpMessage.body[0] * Math.pow(256, 3)) +
                (rtmpMessage.body[1] << 16) +
                (rtmpMessage.body[2] << 8) +
                rtmpMessage.body[3];
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                logger.info(`[rtmp:receive] Set Chunk Size: ${newChunkSize}`);
              }
              this.receiveChunkSize = newChunkSize;
              return seq.done();
            case 3:  // Acknowledgement
              let acknowledgementMessage = parseAcknowledgementMessage(rtmpMessage.body);
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                logger.info(`[rtmp:receive] Ack: ${acknowledgementMessage.sequenceNumber}`);
              }
              return seq.done();
            case 4:  // User Control Message
              let userControlMessage = parseUserControlMessage(rtmpMessage.body);
              if (userControlMessage.eventType === 3) {  // SetBufferLength
                let streamID = (userControlMessage.eventData[0] << 24) +
                  (userControlMessage.eventData[1] << 16) +
                  (userControlMessage.eventData[2] << 8) +
                  userControlMessage.eventData[3];
                let bufferLength = (userControlMessage.eventData[4] << 24) +
                  (userControlMessage.eventData[5] << 16) +
                  (userControlMessage.eventData[6] << 8) +
                  userControlMessage.eventData[7];
                if (DEBUG_INCOMING_RTMP_PACKETS) {
                  logger.info(`[rtmp:receive] SetBufferLength: streamID=${streamID} bufferLength=${bufferLength}`);
                }
              } else if (userControlMessage.eventType === 7) {
                timestamp = (userControlMessage.eventData[0] << 24) +
                  (userControlMessage.eventData[1] << 16) +
                  (userControlMessage.eventData[2] << 8) +
                  userControlMessage.eventData[3];
                if (DEBUG_INCOMING_RTMP_PACKETS) {
                  logger.info(`[rtmp:receive] PingResponse: timestamp=${timestamp}`);
                }
              } else {
                if (DEBUG_INCOMING_RTMP_PACKETS) {
                  logger.info("[rtmp:receive] User Control Message");
                  logger.info(userControlMessage);
                }
              }
              return seq.done();
            case 5:  // Window Acknowledgement Size
              this.windowAckSize = (rtmpMessage.body[0] << 24) +
                (rtmpMessage.body[1] << 16) +
                (rtmpMessage.body[2] << 8) +
                rtmpMessage.body[3];
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                logger.info(`[rtmp:receive] WindowAck: ${this.windowAckSize}`);
              }
              return seq.done();
            case 8:  // Audio Message (incoming)
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                logger.info("[rtmp:receive] Audio Message");
              }
              let audioData = this.parseAudioMessage(rtmpMessage.body);
              if (audioData.adtsFrame != null) {
                if (!this.isFirstAudioReceived) {
                  this.emit('audio_start', this.stream.id);
                  this.isFirstAudioReceived = true;
                }
                pts = dts = flv.convertMsToPTS(rtmpMessage.timestamp);
                this.emit('audio_data', this.stream.id, pts, dts, audioData.adtsFrame);
              }
              return seq.done();
            case 9:  // Video Message (incoming)
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                logger.info("[rtmp:receive] Video Message");
              }
              let videoData = this.parseVideoMessage(rtmpMessage.body);
              if (videoData.nalUnitGlob != null) {
                if (!this.isFirstVideoReceived) {
                  this.emit('video_start', this.stream.id);
                  this.isFirstVideoReceived = true;
                }
                dts = rtmpMessage.timestamp;
                pts = dts + videoData.info.videoDataTag.compositionTime;
                pts = flv.convertMsToPTS(pts);
                dts = flv.convertMsToPTS(dts);
                this.emit('video_data', this.stream.id, pts, dts, videoData.nalUnitGlob);  // TODO pts, dts
              }
              if (videoData.isEOS) {
                logger.info(`[rtmp:client=${this.clientid}] received EOS for stream: ${this.stream.id}`);
                let stream = avstreams.get(this.stream.id);
                if ((stream == null)) {
                  logger.error(`[rtmp:client=${this.clientid}] error: unknown stream: ${this.stream.id}`);
                }
                stream.emit('end');
              }
              return seq.done();
            case 15:  // AMF3 data message
              try {
                dataMessage = parseAMF0DataMessage(rtmpMessage.body.slice(1));
              } catch (e) {
                logger.error(`[rtmp] error: failed to parse AMF0 data message: ${e.stack}`);
                logger.error(`messageTypeID=${rtmpMessage.messageTypeID} body:`);
                Bits.hexdump(rtmpMessage.body);
                seq.done(e);
              }
              if (dataMessage != null) {
                if (DEBUG_INCOMING_RTMP_PACKETS) {
                  logger.info("[rtmp:receive] AMF3 data:");
                  logger.info(dataMessage);
                }
                return this.handleAMFDataMessage(dataMessage, function(err, output) {
                  if (err != null) {
                    logger.error(`[rtmp:receive] packet error: ${err}`);
                  }
                  if (output != null) {
                    outputs.push(output);
                  }
                  return seq.done();
                });
              }
              break;
            case 17:  // AMF3 command (0x11)
              // Does the first byte == 0x00 mean AMF0?
              let commandMessage = parseAMF0CommandMessage(rtmpMessage.body.slice(1));
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                let msec;
                let debugMsg = `[rtmp:receive] AMF3 command: ${commandMessage.command}`;
                if (commandMessage.command === 'pause') {
                  msec = commandMessage.objects[2].value;
                  if (commandMessage.objects[1].value === true) {
                    debugMsg += ` (doPause=true msec=${msec})`;
                  } else {
                    debugMsg += ` (doPause=false msec=${msec})`;
                  }
                } else if (commandMessage.command === 'seek') {
                  msec = commandMessage.objects[1].value;
                  debugMsg += ` (msec=${msec})`;
                }
                logger.debug(debugMsg);
              }
              return this.handleAMFCommandMessage(commandMessage, function(err, output) {
                if (err != null) {
                  logger.error(`[rtmp:receive] packet error: ${err}`);
                }
                if (output != null) {
                  outputs.push(output);
                }
                return seq.done();
              });
            case 18:  // AMF0 data message
              try {
                dataMessage = parseAMF0DataMessage(rtmpMessage.body);
              } catch (e) {
                logger.error(`[rtmp] error: failed to parse AMF0 data message: ${e.stack}`);
                logger.error(`messageTypeID=${rtmpMessage.messageTypeID} body:`);
                Bits.hexdump(rtmpMessage.body);
                seq.done(e);
              }
              if (dataMessage != null) {
                if (DEBUG_INCOMING_RTMP_PACKETS) {
                  logger.info("[rtmp:receive] AMF0 data:");
                  logger.info(dataMessage);
                }
                return this.handleAMFDataMessage(dataMessage, function(err, output) {
                  if (err != null) {
                    logger.error(`[rtmp:receive] packet error: ${err}`);
                  }
                  if (output != null) {
                    outputs.push(output);
                  }
                  return seq.done();
                });
              }
              break;
            case 20:  // AMF0 command
              commandMessage = parseAMF0CommandMessage(rtmpMessage.body);
              if (DEBUG_INCOMING_RTMP_PACKETS) {
                logger.info(`[rtmp:receive] AMF0 command: ${commandMessage.command}`);
              }
              return this.handleAMFCommandMessage(commandMessage, function(err, output) {
                if (err != null) {
                  logger.error(`[rtmp:receive] packet error: ${err}`);
                }
                if (output != null) {
                  outputs.push(output);
                }
                return seq.done();
              });
            default:
              logger.error("----- BUG -----");
              logger.error(`[rtmp:receive] received unknown (not implemented) message type ID: ${rtmpMessage.messageTypeID}`);
              logger.error(rtmpMessage);
              let packageJson = require('./package.json');
              logger.error(`server version: ${packageJson.version}`);
              logger.error("Please report this bug along with the video file or relevant part of");
              logger.error("pcap file, and the full (uncut) output of node-rtsp-rtsp-server. Thanks.");
              logger.error("https://github.com/iizukanao/node-rtsp-rtmp-server/issues");
              logger.error("---------------");
              return seq.done();
          } })());
      };

      return consumeNextRTMPMessage();
    }
  }
}

class RTMPServer {
  constructor(opts) {
    this.eventListeners = {};
    this.port = (opts != null ? opts.rtmpServerPort : undefined) != null ? (opts != null ? opts.rtmpServerPort : undefined) : 1935;
    this.server = net.createServer(c => {
      c.clientId = ++clientMaxId;
      let sess = new RTMPSession(c);
      logger.info(`[rtmp:client=${sess.clientid}] connected`);
      sessions[c.clientId] = sess;
      sessionsCount++;
      c.rtmpSession = sess;
      sess.on('data', function(data) {
        if ((data != null) && (data.length > 0)) {
          return c.write(data);
        }
      });
      sess.on('video_start', (...args) => {
        return this.emit('video_start', ...args);
      }
      );
      sess.on('audio_start', (...args) => {
        return this.emit('audio_start', ...args);
      }
      );
      sess.on('video_data', (...args) => {
        return this.emit('video_data', ...args);
      }
      );
      sess.on('audio_data', (...args) => {
        return this.emit('audio_data', ...args);
      }
      );
      c.on('close', () => {
        logger.info(`[rtmp:client=${sess.clientid}] disconnected`);
        if (sessions[c.clientId] != null) {
          sessions[c.clientId].teardown();
          delete sessions[c.clientId];
          sessionsCount--;
        }
        return this.dumpSessions();
      }
      );
      c.on('error', function(err) {
        logger.error(`[rtmp:client=${sess.clientid}] socket error: ${err}`);
        return c.destroy();
      });
      c.on('data', data => {
        return c.rtmpSession.handleData(data, function(err, output) {
          if (err) {
            return logger.error(`[rtmp] error: ${err}`);
          } else if (output != null) {
            if (output.length > 0) {
              return c.write(output);
            }
          }
        });
      }
      );
      return this.dumpSessions();
    }
    );
  }

  start(opts, callback) {
    let serverPort = (opts != null ? opts.port : undefined) != null ? (opts != null ? opts.port : undefined) : this.port;

    logger.debug(`[rtmp] starting server on port ${serverPort}`);
    return this.server.listen(serverPort, '0.0.0.0', 511, () => {
      logger.info(`[rtmp] server started on port ${serverPort}`);
      return (typeof callback === 'function' ? callback() : undefined);
    }
    );
  }

  stop(callback) {
    return this.server.close(callback);
  }

  on(event, listener) {
    if (this.eventListeners[event] != null) {
      this.eventListeners[event].push(listener);
    } else {
      this.eventListeners[event] = [ listener ];
    }
  }

  emit(event, ...args) {
    if (this.eventListeners[event] != null) {
      for (let listener of Array.from(this.eventListeners[event])) {
        listener(...args);
      }
    }
  }

  dumpSessions() {
    logger.raw(`[rtmp: ${sessionsCount} sessions]`);
    for (var sessionID in sessions) {
      let session = sessions[sessionID];
      logger.raw(` ${session.toString()}`);
    }
    if (rtmptSessionsCount > 0) {
      logger.raw(`[rtmpt: ${rtmptSessionsCount} sessions]`);
      for (sessionID in rtmptSessions) {
        let rtmptSession = rtmptSessions[sessionID];
        logger.raw(` ${rtmptSession.toString()}`);
      }
    }
  }

  teardownRTMPTClient(socket) {
    if (socket.rtmptClientID != null) {
      logger.debug(`[rtmp] teardownRTMPTClient: ${socket.rtmptClientID}`);
      let tsession = rtmptSessions[socket.rtmptClientID];
      if (tsession != null) {
        if (tsession.rtmpSession != null) {
          tsession.rtmpSession.teardown();
        }
        delete rtmptSessions[socket.rtmptClientID];
        return rtmptSessionsCount--;
      }
    }
  }

  updateConfig(newConfig) {
    return config = newConfig;
  }

  // Packets must be come in DTS ascending order
  sendVideoPacket(stream, nalUnits, pts, dts) {
    let firstByte, nalUnit;
    if (DEBUG_INCOMING_STREAM_DATA) {
      let totalBytes = 0;
      for (nalUnit of Array.from(nalUnits)) {
        totalBytes += nalUnit.length;
      }
      logger.info(`received video: stream=${stream.id} ${totalBytes} bytes; ${nalUnits.length} NAL units (${nalUnits.map(nalu => nalu[0] & 0x1f).join(',')}); pts=${pts}`);
    }
    if (dts > pts) {
      throw new Error(`pts must be >= dts (pts=${pts} dts=${dts})`);
    }
    let timestamp = convertPTSToMilliseconds(dts);

    if ((sessionsCount + rtmptSessionsCount) === 0) {
      return;
    }

    let message = [];

    let hasKeyFrame = false;
    // This format may be AVCSample in 5.3.4.2.1 of ISO 14496-15
    for (nalUnit of Array.from(nalUnits)) {
      let nalUnitType = h264.getNALUnitType(nalUnit);
      if (config.dropH264AccessUnitDelimiter &&
      (nalUnitType === h264.NAL_UNIT_TYPE_ACCESS_UNIT_DELIMITER)) {
        // ignore access unit delimiters
        continue;
      }
      if (nalUnitType === h264.NAL_UNIT_TYPE_IDR_PICTURE) {  // 5
        hasKeyFrame = true;
      }
      let payloadLen = nalUnit.length;
      message.push(new Buffer([
        // The length of this data is specified in
        // configuration data that has already been sent
        (payloadLen >>> 24) & 0xff,
        (payloadLen >>> 16) & 0xff,
        (payloadLen >>> 8) & 0xff,
        payloadLen & 0xff,
      ]));
      message.push(nalUnit);
    }

    if (message.length === 0) {
      // message is empty
      return;
    }

    // Add VIDEODATA tag
    if (hasKeyFrame) {  // IDR picture (key frame)
      firstByte = (1 << 4) | config.flv.videocodecid;
    } else {  // non-IDR picture (inter frame)
      firstByte = (2 << 4) | config.flv.videocodecid;
    }
    // Composition time offset: composition time (PTS) - decoding time (DTS)
    let compositionTimeMs = Math.floor((pts - dts) / 90);  // convert to milliseconds
    if (compositionTimeMs > 0x7fffff) {  // composition time is signed 24-bit integer
      compositionTimeMs = 0x7fffff;
    }
    message.unshift(new Buffer([
      // VIDEODATA tag
      firstByte,
      AVC_PACKET_TYPE_NALU,
      // Composition time (signed 24-bit integer)
      // See ISO 14496-12, 8.15.3 for details
      (compositionTimeMs >> 16) & 0xff, // composition time (PTS - DTS)
      (compositionTimeMs >> 8) & 0xff,
      compositionTimeMs & 0xff,
    ]));

    let buf = Buffer.concat(message);

    queueVideoMessage(stream, {
      body: buf,
      timestamp,
      isKeyFrame: hasKeyFrame,
      compositionTime: compositionTimeMs
    }
    );

    stream.rtmpLastTimestamp = timestamp;

  }

  sendAudioPacket(stream, rawDataBlock, timestamp) {
    if (DEBUG_INCOMING_STREAM_DATA) {
      logger.info(`received audio: stream=${stream.id} ${rawDataBlock.length} bytes; timestamp=${timestamp}`);
    }
    timestamp = convertPTSToMilliseconds(timestamp);

    if ((sessionsCount + rtmptSessionsCount) === 0) {
      return;
    }

    // TODO: support other than AAC too?
    let headerBytes = new Buffer(flv.createAACAudioDataTag({
      aacPacketType: flv.AAC_PACKET_TYPE_RAW})
    );

    let buf = Buffer.concat([headerBytes, rawDataBlock], rawDataBlock.length + 2);

    queueAudioMessage(stream, {
      body: buf,
      timestamp
    }
    );

    stream.rtmpLastTimestamp = timestamp;

  }

  sendEOS(stream) {
    logger.debug(`[rtmp] sendEOS for stream ${stream.id}`);
    let lastTimestamp = stream.rtmpLastTimestamp != null ? stream.rtmpLastTimestamp : 0;

    let playComplete = createAMF0DataMessageParams({
      chunkStreamID: 4,
      timestamp: lastTimestamp,
      messageStreamID: 1,
      objects: [
        createAMF0Data('onPlayStatus'),
        createAMF0Object({
          level: 'status',
          code: 'NetStream.Play.Complete',
          duration: 0,
          bytes: 0
        }),
      ]});

    let playStop = createAMF0CommandMessageParams({
      chunkStreamID: 4,  // 5?
      timestamp: lastTimestamp,
      messageStreamID: 1,
      command: 'onStatus',
      transactionID: 0,
      objects: [
        createAMF0Data(null),
        createAMF0Object({
          level: 'status',
          code: 'NetStream.Play.Stop',
          description: `Stopped playing ${stream.id}.`,
          clientid: this.clientid,
          reason: '',
          details: stream.id
        })
      ]});

    let streamEOF1 = {
      chunkStreamID: 2,
      timestamp: 0,
      messageTypeID: 0x04,  // User Control Message
      messageStreamID: 0,
      body: new Buffer([
        // Stream EOF (see 7.1.7. User Control Message Events)
        0, 1,
        // Stream ID of the stream that reaches EOF
        0, 0, 0, 1
      ])
    };

    return queueRTMPMessages(stream, [ playComplete, playStop, streamEOF1 ], {
      forceFlush: true,
      hasControlMessage: true
    }
    );
  }

  handleRTMPTRequest(req, callback) {
    // /fcs/ident2 will be handled in another place
    let match;
    if ((match = /^\/([^/]+)\/([^/]+)(?:\/([^\/]+))?/.exec(req.uri)) != null) {
      let session;
      let command = match[1];
      let client = match[2];
      let index = match[3];
      if ((index == null)) {
        index = client;
      }
      if ((command === 'fcs') && (index === 'ident2')) {
        let response = `\
HTTP/1.1 400 RTMPT command /fcs/ident2 is not supported
Cache-Control: no-cache
Content-Type: text/plain
Content-Length: 0
Connection: keep-alive

\
`.replace(/\n/g, '\r\n');
        return callback(null, response);
      } else if (command === 'open') {
        session = new RTMPTSession(req.socket, (function() {
          rtmptSessions[session.id] = session;
          rtmptSessionsCount++;
          session.respondOpen(req, callback);
          return this.dumpSessions();
        }.bind(this)));
        session.on('video_start', (...args) => {
          return this.emit('video_start', ...args);
        }
        );
        session.on('audio_start', (...args) => {
          return this.emit('audio_start', ...args);
        }
        );
        session.on('video_data', (...args) => {
          return this.emit('video_data', ...args);
        }
        );
        return session.on('audio_data', (...args) => {
          return this.emit('audio_data', ...args);
        }
        );
      } else if (command === 'idle') {
        session = rtmptSessions[client];
        if (session != null) {
          // TODO: Do we have to sort requests by index?
          index = parseInt(index);
          session.respondIdle(req, callback);
          if (session.requestBuffer != null) {
            return session.requestBuffer.nextIndex = index + 1;
          } else {
            return session.requestBuffer = {
              nextIndex: index + 1,
              reqs: []
            };
          }
        } else {
          return callback(new Error("No such session"));
        }
      } else if (command === 'send') {
        session = rtmptSessions[client];
        if (session != null) {
          index = parseInt(index);
          if (session.requestBuffer != null) {
            let info;
            if (index > session.requestBuffer.nextIndex) {
              // If HTTP-tunneling (RTMPT or RTMPTE) is used, Flash Player
              // may send requests in parallel using multiple connections.
              // So we have to buffer and sort the requests.
              session.requestBuffer.reqs.push({
                req,
                index,
                callback
              });
              session.requestBuffer.reqs.sort((a, b) => a.index - b.index);
            } else if (index === session.requestBuffer.nextIndex) {
              session.respondSend(req, callback);
              session.requestBuffer.nextIndex = index + 1;
            } else {
              logger.warn(`[rtmpt] received stale request: ${index}`);
            }

            // Discard old requests
            if ((session.requestBuffer.reqs.length > 0) &&
            ((index - session.requestBuffer.reqs[0].index) > RTMPT_SEND_REQUEST_BUFFER_SIZE)) {
                info = session.requestBuffer.reqs[0];
                if (info.index === (session.requestBuffer.nextIndex + 1)) {
                  logger.warn(`[rtmpt] discarded lost request: ${session.requestBuffer.nextIndex}`);
                } else {
                  logger.warn(`[rtmpt] discarded lost requests: ${session.requestBuffer.nextIndex}-${info.index-1}`);
                }
                session.requestBuffer.nextIndex = info.index;
              }

            // Consume buffered requests
            return (() => {
              let result = [];
              while ((session.requestBuffer.reqs.length > 0) &&
            (session.requestBuffer.reqs[0].index === session.requestBuffer.nextIndex)) {
                info = session.requestBuffer.reqs.shift();
                // TODO: Call respondSend with setImmediate()?
                session.respondSend(info.req, info.callback);
                result.push(session.requestBuffer.nextIndex = info.index + 1);
              }
              return result;
            })();
          } else {
            // TODO: Does index start at zero?
            session.requestBuffer = {
              nextIndex: index + 1,
              reqs: []
            };
            return session.respondSend(req, callback);
          }
        } else {
          return callback(new Error("No such session"));
        }
      } else if (command === 'close') {
        session = rtmptSessions[client];
        if (session != null) {
          return session.respondClose(req, callback);
        } else {
          return callback(new Error("No such session"));
        }
      } else {
        return callback(new Error(`Unknown command: ${command}`));
      }
    } else {
      return callback(new Error(`Unknown URI: ${req.uri}`));
    }
  }
}

// Generate a new sessionID without collision
var generateNewSessionID = callback =>
  generateSessionID(function(err, sid) {
    if (err) {
      callback(err);
      return;
    }
    if (rtmptSessions[sid] != null) {
      return generateNewSessionID(callback);
    } else {
      return callback(null, sid);
    }
  })
;

// Generate a new random session ID
// NOTE: Session ID must be 31 characters or less
var generateSessionID = callback =>
  crypto.randomBytes(16, function(err, buf) {
    if (err) {
      return callback(err);
    } else {
      let sid = buf.toString('hex').slice(0, 31);
      return callback(null, sid);
    }
  })
;

class RTMPTSession {
  constructor(socket, callback) {
    this.creationDate = new Date;  // for debug
    this.eventListeners = {};
    this.socket = socket;
    this.pollingDelay = 1;
    this.pendingResponses = [];
    this.requestBuffer = null;
    this.rtmpSession = new RTMPSession(socket);
    this.rtmpSession.on('data', data => {
      this.scheduleTimeout();
      return this.pendingResponses.push(data);
    }
    );
    this.rtmpSession.on('video_start', (...args) => {
      return this.emit('video_start', ...args);
    }
    );
    this.rtmpSession.on('audio_start', (...args) => {
      return this.emit('audio_start', ...args);
    }
    );
    this.rtmpSession.on('video_data', (...args) => {
      return this.emit('video_data', ...args);
    }
    );
    this.rtmpSession.on('audio_data', (...args) => {
      return this.emit('audio_data', ...args);
    }
    );
    this.rtmpSession.on('teardown', () => {
      logger.info(`[rtmpt:${this.rtmpSession.clientid}] received teardown`);
      return this.close();
    }
    );
    generateNewSessionID((err, sid) => {
      if (err) {
        return callback(err);
      } else {
        this.id = sid;
        this.socket.rtmptClientID = this.id;
        this.scheduleTimeout();
        return (typeof callback === 'function' ? callback(null) : undefined);
      }
    }
    );
  }

  toString() {
    return `${this.id}: rtmp_session=${this.rtmpSession.clientid} created_at=${this.creationDate}`;
  }

  on(event, listener) {
    if (this.eventListeners[event] != null) {
      this.eventListeners[event].push(listener);
    } else {
      this.eventListeners[event] = [ listener ];
    }
  }

  emit(event, ...args) {
    if (this.eventListeners[event] != null) {
      for (let listener of Array.from(this.eventListeners[event])) {
        listener(...args);
      }
    }
  }

  clearTimeout() {
    if (this.timeoutTimer != null) {
      clearTimeout(this.timeoutTimer);
      return this.timeoutTimer = null;
    }
  }

  scheduleTimeout() {
    if (this.isClosed) {
      return;
    }
    this.clearTimeout();
    this.lastTimeoutScheduledTime = Date.now();
    return this.timeoutTimer = setTimeout(() => {
      if (this.isClosed) {
        return;
      }
      if ((this.timeoutTimer == null)) {
        return;
      }
      if ((Date.now() - this.lastTimeoutScheduledTime) < config.rtmptSessionTimeoutMs) {
        return;
      }
      logger.info(`[rtmpt] session timeout: ${this.id}`);
      return this.close();
    }
    , config.rtmptSessionTimeoutMs);
  }

  close() {
    if (this.isClosed) {
      // already closed
      return;
    }
    logger.info(`[rtmpt:${this.rtmpSession.clientid}] close`);
    this.isClosed = true;
    this.clearTimeout();
    if (this.rtmpSession != null) {
      this.rtmpSession.teardown();
      this.rtmpSession = null;
    }
    if (rtmptSessions[this.id] != null) {
      delete rtmptSessions[this.id];
      return rtmptSessionsCount--;
    }
  }

  createHTTPResponse(buf) {
    let contentLength;
    this.scheduleTimeout();
    if (buf != null) {
      contentLength = buf.length;
    } else {
      contentLength = 0;
    }
    let header = `\
HTTP/1.1 200 OK
Cache-Control: no-cache
Content-Length: ${contentLength}
Connection: keep-alive
Content-Type: application/x-fcs

\
`.replace(/\n/g, '\r\n');
    let allBytes = new Buffer(header, 'utf8');
    if (buf != null) {
      allBytes = Buffer.concat([allBytes, buf], allBytes.length + buf.length);
    }
    return allBytes;
  }

  respondOpen(req, callback) {
    this.scheduleTimeout();
    let body = this.id + '\n';
    let bodyBytes = new Buffer(body, 'utf8');
    return callback(null, this.createHTTPResponse(bodyBytes));
  }

  respondIdle(req, callback) {
    this.scheduleTimeout();
    let bufs = [
      new Buffer([ this.pollingDelay ])
    ];
    let totalLength = 1;
    for (let resp of Array.from(this.pendingResponses)) {
      bufs.push(resp);
      totalLength += resp.length;
    }
    this.pendingResponses = [];
    let allBytes = Buffer.concat(bufs, totalLength);
    return callback(null, this.createHTTPResponse(allBytes));
  }

  respondSend(req, callback) {
    this.scheduleTimeout();
    return this.rtmpSession.handleData(req.rawbody, (err, output) => {
      let allBytes;
      if (err) {
        logger.error(`[rtmpt:send-resp] Error: ${err}`);
        return callback(err);
      } else if (output != null) {
        let interval = new Buffer([ this.pollingDelay ]);
        allBytes = Buffer.concat([interval, output], 1 + output.length);
        return callback(null, this.createHTTPResponse(allBytes));
      } else {
        // No response from me
        allBytes = new Buffer([ this.pollingDelay ]);
        return callback(null, this.createHTTPResponse(allBytes));
      }
    }
    );
  }

  respondClose(req, callback) {
    let allBytes = new Buffer([ this.pollingDelay ]);
    this.close();
    return callback(null, this.createHTTPResponse(allBytes));
  }
}

let api =
  {RTMPServer};

export default api;

function __guard__(value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined;
}