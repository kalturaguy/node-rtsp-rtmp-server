import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import h264 from './h264';
import aac from './aac';
import mp4 from './mp4';
import Bits from './bits';
import EventEmitterModule from './event_emitter';
import logger from './logger';

let createStreamId = function() {
  let buf;
  try {
    buf = crypto.randomBytes(256);
  } catch (e) {
    logger.error(`crypto.randomBytes() failed: ${e}`);
    buf = crypto.pseudoRandomBytes(256);
  }

  let shasum = crypto.createHash('sha512');
  shasum.update(buf);
  return shasum.digest('hex').slice(0, 8);
};

// Generates stream upon request
class AVStreamGenerator {
  constructor(methods) {
    if ((methods != null ? methods.generate : undefined) != null) {
      this.generate = methods.generate;
    }
    if ((methods != null ? methods.teardown : undefined) != null) {
      this.teardown = methods.teardown;
    }
    if ((methods != null ? methods.pause : undefined) != null) {
      this.pause = methods.pause;
    }
    if ((methods != null ? methods.resume : undefined) != null) {
      this.resume = methods.resume;
    }
    if ((methods != null ? methods.seek : undefined) != null) {
      this.seek = methods.seek;
    }
    if ((methods != null ? methods.sendVideoPacketsSinceLastKeyFrame : undefined) != null) {
      this.sendVideoPacketsSinceLastKeyFrame = methods.sendVideoPacketsSinceLastKeyFrame;
    }
    if ((methods != null ? methods.getCurrentPlayTime : undefined) != null) {
      this.getCurrentPlayTime = methods.getCurrentPlayTime;
    }
    if ((methods != null ? methods.isPaused : undefined) != null) {
      this.isPaused = methods.isPaused;
    }

    __guardMethod__(methods, 'init', o => o.init());
  }

  generate() {}

  teardown() {}
}

class AVStream {
  constructor(id) {
    this.id = id;  // string
    this.initAVParams();
  }

  initAVParams() {
    this.audioClockRate      = null;  // int
    this.audioSampleRate     = null;  // int
    this.audioChannels       = null;  // int
    this.audioPeriodSize     = 1024;  // TODO: detect this from stream?
    this.audioObjectType     = null;  // int
    this.videoWidth          = null;  // int
    this.videoHeight         = null;  // int
    this.videoProfileLevelId = null;  // string (e.g. '42C01F')
    this.videoFrameRate      = 30.0;  // float  # TODO: default value
    this.videoAVCLevel       = null;  // int
    this.videoAVCProfile     = null;  // int
    this.isVideoStarted      = false; // boolean
    this.isAudioStarted      = false; // boolean
    this.timeAtVideoStart    = null;  // milliseconds since the epoch
    this.timeAtAudioStart    = null;  // milliseconds since the epoch
    this.spsString           = '';    // string
    this.ppsString           = '';    // string
    this.spsNALUnit          = null;  // buffer
    this.ppsNALUnit          = null;  // buffer
    this.spropParameterSets  = '';    // string
    return this.type                = null;  // string ('live' or 'recorded')
  }

  destroy() {
    logger.debug(`[stream:${this.id}] destroy`);
    this.spsNALUnit = null;
    this.ppsNALUnit = null;
    return this.emit('destroy');
  }

  isRecorded() {
    return this.type === api.STREAM_TYPE_RECORDED;
  }

  reset() {
    logger.debug(`[stream:${this.id}] reset`);
    this.initAVParams();
    return this.emit('reset');
  }

  updateSpropParam(buf) {
    let nalUnitType = buf[0] & 0x1f;
    if (nalUnitType === 7) {  // SPS packet
      this.spsString = buf.toString('base64');
      this.videoProfileLevelId = buf.slice(1, 4).toString('hex').toUpperCase();
    } else if (nalUnitType === 8) {  // PPS packet
      this.ppsString = buf.toString('base64');
    }

    return this.spropParameterSets = this.spsString + ',' + this.ppsString;
  }

  resetFrameRate() {
    this.frameRateCalcBasePTS = null;
    this.frameRateCalcNumFrames = null;
    return this.videoFrameRate = 30.0;  // TODO: What value should we use as a default frame rate?
  }

  calcFrameRate(pts) {
    if (this.frameRateCalcBasePTS != null) {
      let diffMs = (pts - this.frameRateCalcBasePTS) / 90;
      if (pts !== this.lastPTS) {
        this.frameRateCalcNumFrames++;
        this.lastPTS = pts;
      }
      if ((this.frameRateCalcNumFrames >= 150) || (diffMs >= 5000)) {
        let frameRate = (this.frameRateCalcNumFrames * 1000) / diffMs;
        if (frameRate !== this.videoFrameRate) {
          logger.debug(`[stream:${this.id}] frame rate: ${this.videoFrameRate}`);
          this.videoFrameRate = frameRate;
          this.emit('update_frame_rate', frameRate);
        }
        this.frameRateCalcBasePTS = pts;
        this.frameRateCalcNumFrames = 0;
        return this.lastPTS = null;
      }
    } else {
      this.frameRateCalcBasePTS = pts;
      this.frameRateCalcNumFrames = 0;
      return this.lastPTS = null;
    }
  }

