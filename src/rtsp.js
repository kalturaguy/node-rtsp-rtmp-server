// RTSP/HTTP/RTMPT hybrid server
//
// RTSP spec:
//   RFC 2326  http://www.ietf.org/rfc/rfc2326.txt

// TODO: clear old sessioncookies

import net from 'net';
import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';
import url from 'url';
import Sequent from 'sequent';

import rtp from './rtp';
import sdp from './sdp';
import h264 from './h264';
import aac from './aac';
import http from './http';
import avstreams from './avstreams';
import Bits from './bits';
import logger from './logger';
import config from './config';

let enabledFeatures = [];
if (config.enableRTSP) {
  enabledFeatures.push('rtsp');
}
if (config.enableHTTP) {
  enabledFeatures.push('http');
}
if (config.enableRTMPT) {
  enabledFeatures.push('rtmpt');
}
const TAG = enabledFeatures.join('/');

// Default server name for RTSP and HTTP responses
let DEFAULT_SERVER_NAME = 'node-rtsp-rtmp-server';

// Start playing from keyframe
let ENABLE_START_PLAYING_FROM_KEYFRAME = false;

// Maximum single NAL unit size
let SINGLE_NAL_UNIT_MAX_SIZE = 1358;

let DAY_NAMES = [
  'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
];

let MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// If true, RTSP requests/response will be printed to the console
let DEBUG_RTSP = false;
let DEBUG_RTSP_HEADERS_ONLY = false;

// If true, outgoing video/audio packets are printed to the console
let DEBUG_OUTGOING_PACKET_DATA = false;

// If true, outgoing RTCP packets (sender reports) are printed to the console
let DEBUG_OUTGOING_RTCP = false;

// If true, RTSP requests/responses tunneled in HTTP will be
// printed to the console
let DEBUG_HTTP_TUNNEL = false;

// If true, UDP transport will always be disabled and
// clients will be forced to use TCP transport.
let DEBUG_DISABLE_UDP_TRANSPORT = false;

// Two CRLFs
let CRLF_CRLF = [ 0x0d, 0x0a, 0x0d, 0x0a ];

let TIMESTAMP_ROUNDOFF = 4294967296;  // 32 bits

if (DEBUG_OUTGOING_PACKET_DATA) {
  logger.enableTag('rtsp:out');
}

let zeropad = function(columns, num) {
  num += '';
  while (num.length < columns) {
    num = `0${num}`;
  }
  return num;
};

let pad = function(digits, n) {
  n = n + '';
  while (n.length < digits) {
    n = `0${n}`;
  }
  return n;
};

// Generate new random session ID
// NOTE: Samsung SC-02B doesn't work with some hex string
let generateNewSessionID = function(callback) {
  let id = '';
  for (let i = 0; i <= 7; i++) {
    id += parseInt(Math.random() * 9) + 1;
  }
  return callback(null, id);
};

// Generate random 32 bit unsigned integer.
// Return value is intended to be used as an SSRC identifier.
let generateRandom32 = function() {
  let str = `${new Date().getTime()}${process.pid}${os.hostname()}` + 
        (1 + (Math.random() * 1000000000));

  let md5sum = crypto.createHash('md5');
  md5sum.update(str);
  return md5sum.digest().slice(0, 4).readUInt32BE(0);
};

let resetStreamParams = function(stream) {
  stream.rtspUploadingClient = null;
  stream.videoSequenceNumber = 0;
  stream.audioSequenceNumber = 0;
  stream.lastVideoRTPTimestamp = null;
  stream.lastAudioRTPTimestamp = null;
  stream.videoRTPTimestampInterval = Math.round(90000 / stream.videoFrameRate);
  return stream.audioRTPTimestampInterval = stream.audioPeriodSize;
};

avstreams.on('update_frame_rate', (stream, frameRate) => stream.videoRTPTimestampInterval = Math.round(90000 / frameRate));

avstreams.on('new', function(stream) {
  stream.rtspNumClients = 0;
  stream.rtspClients = {};
  return resetStreamParams(stream);
});

avstreams.on('reset', stream => resetStreamParams(stream));

class RTSPServer {
  constructor(opts) {
    let calculatedPTS, sendTime, stream;
    this.httpHandler = opts.httpHandler;
    this.rtmpServer = opts.rtmpServer;
    this.rtmptCallback = opts.rtmptCallback;

    this.numClients = 0;

    this.eventListeners = {};
    this.serverName = (opts != null ? opts.serverName : undefined) != null ? (opts != null ? opts.serverName : undefined) : DEFAULT_SERVER_NAME;
    this.port = (opts != null ? opts.port : undefined) != null ? (opts != null ? opts.port : undefined) : 8080;
    this.clients = {};
    this.httpSessions = {};
    this.rtspUploadingClients = {};
    this.highestClientID = 0;

    this.rtpParser = new rtp.RTPParser;

    this.rtpParser.on('h264_nal_units', (streamId, nalUnits, rtpTimestamp) => {
      stream = avstreams.get(streamId);
      if ((stream == null)) {  // No matching stream
        logger.warn(`warn: No matching stream to id ${streamId}`);
        return;
      }

      if ((stream.rtspUploadingClient == null)) {
        // No uploading client associated with the stream
        logger.warn(`warn: No uploading client associated with the stream ${stream.id}`);
        return;
      }
      sendTime = this.getVideoSendTimeForUploadingRTPTimestamp(stream, rtpTimestamp);
      calculatedPTS = rtpTimestamp - stream.rtspUploadingClient.videoRTPStartTimestamp;
      return this.emit('video', stream, nalUnits, calculatedPTS, calculatedPTS);
    }
    );

    this.rtpParser.on('aac_access_units', (streamId, accessUnits, rtpTimestamp) => {
      stream = avstreams.get(streamId);
      if ((stream == null)) {  // No matching stream
        logger.warn(`warn: No matching stream to id ${streamId}`);
        return;
      }

      if ((stream.rtspUploadingClient == null)) {
        // No uploading client associated with the stream
        logger.warn(`warn: No uploading client associated with the stream ${stream.id}`);
        return;
      }
      sendTime = this.getAudioSendTimeForUploadingRTPTimestamp(stream, rtpTimestamp);
      calculatedPTS = Math.round(((rtpTimestamp - stream.rtspUploadingClient.audioRTPStartTimestamp) * 90000) / stream.audioClockRate);
      // PTS may not be monotonically increased (it may not be in decoding order)
      return this.emit('audio', stream, accessUnits, calculatedPTS, calculatedPTS);
    }
    );
  }

  setServerName(name) {
    return this.serverName = name;
  }

  getNextVideoSequenceNumber(stream) {
    let num = stream.videoSequenceNumber + 1;
    if (num > 65535) {
      num -= 65535;
    }
    return num;
  }

  getNextAudioSequenceNumber(stream) {
    let num = stream.audioSequenceNumber + 1;
    if (num > 65535) {
      num -= 65535;
    }
    return num;
  }

  // TODO: Adjust RTP timestamp based on play start time
  getNextVideoRTPTimestamp(stream) {
    if (stream.lastVideoRTPTimestamp != null) {
      return stream.lastVideoRTPTimestamp + stream.videoRTPTimestampInterval;
    } else {
      return 0;
    }
  }

  // TODO: Adjust RTP timestamp based on play start time
  getNextAudioRTPTimestamp(stream) {
    if (stream.lastAudioRTPTimestamp != null) {
      return stream.lastAudioRTPTimestamp + stream.audioRTPTimestampInterval;
    } else {
      return 0;
    }
  }

  getVideoRTPTimestamp(stream, time) {
    return Math.round((time * 90) % TIMESTAMP_ROUNDOFF);
  }

  getAudioRTPTimestamp(stream, time) {
    if ((stream.audioClockRate == null)) {
      throw new Error("audioClockRate is null");
    }
    return Math.round((time * (stream.audioClockRate / 1000)) % TIMESTAMP_ROUNDOFF);
  }

  getVideoSendTimeForUploadingRTPTimestamp(stream, rtpTimestamp) {
    let videoTimestampInfo = stream.rtspUploadingClient != null ? stream.rtspUploadingClient.uploadingTimestampInfo.video : undefined;
    if (videoTimestampInfo != null) {
      let rtpDiff = rtpTimestamp - videoTimestampInfo.rtpTimestamp; // 90 kHz clock
      let timeDiff = rtpDiff / 90;
      return videoTimestampInfo.time + timeDiff;
    } else {
      return Date.now();
    }
  }

  getAudioSendTimeForUploadingRTPTimestamp(stream, rtpTimestamp) {
    let audioTimestampInfo = stream.rtspUploadingClient != null ? stream.rtspUploadingClient.uploadingTimestampInfo.audio : undefined;
    if (audioTimestampInfo != null) {
      let rtpDiff = rtpTimestamp - audioTimestampInfo.rtpTimestamp;
      let timeDiff = (rtpDiff * 1000) / stream.audioClockRate;
      return audioTimestampInfo.time + timeDiff;
    } else {
      return Date.now();
    }
  }

  // @public
  sendVideoData(stream, nalUnits, pts, dts) {
    let isSPSSent = false;
    let isPPSSent = false;
    for (let i = 0; i < nalUnits.length; i++) {
      let nalUnit = nalUnits[i];
      let isLastPacket = i === (nalUnits.length - 1);
      // detect configuration
      let nalUnitType = h264.getNALUnitType(nalUnit);
      if (config.dropH264AccessUnitDelimiter &&
      (nalUnitType === h264.NAL_UNIT_TYPE_ACCESS_UNIT_DELIMITER)) {
        // ignore access unit delimiters
        continue;
      }
      if (nalUnitType === h264.NAL_UNIT_TYPE_SPS) {  // 7
        isSPSSent = true;
      } else if (nalUnitType === h264.NAL_UNIT_TYPE_PPS) {  // 8
        isPPSSent = true;
      }

      // If this is keyframe but SPS and PPS do not exist in the
      // same timestamp, we insert them before the keyframe.
      // TODO: Send SPS and PPS as an aggregation packet (STAP-A).
      if (nalUnitType === 5) {  // keyframe
        // Compensate SPS/PPS if they are not included in nalUnits
        if (!isSPSSent) {  // nal_unit_type 7
          if (stream.spsNALUnit != null) {
            this.sendNALUnitOverRTSP(stream, stream.spsNALUnit, pts, dts, false);
            // there is a case where timestamps of two keyframes are identical
            // (i.e. nalUnits argument contains multiple keyframes)
            isSPSSent = true;
          } else {
            logger.error("Error: SPS is not set");
          }
        }
        if (!isPPSSent) {  // nal_unit_type 8
          if (stream.ppsNALUnit != null) {
            this.sendNALUnitOverRTSP(stream, stream.ppsNALUnit, pts, dts, false);
            // there is a case where timestamps of two keyframes are identical
            // (i.e. nalUnits argument contains multiple keyframes)
            isPPSSent = true;
          } else {
            logger.error("Error: PPS is not set");
          }
        }
      }

      this.sendNALUnitOverRTSP(stream, nalUnit, pts, dts, isLastPacket);
    }

  }

