import Bits from './bits';
import EventEmitterModule from './event_emitter';
import Sequent from 'sequent';
import fs from 'fs';
import logger from './logger';
import h264 from './h264';

let formatDate = date => date.toISOString();

// copyright sign + 'too' (we should not use literal '\xa9'
// since it expands to [0xc2, 0xa9])
let TAG_CTOO = new Buffer([0xa9, 0x74, 0x6f, 0x6f]).toString('utf8');

let MIN_TIME_DIFF = 0.01;  // seconds
let READ_BUFFER_TIME = 3.0;
let QUEUE_BUFFER_TIME = 1.5;

const DEBUG = false;

// If true, outgoing audio/video packets will be printed
let DEBUG_OUTGOING_MP4_DATA = false;

let getCurrentTime = function() {
  let time = process.hrtime();
  return time[0] + (time[1] / 1e9);
};

class MP4File extends EventEmitterModule {
  constructor(filename) {
    super();
    if (filename != null) {
      this.open(filename);
    }
    this.isStopped = false;
  }

  clearBuffers() {
    this.consumedAudioChunks = 0;
    this.consumedVideoChunks = 0;
    this.bufferedAudioTime = 0;
    this.bufferedVideoTime = 0;
    this.queuedAudioTime = 0;
    this.queuedVideoTime = 0;
    this.bufferedAudioSamples = [];
    this.queuedAudioSampleIndex = 0;
    this.bufferedVideoSamples = [];
    this.queuedVideoSampleIndex = 0;
    this.isAudioEOF = false;
    this.isVideoEOF = false;
    return this.sessionId++;
  }

  open(filename) {
    let startTime;
    this.filename = filename;
    if (DEBUG) {
      startTime = process.hrtime();
    }
    this.fileBuf = fs.readFileSync(filename);  // up to 1GB
    this.bits = new Bits(this.fileBuf);
    if (DEBUG) {
      let diffTime = process.hrtime(startTime);
      logger.debug(`[mp4] took ${((diffTime[0] * 1e9) + diffTime[1]) / 1000000} ms to read ${filename}`);
    }

    this.consumedAudioSamples = 0;
    this.consumedVideoSamples = 0;
    this.clearBuffers();

    this.currentPlayTime = 0;
    this.playStartTime = null;

    // sessionId will change when buffer is cleared
    return this.sessionId = 0;
  }

  close() {
    logger.debug(`[mp4:${this.filename}] close`);
    if (!this.isStopped) {
      this.stop();
    }
    this.bits = null;
    this.fileBuf = null;
    this.boxes = null;
    this.moovBox = null;
    this.mdatBox = null;
    this.audioTrakBox = null;
    this.videoTrakBox = null;
  }

  parse() {
    let startTime;
    if (DEBUG) {
      startTime = process.hrtime();
    }
    this.boxes = [];
    while (this.bits.has_more_data()) {
      let box = Box.parse(this.bits, null);  // null == root box
      if (box instanceof MovieBox) {
        this.moovBox = box;
      } else if (box instanceof MediaDataBox) {
        this.mdatBox = box;
      }
      this.boxes.push(box);
    }
    if (DEBUG) {
      let diffTime = process.hrtime(startTime);
      logger.debug(`[mp4] took ${((diffTime[0] * 1e9) + diffTime[1]) / 1000000} ms to parse ${this.filename}`);
    }

    for (let child of Array.from(this.moovBox.children)) {
      if (child instanceof TrackBox) {  // trak
        let tkhdBox = child.find('tkhd');
        if (tkhdBox.isAudioTrack) {
          this.audioTrakBox = child;
        } else {
          this.videoTrakBox = child;
        }
      }
    }

    this.numVideoSamples = this.getNumVideoSamples();
    this.numAudioSamples = this.getNumAudioSamples();

  }

  getTree() {
    if ((this.boxes == null)) {
      throw new Error("parse() must be called before dump");
    }
    let tree = { root: [] };
    for (let box of Array.from(this.boxes)) {
      tree.root.push(box.getTree());
    }
    return tree;
  }

  dump() {
    if ((this.boxes == null)) {
      throw new Error("parse() must be called before dump");
    }
    for (let box of Array.from(this.boxes)) {
      process.stdout.write(box.dump(0, 2));
    }
  }

  hasVideo() {
    return (this.videoTrakBox != null);
  }

  hasAudio() {
    return (this.audioTrakBox != null);
  }

  getSPS() {
    let avcCBox = this.videoTrakBox.find('avcC');
    return avcCBox.sequenceParameterSets[0];
  }

  getPPS() {
    let avcCBox = this.videoTrakBox.find('avcC');
    return avcCBox.pictureParameterSets[0];
  }

  getAudioSpecificConfig() {
    let esdsBox = this.audioTrakBox.find('esds');
    return esdsBox.decoderConfigDescriptor.decoderSpecificInfo.specificInfo;
  }

  stop() {
    return this.isStopped = true;
  }

  isPaused() {
    return this.isStopped;
  }

  pause() {
    if (!this.isStopped) {
      this.isStopped = true;
      return logger.debug(`[mp4:${this.filename}] paused at ${this.currentPlayTime} (server mp4 head time)`);
    } else {
      return logger.debug(`[mp4:${this.filename}] already paused`);
    }
  }

  sendVideoPacketsSinceLastKeyFrame(endSeconds, callback) {
    let videoSampleNumber;
    if ((this.videoTrakBox == null)) {  // video trak does not exist
      if (typeof callback === 'function') {
        callback(null);
      }
      return;
    }

    // Get next sample number
    let stblBox = this.videoTrakBox.child('mdia').child('minf').child('stbl');
    let sttsBox = stblBox.child('stts'); // TimeToSampleBox
    let videoSample = sttsBox.getSampleAfterSeconds(endSeconds);
    if (videoSample != null) {
      videoSampleNumber = videoSample.sampleNumber;
    } else {
      videoSampleNumber = this.numVideoSamples + 1;
    }

    let samples = [];
    let isFirstSample = true;
    while (true) {
      let rawSample = this.getSample(videoSampleNumber, this.videoTrakBox);
      let isKeyFrameFound = false;
      if (rawSample != null) {
        let nalUnits = this.parseH264Sample(rawSample.data);
        for (let nalUnit of Array.from(nalUnits)) {
          if ((nalUnit[0] & 0x1f) === h264.NAL_UNIT_TYPE_IDR_PICTURE) {
            isKeyFrameFound = true;
            break;
          }
        }
        if (!isFirstSample) {
          samples.unshift({
            pts: rawSample.pts,
            dts: rawSample.dts,
            time: rawSample.time,
            data: nalUnits
          });
        }
      }
      if (isFirstSample) {
        isFirstSample = false;
      }
      if (isKeyFrameFound) {
        break;
      }
      videoSampleNumber--;
      if (videoSampleNumber <= 0) {
        break;
      }
    }
    for (let sample of Array.from(samples)) {
      this.emit('video_data', sample.data, sample.pts, sample.dts);
    }

    return (typeof callback === 'function' ? callback(null) : undefined);
  }

  resume() {
    return this.play();
  }

  isAudioEOFReached() {
    return (this.bufferedAudioSamples.length === 0) &&
      (this.consumedAudioSamples === this.numAudioSamples);
  }

  isVideoEOFReached() {
    return (this.bufferedVideoSamples.length === 0) &&
      (this.consumedVideoSamples === this.numVideoSamples);
  }

  fillBuffer(callback) {
    let seq = new Sequent;

    this.bufferAudio(() => {
      // audio samples has been buffered
      return seq.done();
    }
    );

    this.bufferVideo(() => {
      // video samples has been buffered
      return seq.done();
    }
    );

    return seq.wait(2, callback);
  }

  seek(seekSeconds) {
    let audioSampleNumber, stblBox, sttsBox, videoSampleNumber, videoSampleSeconds;
    if (seekSeconds == null) { seekSeconds = 0; }
    logger.debug(`[mp4:${this.filename}] seek: seconds=${seekSeconds}`);
    this.clearBuffers();

    if (this.videoTrakBox != null) {
      // Seek video sample
      stblBox = this.videoTrakBox.child('mdia').child('minf').child('stbl');
      sttsBox = stblBox.child('stts'); // TimeToSampleBox
      let videoSample = sttsBox.getSampleAfterSeconds(seekSeconds);
      if (videoSample != null) {
        logger.debug(`video sample >= ${seekSeconds} is ${JSON.stringify(videoSample)}`);
        videoSampleSeconds = videoSample.seconds;
        this.currentPlayTime = videoSampleSeconds;
        videoSampleNumber = videoSample.sampleNumber;
      } else {
        // No video sample left
        logger.debug(`video sample >= ${seekSeconds} does not exist`);
        this.isVideoEOF = true;
        this.currentPlayTime = this.getDurationSeconds();
        videoSampleNumber = this.numVideoSamples + 1;
        videoSampleSeconds = this.currentPlayTime;
      }
    } else {
      videoSampleNumber = null;
      videoSampleSeconds = null;
    }

    if (this.audioTrakBox != null) {
      // Seek audio sample
      stblBox = this.audioTrakBox.child('mdia').child('minf').child('stbl');
      sttsBox = stblBox.child('stts'); // TimeToSampleBox
      let audioSample = sttsBox.getSampleAfterSeconds(seekSeconds);
      if (audioSample != null) {
        let minTime;
        logger.debug(`audio sample >= ${seekSeconds} is ${JSON.stringify(audioSample)}`);
        audioSampleNumber = audioSample.sampleNumber;

        if ((videoSampleSeconds != null) && (videoSampleSeconds <= audioSample.seconds)) {
          minTime = videoSampleSeconds;
        } else {
          minTime = audioSample.seconds;
        }
        if (this.currentPlayTime !== minTime) {
          this.currentPlayTime = minTime;
        }
      } else {
        // No audio sample left
        logger.debug(`audio sample >= ${seekSeconds} does not exist`);
        audioSampleNumber = this.numAudioSamples + 1;
        this.isAudioEOF = true;
      }
    } else {
      audioSampleNumber = null;
    }

    if (audioSampleNumber != null) {
      this.consumedAudioSamples = audioSampleNumber - 1;
    }

    if (videoSampleNumber != null) {
      this.consumedVideoSamples = videoSampleNumber - 1;
    }

    logger.debug(`[mp4:${this.filename}] set current play time to ${this.currentPlayTime}`);
    return this.currentPlayTime;
  }