  updateConfig(obj) {
    let isConfigUpdated = false;
    for (let name in obj) {
      let value = obj[name];
      if (this[name] !== value) {
        this[name] = value;
        if (value instanceof Buffer) {
          logger.debug(`[stream:${this.id}] update ${name}: Buffer=<0x${value.toString('hex')}>`);
        } else if (typeof(value) === 'object') {
          logger.debug(`[stream:${this.id}] update ${name}:`);
          logger.debug(value);
        } else {
          logger.debug(`[stream:${this.id}] update ${name}: ${value}`);
        }
        if (name === 'audioASCInfo') {
          if ((value != null ? value.sbrPresentFlag : undefined) === 1) {
            if ((value != null ? value.psPresentFlag : undefined) === 1) {
              logger.debug(`[stream:${this.id}] audio: HE-AAC v2`);
            } else {
              logger.debug(`[stream:${this.id}] audio: HE-AAC v1`);
            }
          }
        }
        isConfigUpdated = true;
      }
    }
    if (isConfigUpdated) {
      return this.emit('updateConfig');
    }
  }

  // nal_unit_type 7
  updateSPS(nalUnit) {
    if (((this.spsNALUnit == null)) || (nalUnit.compare(this.spsNALUnit) !== 0)) {
      let sps;
      this.spsNALUnit = nalUnit;
      this.updateSpropParam(nalUnit);
      try {
        sps = h264.readSPS(nalUnit);
      } catch (e) {
        logger.error(`[stream:${this.id}] video data error: failed to read SPS`);
        logger.error(e.stack);
        return;
      }
      let frameSize = h264.getFrameSize(sps);
      let isConfigUpdated = false;
      if (this.videoWidth !== frameSize.width) {
        this.videoWidth = frameSize.width;
        logger.debug(`[stream:${this.id}] video width: ${this.videoWidth}`);
        isConfigUpdated = true;
      }
      if (this.videoHeight !== frameSize.height) {
        this.videoHeight = frameSize.height;
        logger.debug(`[stream:${this.id}] video height: ${this.videoHeight}`);
        isConfigUpdated = true;
      }
      if (this.videoAVCLevel !== sps.level_idc) {
        this.videoAVCLevel = sps.level_idc;
        logger.debug(`[stream:${this.id}] video avclevel: ${this.videoAVCLevel}`);
        isConfigUpdated = true;
      }
      if (this.videoAVCProfile !== sps.profile_idc) {
        this.videoAVCProfile = sps.profile_idc;
        logger.debug(`[stream:${this.id}] video avcprofile: ${this.videoAVCProfile}`);
        isConfigUpdated = true;
      }
      if (isConfigUpdated) {
        logger.debug(`[stream:${this.id}] updated SPS: 0x${nalUnit.toString('hex')}`);
        return this.emit('updateConfig');
      }
    }
  }

  // nal_unit_type 8
  updatePPS(nalUnit) {
    if (((this.ppsNALUnit == null)) || (nalUnit.compare(this.ppsNALUnit) !== 0)) {
      logger.debug(`[stream:${this.id}] updated PPS: 0x${nalUnit.toString('hex')}`);
      this.ppsNALUnit = nalUnit;
      this.updateSpropParam(nalUnit);
      return this.emit('updateConfig');
    }
  }

  toString() {
    let str = `${this.id}: `;
    if (this.videoWidth != null) {
      str += `video: ${this.videoWidth}x${this.videoHeight} profile=${this.videoAVCProfile} level=${this.videoAVCLevel}`;
    } else {
      str += "video: (waiting for data)";
    }
    if (this.audioSampleRate != null) {
      str += `; audio: samplerate=${this.audioSampleRate} channels=${this.audioChannels} objecttype=${this.audioObjectType}`;
    } else {
      str += "; audio: (waiting for data)";
    }
    return str;
  }
}

EventEmitterModule.mixin(AVStream);