  sendNALUnitOverRTSP(stream, nalUnit, pts, dts, marker) {
    if (nalUnit.length >= SINGLE_NAL_UNIT_MAX_SIZE) {
      return this.sendVideoPacketWithFragment(stream, nalUnit, pts, marker);  // TODO what about dts?
    } else {
      return this.sendVideoPacketAsSingleNALUnit(stream, nalUnit, pts, marker);  // TODO what about dts?
    }
  }

  // @public
  sendAudioData(stream, accessUnits, pts, dts) {
    let timestamp;
    if ((stream.audioSampleRate == null)) {
      throw new Error(`audio sample rate has not been detected for stream ${stream.id}`);
    }

    // timestamp: RTP timestamp in audioClockRate
    // pts: PTS in 90 kHz clock
    if (stream.audioClockRate !== 90000) {  // given pts is not in 90 kHz clock
      timestamp = (pts * stream.audioClockRate) / 90000;
    } else {
      timestamp = pts;
    }

    let rtpTimePerFrame = 1024;

    if (this.numClients === 0) {
      return;
    }

    if (stream.rtspNumClients === 0) {
      // No clients connected to the stream
      return;
    }

    let frameGroups = rtp.groupAudioFrames(accessUnits);
    let processedFrames = 0;
    for (let i = 0; i < frameGroups.length; i++) {
      let group = frameGroups[i];
      let concatRawDataBlock = Buffer.concat(group);

      if (++stream.audioSequenceNumber > 65535) {
        stream.audioSequenceNumber -= 65535;
      }

      let ts = Math.round((timestamp + (rtpTimePerFrame * processedFrames)) % TIMESTAMP_ROUNDOFF);
      processedFrames += group.length;
      stream.lastAudioRTPTimestamp = (timestamp + (rtpTimePerFrame * processedFrames)) % TIMESTAMP_ROUNDOFF;

      // TODO dts
      let rtpData = rtp.createRTPHeader({
        marker: true,
        payloadType: 96,
        sequenceNumber: stream.audioSequenceNumber,
        timestamp: ts,
        ssrc: null
      });

      let accessUnitLength = concatRawDataBlock.length;

      // TODO: maximum size of AAC-hbr is 8191 octets
      // TODO: sequence number should start at a random number

      let audioHeader = rtp.createAudioHeader({
        accessUnits: group});

      rtpData = rtpData.concat(audioHeader);

      // Append the access unit (rawDataBlock)
      let rtpBuffer = Buffer.concat([new Buffer(rtpData), concatRawDataBlock],
        rtp.RTP_HEADER_LEN + audioHeader.length + accessUnitLength);

      for (let clientID in stream.rtspClients) {
        let client = stream.rtspClients[clientID];
        if (client.isPlaying) {
          rtp.replaceSSRCInRTP(rtpBuffer, client.audioSSRC);

          client.audioPacketCount++;
          client.audioOctetCount += accessUnitLength;
          logger.tag('rtsp:out', `[rtsp:stream:${stream.id}] send audio to ${client.id}: ts=${ts} pts=${pts}`);
          if (client.useTCPForAudio) {
            if (client.useHTTP) {
              if (client.httpClientType === 'GET') {
                this.sendDataByTCP(client.socket, client.audioTCPDataChannel, rtpBuffer);
              }
            } else {
              this.sendDataByTCP(client.socket, client.audioTCPDataChannel, rtpBuffer);
            }
          } else {
            if (client.clientAudioRTPPort != null) {
              this.audioRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientAudioRTPPort, client.ip, function(err, bytes) {
                if (err) {
                  return logger.error(`[audioRTPSend] error: ${err.message}`);
                }
              });
            }
          }
        }
      }
    }
  }

  sendEOS(stream) {
    return (() => {
      let result = [];
      for (let clientID in stream.rtspClients) {
        let client = stream.rtspClients[clientID];
        let item;
        logger.debug(`[${TAG}:client=${clientID}] sending goodbye for stream ${stream.id}`);
        let buf = new Buffer(rtp.createGoodbye({
          ssrcs: [ client.videoSSRC ]}));
        if (client.useTCPForVideo) {
          if (client.useHTTP) {
            if (client.httpClientType === 'GET') {
              this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
            }
          } else {
            this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
          }
        } else {
          if (client.clientVideoRTCPPort != null) {
            this.videoRTCPSocket.send(buf, 0, buf.length, client.clientVideoRTCPPort, client.ip, function(err, bytes) {
              if (err) {
                return logger.error(`[videoRTCPSend] error: ${err.message}`);
              }
            });
          }
        }

        buf = new Buffer(rtp.createGoodbye({
          ssrcs: [ client.audioSSRC ]}));
        if (client.useTCPForAudio) {
          if (client.useHTTP) {
            if (client.httpClientType === 'GET') {
              item = this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf);
            }
          } else {
            item = this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf);
          }
        } else {
          if (client.clientAudioRTCPPort != null) {
            item = this.audioRTCPSocket.send(buf, 0, buf.length, client.clientAudioRTCPPort, client.ip, function(err, bytes) {
              if (err) {
                return logger.error(`[audioRTCPSend] error: ${err.message}`);
              }
            });
          }
        }
        result.push(item);
      }
      return result;
    })();
  }

  dumpClients() {
    logger.raw(`[rtsp/http: ${Object.keys(this.clients).length} clients]`);
    for (let clientID in this.clients) {
      let client = this.clients[clientID];
      logger.raw(` ${client.toString()}`);
    }
  }

  setLivePathConsumer(func) {
    return this.livePathConsumer = func;
  }

  start(opts, callback) {
    let addr, stream;
    let serverPort = (opts != null ? opts.port : undefined) != null ? (opts != null ? opts.port : undefined) : this.port;

    this.videoRTPSocket = dgram.createSocket('udp4');
    this.videoRTPSocket.bind(config.videoRTPServerPort);
    this.videoRTCPSocket = dgram.createSocket('udp4');
    this.videoRTCPSocket.bind(config.videoRTCPServerPort);

    this.audioRTPSocket = dgram.createSocket('udp4');
    this.audioRTPSocket.bind(config.audioRTPServerPort);
    this.audioRTCPSocket = dgram.createSocket('udp4');
    this.audioRTCPSocket.bind(config.audioRTCPServerPort);

    this.server = net.createServer(c => {
      // New client is connected
      this.highestClientID++;
      let id_str = `c${this.highestClientID}`;
      logger.info(`[${TAG}:client=${id_str}] connected`);
      return generateNewSessionID((err, sessionID) => {
        if (err) { throw err; }
        let client = this.clients[id_str] = new RTSPClient({
          id: id_str,
          sessionID,
          socket: c,
          ip: c.remoteAddress
        });
        this.numClients++;
        c.setKeepAlive(true, 120000);
        c.clientID = id_str;  // TODO: Is this safe?
        c.isAuthenticated = false;
        c.requestCount = 0;
        c.responseCount = 0;
        c.on('close', () => {
          logger.info(`[${TAG}:client=${id_str}] disconnected`);
          logger.debug(`[${TAG}:client=${id_str}] teardown: session=${sessionID}`);
          try {
            c.end();
          } catch (e) {
            logger.error(`socket.end() error: ${e}`);
          }

          delete this.clients[id_str];
          this.numClients--;
          api.leaveClient(client);
          this.stopSendingRTCP(client);

          // TODO: Is this fast enough?
          for (addr in this.rtspUploadingClients) {
            let _client = this.rtspUploadingClients[addr];
            if (_client === client) {
              delete this.rtspUploadingClients[addr];
            }
          }

          return this.dumpClients();
        }
        );
        c.buf = null;
        c.on('error', function(err) {
          logger.error(`Socket error (${c.clientID}): ${err}`);
          return c.destroy();
        });
        return c.on('data', data => {
          return this.handleOnData(c, data);
        }
        );
      }
      );
    }
    );

    this.server.on('error', err => logger.error(`[${TAG}] server error: ${err.message}`));

    let udpVideoDataServer = dgram.createSocket('udp4');
    udpVideoDataServer.on('error', function(err) {
      logger.error(`[${TAG}] udp video data receiver error: ${err.message}`);
      throw err;
    });
    udpVideoDataServer.on('message', (msg, rinfo) => {
      stream = this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'video-data');
      if (stream != null) {
        return this.onUploadVideoData(stream, msg, rinfo);
      }
    }
    );
//      else
//        logger.warn "[#{TAG}] warn: received UDP video data but no existing client found: #{rinfo.address}:#{rinfo.port}"
    udpVideoDataServer.on('listening', function() {
      addr = udpVideoDataServer.address();
      return logger.debug(`[${TAG}] udp video data receiver is listening on port ${addr.port}`);
    });
    udpVideoDataServer.bind(config.rtspVideoDataUDPListenPort);

    let udpVideoControlServer = dgram.createSocket('udp4');
    udpVideoControlServer.on('error', function(err) {
      logger.error(`[${TAG}] udp video control receiver error: ${err.message}`);
      throw err;
    });
    udpVideoControlServer.on('message', (msg, rinfo) => {
      stream = this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'video-control');
      if (stream != null) {
        return this.onUploadVideoControl(stream, msg, rinfo);
      }
    }
    );
//      else
//        logger.warn "[#{TAG}] warn: received UDP video control data but no existing client found: #{rinfo.address}:#{rinfo.port}"
    udpVideoControlServer.on('listening', function() {
      addr = udpVideoControlServer.address();
      return logger.debug(`[${TAG}] udp video control receiver is listening on port ${addr.port}`);
    });
    udpVideoControlServer.bind(config.rtspVideoControlUDPListenPort);

    let udpAudioDataServer = dgram.createSocket('udp4');
    udpAudioDataServer.on('error', function(err) {
      logger.error(`[${TAG}] udp audio data receiver error: ${err.message}`);
      throw err;
    });
    udpAudioDataServer.on('message', (msg, rinfo) => {
      stream = this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'audio-data');
      if (stream != null) {
        return this.onUploadAudioData(stream, msg, rinfo);
      }
    }
    );
//      else
//        logger.warn "[#{TAG}] warn: received UDP audio data but no existing client found: #{rinfo.address}:#{rinfo.port}"
    udpAudioDataServer.on('listening', function() {
      addr = udpAudioDataServer.address();
      return logger.debug(`[${TAG}] udp audio data receiver is listening on port ${addr.port}`);
    });
    udpAudioDataServer.bind(config.rtspAudioDataUDPListenPort);

    let udpAudioControlServer = dgram.createSocket('udp4');
    udpAudioControlServer.on('error', function(err) {
      logger.error(`[${TAG}] udp audio control receiver error: ${err.message}`);
      throw err;
    });
    udpAudioControlServer.on('message', (msg, rinfo) => {
      stream = this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'audio-control');
      if (stream != null) {
        return this.onUploadAudioControl(stream, msg, rinfo);
      }
    }
    );