  play() {
    logger.debug(`[mp4:${this.filename}] start playing from ${this.currentPlayTime} (server mp4 head time)`);
    return this.fillBuffer(() => {
      this.isStopped = false;
      this.playStartTime = getCurrentTime() - this.currentPlayTime;
      if (this.isAudioEOFReached()) {
        this.isAudioEOF = true;
      }
      if (this.isVideoEOFReached()) {
        this.isVideoEOF = true;
      }
      if (this.checkEOF()) {
        // EOF reached
        return false;
      } else {
        this.queueBufferedSamples();
        return true;
      }
    }
    );
  }

  checkAudioBuffer() {
    let timeDiff = this.bufferedAudioTime - this.currentPlayTime;
    if (timeDiff < READ_BUFFER_TIME) {
      // Fill audio buffer
      if (this.readNextAudioChunk()) {
        // Audio EOF not reached
        this.queueBufferedSamples();
      }
    } else {
      this.queueBufferedSamples();
    }
  }

  checkVideoBuffer() {
    let timeDiff = this.bufferedVideoTime - this.currentPlayTime;
    if (timeDiff < READ_BUFFER_TIME) {
      // Fill video buffer
      if (this.readNextVideoChunk()) {
        // Video EOF not reached
        this.queueBufferedSamples();
      }
    } else {
      this.queueBufferedSamples();
    }
  }

  startStreaming() {
    return this.queueBufferedSamples();
  }

  updateCurrentPlayTime() {
    return this.currentPlayTime = getCurrentTime() - this.playStartTime;
  }

  queueBufferedAudioSamples() {
    let audioSample = this.bufferedAudioSamples[this.queuedAudioSampleIndex];
    if ((audioSample == null)) {  // @bufferedAudioSamples is empty
      return;
    }
    let timeDiff = audioSample.time - this.currentPlayTime;
    if (timeDiff <= MIN_TIME_DIFF) {
      this.bufferedAudioSamples.shift();
      this.queuedAudioSampleIndex--;
      if (DEBUG_OUTGOING_MP4_DATA) {
        logger.info(`emit audio_data pts=${audioSample.pts}`);
      }
      this.emit('audio_data', audioSample.data, audioSample.pts);
      this.updateCurrentPlayTime();
      if ((this.queuedAudioSampleIndex === 0) && (this.consumedAudioSamples === this.numAudioSamples)) {
        // No audio sample left
        this.isAudioEOF = true;
        this.checkEOF();
      }
    } else {
      if (!this.isStopped) {
        let { sessionId } = this;
        setTimeout(() => {
          if ((!this.isStopped) && (this.sessionId === sessionId)) {
            this.bufferedAudioSamples.shift();
            this.queuedAudioSampleIndex--;
            if (DEBUG_OUTGOING_MP4_DATA) {
              logger.info(`emit timed audio_data pts=${audioSample.pts}`);
            }
            this.emit('audio_data', audioSample.data, audioSample.pts);
            this.updateCurrentPlayTime();
            if ((this.queuedAudioSampleIndex === 0) && (this.consumedAudioSamples === this.numAudioSamples)) {
              // No audio sample left
              this.isAudioEOF = true;
              return this.checkEOF();
            } else {
              return this.checkAudioBuffer();
            }
          }
        }
        , timeDiff * 1000);
      }
    }
    this.queuedAudioSampleIndex++;
    this.queuedAudioTime = audioSample.time;
    if ((this.queuedAudioTime - this.currentPlayTime) < QUEUE_BUFFER_TIME) {
      return this.queueBufferedSamples();
    }
  }

  queueBufferedVideoSamples() {
    let nalUnit, totalBytes;
    if (this.isStopped) {
      return;
    }
    let videoSample = this.bufferedVideoSamples[this.queuedVideoSampleIndex];
    if ((videoSample == null)) {  // @bufferedVideoSamples is empty
      return;
    }
    let timeDiff = videoSample.time - this.currentPlayTime;
    if (timeDiff <= MIN_TIME_DIFF) {
      this.bufferedVideoSamples.shift();
      this.queuedVideoSampleIndex--;
      if (DEBUG_OUTGOING_MP4_DATA) {
        totalBytes = 0;
        for (nalUnit of Array.from(videoSample.data)) {
          totalBytes += nalUnit.length;
        }
        logger.info(`emit video_data pts=${videoSample.pts} dts=${videoSample.dts} bytes=${totalBytes}`);
      }
      this.emit('video_data', videoSample.data, videoSample.pts, videoSample.dts);
      this.updateCurrentPlayTime();
      if ((this.queuedVideoSampleIndex === 0) && (this.consumedVideoSamples === this.numVideoSamples)) {
        // No video sample left
        this.isVideoEOF = true;
        this.checkEOF();
      }
    } else {
      let { sessionId } = this;
      setTimeout(() => {
        if ((!this.isStopped) && (this.sessionId === sessionId)) {
          this.bufferedVideoSamples.shift();
          this.queuedVideoSampleIndex--;
          if (DEBUG_OUTGOING_MP4_DATA) {
            totalBytes = 0;
            for (nalUnit of Array.from(videoSample.data)) {
              totalBytes += nalUnit.length;
            }
            logger.info(`emit timed video_data pts=${videoSample.pts} dts=${videoSample.dts} bytes=${totalBytes}`);
          }
          this.emit('video_data', videoSample.data, videoSample.pts, videoSample.dts);
          this.updateCurrentPlayTime();
          if ((this.queuedVideoSampleIndex === 0) && (this.consumedVideoSamples === this.numVideoSamples)) {
            // No video sample left
            this.isVideoEOF = true;
            return this.checkEOF();
          } else {
            return this.checkVideoBuffer();
          }
        }
      }
      , timeDiff * 1000);
    }
    this.queuedVideoSampleIndex++;
    this.queuedVideoTime = videoSample.time;
    if ((this.queuedVideoTime - this.currentPlayTime) < QUEUE_BUFFER_TIME) {
      return this.queueBufferedSamples();
    }
  }

  queueBufferedSamples() {
    if (this.isStopped) {
      return;
    }

    // Determine which of audio or video should be sent first
    let firstAudioTime = this.bufferedAudioSamples[this.queuedAudioSampleIndex] != null ? this.bufferedAudioSamples[this.queuedAudioSampleIndex].time : undefined;
    let firstVideoTime = this.bufferedVideoSamples[this.queuedVideoSampleIndex] != null ? this.bufferedVideoSamples[this.queuedVideoSampleIndex].time : undefined;
    if ((firstAudioTime != null) && (firstVideoTime != null)) {
      if (firstVideoTime <= firstAudioTime) {
        this.queueBufferedVideoSamples();
        return this.queueBufferedAudioSamples();
      } else {
        this.queueBufferedAudioSamples();
        return this.queueBufferedVideoSamples();
      }
    } else {
      this.queueBufferedAudioSamples();
      return this.queueBufferedVideoSamples();
    }
  }

  checkEOF() {
    if (this.isAudioEOF && this.isVideoEOF) {
      this.stop();
      this.emit('eof');
      return true;
    }
    return false;
  }

  bufferAudio(callback) {
    // TODO: Use async
    while (this.bufferedAudioTime < (this.currentPlayTime + READ_BUFFER_TIME)) {
      if (!this.readNextAudioChunk()) {
        // No audio sample left
        break;
      }
    }
    return (typeof callback === 'function' ? callback() : undefined);
  }

  bufferVideo(callback) {
    // TODO: Use async
    while (this.bufferedVideoTime < (this.currentPlayTime + READ_BUFFER_TIME)) {
      if (!this.readNextVideoChunk()) {
        // No video sample left
        break;
      }
    }
    return (typeof callback === 'function' ? callback() : undefined);
  }

  getNumVideoSamples() {
    if (this.videoTrakBox != null) {
      let sttsBox = this.videoTrakBox.find('stts');
      return sttsBox.getTotalSamples();
    } else {
      return 0;
    }
  }

  getNumAudioSamples() {
    if (this.audioTrakBox != null) {
      let sttsBox = this.audioTrakBox.find('stts');
      return sttsBox.getTotalSamples();
    } else {
      return 0;
    }
  }

  // Returns the timestamp of the last sample in the file
  getLastTimestamp() {
    let audioLastTimestamp, sttsBox, videoLastTimestamp;
    if (this.videoTrakBox != null) {
      let numVideoSamples = this.getNumVideoSamples();
      sttsBox = this.videoTrakBox.find('stts');
      videoLastTimestamp = sttsBox.getDecodingTime(numVideoSamples).seconds;
    } else {
      videoLastTimestamp = 0;
    }

    if (this.audioTrakBox != null) {
      let numAudioSamples = this.getNumAudioSamples();
      sttsBox = this.audioTrakBox.find('stts');
      audioLastTimestamp = sttsBox.getDecodingTime(numAudioSamples).seconds;
    } else {
      audioLastTimestamp = 0;
    }

    if (audioLastTimestamp > videoLastTimestamp) {
      return audioLastTimestamp;
    } else {
      return videoLastTimestamp;
    }
  }

  getDurationSeconds() {
    let mvhdBox = this.moovBox.child('mvhd');
    return mvhdBox.durationSeconds;
  }

  parseH264Sample(buf) {
    // The format is defined in ISO 14496-15 5.2.3
    // <length><NAL unit> <length><NAL unit> ...

    let avcCBox = this.videoTrakBox.find('avcC');
    let lengthSize = avcCBox.lengthSizeMinusOne + 1;
    let bits = new Bits(buf);

    let nalUnits = [];

    while (bits.has_more_data()) {
      let length = bits.read_bits(lengthSize * 8);
      nalUnits.push(bits.read_bytes(length));
    }

    if (bits.get_remaining_bits() !== 0) {
      throw new Error(`number of remaining bits is not zero: ${bits.get_remaining_bits()}`);
    }

    return nalUnits;
  }