class MP4Stream extends AVStream {
  static create(filename) {
    let mp4File;
    try {
      mp4File = new mp4.MP4File(filename);
    } catch (err) {
      logger.error(`error opening MP4 file ${filename}: ${err}`);
      return null;
    }
    let streamId = api.createNewStreamId();
    let mp4Stream = new MP4Stream(streamId);
    logger.debug(`created stream ${streamId} from file ${filename}`);
    api.emit('new', mp4Stream);
    api.add(mp4Stream);

    mp4Stream.type = api.STREAM_TYPE_RECORDED;
    mp4File.on('audio_data', (data, pts) => mp4Stream.emit('audio_data', data, pts));
    mp4File.on('video_data', (nalUnits, pts, dts) => mp4Stream.emit('video_data', nalUnits, pts, dts));
    mp4File.on('eof', () => mp4Stream.emit('end'));
    mp4File.parse();
    if (mp4File.hasVideo()) {
      mp4Stream.updateSPS(mp4File.getSPS());
      mp4Stream.updatePPS(mp4File.getPPS());
    }
    if (mp4File.hasAudio()) {
      let ascBuf = mp4File.getAudioSpecificConfig();
      let bits = new Bits(ascBuf);
      let ascInfo = aac.readAudioSpecificConfig(bits);
      mp4Stream.updateConfig({
        audioSpecificConfig: ascBuf,
        audioASCInfo: ascInfo,
        audioSampleRate: ascInfo.samplingFrequency,
        audioClockRate: 90000,
        audioChannels: ascInfo.channelConfiguration,
        audioObjectType: ascInfo.audioObjectType
      });
    }
    mp4Stream.durationSeconds = mp4File.getDurationSeconds();
    mp4Stream.lastTagTimestamp = mp4File.getLastTimestamp();
    mp4Stream.mp4File = mp4File;
    mp4File.fillBuffer(function() {
      if (mp4File.hasAudio()) {
        mp4Stream.emit('audio_start');
        mp4Stream.isAudioStarted = true;
      }
      if (mp4File.hasVideo()) {
        mp4Stream.emit('video_start');
        return mp4Stream.isVideoStarted = true;
      }
    });
    return mp4Stream;
  }

  play() {
    return this.mp4File.play();
  }

  pause() {
    return this.mp4File.pause();
  }

  resume() {
    return this.mp4File.resume();
  }

  seek(seekSeconds, callback) {
    let actualStartTime = this.mp4File.seek(seekSeconds);
    return callback(null, actualStartTime);
  }

  sendVideoPacketsSinceLastKeyFrame(endSeconds, callback) {
    return this.mp4File.sendVideoPacketsSinceLastKeyFrame(endSeconds, callback);
  }

  teardown() {
    logger.debug(`[mp4stream:${this.id}] teardown`);
    this.mp4File.close();
    return this.destroy();
  }

  getCurrentPlayTime() {
    return this.mp4File.currentPlayTime;
  }

  isPaused() {
    return this.mp4File.isPaused();
  }
}


let eventListeners = {};
let streams = {};
let streamGenerators = {};
let recordedAppToDir = {};