//      else
//        logger.warn "[#{TAG}] warn: received UDP audio control data but no existing client found: #{rinfo.address}:#{rinfo.port}"
    udpAudioControlServer.on('listening', function() {
      addr = udpAudioControlServer.address();
      return logger.debug(`[${TAG}] udp audio control receiver is listening on port ${addr.port}`);
    });
    udpAudioControlServer.bind(config.rtspAudioControlUDPListenPort);

    logger.debug(`[${TAG}] starting server on port ${serverPort}`);
    return this.server.listen(serverPort, '0.0.0.0', 511, () => {
      logger.info(`[${TAG}] server started on port ${serverPort}`);
      return (typeof callback === 'function' ? callback() : undefined);
    }
    );
  }

  stop(callback) {
    return (this.server != null ? this.server.close(callback) : undefined);
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

  // rtsp://localhost:80/live/a -> live/a
  // This method returns null if no stream id is extracted from the uri
  static getStreamIdFromUri(uri, removeDepthFromEnd) {
    let pathname;
    if (removeDepthFromEnd == null) { removeDepthFromEnd = 0; }
    try {
      ({ pathname } = url.parse(uri));
    } catch (e) {
      return null;
    }

    if ((pathname != null) && (pathname.length > 0)) {
      // Remove leading slash
      pathname = pathname.slice(1);

      // Remove trailing slash
      if (pathname[pathname.length-1] === '/') {
        pathname = pathname.slice(0, +pathname.length-2 + 1 || undefined);
      }

      // Go up directories if removeDepthFromEnd is specified
      while (removeDepthFromEnd > 0) {
        let slashPos = pathname.lastIndexOf('/');
        if (slashPos === -1) {
          break;
        }
        pathname = pathname.slice(0, slashPos);
        removeDepthFromEnd--;
      }
    }

    return pathname;
  }

  getStreamByRTSPUDPAddress(addr, port, channelType) {
    let client = this.rtspUploadingClients[addr + ':' + port];
    if (client != null) {
      return client.uploadingStream;
    }
    return null;
  }

  getStreamByUri(uri) {
    let streamId = RTSPServer.getStreamIdFromUri(uri);
    if (streamId != null) {
      return avstreams.get(streamId);
    } else {
      return null;
    }
  }

  sendVideoSenderReport(stream, client) {
    if ((stream.timeAtVideoStart == null)) {
      return;
    }

    let time = new Date().getTime();
    let rtpTime = this.getVideoRTPTimestamp(stream, time - stream.timeAtVideoStart);
    if (DEBUG_OUTGOING_RTCP) {
      logger.info(`video sender report: rtpTime=${rtpTime} time=${time} timeAtVideoStart=${stream.timeAtVideoStart}`);
    }
    let buf = new Buffer(rtp.createSenderReport({
      time,
      rtpTime,
      ssrc: client.videoSSRC,
      packetCount: client.videoPacketCount,
      octetCount: client.videoOctetCount
    })
    );

    if (client.useTCPForVideo) {
      if (client.useHTTP) {
        if (client.httpClientType === 'GET') {
          return this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
        }
      } else {
        return this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
      }
    } else {
      if (client.clientVideoRTCPPort != null) {
        return this.videoRTCPSocket.send(buf, 0, buf.length, client.clientVideoRTCPPort, client.ip, function(err, bytes) {
          if (err) {
            return logger.error(`[videoRTCPSend] error: ${err.message}`);
          }
        });
      }
    }
  }

  sendAudioSenderReport(stream, client) {
    if ((stream.timeAtAudioStart == null)) {
      return;
    }

    let time = new Date().getTime();
    let rtpTime = this.getAudioRTPTimestamp(stream, time - stream.timeAtAudioStart);
    if (DEBUG_OUTGOING_RTCP) {
      logger.info(`audio sender report: rtpTime=${rtpTime} time=${time} timeAtAudioStart=${stream.timeAtAudioStart}`);
    }
    let buf = new Buffer(rtp.createSenderReport({
      time,
      rtpTime,
      ssrc: client.audioSSRC,
      packetCount: client.audioPacketCount,
      octetCount: client.audioOctetCount
    })
    );

    if (client.useTCPForAudio) {
      if (client.useHTTP) {
        if (client.httpClientType === 'GET') {
          return this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf);
        }
      } else {
        return this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf);
      }
    } else {
      if (client.clientAudioRTCPPort != null) {
        return this.audioRTCPSocket.send(buf, 0, buf.length, client.clientAudioRTCPPort, client.ip, function(err, bytes) {
          if (err) {
            return logger.error(`[audioRTCPSend] error: ${err.message}`);
          }
        });
      }
    }
  }

  stopSendingRTCP(client) {
    if (client.timeoutID != null) {
      clearTimeout(client.timeoutID);
      return client.timeoutID = null;
    }
  }

  // Send RTCP sender report packets for audio and video streams
  sendSenderReports(stream, client) {
    if ((this.clients[client.id] == null)) {  // client socket is already closed
      this.stopSendingRTCP(client);
      return;
    }

    if (stream.isAudioStarted) {
      this.sendAudioSenderReport(stream, client);
    }
    if (stream.isVideoStarted) {
      this.sendVideoSenderReport(stream, client);
    }

    return client.timeoutID = setTimeout(() => {
      return this.sendSenderReports(stream, client);
    }
    , config.rtcpSenderReportIntervalMs);
  }

  startSendingRTCP(stream, client) {
    this.stopSendingRTCP(client);

    return this.sendSenderReports(stream, client);
  }

  onReceiveVideoRTCP(buf) {}
    // TODO: handle BYE message

  onReceiveAudioRTCP(buf) {}
    // TODO: handle BYE message

  sendDataByTCP(socket, channel, rtpBuffer) {
    let rtpLen = rtpBuffer.length;
    let tcpHeader = api.createInterleavedHeader({
      channel,
      payloadLength: rtpLen
    });
    return socket.write(Buffer.concat([tcpHeader, rtpBuffer],
      api.INTERLEAVED_HEADER_LEN + rtpBuffer.length)
    );
  }

  // Process incoming RTSP data that is tunneled in HTTP POST
  handleTunneledPOSTData(client, data, callback) {
    // Concatenate outstanding base64 string
    let base64Buf, decodedBuf, postData;
    if (data == null) { data = ''; }
    if (client.postBase64Buf != null) {
      base64Buf = client.postBase64Buf + data;
    } else {
      base64Buf = data;
    }

    if (base64Buf.length > 0) {
      // Length of base64-encoded string is always divisible by 4
      let div = base64Buf.length % 4;
      if (div !== 0) {
        // extract last div characters
        client.postBase64Buf = base64Buf.slice(-div);
        base64Buf = base64Buf.slice(0, -div);
      } else {
        client.postBase64Buf = null;
      }

      // Decode base64-encoded data
      decodedBuf = new Buffer(base64Buf, 'base64');
    } else {  // no base64 input
      decodedBuf = new Buffer([]);
    }

    // Concatenate outstanding buffer
    if (client.postBuf != null) {
      postData = Buffer.concat([client.postBuf, decodedBuf]);
      client.postBuf = null;
    } else {
      postData = decodedBuf;
    }

    if (postData.length === 0) {  // no data to process
      if (typeof callback === 'function') {
        callback(null);
      }
      return;
    }

    // Will be called before return
    let processRemainingBuffer = () => {
      if ((client.postBase64Buf != null) || (client.postBuf != null)) {
        this.handleTunneledPOSTData(client, '', callback);
      } else {
        if (typeof callback === 'function') {
          callback(null);
        }
      }
    };

    // TODO: Do we have to interpret interleaved data here?
    if (config.enableRTSP && (postData[0] === api.INTERLEAVED_SIGN)) {  // interleaved data
      let interleavedData = api.getInterleavedData(postData);
      if ((interleavedData == null)) {
        // not enough buffer for an interleaved data
        client.postBuf = postData;
        if (typeof callback === 'function') {
          callback(null);
        }
        return;
      }
      // At this point, postData has enough buffer for this interleaved data.

      this.onInterleavedRTPPacketFromClient(client, interleavedData);

      if (postData.length > interleavedData.totalLength) {
        client.postBuf = client.buf.slice(interleavedData.totalLength);
      }

      return processRemainingBuffer();
    } else {
      let delimiterPos = Bits.searchBytesInArray(postData, CRLF_CRLF);
      if (delimiterPos === -1) {  // not found (not enough buffer)
        client.postBuf = postData;
        if (typeof callback === 'function') {
          callback(null);
        }
        return;
      }

      let decodedRequest = postData.slice(0, delimiterPos).toString('utf8');
      let remainingPostData = postData.slice(delimiterPos+CRLF_CRLF.length);
      let req = http.parseRequest(decodedRequest);
      if ((req == null)) {  // parse error
        logger.error(`Unable to parse request: ${decodedRequest}`);
        if (typeof callback === 'function') {
          callback(new Error("malformed request"));
        }
        return;
      }

      if (req.headers['content-length'] != null) {
        req.contentLength = parseInt(req.headers['content-length']);
        if (remainingPostData.length < req.contentLength) {
          // not enough buffer for the body
          client.postBuf = postData;
          if (typeof callback === 'function') {
            callback(null);
          }
          return;
        }
        if (remainingPostData.length > req.contentLength) {
          req.rawbody = remainingPostData.slice(0, req.contentLength);
          client.postBuf = remainingPostData.slice(req.contentLength);
        } else { // remainingPostData.length == req.contentLength
          req.rawbody = remainingPostData;
        }
      } else if (remainingPostData.length > 0) {
        client.postBuf = remainingPostData;
      }

      if (DEBUG_HTTP_TUNNEL) {
        logger.info("===request (HTTP tunneled/decoded)===");
        process.stdout.write(decodedRequest);
        logger.info("=============");
      }
      return this.respond(client.socket, req, function(err, output) {
        if (err) {
          logger.error(`[respond] Error: ${err}`);
          if (typeof callback === 'function') {
            callback(err);
          }
          return;
        }
        if (output != null) {
          if (DEBUG_HTTP_TUNNEL) {
            logger.info("===response (HTTP tunneled)===");
            process.stdout.write(output);
            logger.info("=============");
          }
          client.getClient.socket.write(output);
        } else {
          if (DEBUG_HTTP_TUNNEL) {
            logger.info("===empty response (HTTP tunneled)===");
          }
        }
        return processRemainingBuffer();
      });
    }
  }