  getSample(sampleNumber, trakBox) {
    let stblBox = trakBox.child('mdia').child('minf').child('stbl');
    let sttsBox = stblBox.child('stts');
    let stscBox = stblBox.child('stsc');
    let chunkNumber = stscBox.findChunk(sampleNumber);

    // Get chunk offset in the file
    let stcoBox = stblBox.child('stco');
    let chunkOffset = stcoBox.getChunkOffset(chunkNumber);

    let firstSampleNumberInChunk = stscBox.getFirstSampleNumberInChunk(chunkNumber);

    // Get an array of sample sizes in this chunk
    let stszBox = stblBox.child('stsz');
    let sampleSizes = stszBox.getSampleSizes(firstSampleNumberInChunk,
      (sampleNumber - firstSampleNumberInChunk) + 1);

    let cttsBox = stblBox.child('ctts');
    let samples = [];
    let sampleOffset = 0;
    let mdhdBox = trakBox.child('mdia').child('mdhd');
    for (let i = 0; i < sampleSizes.length; i++) {
      let sampleSize = sampleSizes[i];
      if ((firstSampleNumberInChunk + i) === sampleNumber) {
        var dts, pts;
        let compositionTimeOffset = 0;
        if (cttsBox != null) {
          compositionTimeOffset = cttsBox.getCompositionTimeOffset(sampleNumber);
        }
        let sampleTime = sttsBox.getDecodingTime(sampleNumber);
        let compositionTime = sampleTime.time + compositionTimeOffset;
        if (mdhdBox.timescale !== 90000) {
          pts = Math.floor((compositionTime * 90000) / mdhdBox.timescale);
          dts = Math.floor((sampleTime.time * 90000) / mdhdBox.timescale);
        } else {
          pts = compositionTime;
          dts = sampleTime.time;
        }
        return {
          pts,
          dts,
          time: sampleTime.seconds,
          data: this.fileBuf.slice(chunkOffset+sampleOffset, chunkOffset+sampleOffset+sampleSize)
        };
      }
      sampleOffset += sampleSize;
    }

    return null;
  }

  readChunk(chunkNumber, fromSampleNumber, trakBox) {
    let stblBox = trakBox.child('mdia').child('minf').child('stbl');
    let sttsBox = stblBox.child('stts');
    let stscBox = stblBox.child('stsc');
    let numSamplesInChunk = stscBox.getNumSamplesInChunk(chunkNumber);

    // Get chunk offset in the file
    let stcoBox = stblBox.child('stco');
    let chunkOffset = stcoBox.getChunkOffset(chunkNumber);

    let firstSampleNumberInChunk = stscBox.getFirstSampleNumberInChunk(chunkNumber);

    // Get an array of sample sizes in this chunk
    let stszBox = stblBox.child('stsz');
    let sampleSizes = stszBox.getSampleSizes(firstSampleNumberInChunk, numSamplesInChunk);

    let cttsBox = stblBox.child('ctts');
    let samples = [];
    let sampleOffset = 0;
    let mdhdBox = trakBox.child('mdia').child('mdhd');
    for (let i = 0; i < sampleSizes.length; i++) {
      let sampleSize = sampleSizes[i];
      if ((firstSampleNumberInChunk + i) >= fromSampleNumber) {
        var dts, pts;
        let compositionTimeOffset = 0;
        if (cttsBox != null) {
          compositionTimeOffset = cttsBox.getCompositionTimeOffset(firstSampleNumberInChunk + i);
        }
        let sampleTime = sttsBox.getDecodingTime(firstSampleNumberInChunk + i);
        let compositionTime = sampleTime.time + compositionTimeOffset;
        if (mdhdBox.timescale !== 90000) {
          pts = Math.floor((compositionTime * 90000) / mdhdBox.timescale);
          dts = Math.floor((sampleTime.time * 90000) / mdhdBox.timescale);
        } else {
          pts = compositionTime;
          dts = sampleTime.time;
        }
        samples.push({
          pts,
          dts,
          time: sampleTime.seconds,
          data: this.fileBuf.slice(chunkOffset+sampleOffset, chunkOffset+sampleOffset+sampleSize)
        });
      }
      sampleOffset += sampleSize;
    }

    return samples;
  }

  readNextVideoChunk() {
    let samples;
    if (this.consumedVideoSamples >= this.numVideoSamples) {
      return false;
    }

    if ((this.consumedVideoChunks === 0) && (this.consumedVideoSamples !== 0)) { // seeked
      let stscBox = this.videoTrakBox.find('stsc');
      let chunkNumber = stscBox.findChunk(this.consumedVideoSamples + 1);
      samples = this.readChunk(chunkNumber, this.consumedVideoSamples + 1, this.videoTrakBox);
      this.consumedVideoChunks = chunkNumber;
    } else {
      samples = this.readChunk(this.consumedVideoChunks + 1, this.consumedVideoSamples + 1, this.videoTrakBox);
      this.consumedVideoChunks++;
    }

    for (let sample of Array.from(samples)) {
      let nalUnits = this.parseH264Sample(sample.data);
      sample.data = nalUnits;
    }

    let numSamples = samples.length;
    this.consumedVideoSamples += numSamples;
    this.bufferedVideoTime = samples[numSamples - 1].time;
    this.bufferedVideoSamples = this.bufferedVideoSamples.concat(samples);

    return true;
  }

  parseAACSample(buf) {}
    // nop

  readNextAudioChunk() {
    let samples;
    if (this.consumedAudioSamples >= this.numAudioSamples) {
      return false;
    }

    if ((this.consumedAudioChunks === 0) && (this.consumedAudioSamples !== 0)) { // seeked
      let stscBox = this.audioTrakBox.find('stsc');
      let chunkNumber = stscBox.findChunk(this.consumedAudioSamples + 1);
      samples = this.readChunk(chunkNumber, this.consumedAudioSamples + 1, this.audioTrakBox);
      this.consumedAudioChunks = chunkNumber;
    } else {
      samples = this.readChunk(this.consumedAudioChunks + 1, this.consumedAudioSamples + 1, this.audioTrakBox);
      this.consumedAudioChunks++;
    }

//    for sample in samples
//      @parseAACSample sample.data

    this.consumedAudioSamples += samples.length;
    this.bufferedAudioTime = samples[samples.length-1].time;
    this.bufferedAudioSamples = this.bufferedAudioSamples.concat(samples);

    return true;
  }
}

//EventEmitterModule.mixin(MP4File);

class Box {
  // time: seconds since midnight, Jan. 1, 1904 UTC
  static mp4TimeToDate(time) {
    return new Date(new Date('1904-01-01 00:00:00+0000').getTime() + (time * 1000));
  }

  getTree() {
    let obj =
      {type: this.typeStr};
    if (this.children != null) {
      obj.children = [];
      for (let child of Array.from(this.children)) {
        obj.children.push(child.getTree());
      }
    }
    return obj;
  }

  dump(depth, detailLevel) {
    if (depth == null) { depth = 0; }
    if (detailLevel == null) { detailLevel = 0; }
    let str = '';
    for (let i = 0, end = depth, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      str += '  ';
    }
    str += `${this.typeStr}`;
    if (detailLevel > 0) {
      let detailString = this.getDetails(detailLevel);
      if (detailString != null) {
        str += ` (${detailString})`;
      }
    }
    str += "\n";
    if (this.children != null) {
      for (let child of Array.from(this.children)) {
        str += child.dump(depth+1, detailLevel);
      }
    }
    return str;
  }

  getDetails(detailLevel) {
    return null;
  }

  constructor(info) {
    for (let name in info) {
      let value = info[name];
      this[name] = value;
    }
    if (this.data != null) {
      this.read(this.data);
    }
  }

  readFullBoxHeader(bits) {
    this.version = bits.read_byte();
    this.flags = bits.read_bits(24);
  }

  findParent(typeStr) {
    if (this.parent != null) {
      if (this.parent.typeStr === typeStr) {
        return this.parent;
      } else {
        return this.parent.findParent(typeStr);
      }
    } else {
      return null;
    }
  }

  child(typeStr) {
    if (this.typeStr === typeStr) {
      return this;
    } else {
      if (this.children != null) {
        for (let child of Array.from(this.children)) {
          if (child.typeStr === typeStr) {
            return child;
          }
        }
      }
      return null;
    }
  }

  find(typeStr) {
    if (this.typeStr === typeStr) {
      return this;
    } else {
      if (this.children != null) {
        for (let child of Array.from(this.children)) {
          let box = child.find(typeStr);
          if (box != null) {
            return box;
          }
        }
      }
      return null;
    }
  }

  read(buf) {}

  static readHeader(bits, destObj) {
    destObj.size = bits.read_uint32();
    destObj.type = bits.read_bytes(4);
    destObj.typeStr = destObj.type.toString('utf8');
    let headerLen = 8;
    if (destObj.size === 1) {
      destObj.size = bits.read_bits(64);  // TODO: might lose some precision
      headerLen += 8;
    }
    if (destObj.typeStr === 'uuid') {
      destObj.usertype = bits.read_bytes(16);
      headerLen += 16;
    }

    if (destObj.size > 0) {
      destObj.data = bits.read_bytes(destObj.size - headerLen);
    } else {
      destObj.data = bits.remaining_buffer();
      destObj.size = headerLen + destObj.data.length;
    }

  }

  static readLanguageCode(bits) {
    return Box.readASCII(bits) + Box.readASCII(bits) + Box.readASCII(bits);
  }

  static readASCII(bits) {
    let diff = bits.read_bits(5);
    return String.fromCharCode(0x60 + diff);
  }