var api = {
  STREAM_TYPE_LIVE: 'live',
  STREAM_TYPE_RECORDED: 'recorded',

  AVStream,
  MP4Stream,
  AVStreamGenerator,

  emit(name, ...data) {
    if (eventListeners[name] != null) {
      for (let listener of Array.from(eventListeners[name])) {
        listener(...data);
      }
    }
  },

  on(name, listener) {
    if (eventListeners[name] != null) {
      return eventListeners[name].push(listener);
    } else {
      return eventListeners[name] = [ listener ];
    }
  },

  removeListener(name, listener) {
    if (eventListeners[name] != null) {
      for (let i = 0; i < eventListeners[name].length; i++) {
        let _listener = eventListeners[name][i];
        if (_listener === listener) {
          eventListeners.splice(i, i - i + 1, ...[].concat([]));  // remove element at index i
        }
      }
    }
  },

  getAll() {
    return streams;
  },

  exists(streamId) {
    return (streams[streamId] != null);
  },

  get(streamId) {
    let stream;
    if (streams[streamId] != null) { // existing stream
      return streams[streamId];
    } else if (streamGenerators[streamId] != null) { // generator
      stream = streamGenerators[streamId].generate();
      if (stream != null) {
        stream.teardown = streamGenerators[streamId].teardown;
        stream.pause = streamGenerators[streamId].pause;
        stream.resume = function() {
          stream.resetFrameRate();
          return streamGenerators[streamId].resume.apply(this, arguments);
        };
        stream.seek = function() {
          stream.resetFrameRate();
          return streamGenerators[streamId].seek.apply(this, arguments);
        };
        stream.getCurrentPlayTime = streamGenerators[streamId].getCurrentPlayTime;
        stream.sendVideoPacketsSinceLastKeyFrame =
          streamGenerators[streamId].sendVideoPacketsSinceLastKeyFrame;
        stream.isPaused = streamGenerators[streamId].isPaused;
        logger.debug(`created stream ${stream.id}`);
      }
      return stream;
    } else { // recorded dir
      for (let app in recordedAppToDir) {
        let dir = recordedAppToDir[app];
        if (streamId.slice(0, +app.length + 1 || undefined) === (app + '/')) {
          var filetype, match;
          let filename = streamId.slice(app.length+1);

          // Strip "filetype:" from "filetype:filename"
          if ((match = /^(\w*?):(.*)$/.exec(filename)) != null) {
            filetype = match[1];
            filename = match[2];
          } else {
            filetype = 'mp4';  // default extension
          }

          filename = path.normalize(filename);

          // Check that filename is legitimate
          let pathSep = path.sep;
          if (pathSep === '\\') {  // Windows
            pathSep = `\${pathSep}`;  // Escape '\' for regex
          }
          if ((filename === '.') ||
          new RegExp(`(^|${pathSep})..(${pathSep}|$)`).test(filename)) {
            logger.warn(`rejected request to stream: ${streamId}`);
            break;
          }

          try {
            fs.accessSync(`${dir}/${filename}`, fs.R_OK);
          } catch (e) {
            // Add extension to the end and try again
            try {
              fs.accessSync(`${dir}/${filename}.${filetype}`, fs.R_OK);
              filename = `${filename}.${filetype}`;
            } catch (e) {
              logger.error(`error: failed to read ${dir}/${filename} or ${dir}/${filename}.${filetype}: ${e}`);
              return null;
            }
          }
          stream = MP4Stream.create(`${dir}/${filename}`);
          logger.info(`created stream ${stream.id} from ${dir}/${filename}`);
          return stream;
        }
      }
      return null;
    }
  },

  attachRecordedDirToApp(dir, appName) {
    if (recordedAppToDir[appName] != null) {
      logger.warn(`warning: avstreams.attachRecordedDirToApp: overwriting existing app: ${appName}`);
    }
    return recordedAppToDir[appName] = dir;
  },

  addGenerator(streamId, generator) {
    if (streamGenerators[streamId] != null) {
      logger.warn(`warning: avstreams.addGenerator(): overwriting generator: ${streamId}`);
    }
    return streamGenerators[streamId] = generator;
  },

  removeGenerator(streamId) {
    if (streamGenerators[streamId] != null) {
      streamGenerators[streamId].teardown();
    }
    return delete streamGenerators[streamId];
  },

  createNewStreamId() {
    let retryCount = 0;
    while (true) {
      let id = createStreamId();
      if (!api.exists(id)) {
        return id;
      }
      retryCount++;
      if (retryCount >= 100) {
        throw new Error("avstreams.createNewStreamId: Failed to create new stream id");
      }
    }
  },

  // Creates a new stream.
  // If streamId is not given, a unique id will be generated.
  create(streamId) {
    if ((streamId == null)) {
      streamId = api.createNewStreamId();
    }
    let stream = new AVStream(streamId);
    logger.debug(`created stream ${streamId}`);
    api.emit('new', stream);
    api.add(stream);
    return stream;
  },

  getOrCreate(streamId) {
    let stream = streams[streamId];
    if ((stream == null)) {
      stream = api.create(streamId);
    }
    return stream;
  },

  add(stream) {
    if (streams[stream.id] != null) {
      logger.warn(`warning: overwriting stream: ${stream.id}`);
    }
    streams[stream.id] = stream;
    api.emit('add_stream', stream);
    stream._onAnyListener = (stream =>
      function(eventName, ...data) {
        api.emit(eventName, stream, ...data);
        if (eventName === 'destroy') {
          return api.remove(stream.id);
        }
      }
    )(stream);
    return stream.onAny(stream._onAnyListener);
  },

  remove(streamId) {
    let stream;
    if (typeof(streamId) === 'object') {
      // streamId argument might be stream object
      stream = streamId;
      streamId = stream != null ? stream.id : undefined;
    } else {
      stream = streams[streamId];
    }
    if (stream != null) {
      stream.offAny(stream._onAnyListener);
      api.emit('remove_stream', stream);
    }
    return delete streams[streamId];
  },

  clear() {
    streams = {};
    return api.emit('clear_streams');
  },

  dump() {
    logger.raw(`[streams: ${Object.keys(streams).length}]`);
    return (() => {
      let result = [];
      for (let streamId in streams) {
        let stream = streams[streamId];
        result.push(logger.raw(` ${stream.toString()}`));
      }
      return result;
    })();
  }
};

export default api;

function __guardMethod__(obj, methodName, transform) {
  if (typeof obj !== 'undefined' && obj !== null && typeof obj[methodName] === 'function') {
    return transform(obj, methodName);
  } else {
    return undefined;
  }
}