//  cancelTimeout: (socket) ->
//    if socket.timeoutTimer?
//      clearTimeout socket.timeoutTimer
//
//  scheduleTimeout: (socket) ->
//    @cancelTimeout socket
//    socket.scheduledTimeoutTime = Date.now() + config.keepaliveTimeoutMs
//    socket.timeoutTimer = setTimeout =>
//      if not clients[socket.clientID]?
//        return
//      if Date.now() < socket.scheduledTimeoutTime
//        return
//      logger.info "keepalive timeout: #{socket.clientID}"
//      @teardownClient socket.clientID
//    , config.keepaliveTimeoutMs

  // Called when the server received an interleaved RTP packet
  onInterleavedRTPPacketFromClient(client, interleavedData) {
    if (client.uploadingStream != null) {
      let stream = client.uploadingStream;
      // TODO: Support multiple streams
      let senderInfo = {
        address: null,
        port: null
      };
      switch (interleavedData.channel) {
        case stream.rtspUploadingClient.uploadingChannels.videoData:
          return this.onUploadVideoData(stream, interleavedData.data, senderInfo);
        case stream.rtspUploadingClient.uploadingChannels.videoControl:
          return this.onUploadVideoControl(stream, interleavedData.data, senderInfo);
        case stream.rtspUploadingClient.uploadingChannels.audioData:
          return this.onUploadAudioData(stream, interleavedData.data, senderInfo);
        case stream.rtspUploadingClient.uploadingChannels.audioControl:
          return this.onUploadAudioControl(stream, interleavedData.data, senderInfo);
        default:
          return logger.error(`Error: unknown interleaved channel: ${interleavedData.channel}`);
      }
    }
  }
    // Discard incoming RTP packets if the client is not uploading streams

  // Called when new data comes from TCP connection
  handleOnData(c, data) {
    let buf, req;
    let id_str = c.clientID;
    if ((this.clients[id_str] == null)) {  // client socket is already closed
      logger.error(`error: invalid client ID: ${id_str}`);
      return;
    }

    let client = this.clients[id_str];
    if (client.isSendingPOST) {
      this.handleTunneledPOSTData(client, data.toString('utf8'));
      return;
    }
    if (c.buf != null) {
      c.buf = Buffer.concat([c.buf, data], c.buf.length + data.length);
    } else {
      c.buf = data;
    }
    if (c.buf[0] === api.INTERLEAVED_SIGN) { // dollar sign '$' (RFC 2326 - 10.12)
      let interleavedData = api.getInterleavedData(c.buf);
      if ((interleavedData == null)) {
        // not enough buffer for an interleaved data
        return;
      }

      // At this point, c.buf has enough buffer for this interleaved data.
      if (c.buf.length > interleavedData.totalLength) {
        c.buf = c.buf.slice(interleavedData.totalLength);
      } else {
        c.buf = null;
      }

      this.onInterleavedRTPPacketFromClient(client, interleavedData);

      if (c.buf != null) {
        // Process the remaining buffer
        // TODO: Is there more efficient way to do this?
        ({ buf } = c);
        c.buf = null;
        this.handleOnData(c, buf);
      }

      return;
    }
    if (c.ongoingRequest != null) {
      req = c.ongoingRequest;
      req.rawbody = Buffer.concat([req.rawbody, data], req.rawbody.length + data.length);
      if (req.rawbody.length < req.contentLength) {
        return;
      }
      req.socket = c;
      if (req.rawbody.length > req.contentLength) {
        c.buf = req.rawbody.slice(req.contentLength);
        req.rawbody = req.rawbody.slice(0, req.contentLength);
      } else {
        c.buf = null;
      }
      req.body = req.rawbody.toString('utf8');
      if (DEBUG_RTSP) {
        logger.info(`===RTSP/HTTP request (cont) from ${id_str}===`);
        if (DEBUG_RTSP_HEADERS_ONLY) {
          logger.info("(redacted)");
        } else {
          process.stdout.write(data.toString('utf8'));
        }
        logger.info("==================");
      }
    } else {
      let bufString = c.buf.toString('utf8');
      if (bufString.indexOf('\r\n\r\n') === -1) {
        return;
      }
      if (DEBUG_RTSP) {
        logger.info(`===RTSP/HTTP request from ${id_str}===`);
        if (DEBUG_RTSP_HEADERS_ONLY) {
          process.stdout.write(bufString.replace(/\r\n\r\n[\s\S]*/, '\n'));
        } else {
          process.stdout.write(bufString);
        }
        logger.info("==================");
      }
      req = http.parseRequest(bufString);
      if ((req == null)) {
        logger.error(`Unable to parse request: ${bufString}`);
        c.buf = null;
        return;
      }
      req.rawbody = c.buf.slice(req.headerBytes+4);
      req.socket = c;
      if (req.headers['content-length'] != null) {
        if (req.headers['content-type'] === 'application/x-rtsp-tunnelled') {
          // If HTTP tunneling is used, we have to ignore content-length.
          req.contentLength = 0;
        } else {
          req.contentLength = parseInt(req.headers['content-length']);
        }
        if (req.rawbody.length < req.contentLength) {
          c.ongoingRequest = req;
          return;
        }
        if (req.rawbody.length > req.contentLength) {
          c.buf = req.rawbody.slice(req.contentLength);
          req.rawbody = req.rawbody.slice(0, req.contentLength);
        } else {
          c.buf = null;
        }
      } else {
        if (req.rawbody.length > 0) {
          c.buf = req.rawbody;
        } else {
          c.buf = null;
        }
      }
    }
    c.ongoingRequest = null;
    return this.respond(c, req, (err, output, resultOpts) => {
      if (err) {
        logger.error(`[respond] Error: ${err}`);
        return;
      }
      if (output != null) {
        // Write the response
        if (DEBUG_RTSP) {
          logger.info(`===RTSP/HTTP response to ${id_str}===`);
        }
        if (output instanceof Array) {
          for (let i = 0; i < output.length; i++) {
            let out = output[i];
            if (DEBUG_RTSP) {
              logger.info(out);
            }
            c.write(out);
          }
        } else {
          if (DEBUG_RTSP) {
            if (DEBUG_RTSP_HEADERS_ONLY) {
              let headerBytes;
              let delimPos = Bits.searchBytesInArray(output, [ 0x0d, 0x0a, 0x0d, 0x0a ]);
              if (delimPos !== -1) {
                headerBytes = output.slice(0, +delimPos+1 + 1 || undefined);
              } else {
                headerBytes = output;
              }
              process.stdout.write(headerBytes);
            } else {
              process.stdout.write(output);
            }
          }
          c.write(output);
        }
        if (DEBUG_RTSP) {
          logger.info("===================");
        }
      } else {
        if (DEBUG_RTSP) {
          logger.info(`===RTSP/HTTP empty response to ${id_str}===`);
        }
      }
      if (resultOpts != null ? resultOpts.close : undefined) {
        // Half-close the socket
        c.end();
      }
      if (c.buf != null) {
        // Process the remaining buffer
        ({ buf } = c);
        c.buf = null;
        return this.handleOnData(c, buf);
      }
    }
    );
  }

  sendVideoPacketWithFragment(stream, nalUnit, timestamp, marker) {
    let client, clientID, rtpBuffer, rtpData;
    if (marker == null) { marker = true; }
    let ts = timestamp % TIMESTAMP_ROUNDOFF;
    stream.lastVideoRTPTimestamp = ts;

    if (this.numClients === 0) {
      return;
    }

    if (stream.rtspNumClients === 0) {
      // No clients connected to the stream
      return;
    }

    let nalUnitType = nalUnit[0] & 0x1f;
    let isKeyFrame = nalUnitType === 5;
    let nal_ref_idc = nalUnit[0] & 0b01100000;  // skip ">> 5" operation

    nalUnit = nalUnit.slice(1);

    let fragmentNumber = 0;
    while (nalUnit.length > SINGLE_NAL_UNIT_MAX_SIZE) {
      if (++stream.videoSequenceNumber > 65535) {
        stream.videoSequenceNumber -= 65535;
      }

      fragmentNumber++;
      let thisNalUnit = nalUnit.slice(0, SINGLE_NAL_UNIT_MAX_SIZE);
      nalUnit = nalUnit.slice(SINGLE_NAL_UNIT_MAX_SIZE);

      // TODO: sequence number should start at a random number
      rtpData = rtp.createRTPHeader({
        marker: false,
        payloadType: 97,
        sequenceNumber: stream.videoSequenceNumber,
        timestamp: ts,
        ssrc: null
      });

      rtpData = rtpData.concat(rtp.createFragmentationUnitHeader({
        nal_ref_idc,
        nal_unit_type: nalUnitType,
        isStart: fragmentNumber === 1,
        isEnd: false
      })
      );

      // Append NAL unit
      let thisNalUnitLen = thisNalUnit.length;
      rtpBuffer = Buffer.concat([new Buffer(rtpData), thisNalUnit],
        rtp.RTP_HEADER_LEN + 2 + thisNalUnitLen);

      for (clientID in stream.rtspClients) {
        client = stream.rtspClients[clientID];
        if (client.isWaitingForKeyFrame && isKeyFrame) {
          client.isPlaying = true;
          client.isWaitingForKeyFrame = false;
        }

        if (client.isPlaying) {
          rtp.replaceSSRCInRTP(rtpBuffer, client.videoSSRC);

          logger.tag('rtsp:out', `[rtsp:stream:${stream.id}] send video to ${client.id}: fragment n=${fragmentNumber} timestamp=${ts} bytes=${rtpBuffer.length} marker=false keyframe=${isKeyFrame}`);

          client.videoPacketCount++;
          client.videoOctetCount += thisNalUnitLen;
          if (client.useTCPForVideo) {
            if (client.useHTTP) {
              if (client.httpClientType === 'GET') {
                this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
              }
            } else {
              this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
            }
          } else {
            if (client.clientVideoRTPPort != null) {
              this.videoRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientVideoRTPPort, client.ip, function(err, bytes) {
                if (err) {
                  return logger.error(`[videoRTPSend] error: ${err.message}`);
                }
              });
            }
          }
        }
      }
    }

    // last packet
    if (++stream.videoSequenceNumber > 65535) {
      stream.videoSequenceNumber -= 65535;
    }

    // TODO: sequence number should be started from a random number
    rtpData = rtp.createRTPHeader({
      marker,
      payloadType: 97,
      sequenceNumber: stream.videoSequenceNumber,
      timestamp: ts,
      ssrc: null
    });

    rtpData = rtpData.concat(rtp.createFragmentationUnitHeader({
      nal_ref_idc,
      nal_unit_type: nalUnitType,
      isStart: false,
      isEnd: true
    })
    );

    let nalUnitLen = nalUnit.length;
    rtpBuffer = Buffer.concat([new Buffer(rtpData), nalUnit],
      rtp.RTP_HEADER_LEN + 2 + nalUnitLen);
    for (clientID in stream.rtspClients) {
      client = stream.rtspClients[clientID];
      if (client.isWaitingForKeyFrame && isKeyFrame) {
        client.isPlaying = true;
        client.isWaitingForKeyFrame = false;
      }

      if (client.isPlaying) {
        rtp.replaceSSRCInRTP(rtpBuffer, client.videoSSRC);

        client.videoPacketCount++;
        client.videoOctetCount += nalUnitLen;
        logger.tag('rtsp:out', `[rtsp:stream:${stream.id}] send video to ${client.id}: fragment-last n=${fragmentNumber+1} timestamp=${ts} bytes=${rtpBuffer.length} marker=${marker} keyframe=${isKeyFrame}`);
        if (client.useTCPForVideo) {
          if (client.useHTTP) {
            if (client.httpClientType === 'GET') {
              this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
            }
          } else {
            this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
          }
        } else {
          if (client.clientVideoRTPPort != null) {
            this.videoRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientVideoRTPPort, client.ip, function(err, bytes) {
              if (err) {
                return logger.error(`[videoRTPSend] error: ${err.message}`);
              }
            });
          }
        }
      }
    }
  }

  sendVideoPacketAsSingleNALUnit(stream, nalUnit, timestamp, marker) {
    if (marker == null) { marker = true; }
    if (++stream.videoSequenceNumber > 65535) {
      stream.videoSequenceNumber -= 65535;
    }

    let ts = timestamp % TIMESTAMP_ROUNDOFF;
    stream.lastVideoRTPTimestamp = ts;

    let nalUnitType = nalUnit[0] & 0x1f;

    if (this.numClients === 0) {
      return;
    }

    if (stream.rtspNumClients === 0) {
      // No clients connected to the stream
      return;
    }

    let isKeyFrame = nalUnitType === 5;

    // TODO: sequence number should be started from a random number
    let rtpHeader = rtp.createRTPHeader({
      marker,
      payloadType: 97,
      sequenceNumber: stream.videoSequenceNumber,
      timestamp: ts,
      ssrc: null
    });

    let nalUnitLen = nalUnit.length;
    let rtpBuffer = Buffer.concat([new Buffer(rtpHeader), nalUnit],
      rtp.RTP_HEADER_LEN + nalUnitLen);

    for (let clientID in stream.rtspClients) {
      let client = stream.rtspClients[clientID];
      if (client.isWaitingForKeyFrame && isKeyFrame) {
        client.isPlaying = true;
        client.isWaitingForKeyFrame = false;
      }

      if (client.isPlaying) {
        rtp.replaceSSRCInRTP(rtpBuffer, client.videoSSRC);

        client.videoPacketCount++;
        client.videoOctetCount += nalUnitLen;
        logger.tag('rtsp:out', `[rtsp:stream:${stream.id}] send video to ${client.id}: single timestamp=${timestamp} keyframe=${isKeyFrame}`);
        if (client.useTCPForVideo) {
          if (client.useHTTP) {
            if (client.httpClientType === 'GET') {
              this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
            }
          } else {
            this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
          }
        } else {
          if (client.clientVideoRTPPort != null) {
            this.videoRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientVideoRTPPort, client.ip, function(err, bytes) {
              if (err) {
                return logger.error(`[videoRTPSend] error: ${err.message}`);
              }
            });
          }
        }
      }
    }
  }

  static getISO8601DateString() {
    let d = new Date;
    let str = `${d.getUTCFullYear()}-${pad(2, d.getUTCMonth()+1)}-${pad(2, d.getUTCDate())}T` + 
          `${pad(2, d.getUTCHours())}:${pad(2, d.getUTCMinutes())}:${pad(2, d.getUTCSeconds())}.` + 
          `${pad(4, d.getUTCMilliseconds())}Z`;
    return str;
  }

  consumePathname(uri, callback) {
    if (this.livePathConsumer != null) {
      return this.livePathConsumer(uri, callback);
    } else {
      let pathname = url.parse(uri).pathname.slice(1);

      // TODO: Implement authentication yourself
      let authSuccess = true;

      if (authSuccess) {
        return callback(null);
      } else {
        return callback(new Error('Invalid access'));
      }
    }
  }

  respondWithUnsupportedTransport(callback, headers) {
    let res = 'RTSP/1.0 461 Unsupported Transport\n';
    if (headers != null) {
      for (let name in headers) {
        let value = headers[name];
        res += `${name}: ${value}\n`;
      }
    }
    res += '\n';
    return callback(null, res.replace(/\n/g, '\r\n'));
  }

  notFound(protocol, opts, callback) {
    let res = `\
${protocol}/1.0 404 Not Found
Content-Length: 9
Content-Type: text/plain
\
`;
    if ((opts != null ? opts.keepalive : undefined)) {
      res += "Connection: keep-alive\n";
    } else {
      res += "Connection: close\n";
    }
    res += `\

Not Found\
`;
    return callback(null, res.replace(/\n/g, "\r\n"));
  }

  respondWithNotFound(req, protocol, callback) {
    if ((protocol == null)) {
      protocol = 'RTSP';
    }
    let res = `\
${protocol}/1.0 404 Not Found
Date: ${api.getDateHeader()}
Content-Length: 9
Content-Type: text/plain

Not Found\
`.replace(/\n/g, "\r\n");
    return callback(null, res,
      {close: (req.headers.connection != null ? req.headers.connection.toLowerCase() : undefined) !== 'keep-alive'});
  }

  respondOptions(socket, req, callback) {
    let res = `\
RTSP/1.0 200 OK
CSeq: ${req.headers.cseq != null ? req.headers.cseq : 0}
Public: DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, ANNOUNCE, RECORD

\
`.replace(/\n/g, "\r\n");
    return callback(null, res);
  }

  respondPost(socket, req, callback) {
    let client = this.clients[socket.clientID];
    let { pathname } = url.parse(req.uri);
    if (config.enableRTMPT && /^\/(?:fcs|open|idle|send|close)\//.test(pathname)) {
      if ((client.clientType == null)) {
        client.clientType = 'rtmpt';
        this.dumpClients();
      }
      if (this.rtmptCallback != null) {
        this.rtmptCallback(req, (err, output) => {
          if (err) {
            logger.error(`[rtmpt] Error: ${err}`);
            return this.respondWithNotFound(req, 'HTTP', callback);
          } else {
            return callback(err, output);
          }
        }
        );
      } else {
        this.respondWithNotFound(req, 'HTTP', callback);
      }
    } else if (config.enableRTSP) {
      // TODO: POST/GET connections may be re-initialized
      // Incoming channel
      if ((this.httpSessions[req.headers['x-sessioncookie']] == null)) {
        if (this.httpHandler != null) {
          this.respondWithNotFound(req, 'HTTP', callback);
        } else {
          // Request cannot be handled; close the connection
          callback(null, null,
            {close: true});
        }
        return;
      }
      socket.isAuthenticated = true;
      client.sessionCookie = req.headers['x-sessioncookie'];
      this.httpSessions[client.sessionCookie].post = client;
      let getClient = this.httpSessions[client.sessionCookie].get;
      // Make circular reference
      getClient.postClient = client;
      client.getClient = getClient;
      client.useHTTP = true;
      client.httpClientType = 'POST';
      client.isSendingPOST = true;

      if (req.body != null) {
        this.handleTunneledPOSTData(client, req.body);
      }

      // There's no response from the server
    } else if (this.httpHandler != null) {
      this.httpHandler.handlePath(pathname, req, (err, output) =>
        callback(err, output,
          {close: (req.headers.connection != null ? req.headers.connection.toLowerCase() : undefined) !== 'keep-alive'})
      );
    } else {
      // Request cannot be handled; close the connection
      callback(null, null,
        {close: true});
    }
  }

  respondGet(socket, req, callback) {
    let match, postClient, res;
    let liveRegex = new RegExp(`^/${config.liveApplicationName}/(.*)$`);
    let recordedRegex = new RegExp(`^/${config.recordedApplicationName}/(.*)$`);
    let client = this.clients[socket.clientID];
    let { pathname } = url.parse(req.uri);
    if (config.enableRTSP && ((match = liveRegex.exec(req.uri)) != null)) {
      // Outgoing channel
      this.consumePathname(req.uri, err => {
        if (err) {
          logger.warn(`Failed to consume pathname: ${err}`);
          this.respondWithNotFound(req, 'HTTP', callback);
          return;
        }
        client.sessionCookie = req.headers['x-sessioncookie'];
        client.useHTTP = true;
        client.httpClientType = 'GET';
        if (this.httpSessions[client.sessionCookie] != null) {
          postClient = this.httpSessions[client.sessionCookie].post;
          if (postClient != null) {
            postClient.getClient = client;
            client.postClient = postClient;
          }
        } else {
          this.httpSessions[client.sessionCookie] = {};
        }
        this.httpSessions[client.sessionCookie].get = client;
        socket.isAuthenticated = true;
        res = `\
HTTP/1.0 200 OK
Server: ${this.serverName}
Connection: close
Date: ${api.getDateHeader()}
Cache-Control: no-store
Pragma: no-cache
Content-Type: application/x-rtsp-tunnelled

\
`.replace(/\n/g, "\r\n");

        // Do not close the connection
        return callback(null, res);
      }
      );
    } else if (config.enableRTSP && ((match = recordedRegex.exec(req.uri)) != null)) {
      // Outgoing channel
      this.consumePathname(req.uri, err => {
        if (err) {
          logger.warn(`Failed to consume pathname: ${err}`);
          this.respondWithNotFound(req, 'HTTP', callback);
          return;
        }
        client.sessionCookie = req.headers['x-sessioncookie'];
        client.useHTTP = true;
        client.httpClientType = 'GET';
        if (this.httpSessions[client.sessionCookie] != null) {
          postClient = this.httpSessions[client.sessionCookie].post;
          if (postClient != null) {
            postClient.getClient = client;
            client.postClient = postClient;
          }
        } else {
          this.httpSessions[client.sessionCookie] = {};
        }
        this.httpSessions[client.sessionCookie].get = client;
        socket.isAuthenticated = true;
        res = `\
HTTP/1.0 200 OK
Server: ${this.serverName}
Connection: close
Date: ${api.getDateHeader()}
Cache-Control: no-store
Pragma: no-cache
Content-Type: application/x-rtsp-tunnelled

\
`.replace(/\n/g, "\r\n");

        // Do not close the connection
        return callback(null, res);
      }
      );
    } else if (this.httpHandler != null) {
      this.httpHandler.handlePath(pathname, req, (err, output) =>
        callback(err, output,
          {close: (req.headers.connection != null ? req.headers.connection.toLowerCase() : undefined) !== 'keep-alive'})
      );
    } else {
      // Request cannot be handled; close the connection
      callback(null, null,
        {close: true});
    }
  }

  respondDescribe(socket, req, callback) {
    let client = this.clients[socket.clientID];
    return this.consumePathname(req.uri, err => {
      let body, res;
      if (err) {
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }
      socket.isAuthenticated = true;
      client.bandwidth = req.headers.bandwidth;

      let streamId = RTSPServer.getStreamIdFromUri(req.uri);
      let stream = null;
      if (streamId != null) {
        stream = avstreams.get(streamId);
      }

      client.stream = stream;

      if ((stream == null)) {
        logger.info(`[${TAG}:client=${client.id}] requested stream not found: ${streamId}`);
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }

      let sdpData = {
        username      : '-',
        sessionID     : client.sessionID,
        sessionVersion: client.sessionID,
        addressType   : 'IP4',
        unicastAddress: api.getMeaningfulIPTo(socket)
      };

      if (stream.isAudioStarted) {
        sdpData.hasAudio          = true;
        sdpData.audioPayloadType  = 96;
        sdpData.audioEncodingName = 'mpeg4-generic';
        sdpData.audioClockRate    = stream.audioClockRate;
        sdpData.audioChannels     = stream.audioChannels;
        sdpData.audioSampleRate   = stream.audioSampleRate;
        sdpData.audioObjectType   = stream.audioObjectType;

        let ascInfo = stream.audioASCInfo;
        // Check whether explicit hierarchical signaling of SBR is used
        if ((ascInfo != null ? ascInfo.explicitHierarchicalSBR : undefined) && config.rtspDisableHierarchicalSBR) {
          logger.debug(`[${TAG}:client=${client.id}] converting hierarchical signaling of SBR` +
            ` (AudioSpecificConfig=0x${stream.audioSpecificConfig.toString('hex')})` +
            " to backward compatible signaling"
          );
          sdpData.audioSpecificConfig = new Buffer(aac.createAudioSpecificConfig(ascInfo));
        } else if (stream.audioSpecificConfig != null) {
          sdpData.audioSpecificConfig = stream.audioSpecificConfig;
        } else {
          // no AudioSpecificConfig available
          sdpData.audioSpecificConfig = new Buffer(aac.createAudioSpecificConfig({
            audioObjectType: stream.audioObjectType,
            samplingFrequency: stream.audioSampleRate,
            channels: stream.audioChannels,
            frameLength: 1024
          })
          );  // TODO: How to detect 960?
        }
        logger.debug(`[${TAG}:client=${client.id}] sending AudioSpecificConfig: 0x${sdpData.audioSpecificConfig.toString('hex')}`);
      }

      if (stream.isVideoStarted) {
        sdpData.hasVideo                = true;
        sdpData.videoPayloadType        = 97;
        sdpData.videoEncodingName       = 'H264';  // must be H264
        sdpData.videoClockRate          = 90000;  // must be 90000
        sdpData.videoProfileLevelId     = stream.videoProfileLevelId;
        if (stream.spropParameterSets !== '') {
          sdpData.videoSpropParameterSets = stream.spropParameterSets;
        }
        sdpData.videoHeight             = stream.videoHeight;
        sdpData.videoWidth              = stream.videoWidth;
        sdpData.videoFrameRate          = stream.videoFrameRate.toFixed(1);
      }

      if (stream.isRecorded()) {
        sdpData.durationSeconds = stream.durationSeconds;
      }

      try {
        body = sdp.createSDP(sdpData);
      } catch (e) {
        logger.error(`error: Unable to create SDP: ${e}`);
        callback(new Error('Unable to create SDP'));
        return;
      }

      if (/^HTTP\//.test(req.protocol)) {
        res = 'HTTP/1.0 200 OK\n';
      } else {
        res = 'RTSP/1.0 200 OK\n';
      }
      if (req.headers.cseq != null) {
        res += `CSeq: ${req.headers.cseq}\n`;
      }
      let dateHeader = api.getDateHeader();
      res += `\
Content-Base: ${req.uri}/
Content-Length: ${body.length}
Content-Type: application/sdp
Date: ${dateHeader}
Expires: ${dateHeader}
Session: ${client.sessionID};timeout=60
Server: ${this.serverName}
Cache-Control: no-cache

\
`;

      return callback(null, res.replace(/\n/g, "\r\n") + body);
    }
    );
  }

  respondSetup(socket, req, callback) {
    let dateHeader, match, res, transportHeader;
    let client = this.clients[socket.clientID];
    if (!socket.isAuthenticated) {
      this.respondWithNotFound(req, 'RTSP', callback);
      return;
    }
    let serverPort = null;
    let track = null;

    if (DEBUG_DISABLE_UDP_TRANSPORT &&
    (!/\bTCP\b/.test(req.headers.transport))) {
      // Disable UDP transport and force the client to switch to TCP transport
      logger.info("Unsupported transport: UDP is disabled");
      this.respondWithUnsupportedTransport(callback, {CSeq: req.headers.cseq});
      return;
    }

    client.mode = 'PLAY';
    if ((match = /;mode=([^;]*)/.exec(req.headers.transport)) != null) {
      client.mode = match[1].toUpperCase();  // PLAY or RECORD
    }

    if (client.mode === 'RECORD') {
      let mediaType;
      let sdpInfo = client.announceSDPInfo;
      if ((match = /\/([^/]+)$/.exec(req.uri)) != null) {
        let setupStreamId = match[1];  // e.g. "streamid=0"
        mediaType = null;
        for (let media of Array.from(sdpInfo.media)) {
          if ((media.attributes != null ? media.attributes.control : undefined) === setupStreamId) {
            mediaType = media.media;
            break;
          }
        }
        if ((mediaType == null)) {
          throw new Error(`streamid not found: ${setupStreamId}`);
        }
      } else {
        throw new Error(`Unknown URI: ${req.uri}`);
      }

      let streamId = RTSPServer.getStreamIdFromUri(req.uri, 1);
      let stream = avstreams.get(streamId);
      if ((stream == null)) {
        logger.warn(`warning: SETUP specified non-existent stream: ${streamId}`);
        logger.warn("         Stream has to be created by ANNOUNCE method.");
        stream = avstreams.create(streamId);
        stream.type = avstreams.STREAM_TYPE_LIVE;
      }
      if ((stream.rtspUploadingClient == null)) {
        stream.rtspUploadingClient = {};
      }
      if ((stream.rtspUploadingClient.uploadingChannels == null)) {
        stream.rtspUploadingClient.uploadingChannels = {};
      }
      if ((match = /;interleaved=(\d)-(\d)/.exec(req.headers.transport)) != null) {
        if ((client.clientType == null)) {
          client.clientType = 'publish-tcp';
          this.dumpClients();
        }
        if (mediaType === 'video') {
          stream.rtspUploadingClient.uploadingChannels.videoData = parseInt(match[1]);
          stream.rtspUploadingClient.uploadingChannels.videoControl = parseInt(match[2]);
        } else {  // audio
          stream.rtspUploadingClient.uploadingChannels.audioData = parseInt(match[1]);
          stream.rtspUploadingClient.uploadingChannels.audioControl = parseInt(match[2]);
        }
        // interleaved mode (use current connection)
        transportHeader = req.headers.transport.replace(/mode=[^;]*/, '');
      } else {
        let controlPort, dataPort;
        if ((client.clientType == null)) {
          client.clientType = 'publish-udp';
          this.dumpClients();
        }
        if (mediaType === 'video') {
          [dataPort, controlPort] = Array.from([config.rtspVideoDataUDPListenPort, config.rtspVideoControlUDPListenPort]);
          if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
            logger.debug(`registering video rtspUploadingClient ${client.ip}:${parseInt(match[1])}`);
            logger.debug(`registering video rtspUploadingClient ${client.ip}:${parseInt(match[2])}`);
            this.rtspUploadingClients[client.ip + ':' + parseInt(match[1])] = client;
            this.rtspUploadingClients[client.ip + ':' + parseInt(match[2])] = client;
          }
        } else {  // audio
          [dataPort, controlPort] = Array.from([config.rtspAudioDataUDPListenPort, config.rtspAudioControlUDPListenPort]);
          if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
            logger.debug(`registering audio rtspUploadingClient ${client.ip}:${parseInt(match[1])}`);
            logger.debug(`registering audio rtspUploadingClient ${client.ip}:${parseInt(match[2])}`);
            this.rtspUploadingClients[client.ip + ':' + parseInt(match[1])] = client;
            this.rtspUploadingClients[client.ip + ':' + parseInt(match[2])] = client;
          }
        }

        // client will send packets to "source" address which is specified here
        transportHeader = req.headers.transport.replace(/mode=[^;]*/, '') +
//                          "source=#{api.getMeaningfulIPTo socket};" +
                          `server_port=${dataPort}-${controlPort}`;
      }
      dateHeader = api.getDateHeader();
      res = `\
RTSP/1.0 200 OK
Date: ${dateHeader}
Expires: ${dateHeader}
Transport: ${transportHeader}
Session: ${client.sessionID};timeout=60
CSeq: ${req.headers.cseq}
Server: ${this.serverName}
Cache-Control: no-cache

\
`.replace(/\n/g, "\r\n");
      return callback(null, res);
    } else {  // PLAY mode
      let control_ch, data_ch, ssrc, useTCPTransport;
      if (/trackID=1\/?$/.test(req.uri)) {  // audio
        track = 'audio';
        if (client.useHTTP) {
          ssrc = client.getClient.audioSSRC;
        } else {
          ssrc = client.audioSSRC;
        }
        serverPort = `${config.audioRTPServerPort}-${config.audioRTCPServerPort}`;
        if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
          client.clientAudioRTPPort = parseInt(match[1]);
          client.clientAudioRTCPPort = parseInt(match[2]);
        }
      } else {  // video
        track = 'video';
        if (client.useHTTP) {
          ssrc = client.getClient.videoSSRC;
        } else {
          ssrc = client.videoSSRC;
        }
        serverPort = `${config.videoRTPServerPort}-${config.videoRTCPServerPort}`;
        if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
          client.clientVideoRTPPort = parseInt(match[1]);
          client.clientVideoRTCPPort = parseInt(match[2]);
        }
      }

      if (/\bTCP\b/.test(req.headers.transport)) {
        let target;
        useTCPTransport = true;
        if ((match = /;interleaved=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
          let ch1 = parseInt(match[1]);
          let ch2 = parseInt(match[2]);
          // even channel number is used for data, odd number is for control
          if ((ch1 % 2) === 0) {
            [data_ch, control_ch] = Array.from([ch1, ch2]);
          } else {
            [data_ch, control_ch] = Array.from([ch2, ch1]);
          }
        } else {
          if (track === 'audio') {
            data_ch = 0;
            control_ch = 1;
          } else {
            data_ch = 2;
            control_ch = 3;
          }
        }
        if (track === 'video') {
          if (client.useHTTP) {
            target = client.getClient;
          } else {
            target = client;
          }
          target.videoTCPDataChannel = data_ch;
          target.videoTCPControlChannel = control_ch;
          target.useTCPForVideo = true;
        } else {
          if (client.useHTTP) {
            target = client.getClient;
          } else {
            target = client;
          }
          target.audioTCPDataChannel = data_ch;
          target.audioTCPControlChannel = control_ch;
          target.useTCPForAudio = true;
        }
      } else {
        useTCPTransport = false;
        if (track === 'video') {
          client.useTCPForVideo = false;
        } else {
          client.useTCPForAudio = false;
        }
      }

      client.supportsReliableRTP = req.headers['x-retransmit'] === 'our-retransmit';
      if (req.headers['x-dynamic-rate'] != null) {
        client.supportsDynamicRate = req.headers['x-dynamic-rate'] === '1';
      } else {
        client.supportsDynamicRate = client.supportsReliableRTP;
      }
      if (req.headers['x-transport-options'] != null) {
        match = /late-tolerance=([0-9.]+)/.exec(req.headers['x-transport-options']);
        if (match != null) {
          client.lateTolerance = parseFloat(match[1]);
        }
      }

      if (useTCPTransport) {
        if (/;interleaved=/.test(req.headers.transport)) {
          transportHeader = req.headers.transport;
        } else {  // Maybe HTTP tunnelling
          transportHeader = req.headers.transport + `;interleaved=${data_ch}-${control_ch}` +
                            `;ssrc=${zeropad(8, ssrc.toString(16))}`;
        }
      } else {
        transportHeader = req.headers.transport +
//                          ";source=#{api.getMeaningfulIPTo socket}" +
                          `;server_port=${serverPort};ssrc=${zeropad(8, ssrc.toString(16))}`;
      }
      dateHeader = api.getDateHeader();
      res = `\
RTSP/1.0 200 OK
Date: ${dateHeader}
Expires: ${dateHeader}
Transport: ${transportHeader}
Session: ${client.sessionID};timeout=60
CSeq: ${req.headers.cseq}
Server: ${this.serverName}
Cache-Control: no-cache

\
`.replace(/\n/g, "\r\n");
      return callback(null, res);
    }
  }
    // after the response, client will send one or two RTP packets to this server

  respondPlay(socket, req, callback) {
    let match, startTime;
    if ((req.headers.range != null) && ((match = /npt=([\d.]+)-/.exec(req.headers.range)) != null)) {
      startTime = parseFloat(match[1]);
    } else {
      startTime = null;
    }

    let client = this.clients[socket.clientID];
    if (!socket.isAuthenticated) {
      this.respondWithNotFound(req, 'RTSP', callback);
      return;
    }

    let preventFromPlaying = false;
    let { stream } = client;
    if ((stream == null)) {
      this.respondWithNotFound(req, 'RTSP', callback);
      return;
    }

    let doResumeLater = false;

    let rangeStartTime = 0;
    let seq = new Sequent;
    if (stream.isRecorded()) {
      if ((startTime == null) && stream.isPaused()) {
        startTime = stream.getCurrentPlayTime();
        logger.info(`[${TAG}:client=${client.id}] resuming stream at ${stream.getCurrentPlayTime()}`);
      }
      if (startTime != null) {
        logger.info(`[${TAG}:client=${client.id}] seek to ${startTime}`);
        stream.pause();
        rangeStartTime = startTime;
        stream.seek(startTime, function(err, actualStartTime) {
          if (err) {
            logger.error(`[${TAG}:client=${client.id}] error: seek failed: ${err}`);
            return;
          }
          logger.debug(`[${TAG}:client=${client.id}] finished seeking stream to ${startTime}`);
          return stream.sendVideoPacketsSinceLastKeyFrame(startTime, function() {
            doResumeLater = true;
            return seq.done();
          });
        });
      } else {
        seq.done();
      }
    } else {
      seq.done();
    }


//    if (req.headers['user-agent']?.indexOf('QuickTime') > -1) and
//    not client.getClient?.useTCPForVideo
//      # QuickTime produces poor quality image over UDP.
//      # So we let QuickTime switch transport.
//      logger.info "UDP is disabled for QuickTime"
//      preventFromPlaying = true

//    Range: clock=#{RTSPServer.getISO8601DateString()}-
    // RTP-Info is defined in Section 12.33 in RFC 2326
    // seq: Indicates the sequence number of the first packet of the stream.
    // rtptime: Indicates the RTP timestamp corresponding to the time value in
    //          the Range response header.
    // TODO: Send this response after the first packet for this stream arrives
    return seq.wait(1, () => {
      let baseUrl = req.uri.replace(/\/$/, '');
      let rtpInfos = [];
      if (stream.isAudioStarted) {
        rtpInfos.push(`url=${baseUrl}/trackID=1;seq=${this.getNextAudioSequenceNumber(stream)};rtptime=${this.getNextAudioRTPTimestamp(stream)}`);
      }
      if (stream.isVideoStarted) {
        rtpInfos.push(`url=${baseUrl}/trackID=2;seq=${this.getNextVideoSequenceNumber(stream)};rtptime=${this.getNextVideoRTPTimestamp(stream)}`);
      }
      let res = `\
RTSP/1.0 200 OK
Range: npt=${rangeStartTime}-
Session: ${client.sessionID};timeout=60
CSeq: ${req.headers.cseq}
RTP-Info: ${rtpInfos.join(',')}
Server: ${this.serverName}
Cache-Control: no-cache

\
`.replace(/\n/g, "\r\n");
      if (!preventFromPlaying) {
        stream.rtspNumClients++;
        client.enablePlaying();
        if (client.useHTTP) {
          logger.info(`[${TAG}:client=${client.getClient.id}] start streaming over HTTP GET`);
          stream.rtspClients[client.getClient.id] = client.getClient;
          client.clientType = 'http-post';
          client.getClient.clientType = 'http-get';
          this.dumpClients();
        } else if (client.useTCPForVideo) {  // or client.useTCPForAudio?
          logger.info(`[${TAG}:client=${client.id}] start streaming over TCP`);
          stream.rtspClients[client.id] = client;
          client.clientType = 'tcp';
          this.dumpClients();
        } else {
          logger.info(`[${TAG}:client=${client.id}] start streaming over UDP`);
          if (ENABLE_START_PLAYING_FROM_KEYFRAME && stream.isVideoStarted) {
            client.isWaitingForKeyFrame = true;
          } else {
            client.isPlaying = true;
          }
          stream.rtspClients[client.id] = client;
          client.clientType = 'udp';
          this.dumpClients();
        }
        if (client.useHTTP) {
          this.startSendingRTCP(stream, client.getClient);
        } else {
          this.startSendingRTCP(stream, client);
        }
      } else {
        logger.info(`[${TAG}:client=${client.id}] not playing`);
      }
      callback(null, res);

      if (doResumeLater) {
        return stream.resume(false);
      }
    }
    );
  }

  respondPause(socket, req, callback) {
    let client = this.clients[socket.clientID];
    if (!socket.isAuthenticated) {
      this.respondWithNotFound(req, 'RTSP', callback);
      return;
    }
    this.stopSendingRTCP(client);
    client.disablePlaying();
    if (client.stream.isRecorded()) {
      client.stream.pause();
    }
    let res = `\
RTSP/1.0 200 OK
Session: ${client.sessionID};timeout=60
CSeq: ${req.headers.cseq}
Cache-Control: no-cache

\
`.replace(/\n/g, "\r\n");
    return callback(null, res);
  }

  respondTeardown(socket, req, callback) {
    let client = this.clients[socket.clientID];
    let stream = client.uploadingStream != null ? client.uploadingStream : client.stream;
    if (client === (stream != null ? stream.rtspUploadingClient : undefined)) {
      logger.info(`[${TAG}:client=${client.id}] finished uploading stream ${stream.id}`);
      stream.rtspUploadingClient = null;
      stream.emit('end');
    }
    if ((stream != null ? stream.type : undefined) === avstreams.STREAM_TYPE_RECORDED) {
      if (typeof stream.teardown === 'function') {
        stream.teardown();
      }
    }
    if (!socket.isAuthenticated) {
      this.respondWithNotFound(req, 'RTSP', callback);
      return;
    }
    client.disablePlaying();
    if ((stream != null ? stream.rtspClients[client.id] : undefined) != null) {
      delete stream.rtspClients[client.id];
      stream.rtspNumClients--;
    }
    let res = `\
RTSP/1.0 200 OK
Session: ${client.sessionID};timeout=60
CSeq: ${req.headers.cseq}
Cache-Control: no-cache

\
`.replace(/\n/g, "\r\n");
    return callback(null, res);
  }

  respondAnnounce(socket, req, callback) {
    // TODO: Refuse uploading to a stream that is being uploaded
    let client = this.clients[socket.clientID];
    let streamId = RTSPServer.getStreamIdFromUri(req.uri);
    let stream = avstreams.get(streamId);
    if (stream != null) {
      stream.reset();
      this.rtpParser.clearUnorderedPacketBuffer(stream.id);
    } else {
      stream = avstreams.create(streamId);
      stream.type = avstreams.STREAM_TYPE_LIVE;
    }

    let sdpInfo = sdp.parse(req.body);

    for (let media of Array.from(sdpInfo.media)) {
      if (media.media === 'video') {
        sdpInfo.video = media;
        if ((media.fmtpParams != null ? media.fmtpParams['packetization-mode'] : undefined) != null) {
          let packetizationMode = parseInt(media.fmtpParams['packetization-mode']);
          if (![0, 1].includes(packetizationMode)) {
            logger.error(`[rtsp:stream:${streamId}] error: unsupported packetization-mode: ${packetizationMode}`);
          }
        }
        if ((media.fmtpParams != null ? media.fmtpParams['sprop-parameter-sets'] : undefined) != null) {
          let nalUnits = h264.parseSpropParameterSets(media.fmtpParams['sprop-parameter-sets']);
          for (let nalUnit of Array.from(nalUnits)) {
            let nalUnitType = nalUnit[0] & 0x1f;
            switch (nalUnitType) {
              case h264.NAL_UNIT_TYPE_SPS:  // 7
                stream.updateSPS(nalUnit);
                break;
              case h264.NAL_UNIT_TYPE_PPS:  // 8
                stream.updatePPS(nalUnit);
                break;
              default:
                logger.warn(`unknown nal_unit_type ${nalUnitType} in sprop-parameter-sets`);
            }
          }
        }
      } else if (media.media === 'audio') {
        var audioObjectType;
        sdpInfo.audio = media;

        if ((media.clockRate == null)) {
          logger.error("Error: rtpmap attribute in SDP must have audio clock rate; assuming 44100");
          media.clockRate = 44100;
        }

        if ((media.audioChannels == null)) {
          logger.error("Error: rtpmap attribute in SDP must have audio channels; assuming 2");
          media.audioChannels = 2;
        }

        logger.debug(`[${TAG}:client=${client.id}] audio fmtp: ${JSON.stringify(media.fmtpParams)}`);

        if ((media.fmtpParams == null)) {
          logger.error("Error: fmtp attribute does not exist in SDP");
          media.fmtpParams = {};
        }

        let audioSpecificConfig = null;
        let ascInfo = null;
        if ((media.fmtpParams.config != null) && (media.fmtpParams.config !== '')) {
          audioSpecificConfig = new Buffer(media.fmtpParams.config, 'hex');
          ascInfo = aac.parseAudioSpecificConfig(audioSpecificConfig);
          ({ audioObjectType } = ascInfo);
        } else {
          logger.error("Error: fmtp attribute in SDP does not have config parameter; assuming audioObjectType=2");
          audioObjectType = 2;
        }

        stream.updateConfig({
          audioSampleRate: media.clockRate,
          audioClockRate: media.clockRate,
          audioChannels: media.audioChannels,
          audioObjectType,
          audioSpecificConfig,
          audioASCInfo: ascInfo
        });

        if (media.fmtpParams.sizelength != null) {
          media.fmtpParams.sizelength = parseInt(media.fmtpParams.sizelength);
        } else {
          logger.error("Error: fmtp attribute in SDP must have sizelength parameter; assuming 13");
          media.fmtpParams.sizelength = 13;
        }
        if (media.fmtpParams.indexlength != null) {
          media.fmtpParams.indexlength = parseInt(media.fmtpParams.indexlength);
        } else {
          logger.error("Error: fmtp attribute in SDP must have indexlength parameter; assuming 3");
          media.fmtpParams.indexlength = 3;
        }
        if (media.fmtpParams.indexdeltalength != null) {
          media.fmtpParams.indexdeltalength = parseInt(media.fmtpParams.indexdeltalength);
        } else {
          logger.error("Error: fmtp attribute in SDP must have indexdeltalength parameter; assuming 3");
          media.fmtpParams.indexdeltalength = 3;
        }
      }
    }

    client.announceSDPInfo = sdpInfo;
    // make circular reference between stream and client
    stream.rtspUploadingClient = client;
    client.uploadingStream = stream;
    client.uploadingTimestampInfo = {};

    socket.isAuthenticated = true;

    let res = `\
RTSP/1.0 200 OK
CSeq: ${req.headers.cseq}

\
`.replace(/\n/g, "\r\n");
    return callback(null, res);
  }

  respondRecord(socket, req, callback) {
    let res;
    let client = this.clients[socket.clientID];
    if (client.mode !== 'RECORD') {
      logger.debug(`client mode is not RECORD (got ${client.mode})`);
      res = `\
RTSP/1.0 405 Method Not Allowed
CSeq: ${req.headers.cseq}

\
`.replace(/\n/g, "\r\n");
      return callback(null, res);
    }

    let streamId = RTSPServer.getStreamIdFromUri(req.uri);
    logger.info(`[${TAG}:client=${client.id}] started uploading stream ${streamId}`);
    let stream = avstreams.getOrCreate(streamId);
    if (client.announceSDPInfo.video != null) {  // has video
      this.emit('video_start', stream);
    }
    if (client.announceSDPInfo.audio != null) {  // has audio
      this.emit('audio_start', stream);
    }
    res = `\
RTSP/1.0 200 OK
Session: ${client.sessionID};timeout=60
CSeq: ${req.headers.cseq}
Server: ${this.serverName}
Cache-Control: no-cache

\
`.replace(/\n/g, "\r\n");
    return callback(null, res);
  }

  respond(socket, req, callback) {
    if ((req.protocolName !== 'RTSP') && (req.protocolName !== 'HTTP')) {
      // Request cannot be handled; close the connection
      callback(null, null,
        {close: true});
    }
    if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'OPTIONS')) {
      return this.respondOptions(socket, req, callback);
    } else if ((req.method === 'POST') && (req.protocolName === 'HTTP')) { // HTTP POST
      return this.respondPost(socket, req, callback);
    } else if ((req.method === 'GET') && (req.protocolName === 'HTTP')) { // HTTP GET
      return this.respondGet(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'DESCRIBE')) {  // DESCRIBE for RTSP, GET for HTTP
      return this.respondDescribe(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'SETUP')) {
      return this.respondSetup(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'PLAY')) {
      return this.respondPlay(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'PAUSE')) {
      return this.respondPause(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'TEARDOWN')) {
      return this.respondTeardown(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'ANNOUNCE')) {
      return this.respondAnnounce(socket, req, callback);
    } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'RECORD')) {
      return this.respondRecord(socket, req, callback);
    } else {
      logger.warn(`[${TAG}] method \"${req.method}\" not implemented for protocol \"${req.protocol}\"`);
      return this.respondWithNotFound(req, req.protocolName, callback);
    }
  }

  // Called when received video data over RTSP
  onUploadVideoData(stream, msg, rinfo) {
    if ((stream.rtspUploadingClient == null)) {
//      logger.warn "no client is uploading video data to stream #{stream.id}"
      return;
    }
    let packet = rtp.parsePacket(msg);
    if ((stream.rtspUploadingClient.videoRTPStartTimestamp == null)) {
      // TODO: Is it correct to set the start timestamp in this manner?
      stream.rtspUploadingClient.videoRTPStartTimestamp = packet.rtpHeader.timestamp;
    }
    if (packet.rtpHeader.payloadType === stream.rtspUploadingClient.announceSDPInfo.video.fmt) {
      return this.rtpParser.feedUnorderedH264Buffer(msg, stream.id);
    } else {
      return logger.error(`Error: Unknown payload type: ${packet.rtpHeader.payloadType} as video`);
    }
  }

  onUploadVideoControl(stream, msg, rinfo) {
    if ((stream.rtspUploadingClient == null)) {
//      logger.warn "no client is uploading audio data to stream #{stream.id}"
      return;
    }
    let packets = rtp.parsePackets(msg);
    return (() => {
      let result = [];
      for (let packet of Array.from(packets)) {
        let item;
        if (packet.rtcpSenderReport != null) {
          if ((stream.rtspUploadingClient.uploadingTimestampInfo.video == null)) {
            stream.rtspUploadingClient.uploadingTimestampInfo.video = {};
          }
          stream.rtspUploadingClient.uploadingTimestampInfo.video.rtpTimestamp = packet.rtcpSenderReport.rtpTimestamp;
          item = stream.rtspUploadingClient.uploadingTimestampInfo.video.time = packet.rtcpSenderReport.ntpTimestampInMs;
        }
        result.push(item);
      }
      return result;
    })();
  }

  onUploadAudioData(stream, msg, rinfo) {
    if ((stream.rtspUploadingClient == null)) {
//      logger.warn "no client is uploading audio data to stream #{stream.id}"
      return;
    }
    let packet = rtp.parsePacket(msg);
    if ((stream.rtspUploadingClient.audioRTPStartTimestamp == null)) {
      // TODO: Is it correct to set the start timestamp in this manner?
      stream.rtspUploadingClient.audioRTPStartTimestamp = packet.rtpHeader.timestamp;
    }
    if (packet.rtpHeader.payloadType === stream.rtspUploadingClient.announceSDPInfo.audio.fmt) {
      return this.rtpParser.feedUnorderedAACBuffer(msg, stream.id, stream.rtspUploadingClient.announceSDPInfo.audio.fmtpParams);
    } else {
      return logger.error(`Error: Unknown payload type: ${packet.rtpHeader.payloadType} as audio`);
    }
  }

  onUploadAudioControl(stream, msg, rinfo) {
    if ((stream.rtspUploadingClient == null)) {
//      logger.warn "no client is uploading audio data to stream #{stream.id}"
      return;
    }
    let packets = rtp.parsePackets(msg);
    return (() => {
      let result = [];
      for (let packet of Array.from(packets)) {
        let item;
        if (packet.rtcpSenderReport != null) {
          if ((stream.rtspUploadingClient.uploadingTimestampInfo.audio == null)) {
            stream.rtspUploadingClient.uploadingTimestampInfo.audio = {};
          }
          stream.rtspUploadingClient.uploadingTimestampInfo.audio.rtpTimestamp = packet.rtcpSenderReport.rtpTimestamp;
          item = stream.rtspUploadingClient.uploadingTimestampInfo.audio.time = packet.rtcpSenderReport.ntpTimestampInMs;
        }
        result.push(item);
      }
      return result;
    })();
  }
}