  static parse(bits, parent, cls) {
    if (parent == null) { parent = null; }
    let info = {};
    info.parent = parent;
    this.readHeader(bits, info);

    switch (info.typeStr) {
      case 'ftyp':
        return new FileTypeBox(info);
      case 'moov':
        return new MovieBox(info);
      case 'mvhd':
        return new MovieHeaderBox(info);
      case 'mdat':
        return new MediaDataBox(info);
      case 'trak':
        return new TrackBox(info);
      case 'tkhd':
        return new TrackHeaderBox(info);
      case 'edts':
        return new EditBox(info);
      case 'elst':
        return new EditListBox(info);
      case 'mdia':
        return new MediaBox(info);
      case 'iods':
        return new ObjectDescriptorBox(info);
      case 'mdhd':
        return new MediaHeaderBox(info);
      case 'hdlr':
        return new HandlerBox(info);
      case 'minf':
        return new MediaInformationBox(info);
      case 'vmhd':
        return new VideoMediaHeaderBox(info);
      case 'dinf':
        return new DataInformationBox(info);
      case 'dref':
        return new DataReferenceBox(info);
      case 'url ':
        return new DataEntryUrlBox(info);
      case 'urn ':
        return new DataEntryUrnBox(info);
      case 'stbl':
        return new SampleTableBox(info);
      case 'stsd':
        return new SampleDescriptionBox(info);
      case 'stts':
        return new TimeToSampleBox(info);
      case 'stss':
        return new SyncSampleBox(info);
      case 'stsc':
        return new SampleToChunkBox(info);
      case 'stsz':
        return new SampleSizeBox(info);
      case 'stco':
        return new ChunkOffsetBox(info);
      case 'smhd':
        return new SoundMediaHeaderBox(info);
      case 'meta':
        return new MetaBox(info);
      case 'pitm':
        return new PrimaryItemBox(info);
      case 'iloc':
        return new ItemLocationBox(info);
      case 'ipro':
        return new ItemProtectionBox(info);
      case 'infe':
        return new ItemInfoEntry(info);
      case 'iinf':
        return new ItemInfoBox(info);
      case 'ilst':
        return new MetadataItemListBox(info);
      case 'gsst':
        return new GoogleGSSTBox(info);
      case 'gstd':
        return new GoogleGSTDBox(info);
      case 'gssd':
        return new GoogleGSSDBox(info);
      case 'gspu':
        return new GoogleGSPUBox(info);
      case 'gspm':
        return new GoogleGSPMBox(info);
      case 'gshh':
        return new GoogleGSHHBox(info);
      case 'udta':
        return new UserDataBox(info);
      case 'avc1':
        return new AVCSampleEntry(info);
      case 'avcC':
        return new AVCConfigurationBox(info);
      case 'btrt':
        return new MPEG4BitRateBox(info);
      case 'm4ds':
        return new MPEG4ExtensionDescriptorsBox(info);
      case 'mp4a':
        return new MP4AudioSampleEntry(info);
      case 'esds':
        return new ESDBox(info);
      case 'free':
        return new FreeSpaceBox(info);
      case 'ctts':
        return new CompositionOffsetBox(info);
      case TAG_CTOO:
        return new CTOOBox(info);
      default:
        if (cls != null) {
          return new cls(info);
        } else {
          logger.warn(`[mp4] warning: skipping unknown (not implemented) box type: ${info.typeStr} (0x${info.type.toString('hex')})`);
          return new Box(info);
        }
    }
  }
}

class Container extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.children = [];
    while (bits.has_more_data()) {
      let box = Box.parse(bits, this);
      this.children.push(box);
    }
  }
}

//  getDetails: (detailLevel) ->
//    "Container"

// moov
class MovieBox extends Container {}

// stbl
class SampleTableBox extends Container {}

// dinf
class DataInformationBox extends Container {}

// udta
class UserDataBox extends Container {}

// minf
class MediaInformationBox extends Container {}

// mdia
class MediaBox extends Container {}

// edts
class EditBox extends Container {}

// trak
class TrackBox extends Container {}

// ftyp
class FileTypeBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.majorBrand = bits.read_uint32();
    this.majorBrandStr = Bits.uintToString(this.majorBrand, 4);
    this.minorVersion = bits.read_uint32();
    this.compatibleBrands = [];
    while (bits.has_more_data()) {
      let brand = bits.read_bytes(4);
      let brandStr = brand.toString('utf8');
      this.compatibleBrands.push({
        brand,
        brandStr
      });
    }
  }

  getDetails(detailLevel) {
    return `brand=${this.majorBrandStr} version=${this.minorVersion}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.brand = this.majorBrandStr;
    obj.version = this.minorVersion;
    return obj;
  }
}

// mvhd
class MovieHeaderBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    if (this.version === 1) {
      this.creationTime = bits.read_bits(64);  // TODO: loses precision
      this.creationDate = Box.mp4TimeToDate(this.creationTime);
      this.modificationTime = bits.read_bits(64);  // TODO: loses precision
      this.modificationDate = Box.mp4TimeToDate(this.modificationTime);
      this.timescale = bits.read_uint32();
      this.duration = bits.read_bits(64);  // TODO: loses precision
      this.durationSeconds = this.duration / this.timescale;
    } else {  // @version is 0
      this.creationTime = bits.read_bits(32);  // TODO: loses precision
      this.creationDate = Box.mp4TimeToDate(this.creationTime);
      this.modificationTime = bits.read_bits(32);  // TODO: loses precision
      this.modificationDate = Box.mp4TimeToDate(this.modificationTime);
      this.timescale = bits.read_uint32();
      this.duration = bits.read_bits(32);  // TODO: loses precision
      this.durationSeconds = this.duration / this.timescale;
    }
    this.rate = bits.read_int(32);
    if (this.rate !== 0x00010000) {  // 1.0
      logger.warn(`[mp4] warning: Irregular rate found in mvhd box: ${this.rate}`);
    }
    this.volume = bits.read_int(16);
    if (this.volume !== 0x0100) {  // full volume
      logger.warn(`[mp4] warning: Irregular volume found in mvhd box: ${this.volume}`);
    }
    let reserved = bits.read_bits(16);
    if (reserved !== 0) {
      throw new Error(`reserved bits are not all zero: ${reserved}`);
    }
    let reservedInt1 = bits.read_int(32);
    if (reservedInt1 !== 0) {
      throw new Error(`reserved int(32) (1) is not zero: ${reservedInt1}`);
    }
    let reservedInt2 = bits.read_int(32);
    if (reservedInt2 !== 0) {
      throw new Error(`reserved int(32) (2) is not zero: ${reservedInt2}`);
    }
    bits.skip_bytes(4 * 9);  // Unity matrix
    bits.skip_bytes(4 * 6);  // pre_defined
    this.nextTrackID = bits.read_uint32();

    if (bits.has_more_data()) {
      throw new Error("mvhd box has more data");
    }
  }

  getDetails(detailLevel) {
    return `created=${formatDate(this.creationDate)} modified=${formatDate(this.modificationDate)} timescale=${this.timescale} durationSeconds=${this.durationSeconds}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.creationDate = this.creationDate;
    obj.modificationDate = this.modificationDate;
    obj.timescale = this.timescale;
    obj.duration = this.duration;
    obj.durationSeconds = this.durationSeconds;
    return obj;
  }
}

// Object Descriptor Box: contains an Object Descriptor or an Initial Object Descriptor
// (iods)
// Defined in ISO 14496-14
class ObjectDescriptorBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);
  }
}

// Track header box: specifies the characteristics of a single track (tkhd)
class TrackHeaderBox extends Box {
  read(buf) {
    let reserved;
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    if (this.version === 1) {
      this.creationTime = bits.read_bits(64);  // TODO: loses precision
      this.creationDate = Box.mp4TimeToDate(this.creationTime);
      this.modificationTime = bits.read_bits(64);  // TODO: loses precision
      this.modificationDate = Box.mp4TimeToDate(this.modificationTime);
      this.trackID = bits.read_uint32();
      reserved = bits.read_uint32();
      if (reserved !== 0) {
        throw new Error(`tkhd: reserved bits are not zero: ${reserved}`);
      }
      this.duration = bits.read_bits(64);  // TODO: loses precision
    } else {  // @version is 0
      this.creationTime = bits.read_bits(32);  // TODO: loses precision
      this.creationDate = Box.mp4TimeToDate(this.creationTime);
      this.modificationTime = bits.read_bits(32);  // TODO: loses precision
      this.modificationDate = Box.mp4TimeToDate(this.modificationTime);
      this.trackID = bits.read_uint32();
      reserved = bits.read_uint32();
      if (reserved !== 0) {
        throw new Error(`tkhd: reserved bits are not zero: ${reserved}`);
      }
      this.duration = bits.read_bits(32);  // TODO: loses precision
    }
    reserved = bits.read_bits(64);
    if (reserved !== 0) {
      throw new Error(`tkhd: reserved bits are not zero: ${reserved}`);
    }
    this.layer = bits.read_int(16);
    if (this.layer !== 0) {
      logger.warn(`[mp4] warning: layer is not 0 in tkhd box: ${this.layer}`);
    }
    this.alternateGroup = bits.read_int(16);
//    if @alternateGroup isnt 0
//      logger.warn "[mp4] warning: alternate_group is not 0 in tkhd box: #{@alternateGroup}"
    this.volume = bits.read_int(16);
    if (this.volume === 0x0100) {
      this.isAudioTrack = true;
    } else {
      this.isAudioTrack = false;
    }
    reserved = bits.read_bits(16);
    if (reserved !== 0) {
      throw new Error(`tkhd: reserved bits are not zero: ${reserved}`);
    }
    bits.skip_bytes(4 * 9);
    this.width = bits.read_uint32() / 65536;  // fixed-point 16.16 value
    this.height = bits.read_uint32() / 65536;  // fixed-point 16.16 value

    if (bits.has_more_data()) {
      throw new Error("tkhd box has more data");
    }
  }

  getDetails(detailLevel) {
    let str = `created=${formatDate(this.creationDate)} modified=${formatDate(this.modificationDate)}`;
    if (this.isAudioTrack) {
      str += " audio";
    } else {
      str += ` video; width=${this.width} height=${this.height}`;
    }
    return str;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.creationDate = this.creationDate;
    obj.modificationDate = this.modificationDate;
    obj.isAudioTrack = this.isAudioTrack;
    obj.width = this.width;
    obj.height = this.height;
    return obj;
  }
}

// elst
// Edit list box: explicit timeline map
class EditListBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    // moov
    //   mvhd <- find target
    //   iods
    //   trak
    //     tkhd
    //     edts
    //       elst <- self
    let mvhdBox = this.findParent('moov').find('mvhd');

    // We cannot get mdhd box at this time, since it is not parsed yet

    let entryCount = bits.read_uint32();
    this.entries = [];
    for (let i = 1, end = entryCount, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
      var mediaTime, segmentDuration;
      if (this.version === 1) {
        segmentDuration = bits.read_bits(64);  // TODO: loses precision
        mediaTime = bits.read_int(64);
      } else {  // @version is 0
        segmentDuration = bits.read_bits(32);
        mediaTime = bits.read_int(32);
      }
      let mediaRateInteger = bits.read_int(16);
      let mediaRateFraction = bits.read_int(16);
      if (mediaRateFraction !== 0) {
        logger.warn(`[mp4] warning: media_rate_fraction is not 0 in elst box: ${mediaRateFraction}`);
      }
      this.entries.push({
        segmentDuration,  // in Movie Header Box (mvhd) timescale
        segmentDurationSeconds: segmentDuration / mvhdBox.timescale,
        mediaTime,  // in media (mdhd) timescale
        mediaRate: mediaRateInteger + (mediaRateFraction / 65536)
      });
    } // TODO: Is this correct?

    if (bits.has_more_data()) {
      throw new Error("elst box has more data");
    }
  }

  // Returns the starting offset for this track in mdhd timescale units
  getEmptyDuration() {
    let time = 0;
    for (let entry of Array.from(this.entries)) {
      if (entry.mediaTime === -1) {  // empty edit
        // moov
        //   mvhd <- find target
        //   iods
        //   trak
        //     tkhd
        //     edts
        //       elst <- self
        let mvhdBox = this.findParent('moov').child('mvhd');

        //   trak
        //     tkhd
        //     edts
        //       elst <- self
        //     mdia
        //       mdhd <- find target
        let mdhdBox = this.findParent('trak').child('mdia').child('mdhd');
        if ((mdhdBox == null)) {
          throw new Error("cannot access mdhd box (not parsed yet?)");
        }

        // Convert segmentDuration from mvhd timescale to mdhd timescale
        time += (entry.segmentDuration * mdhdBox.timescale) / mvhdBox.timescale;
      } else {
        // mediaTime is already in mdhd timescale, so no conversion needed
        return time + entry.mediaTime;
      }
    }
  }

  getDetails(detailLevel) {
    return this.entries.map((entry, index) => `[${index}]:segmentDuration=${entry.segmentDuration},segmentDurationSeconds=${entry.segmentDurationSeconds},mediaTime=${entry.mediaTime},mediaRate=${entry.mediaRate}`).join(',');
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.entries = this.entries;
    return obj;
  }
}

// Media Header Box (mdhd): declares overall information
// Container: Media Box ('mdia')
// Defined in ISO 14496-12
class MediaHeaderBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    if (this.version === 1) {
      this.creationTime = bits.read_bits(64);  // TODO: loses precision
      this.creationDate = Box.mp4TimeToDate(this.creationTime);
      this.modificationTime = bits.read_bits(64);  // TODO: loses precision
      this.modificationDate = Box.mp4TimeToDate(this.modificationTime);
      this.timescale = bits.read_uint32();
      this.duration = bits.read_bits(64);  // TODO: loses precision
    } else {  // @version is 0
      this.creationTime = bits.read_bits(32);
      this.creationDate = Box.mp4TimeToDate(this.creationTime);
      this.modificationTime = bits.read_bits(32);
      this.modificationDate = Box.mp4TimeToDate(this.modificationTime);
      this.timescale = bits.read_uint32();
      this.duration = bits.read_uint32();
    }
    this.durationSeconds = this.duration / this.timescale;
    let pad = bits.read_bit();
    if (pad !== 0) {
      throw new Error(`mdhd: pad is not 0: ${pad}`);
    }
    this.language = Box.readLanguageCode(bits);
    let pre_defined = bits.read_bits(16);
    if (pre_defined !== 0) {
      throw new Error(`mdhd: pre_defined is not 0: ${pre_defined}`);
    }
  }

  getDetails(detailLevel) {
    return `created=${formatDate(this.creationDate)} modified=${formatDate(this.modificationDate)} timescale=${this.timescale} durationSeconds=${this.durationSeconds} lang=${this.language}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.creationDate = this.creationDate;
    obj.modificationDate = this.modificationDate;
    obj.timescale = this.timescale;
    obj.duration = this.duration;
    obj.durationSeconds = this.durationSeconds;
    obj.language = this.language;
    return obj;
  }
}

// Handler Reference Box (hdlr): declares the nature of the media in a track
// Container: Media Box ('mdia') or Meta Box ('meta')
// Defined in ISO 14496-12
class HandlerBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    let pre_defined = bits.read_bits(32);
    if (pre_defined !== 0) {
      throw new Error(`hdlr: pre_defined is not 0 (got ${pre_defined})`);
    }
    this.handlerType = bits.read_bytes(4).toString('utf8');
    // vide: Video track
    // soun: Audio track
    // hint: Hint track
    bits.skip_bytes(4 * 3);  // reserved 0 bits (may not be all zero if handlerType is
                           // none of the above)
    this.name = bits.get_string();
  }

  getDetails(detailLevel) {
    return `handlerType=${this.handlerType} name=${this.name}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.handlerType = this.handlerType;
    obj.name = this.name;
    return obj;
  }
}

// Video Media Header Box (vmhd): general presentation information
class VideoMediaHeaderBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.graphicsmode = bits.read_bits(16);
    if (this.graphicsmode !== 0) {
      logger.warn(`[mp4] warning: vmhd: non-standard graphicsmode: ${this.graphicsmode}`);
    }
    this.opcolor = {};
    this.opcolor.red = bits.read_bits(16);
    this.opcolor.green = bits.read_bits(16);
    return this.opcolor.blue = bits.read_bits(16);
  }
}

//  getDetails: (detailLevel) ->
//    "graphicsMode=#{@graphicsmode} opColor=0x#{Bits.zeropad 2, @opcolor.red.toString 16}#{Bits.zeropad 2, @opcolor.green.toString 16}#{Bits.zeropad 2, @opcolor.blue.toString 16}"

// Data Reference Box (dref): table of data references that declare
//                            locations of the media data
class DataReferenceBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    let entry_count = bits.read_uint32();
    this.children = [];
    for (let i = 1, end = entry_count, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
      this.children.push(Box.parse(bits, this));
    }
  }
}

// "url "
class DataEntryUrlBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    if (bits.has_more_data()) {
      this.location = bits.get_string();
    } else {
      this.location = null;
    }
  }

  getDetails(detailLevel) {
    if (this.location != null) {
      return `location=${this.location}`;
    } else {
      return "empty location value";
    }
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.location = this.location;
    return obj;
  }
}

// "urn "
class DataEntryUrnBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    if (bits.has_more_data()) {
      this.name = bits.get_string();
    } else {
      this.name = null;
    }
    if (bits.has_more_data()) {
      this.location = bits.get_string();
    } else {
      this.location = null;
    }
  }
}

// Sample Description Box (stsd): coding type and any initialization information
// Defined in ISO 14496-12
class SampleDescriptionBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    // moov
    //   mvhd
    //   iods
    //   trak
    //     tkhd
    //     edts
    //       elst
    //     mdia
    //       mdhd
    //       hdlr <- find target
    //       minf
    //         vmhd
    //         dinf
    //           dref
    //             url 
    //         stbl
    //           stsd <- self
    //             stts
    let handlerRefBox = this.findParent('mdia').find('hdlr');
    let { handlerType } = handlerRefBox;

    let entry_count = bits.read_uint32();
    this.children = [];
    for (let i = 1, end = entry_count, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
      switch (handlerType) {
        case 'soun':  // for audio tracks
          this.children.push(Box.parse(bits, this, AudioSampleEntry));
          break;
        case 'vide':  // for video tracks
          this.children.push(Box.parse(bits, this, VisualSampleEntry));
          break;
        case 'hint':  // hint track
          this.children.push(Box.parse(bits, this, HintSampleEntry));
          break;
        default:
          logger.warn(`[mp4] warning: ignoring a sample entry for unknown handlerType in stsd box: ${handlerType}`);
      }
    }
  }
}

class HintSampleEntry extends Box {
  read(buf) {
    let bits = new Bits(buf);
    // SampleEntry
    let reserved = bits.read_bits(8 * 6);
    if (reserved !== 0) {
      throw new Error(`VisualSampleEntry: reserved bits are not 0: ${reserved}`);
    }
    this.dataReferenceIndex = bits.read_bits(16);

    // unsigned int(8) data []

  }
}

class AudioSampleEntry extends Box {
  read(buf) {
    let bits = new Bits(buf);
    // SampleEntry
    let reserved = bits.read_bits(8 * 6);
    if (reserved !== 0) {
      throw new Error(`AudioSampleEntry: reserved bits are not 0: ${reserved}`);
    }
    this.dataReferenceIndex = bits.read_bits(16);

    reserved = bits.read_bytes_sum(4 * 2);
    if (reserved !== 0) {
      throw new Error(`AudioSampleEntry: reserved-1 bits are not 0: ${reserved}`);
    }

    this.channelCount = bits.read_bits(16);
    if (this.channelCount !== 2) {
      throw new Error(`AudioSampleEntry: channelCount is not 2: ${this.channelCount}`);
    }

    this.sampleSize = bits.read_bits(16);
    if (this.sampleSize !== 16) {
      throw new Error(`AudioSampleEntry: sampleSize is not 16: ${this.sampleSize}`);
    }

    let pre_defined = bits.read_bits(16);
    if (pre_defined !== 0) {
      throw new Error(`AudioSampleEntry: pre_defined is not 0: ${pre_defined}`);
    }

    reserved = bits.read_bits(16);
    if (reserved !== 0) {
      throw new Error(`AudioSampleEntry: reserved-2 bits are not 0: ${reserved}`);
    }

    // moov
    //   mvhd
    //   iods
    //   trak
    //     tkhd
    //     edts
    //       elst
    //     mdia
    //       mdhd <- find target
    //       hdlr
    //       minf
    //         vmhd
    //         dinf
    //           dref
    //             url 
    //         stbl
    //           stsd <- self
    //             stts
    let mdhdBox = this.findParent('mdia').find('mdhd');

    this.sampleRate = bits.read_uint32();
    if (this.sampleRate !== (mdhdBox.timescale * Math.pow(2, 16))) {  // "<< 16" may lead to int32 overflow
      throw new Error(`AudioSampleEntry: illegal sampleRate: ${this.sampleRate} (should be ${mdhdBox.timescale << 16})`);
    }

    this.remaining_buf = bits.remaining_buffer();
  }
}