// Represents an RTSP session
class RTSPClient {
  constructor(opts) {
    this.videoPacketCount = 0;
    this.videoOctetCount = 0;
    this.audioPacketCount = 0;
    this.audioOctetCount = 0;
    this.isPlaying = false;
    this.timeoutID = null;
    this.videoSSRC = generateRandom32();
    this.audioSSRC = generateRandom32();
    this.supportsReliableRTP = false;

    for (let name in opts) {
      let value = opts[name];
      this[name] = value;
    }
  }

  disablePlaying() {
    if (this.useHTTP) {
      this.getClient.isWaitingForKeyFrame = false;
      return this.getClient.isPlaying = false;
    } else {
      this.isWaitingForKeyFrame = false;
      return this.isPlaying = false;
    }
  }

  enablePlaying() {
    if (this.useHTTP) {
      if (ENABLE_START_PLAYING_FROM_KEYFRAME && client.stream.isVideoStarted) {
        return this.getClient.isWaitingForKeyFrame = true;
      } else {
        return this.getClient.isPlaying = true;
      }
    } else {
      if (ENABLE_START_PLAYING_FROM_KEYFRAME && stream.isVideoStarted) {
        return this.isWaitingForKeyFrame = true;
      } else {
        return this.isPlaying = true;
      }
    }
  }