class VisualSampleEntry extends Box {
  read(buf) {
    let bits = new Bits(buf);
    // SampleEntry
    let reserved = bits.read_bits(8 * 6);
    if (reserved !== 0) {
      throw new Error(`VisualSampleEntry: reserved bits are not 0: ${reserved}`);
    }
    this.dataReferenceIndex = bits.read_bits(16);

    // VisualSampleEntry
    let pre_defined = bits.read_bits(16);
    if (pre_defined !== 0) {
      throw new Error(`VisualSampleEntry: pre_defined bits are not 0: ${pre_defined}`);
    }
    reserved = bits.read_bits(16);
    if (reserved !== 0) {
      throw new Error(`VisualSampleEntry: reserved bits are not 0: ${reserved}`);
    }
    pre_defined = bits.read_bytes_sum(4 * 3);
    if (pre_defined !== 0) {
      throw new Error(`VisualSampleEntry: pre_defined is not 0: ${pre_defined}`);
    }
    this.width = bits.read_bits(16);
    this.height = bits.read_bits(16);
    this.horizontalResolution = bits.read_uint32();
    if (this.horizontalResolution !== 0x00480000) {  // 72 dpi
      throw new Error(`VisualSampleEntry: horizontalResolution is not 0x00480000: ${this.horizontalResolution}`);
    }
    this.verticalResolution = bits.read_uint32();
    if (this.verticalResolution !== 0x00480000) {  // 72 dpi
      throw new Error(`VisualSampleEntry: verticalResolution is not 0x00480000: ${this.verticalResolution}`);
    }
    reserved = bits.read_uint32();
    if (reserved !== 0) {
      throw new Error(`VisualSampleEntry: reserved bits are not 0: ${reserved}`);
    }
    this.frameCount = bits.read_bits(16);
    if (this.frameCount !== 1) {
      throw new Error(`VisualSampleEntry: frameCount is not 1: ${this.frameCount}`);
    }

    // compressor name: 32 bytes
    let compressorNameBytes = bits.read_byte();
    if (compressorNameBytes > 0) {
      this.compressorName = bits.read_bytes(compressorNameBytes).toString('utf8');
    } else {
      this.compressorName = null;
    }
    let paddingLen = 32 - 1 - compressorNameBytes;
    if (paddingLen > 0) {
      bits.skip_bytes(paddingLen);
    }

    this.depth = bits.read_bits(16);
    if (this.depth !== 0x0018) {
      throw new Error(`VisualSampleEntry: depth is not 0x0018: ${this.depth}`);
    }
    pre_defined = bits.read_int(16);
    if (pre_defined !== -1) {
      throw new Error(`VisualSampleEntry: pre_defined is not -1: ${pre_defined}`);
    }

    this.remaining_buf = bits.remaining_buffer();
  }
}

// stts
// Defined in ISO 14496-12
class TimeToSampleBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.entryCount = bits.read_uint32();
    this.entries = [];
    for (let i = 0, end = this.entryCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      // number of consecutive samples that have the given duration
      let sampleCount = bits.read_uint32();
      // delta of these samples in the time-scale of the media
      let sampleDelta = bits.read_uint32();
      if (sampleDelta < 0) {
        throw new Error(`stts: negative sampleDelta is not allowed: ${sampleDelta}`);
      }
      this.entries.push({
        sampleCount,
        sampleDelta
      });
    }
  }

  getTotalSamples() {
    let samples = 0;
    for (let entry of Array.from(this.entries)) {
      samples += entry.sampleCount;
    }
    return samples;
  }

  // Returns the total length of this media in seconds
  getTotalLength() {
    // mdia
    //   mdhd <- find target
    //   hdlr
    //   minf
    //     vmhd
    //     dinf
    //       dref
    //         url
    //     stbl
    //       stsd
    //         avc1
    //           avcC
    //           btrt
    //       stts <- self
    let mdhdBox = this.findParent('mdia').find('mdhd');

    let time = 0;
    for (let entry of Array.from(this.entries)) {
      time += entry.sampleDelta * entry.sampleCount;
    }
    return time / mdhdBox.timescale;
  }

  // Returns a sample which comes exactly at or immediately after
  // the specified time (in seconds). If isExclusive=true, it excludes
  // a sample whose timestamp is equal to the specified time.
  // If there is no matching sample, this method returns null.
  getSampleAfterSeconds(sec, isExclusive) {
    let totalTime;
    if (isExclusive == null) { isExclusive = false; }
    let { timescale } = this.findParent('mdia').find('mdhd');
    let remainingTime = sec * timescale;
    let sampleNumber = 1;
    let elstBox = __guard__(this.findParent('trak').child('edts'), x => x.child('elst'));
    if (elstBox != null) {
      totalTime = elstBox.getEmptyDuration();
      remainingTime -= totalTime;
    } else {
      totalTime = 0;
    }
    for (let entry of Array.from(this.entries)) {
      let numSamples = Math.ceil(remainingTime / entry.sampleDelta);
      if (numSamples < 0) {
        numSamples = 0;
      }
      if (numSamples <= entry.sampleCount) {
        totalTime += numSamples * entry.sampleDelta;
        let totalSeconds = totalTime / timescale;
        if (isExclusive && (totalSeconds <= sec)) {
          numSamples++;
          totalTime += entry.sampleDelta;
          totalSeconds = totalTime / timescale;
        }
        return {
          sampleNumber: sampleNumber + numSamples,
          time: totalTime,
          seconds: totalSeconds
        };
      }
      sampleNumber += entry.sampleCount;
      let entryDuration = entry.sampleDelta * entry.sampleCount;
      totalTime += entryDuration;
      remainingTime -= entryDuration;
    }

    // EOF
    return null;
  }

  // Returns a sample which represents the data at the specified time
  // (in seconds). If there is no sample at the specified time, this
  // method returns null.
  getSampleAtSeconds(sec) {
    let totalTime;
    let { timescale } = this.findParent('mdia').find('mdhd');
    let remainingTime = sec * timescale;
    let sampleNumber = 1;
    let elstBox = __guard__(this.findParent('trak').child('edts'), x => x.child('elst'));
    if (elstBox != null) {
      totalTime = elstBox.getEmptyDuration();
      remainingTime -= totalTime;
    } else {
      totalTime = 0;
    }
    for (let entry of Array.from(this.entries)) {
      let sampleIndexInChunk = Math.floor(remainingTime / entry.sampleDelta);
      if (sampleIndexInChunk < 0) {
        sampleIndexInChunk = 0;
      }
      if (sampleIndexInChunk < entry.sampleCount) {
        totalTime += sampleIndexInChunk * entry.sampleDelta;
        return {
          sampleNumber: sampleNumber + sampleIndexInChunk,
          time: totalTime,
          seconds: totalTime / timescale
        };
      }
      sampleNumber += entry.sampleCount;
      let entryDuration = entry.sampleDelta * entry.sampleCount;
      totalTime += entryDuration;
      remainingTime -= entryDuration;
    }

    // EOF
    return null;
  }

  // Returns a decoding time for the given sample number.
  // The sample number starts at 1.
  getDecodingTime(sampleNumber) {
    let time;
    let trakBox = this.findParent('trak');
    let elstBox = __guard__(trakBox.child('edts'), x => x.child('elst'));
    let mdhdBox = trakBox.child('mdia').child('mdhd');

    sampleNumber--;
    if (elstBox != null) {
      time = elstBox.getEmptyDuration();
    } else {
      time = 0;
    }
    for (let entry of Array.from(this.entries)) {
      if (sampleNumber > entry.sampleCount) {
        time += entry.sampleDelta * entry.sampleCount;
        sampleNumber -= entry.sampleCount;
      } else {
        time += entry.sampleDelta * sampleNumber;
        break;
      }
    }
    return {
      time,
      seconds: time / mdhdBox.timescale
    };
  }

  getDetails(detailLevel) {
    let str = `entryCount=${this.entryCount}`;
    if (detailLevel >= 2) {
      str += ` ${this.entries.map((entry, index) => `[${index}]:sampleCount=${entry.sampleCount},sampleDelta=${entry.sampleDelta}`).join(',')}`;
    }
    return str;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.entries = this.entries;
    return obj;
  }
}

// stss: random access points
// If stss is not present, every sample is a random access point.
class SyncSampleBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.entryCount = bits.read_uint32();
    this.sampleNumbers = [];
    let lastSampleNumber = -1;
    for (let i = 0, end = this.entryCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let sampleNumber = bits.read_uint32();
      if (sampleNumber < lastSampleNumber) {
        throw new Error(`stss: sample number must be in increasing order: ${sampleNumber} < ${lastSampleNumber}`);
      }
      lastSampleNumber = sampleNumber;
      this.sampleNumbers.push(sampleNumber);
    }
  }

  getDetails(detailLevel) {
    if (detailLevel >= 2) {
      return `sampleNumbers=${this.sampleNumbers.join(',')}`;
    } else {
      return `entryCount=${this.entryCount}`;
    }
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.sampleNumbers = this.sampleNumbers;
    return obj;
  }
}

// stsc: number of samples for each chunk
class SampleToChunkBox extends Box {
  read(buf) {
    let firstChunk, i;
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.entryCount = bits.read_uint32();
    this.entries = [];
    let sampleNumber = 1;
    for (i = 0, end = this.entryCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      var asc, end;
      firstChunk = bits.read_uint32();
      let samplesPerChunk = bits.read_uint32();
      let sampleDescriptionIndex = bits.read_uint32();
      if (i > 0) {
        let lastEntry = this.entries[this.entries.length - 1];
        sampleNumber += (firstChunk - lastEntry.firstChunk) * lastEntry.samplesPerChunk;
      }
      this.entries.push({
        firstChunk,
        firstSample: sampleNumber,
        samplesPerChunk,
        sampleDescriptionIndex
      });
    }

    // Determine the number of chunks of each entry
    let endIndex = this.entries.length - 1;
    for (i = 0, end1 = endIndex, asc1 = 0 <= end1; asc1 ? i < end1 : i > end1; asc1 ? i++ : i--) {
      var asc1, end1;
      if (i === endIndex) {
        break;
      }
      this.entries[i].numChunks = this.entries[i+1].firstChunk - this.entries[i].firstChunk;
    }

    // XXX: We could determine the number of chunks in the last batch because
    //      the total number of samples is known by stts box. However we don't
    //      need it.

  }

  getNumSamplesExceptLastChunk() {
    let samples = 0;
    for (let entry of Array.from(this.entries)) {
      if (entry.numChunks != null) {
        samples += entry.samplesPerChunk * entry.numChunks;
      }
    }
    return samples;
  }

  getNumSamplesInChunk(chunk) {
    for (let entry of Array.from(this.entries)) {
      if ((entry.numChunks == null)) {
        // TOOD: too heavy
        let sttsBox = this.findParent('stbl').find('stts');
        return entry.samplesPerChunk;
      }
      if (chunk < (entry.firstChunk + entry.numChunks)) {
        return entry.samplesPerChunk;
      }
    }
    throw new Error(`Chunk not found: ${chunk}`);
  }

  findChunk(sampleNumber) {
    for (let entry of Array.from(this.entries)) {
      if ((entry.numChunks == null)) {
        return entry.firstChunk + Math.floor((sampleNumber-1) / entry.samplesPerChunk);
      }
      if (sampleNumber <= (entry.samplesPerChunk * entry.numChunks)) {
        return entry.firstChunk + Math.floor((sampleNumber-1) / entry.samplesPerChunk);
      }
      sampleNumber -= entry.samplesPerChunk * entry.numChunks;
    }
    throw new Error(`Chunk for sample number ${sampleNumber} is not found`);
  }

  getFirstSampleNumberInChunk(chunkNumber) {
    for (let start = this.entries.length-1, i = start, asc = start <= 0; asc ? i <= 0 : i >= 0; asc ? i++ : i--) {
      if (chunkNumber >= this.entries[i].firstChunk) {
        return this.entries[i].firstSample +
          ((chunkNumber - this.entries[i].firstChunk) * this.entries[i].samplesPerChunk);
      }
    }
    return null;
  }

  getDetails(detailLevel) {
    if (detailLevel >= 2) {
      return this.entries.map(entry => `firstChunk=${entry.firstChunk} samplesPerChunk=${entry.samplesPerChunk} sampleDescriptionIndex=${entry.sampleDescriptionIndex}`).join(', ');
    } else {
      return `entryCount=${this.entryCount}`;
    }
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.entries = this.entries;
    return obj;
  }
}

// stsz: sample sizes
class SampleSizeBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    // Default sample size
    // 0: samples have different sizes
    this.sampleSize = bits.read_uint32();

    // Number of samples in the track
    this.sampleCount = bits.read_uint32();
    if (this.sampleSize === 0) {
      this.entrySizes = [];
      for (let i = 1, end = this.sampleCount, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
        this.entrySizes.push(bits.read_uint32());
      }
    }
  }

  // Returns an array of sample sizes beginning at sampleNumber through
  // the specified number of samples (len)
  getSampleSizes(sampleNumber, len) {
    let i;
    if (len == null) { len = 1; }
    let sizes = [];
    if (this.sampleSize !== 0) {
      for (i = len, asc = len <= 0; asc ? i < 0 : i > 0; asc ? i++ : i--) {
        var asc;
        sizes.push(this.sampleSize);
      }
    } else {
      for (i = len, asc1 = len <= 0; asc1 ? i < 0 : i > 0; asc1 ? i++ : i--) {
        var asc1;
        sizes.push(this.entrySizes[sampleNumber - 1]);
        sampleNumber++;
      }
    }
    return sizes;
  }

  // Returns the total bytes from sampleNumber through
  // the specified number of samples (len)
  getTotalSampleSize(sampleNumber, len) {
    if (len == null) { len = 1; }
    if (this.sampleSize !== 0) {  // all samples are the same size
      return this.sampleSize * len;
    } else {  // the samples have different sizes
      let totalLength = 0;
      for (let i = len, asc = len <= 0; asc ? i < 0 : i > 0; asc ? i++ : i--) {
        if (sampleNumber > this.entrySizes.length) {
          throw new Error(`Sample number is out of range: ${sampleNumber} > ${this.entrySizes.length}`);
        }
        totalLength += this.entrySizes[sampleNumber - 1];  // TODO: Is -1 correct?
        sampleNumber++;
      }
      return totalLength;
    }
  }

  getDetails(detailLevel) {
    let str = `sampleSize=${this.sampleSize} sampleCount=${this.sampleCount}`;
    if (this.entrySizes != null) {
      if (detailLevel >= 2) {
        str += ` entrySizes=${this.entrySizes.join(',')}`;
      } else {
        str += ` num_entrySizes=${this.entrySizes.length}`;
      }
    }
    return str;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.sampleSize = this.sampleSize;
    obj.sampleCount = this.sampleCount;
    if (this.entrySizes != null) {
      obj.entrySizes = this.entrySizes;
    }
    return obj;
  }
}

// stco: chunk offsets relative to the beginning of the file
class ChunkOffsetBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.entryCount = bits.read_uint32();
    this.chunkOffsets = [];
    for (let i = 1, end = this.entryCount, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
      this.chunkOffsets.push(bits.read_uint32());
    }
  }

  // Returns a position of the chunk relative to the beginning of the file
  getChunkOffset(chunkNumber) {
    if ((chunkNumber <= 0) || (chunkNumber > this.chunkOffsets.length)) {
      throw new Error(`Chunk number out of range: ${chunkNumber} (len=${this.chunkOffsets.length})`);
    }
    return this.chunkOffsets[chunkNumber - 1];
  }

  getDetails(detailLevel) {
    if (detailLevel >= 2) {
      return `chunkOffsets=${this.chunkOffsets.join(',')}`;
    } else {
      return `entryCount=${this.entryCount}`;
    }
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.chunkOffsets = this.chunkOffsets;
    return obj;
  }
}

// smhd
class SoundMediaHeaderBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.balance = bits.read_bits(16);
    if (this.balance !== 0) {
      throw new Error(`smhd: balance is not 0: ${this.balance}`);
    }

    let reserved = bits.read_bits(16);
    if (reserved !== 0) {
      throw new Error(`smhd: reserved bits are not 0: ${reserved}`);
    }

  }
}

// meta: descriptive or annotative metadata
class MetaBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.children = [];
    while (bits.has_more_data()) {
      let box = Box.parse(bits, this);
      this.children.push(box);
    }
  }
}

// pitm: one of the referenced items
class PrimaryItemBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.itemID = bits.read_bits(16);
  }
}

// iloc
class ItemLocationBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.offsetSize = bits.read_bits(4);
    this.lengthSize = bits.read_bits(4);
    this.baseOffsetSize = bits.read_bits(4);
    this.reserved = bits.read_bits(4);
    this.itemCount = bits.read_bits(16);
    this.items = [];
    for (let i = 0, end = this.itemCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let itemID = bits.read_bits(16);
      let dataReferenceIndex = bits.read_bits(16);
      let baseOffset = bits.read_bits(this.baseOffsetSize * 8);
      let extentCount = bits.read_bits(16);
      let extents = [];
      for (let j = 0, end1 = extentCount, asc1 = 0 <= end1; asc1 ? j < end1 : j > end1; asc1 ? j++ : j--) {
        let extentOffset = bits.read_bits(this.offsetSize * 8);
        let extentLength = bits.read_bits(this.lengthSize * 8);
        extents.push({
          extentOffset,
          extentLength
        });
      }
      this.items.push({
        itemID,
        dataReferenceIndex,
        baseOffset,
        extentCount,
        extents
      });
    }
  }
}

// ipro: an array of item protection information
class ItemProtectionBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.protectionCount = bits.read_bits(16);

    this.children = [];
    for (let i = 1, end = this.protectionCount, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
      let box = Box.parse(bits, this);
      this.children.push(box);
    }
  }
}

// infe: extra information about selected items
class ItemInfoEntry extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.itemID = bits.read_bits(16);
    this.itemProtectionIndex = bits.read_bits(16);
    this.itemName = bits.get_string();
    this.contentType = bits.get_string();
    if (bits.has_more_data()) {
      this.contentEncoding = bits.get_string();
    }
  }
}

// iinf: extra information about selected items
class ItemInfoBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.entryCount = bits.read_bits(16);

    this.children = [];
    for (let i = 1, end = this.entryCount, asc = 1 <= end; asc ? i <= end : i >= end; asc ? i++ : i--) {
      let box = Box.parse(bits, this);
      this.children.push(box);
    }
  }
}

// ilst: list of actual metadata values
class MetadataItemListBox extends Container {}

class GenericDataBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.length = bits.read_uint32();
    this.name = bits.read_bytes(4).toString('utf8');
    this.entryCount = bits.read_uint32();
    let zeroBytes = bits.read_bytes_sum(4);
    if (zeroBytes !== 0) {
      logger.warn(`[mp4] warning: zeroBytes are not all zeros (got ${zeroBytes})`);
    }
    this.value = bits.read_bytes(this.length - 16);
    let nullPos = Bits.searchByteInBuffer(this.value, 0x00);
    if (nullPos === 0) {
      this.valueStr = null;
    } else if (nullPos !== -1) {
      this.valueStr = this.value.slice(0, nullPos).toString('utf8');
    } else {
      this.valueStr = this.value.toString('utf8');
    }
  }

  getDetails(detailLevel) {
    return `${this.name}=${this.valueStr}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.data = this.valueStr;
    return obj;
  }
}

// gsst: unknown
class GoogleGSSTBox extends GenericDataBox {}

// gstd: unknown
class GoogleGSTDBox extends GenericDataBox {}

// gssd: unknown
class GoogleGSSDBox extends GenericDataBox {}

// gspu: unknown
class GoogleGSPUBox extends GenericDataBox {}

// gspm: unknown
class GoogleGSPMBox extends GenericDataBox {}

// gshh: unknown
class GoogleGSHHBox extends GenericDataBox {}

// Media Data Box (mdat): audio/video frames
// Defined in ISO 14496-12
class MediaDataBox extends Box {
  read(buf) {}
}
    // We will not parse the raw media stream

// avc1
// Defined in ISO 14496-15
class AVCSampleEntry extends VisualSampleEntry {
  read(buf) {
    super.read(buf);
    let bits = new Bits(this.remaining_buf);
    this.children = [];
    this.children.push(Box.parse(bits, this, AVCConfigurationBox));
    if (bits.has_more_data()) {
      this.children.push(Box.parse(bits, this, MPEG4BitRateBox));
    }
    if (bits.has_more_data()) {
      this.children.push(Box.parse(bits, this, MPEG4ExtensionDescriptorsBox));
    }
  }
}

// btrt
// Defined in ISO 14496-15
class MPEG4BitRateBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.bufferSizeDB = bits.read_uint32();
    this.maxBitrate = bits.read_uint32();
    return this.avgBitrate = bits.read_uint32();
  }

  getDetails(detailLevel) {
    return `bufferSizeDB=${this.bufferSizeDB} maxBitrate=${this.maxBitrate} avgBitrate=${this.avgBitrate}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.bufferSizeDB = this.bufferSizeDB;
    obj.maxBitrate = this.maxBitrate;
    obj.avgBitrate = this.avgBitrate;
    return obj;
  }
}

// m4ds
// Defined in ISO 14496-15
class MPEG4ExtensionDescriptorsBox {
  read(buf) {}
}
    // TODO: implement this?