  toString() {
    if ((this.socket.remoteAddress == null)) {
      return `${this.id}: session=${this.sessionID} (being destroyed)`;
    } else {
      let transportDesc = (this.clientType != null) ? `type=${this.clientType}` : '';
      if (['http-get', 'tcp', 'udp'].includes(this.clientType)) {
        transportDesc += ` isPlaying=${this.isPlaying}`;
      }
      return `${this.id}: session=${this.sessionID} addr=${this.socket.remoteAddress} port=${this.socket.remotePort} ${transportDesc}`;
    }
  }
}

var api = {
  RTSPServer,

  INTERLEAVED_SIGN: 0x24,  // '$' (dollar sign)
  INTERLEAVED_HEADER_LEN: 4,

  // Creates an interleaved header and returns the buffer.
  //
  // opts:
  //   channel: <number> channel identifier
  //   payloadLength: <number> payload length
  createInterleavedHeader(opts) {
    if (((opts != null ? opts.channel : undefined) == null)) {
      throw new Error("createInterleavedHeader: channel is required");
    }
    if (((opts != null ? opts.payloadLength : undefined) == null)) {
      throw new Error("createInterleavedHeader: payloadLength is required");
    }

    return new Buffer([
      api.INTERLEAVED_SIGN,
      opts.channel,
      opts.payloadLength >> 8, opts.payloadLength & 0xff,
    ]);
  },

  // Parses and returns an interleaved header.
  //
  // If the buffer doesn't have enough length for an interleaved header,
  // returns null.
  parseInterleavedHeader(buf) {
    if (buf.length < api.INTERLEAVED_HEADER_LEN) {
      // not enough buffer
      return null;
    }

    if (buf[0] !== api.INTERLEAVED_SIGN) {
      throw new Error("The buffer is not an interleaved data");
    }

    let info = {};
    info.channel = buf[1];
    info.payloadLength = (buf[2] << 8) | buf[3];
    info.totalLength = api.INTERLEAVED_HEADER_LEN + info.payloadLength;
    return info;
  },

  // Parses and returns the information of complete interleaved data.
  //
  // If parsing failed or buf doesn't have enough length for
  // the payload, returns null.
  getInterleavedData(buf) {
    let info = api.parseInterleavedHeader(buf);
    if ((info == null)) {
      return null;
    }

    if (buf.length < info.totalLength) {
      // not enough buffer
      return null;
    }

    info.data = buf.slice(api.INTERLEAVED_HEADER_LEN, info.totalLength);

    return info;
  },

  isLoopbackAddress(socket) {
    return socket.remoteAddress === '127.0.0.1';
  },

  // Check if the remote address of the given socket is private
  isPrivateNetwork(socket) {
    let match;
    if (/^(10\.|192\.168\.|127\.0\.0\.)/.test(socket.remoteAddress)) {
      return true;
    }
    if ((match = /^172.(\d+)\./.exec(socket.remoteAddress)) != null) {
      let num = parseInt(match[1]);
      if (16 <= num && num <= 31) {
        return true;
      }
    }
    return false;
  },

  getDateHeader() {
    let d = new Date;
    return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}` +
    ` ${d.getUTCFullYear()} ${zeropad(2, d.getUTCHours())}:${zeropad(2, d.getUTCMinutes())}` +
    `:${zeropad(2, d.getUTCSeconds())} UTC`;
  },

  // Returns this machine's IP address which is attached to network interface
  // TODO: Get IP address from socket
  getLocalIP() {
    let ifacePrecedence = [ 'wlan', 'eth', 'en' ];

    // compare function for sort
    let getPriority = function(ifaceName) {
      for (let i = 0; i < ifacePrecedence.length; i++) {
        let name = ifacePrecedence[i];
        if (ifaceName.indexOf(name) === 0) {
          return i;
        }
      }
      return ifacePrecedence.length;
    };

    let ifaces = os.networkInterfaces();
    let ifaceNames = Object.keys(ifaces);
    ifaceNames.sort((a, b) => getPriority(a) - getPriority(b));

    for (let ifaceName of Array.from(ifaceNames)) {
      for (let addr of Array.from(ifaces[ifaceName])) {
        if ((!addr.internal) && (addr.family === 'IPv4')) {
          return addr.address;
        }
      }
    }

    return "127.0.0.1";
  },

  getExternalIP() {
    return "127.0.0.1";
  }, // TODO: Fetch this from UPnP or something

  // Get local IP address which is meaningful to the
  // partner of the given socket
  getMeaningfulIPTo(socket) {
    if (api.isLoopbackAddress(socket)) {
      return '127.0.0.1';
    } else if (api.isPrivateNetwork(socket)) {
      return api.getLocalIP();
    } else {
      return api.getExternalIP();
    }
  },

  leaveClient(client) {
    let object = avstreams.getAll();
    for (let streamName in object) {
      let stream = object[streamName];
      logger.debug(`[stream:${stream.id}] leaveClient: ${client.id}`);
      if (stream.rtspClients[client.id] != null) {
        delete stream.rtspClients[client.id];
        stream.rtspNumClients--;
      }
    }
  }
};

export default api;