// avcC
// Defined in ISO 14496-15
class AVCConfigurationBox extends Box {
  read(buf) {
    let i;
    let bits = new Bits(buf);

    // AVCDecoderConfigurationRecord
    this.configurationVersion = bits.read_byte();
    if (this.configurationVersion !== 1) {
      logger.warn(`warning: mp4: avcC: unknown configurationVersion: ${this.configurationVersion}`);
    }
    this.AVCProfileIndication = bits.read_byte();
    this.profileCompatibility = bits.read_byte();
    this.AVCLevelIndication = bits.read_byte();
    let reserved = bits.read_bits(6);
//    if reserved isnt 0b111111  # XXX: not always 0b111111?
//      throw new Error "AVCConfigurationBox: reserved-1 is not #{0b111111} (got #{reserved})"
    this.lengthSizeMinusOne = bits.read_bits(2);
    reserved = bits.read_bits(3);
//    if reserved isnt 0b111  # XXX: not always 0b111?
//      throw new Error "AVCConfigurationBox: reserved-2 is not #{0b111} (got #{reserved})"

    // SPS
    this.numOfSequenceParameterSets = bits.read_bits(5);
    this.sequenceParameterSets = [];
    for (i = 0, end = this.numOfSequenceParameterSets, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      var asc, end;
      let sequenceParameterSetLength = bits.read_bits(16);
      this.sequenceParameterSets.push(bits.read_bytes(sequenceParameterSetLength));
    }

    // PPS
    this.numOfPictureParameterSets = bits.read_byte();
    this.pictureParameterSets = [];
    for (i = 0, end1 = this.numOfPictureParameterSets, asc1 = 0 <= end1; asc1 ? i < end1 : i > end1; asc1 ? i++ : i--) {
      var asc1, end1;
      let pictureParameterSetLength = bits.read_bits(16);
      this.pictureParameterSets.push(bits.read_bytes(pictureParameterSetLength));
    }

  }

  getDetails(detailLevel) {
    return `sps=${this.sequenceParameterSets.map(sps => `0x${sps.toString('hex')}`).join(',')} pps=${this.pictureParameterSets.map(pps => `0x${pps.toString('hex')}`).join(',')}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.sps = this.sequenceParameterSets.map(sps => [...sps]);
    obj.pps = this.pictureParameterSets.map(pps => [...pps]);
    return obj;
  }
}

// esds
class ESDBox extends Box {
  readDecoderConfigDescriptor(bits) {
    let info = {};
    info.tag = bits.read_byte();
    if (info.tag !== 0x04) {  // 0x04 == DecoderConfigDescrTag
      throw new Error(`ESDBox: DecoderConfigDescrTag is not 4 (got ${info.tag})`);
    }
    info.length = this.readDescriptorLength(bits);
    info.objectProfileIndication = bits.read_byte();
    info.streamType = bits.read_bits(6);
    info.upStream = bits.read_bit();
    let reserved = bits.read_bit();
    if (reserved !== 1) {
      throw new Error(`ESDBox: DecoderConfigDescriptor: reserved bit is not 1 (got ${reserved})`);
    }
    info.bufferSizeDB = bits.read_bits(24);
    info.maxBitrate = bits.read_uint32();
    info.avgBitrate = bits.read_uint32();
    info.decoderSpecificInfo = this.readDecoderSpecificInfo(bits);
    return info;
  }

  readDecoderSpecificInfo(bits) {
    let info = {};
    info.tag = bits.read_byte();
    if (info.tag !== 0x05) {  // 0x05 == DecSpecificInfoTag
      throw new Error(`ESDBox: DecSpecificInfoTag is not 5 (got ${info.tag})`);
    }
    info.length = this.readDescriptorLength(bits);
    info.specificInfo = bits.read_bytes(info.length);
    return info;
  }

  readSLConfigDescriptor(bits) {
    let info = {};
    info.tag = bits.read_byte();
    if (info.tag !== 0x06) {  // 0x06 == SLConfigDescrTag
      throw new Error(`ESDBox: SLConfigDescrTag is not 6 (got ${info.tag})`);
    }
    info.length = this.readDescriptorLength(bits);
    info.predefined = bits.read_byte();
    if (info.predefined === 0) {
      info.useAccessUnitStartFlag = bits.read_bit();
      info.useAccessUnitEndFlag = bits.read_bit();
      info.useRandomAccessPointFlag = bits.read_bit();
      info.hasRandomAccessUnitsOnlyFlag = bits.read_bit();
      info.usePaddingFlag = bits.read_bit();
      info.useTimeStampsFlag = bits.read_bit();
      info.useIdleFlag = bits.read_bit();
      info.durationFlag = bits.read_bit();
      info.timeStampResolution = bits.read_uint32();
      info.ocrResolution = bits.read_uint32();
      info.timeStampLength = bits.read_byte();
      if (info.timeStampLength > 64) {
        throw new Error(`ESDBox: SLConfigDescriptor: timeStampLength must be <= 64 (got ${info.timeStampLength})`);
      }
      info.ocrLength = bits.read_byte();
      if (info.ocrLength > 64) {
        throw new Error(`ESDBox: SLConfigDescriptor: ocrLength must be <= 64 (got ${info.ocrLength})`);
      }
      info.auLength = bits.read_byte();
      if (info.auLength > 32) {
        throw new Error(`ESDBox: SLConfigDescriptor: auLength must be <= 64 (got ${info.auLength})`);
      }
      info.instantBitrateLength = bits.read_byte();
      info.degradationPriorityLength = bits.read_bits(4);
      info.auSeqNumLength = bits.read_bits(5);
      if (info.auSeqNumLength > 16) {
        throw new Error(`ESDBox: SLConfigDescriptor: auSeqNumLength must be <= 16 (got ${info.auSeqNumLength})`);
      }
      info.packetSeqNumLength = bits.read_bits(5);
      if (info.packetSeqNumLength > 16) {
        throw new Error(`ESDBox: SLConfigDescriptor: packetSeqNumLength must be <= 16 (got ${info.packetSeqNumLength})`);
      }
      let reserved = bits.read_bits(2);
      if (reserved !== 0b11) {
        throw new Error(`ESDBox: SLConfigDescriptor: reserved bits value is not ${0b11} (got ${reserved})`);
      }

      if (info.durationFlag === 1) {
        info.timeScale = bits.read_uint32();
        info.accessUnitDuration = bits.read_bits(16);
        info.compositionUnitDuration = bits.read_bits(16);
      }
      if (info.useTimeStampsFlag === 0) {
        info.startDecodingTimeStamp = bits.read_bits(info.timeStampLength);
        info.startCompositionTimeStamp = bits.read_bits(info.timeStamplength);
      }
    }
    return info;
  }

  readDescriptorLength(bits) {
    let len = bits.read_byte();
    // TODO: Is this correct?
    if (len >= 0x80) {
      len = ((len & 0x7f) << 21) |
        ((bits.read_byte() & 0x7f) << 14) |
        ((bits.read_byte() & 0x7f) << 7) |
        bits.read_byte();
    }
    return len;
  }

  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    // ES_Descriptor (defined in ISO 14496-1)
    this.tag = bits.read_byte();
    if (this.tag !== 0x03) {  // 0x03 == ES_DescrTag
      throw new Error(`ESDBox: tag is not ${0x03} (got ${this.tag})`);
    }
    this.length = this.readDescriptorLength(bits);
    this.ES_ID = bits.read_bits(16);
    this.streamDependenceFlag = bits.read_bit();
    this.urlFlag = bits.read_bit();
    this.ocrStreamFlag = bits.read_bit();
    this.streamPriority = bits.read_bits(5);
    if (this.streamDependenceFlag === 1) {
      this.depenedsOnES_ID = bits.read_bits(16);
    }
    if (this.urlFlag === 1) {
      this.urlLength = bits.read_byte();
      this.urlString = bits.read_bytes(this.urlLength);
    }
    if (this.ocrStreamFlag === 1) {
      this.ocrES_ID = bits.read_bits(16);
    }

    this.decoderConfigDescriptor = this.readDecoderConfigDescriptor(bits);

    // TODO: if ODProfileLevelIndication is 0x01

    this.slConfigDescriptor = this.readSLConfigDescriptor(bits);

    // TODO:
    // IPI_DescPointer
    // IP_IdentificationDataSet
    // IPMP_DescriptorPointer
    // LanguageDescriptor
    // QoS_Descriptor
    // RegistrationDescriptor
    // ExtensionDescriptor

  }

  getDetails(detailLevel) {
    return `audioSpecificConfig=0x${this.decoderConfigDescriptor.decoderSpecificInfo.specificInfo.toString('hex')} maxBitrate=${this.decoderConfigDescriptor.maxBitrate} avgBitrate=${this.decoderConfigDescriptor.avgBitrate}`;
  }

  getTree() {
    let obj = super.getTree(...arguments);
    obj.audioSpecificConfig = [...this.decoderConfigDescriptor.decoderSpecificInfo.specificInfo];
    obj.maxBitrate = this.decoderConfigDescriptor.maxBitrate;
    obj.avgBitrate = this.decoderConfigDescriptor.avgBitrate;
    return obj;
  }
}

// mp4a
// Defined in ISO 14496-14
class MP4AudioSampleEntry extends AudioSampleEntry {
  read(buf) {
    super.read(buf);
    let bits = new Bits(this.remaining_buf);
    this.children = [
      Box.parse(bits, this, ESDBox)
    ];
  }
}

// free: can be ignored
// Defined in ISO 14496-12
class FreeSpaceBox extends Box {}

// ctts: offset between decoding time and composition time
class CompositionOffsetBox extends Box {
  read(buf) {
    let bits = new Bits(buf);
    this.readFullBoxHeader(bits);

    this.entryCount = bits.read_uint32();
    this.entries = [];
    for (let i = 0, end = this.entryCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let sampleCount = bits.read_uint32();
      let sampleOffset = bits.read_uint32();
      this.entries.push({
        sampleCount,
        sampleOffset
      });
    }
  }

  // sampleNumber is indexed from 1
  getCompositionTimeOffset(sampleNumber) {
    for (let entry of Array.from(this.entries)) {
      if (sampleNumber <= entry.sampleCount) {
        return entry.sampleOffset;
      }
      sampleNumber -= entry.sampleCount;
    }
    throw new Error(`mp4: ctts: composition time for sample number ${sampleNumber} not found`);
  }
}

// '\xa9too' (copyright sign + 'too')
class CTOOBox extends GenericDataBox {}


let api =
  {MP4File};

export default api;

function __guard__(value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined;
}