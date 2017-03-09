// RTP spec:
//   RFC 3550  http://tools.ietf.org/html/rfc3550
// RTP payload format for H.264 video:
//   RFC 6184  http://tools.ietf.org/html/rfc6184
// RTP payload format for AAC audio:
//   RFC 3640  http://tools.ietf.org/html/rfc3640
//   RFC 5691  http://tools.ietf.org/html/rfc5691
//
// TODO: Use DON (decoding order number) to carry B-frames.
//       DON is to RTP what DTS is to MPEG-TS.

import Bits from './bits';
import aac from './aac';
import logger from './logger';

// Number of seconds from 1900-01-01 to 1970-01-01
const EPOCH = 2208988800;

// Constant for calculating NTP fractional second
let NTP_SCALE_FRAC = 4294.967295;

// Minimum length of an RTP header
let RTP_HEADER_LEN = 12;

let MAX_PAYLOAD_SIZE = 1360;

let MAX_SEQUENCE_NUMBER = 65535;

class RTPParser {
  constructor() {
    this.eventListeners = {};
    this.packetBuffers = {};
    this.fragmentedH264PacketBuffer = {};
    this.h264NALUnitBuffer = {};
    this.aacAccessUnitBuffer = {};

    // config
    this.unorderedPacketBufferSize = 10;
  }

  emit(name, ...data) {
    if (this.eventListeners[name] != null) {
      for (let listener of Array.from(this.eventListeners[name])) {
        listener(...data);
      }
    }
  }

  on(name, listener) {
    if (this.eventListeners[name] != null) {
      return this.eventListeners[name].push(listener);
    } else {
      return this.eventListeners[name] = [ listener ];
    }
  }

  feedUnorderedAACBuffer(buf, clientId, params) {
    let packet = api.parseAACPacket(buf, params);
    return this.feedUnorderedPacket(`aac:${clientId}`, packet);
  }

  feedUnorderedH264Buffer(buf, clientId) {
    let packet = api.parseH264Packet(buf);
    return this.feedUnorderedPacket(`h264:${clientId}`, packet);
  }

  clearAllUnorderedPacketBuffers() {
    return this.packetBuffers = {};
  }

  clearUnorderedPacketBuffer(tag) {
    delete this.packetBuffers[`h264:${tag}`];
    return delete this.packetBuffers[`aac:${tag}`];
  }

  feedUnorderedPacket(tag, packet) {
    if ((this.packetBuffers[tag] == null)) {
      this.packetBuffers[tag] = {
        nextSequenceNumber: packet.rtpHeader.sequenceNumber,
        minSequenceNumberInBuffer: null,
        buffer: []
      };
    }
    let packetBuffer = this.packetBuffers[tag];
    if (packetBuffer.nextSequenceNumber === packet.rtpHeader.sequenceNumber) {
      this.onOrderedPacket(tag, packet);
      packetBuffer.nextSequenceNumber++;
      if (packetBuffer.nextSequenceNumber > MAX_SEQUENCE_NUMBER) {
        return packetBuffer.nextSequenceNumber = 0;
      }
    } else {
      // stash packet in buffer
      let buffers = packetBuffer.buffer;
      buffers.push(packet);
      if (buffers.length >= 2) {
        buffers.sort(function(a, b) {
          let numberA = a.rtpHeader.sequenceNumber;
          let numberB = b.rtpHeader.sequenceNumber;
          if ((numberA - numberB) >= 60000) {  // large enough gap
            return -1;  // a comes first
          } else if ((numberB - numberA) >= 60000) {  // large enough gap
            return 1;   // b comes first
          } else {
            return numberA - numberB;
          }
        });
        while (((buffers.length) > 0) &&
        (buffers[0].rtpHeader.sequenceNumber === packetBuffer.nextSequenceNumber)) {
          this.onOrderedPacket(tag, buffers.shift());
          packetBuffer.nextSequenceNumber++;
          if (packetBuffer.nextSequenceNumber > MAX_SEQUENCE_NUMBER) {
            packetBuffer.nextSequenceNumber = 0;
          }
        }
        return (() => {
          let result = [];
          while (buffers.length >= 2) {
            let item;
            let latestSequenceNumber = buffers[buffers.length-1].rtpHeader.sequenceNumber;
            let diff = latestSequenceNumber - packetBuffer.nextSequenceNumber;
            if (diff < 0) {
              diff += MAX_SEQUENCE_NUMBER + 1;
            }
            if (diff < this.unorderedPacketBufferSize) {
              break;
            }

            let firstPacket = buffers.shift();
            if (packetBuffer.nextSequenceNumber !== firstPacket.rtpHeader.sequenceNumber) {
              let discardedSequenceNumber = firstPacket.rtpHeader.sequenceNumber - 1;
              if (discardedSequenceNumber < 0) {
                discardedSequenceNumber += MAX_SEQUENCE_NUMBER;
              }
              if (packetBuffer.nextSequenceNumber !== discardedSequenceNumber) {
                logger.warn(`rtp: ${tag}: incoming packet loss: sequence number ${packetBuffer.nextSequenceNumber}-${discardedSequenceNumber}`);
              } else {
                logger.warn(`rtp: ${tag}: incoming packet loss: sequence number ${discardedSequenceNumber}`);
              }
            }
            // consume the first packet
            this.onOrderedPacket(tag, firstPacket);

            packetBuffer.nextSequenceNumber = firstPacket.rtpHeader.sequenceNumber + 1;
            if (packetBuffer.nextSequenceNumber > MAX_SEQUENCE_NUMBER) {
              item = packetBuffer.nextSequenceNumber = 0;
            }
            result.push(item);
          }
          return result;
        })();
      }
    }
  }

  onH264NALUnit(clientId, nalUnit, packet, timestamp) {
    if ((this.h264NALUnitBuffer[clientId] == null)) {
      this.h264NALUnitBuffer[clientId] = [];
    }
    this.h264NALUnitBuffer[clientId].push(nalUnit);
    if (packet.rtpHeader.marker) {
      this.emit('h264_nal_units', clientId, this.h264NALUnitBuffer[clientId], timestamp);
      return this.h264NALUnitBuffer[clientId] = [];
    }
  }

  onAACAccessUnits(clientId, accessUnits, packet, timestamp) {
    if ((this.aacAccessUnitBuffer[clientId] == null)) {
      this.aacAccessUnitBuffer[clientId] = [];
    }
    this.aacAccessUnitBuffer[clientId] = this.aacAccessUnitBuffer[clientId].concat(accessUnits);
    if (packet.rtpHeader.marker) {
      this.emit('aac_access_units', clientId, this.aacAccessUnitBuffer[clientId], timestamp);
      return this.aacAccessUnitBuffer[clientId] = [];
    }
  }

  onOrderedPacket(tag, packet) {
    let clientId, match;
    if ((match = /^h264:(.*)$/.exec(tag)) != null) {
      clientId = match[1];
      if (packet.h264.fu_a != null) {  // FU-A
        // startBit and endBit won't both be set to 1 in the same FU header
        if (packet.h264.fu_a.fuHeader.startBit) {
          this.fragmentedH264PacketBuffer[tag] = [
            new Buffer([ (packet.h264.nal_ref_idc << 5) | packet.h264.fu_a.fuHeader.nal_unit_payload_type ]),
            packet.h264.fu_a.nal_unit_fragment
          ];
        } else if (this.fragmentedH264PacketBuffer[tag] != null) {
          this.fragmentedH264PacketBuffer[tag].push(packet.h264.fu_a.nal_unit_fragment);
        } else {
          logger.warn(`rtp: ${tag}: discarded fragmented incoming packet: ${packet.rtpHeader.sequenceNumber}`);
          return;
        }
        if (packet.h264.fu_a.fuHeader.endBit) {
          this.onH264NALUnit(clientId, Buffer.concat(this.fragmentedH264PacketBuffer[tag]), packet, packet.rtpHeader.timestamp);
          return this.fragmentedH264PacketBuffer[tag] = null;
        }
      } else if (packet.h264.stap_a != null) {  // STAP-A
        return Array.from(packet.h264.stap_a.nalUnits).map((nalUnit) =>
          this.onH264NALUnit(clientId, nalUnit, packet, packet.rtpHeader.timestamp));
      } else { // single NAL unit
        return this.onH264NALUnit(clientId, packet.h264.nal_unit, packet, packet.rtpHeader.timestamp);
      }
    } else if ((match = /^aac:(.*)$/.exec(tag)) != null) {
      clientId = match[1];
      return this.onAACAccessUnits(clientId, packet.aac.accessUnits, packet, packet.rtpHeader.timestamp);
    } else {
      throw new Error(`Unknown tag: ${tag}`);
    }
  }
}

var api = {
  RTPParser,

  // Number of bytes in RTP header
  RTP_HEADER_LEN,

  RTCP_PACKET_TYPE_SENDER_REPORT      : 200,  // SR
  RTCP_PACKET_TYPE_RECEIVER_REPORT    : 201,  // RR
  RTCP_PACKET_TYPE_SOURCE_DESCRIPTION : 202,  // SDES
  RTCP_PACKET_TYPE_GOODBYE            : 203,  // BYE
  RTCP_PACKET_TYPE_APPLICATION_DEFINED: 204,  // APP

  H264_NAL_UNIT_TYPE_STAP_A: 24,
  H264_NAL_UNIT_TYPE_STAP_B: 25,
  H264_NAL_UNIT_TYPE_MTAP16: 26,
  H264_NAL_UNIT_TYPE_MTAP24: 27,
  H264_NAL_UNIT_TYPE_FU_A  : 28,
  H264_NAL_UNIT_TYPE_FU_B  : 29,

  // Remove padding from the end of the buffer
  removeTrailingPadding(bits) {
    let paddingLength = bits.last_get_byte_at(0);
    return bits.remove_trailing_bytes(paddingLength);
  },

  readRTCPSenderReport(bits) {
    // RFC 3550 - 6.4.1 SR: Sender Report RTCP Packet
    let startBytePos = bits.current_position().byte;
    let info = {};
    info.version = bits.read_bits(2);
    info.padding = bits.read_bit();
    if (info.padding === 1) {
      api.removeTrailingPadding(bits);
    }
    info.reportCount = bits.read_bits(5);
    info.payloadType = bits.read_byte();  // == 200
    if (info.payloadType !== api.RTCP_PACKET_TYPE_SENDER_REPORT) {
      throw new Error(`payload type must be ${api.RTCP_PACKET_TYPE_SENDER_REPORT}`);
    }
    info.wordsMinusOne = bits.read_bits(16);
    info.totalBytes = (info.wordsMinusOne + 1) * 4;
    info.ssrc = bits.read_bits(32);
    info.ntpTimestamp = [ bits.read_bits(32), bits.read_bits(32) ];
    info.ntpTimestampInMs = api.ntpTimestampToTime(info.ntpTimestamp);
    info.rtpTimestamp = bits.read_bits(32);
    info.senderPacketCount = bits.read_bits(32);
    info.senderOctetCount = bits.read_bits(32);

    info.reportBlocks = [];
    for (let i = 0, end = info.reportCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let reportBlock = {};
      reportBlock.ssrc = bits.read_bits(32);
      reportBlock.fractionLost = bits.read_byte();
      reportBlock.packetsLost = bits.read_int(24);
      reportBlock.highestSequenceNumber = bits.read_bits(32);
      reportBlock.jitter = bits.read_bits(32);
      reportBlock.lastSR = bits.read_bits(32);
      reportBlock.delaySinceLastSR = bits.read_bits(32);
      info.reportBlocks.push(reportBlock);
    }

    // skip padding bytes
    let readBytes = bits.current_position().byte - startBytePos;
    if (readBytes < info.totalBytes) {
      bits.skip_bytes(info.totalBytes - readBytes);
    }

    return info;
  },

  readRTCPReceiverReport(bits) {
    // RFC 3550 - 6.4.2 RR: Receiver Report RTCP Packet
    let startBytePos = bits.current_position().byte;
    let info = {};
    info.version = bits.read_bits(2);
    info.padding = bits.read_bit();
    if (info.padding === 1) {
      api.removeTrailingPadding(bits);
    }
    info.reportCount = bits.read_bits(5);
    info.payloadType = bits.read_byte();  // == 201
    if (info.payloadType !== api.RTCP_PACKET_TYPE_RECEIVER_REPORT) {
      throw new Error(`payload type must be ${api.RTCP_PACKET_TYPE_RECEIVER_REPORT}`);
    }
    info.wordsMinusOne = bits.read_bits(16);
    info.totalBytes = (info.wordsMinusOne + 1) * 4;
    info.ssrc = bits.read_bits(32);
    info.reportBlocks = [];
    for (let i = 0, end = info.reportCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let reportBlock = {};
      reportBlock.ssrc = bits.read_bits(32);
      reportBlock.fractionLost = bits.read_byte();
      reportBlock.packetsLost = bits.read_int(24);
      reportBlock.highestSequenceNumber = bits.read_bits(32);
      reportBlock.jitter = bits.read_bits(32);
      reportBlock.lastSR = bits.read_bits(32);
      reportBlock.delaySinceLastSR = bits.read_bits(32);
      info.reportBlocks.push(reportBlock);
    }

    // skip padding bytes
    let readBytes = bits.current_position().byte - startBytePos;
    if (readBytes < info.totalBytes) {
      bits.skip_bytes(info.totalBytes - readBytes);
    }

    return info;
  },

  readRTCPSourceDescription(bits) {
    // RFC 3550 - 6.5 SDES: Source Description RTCP Packet
    let startBytePos = bits.current_position().byte;
    let info = {};
    info.version = bits.read_bits(2);
    info.padding = bits.read_bit();
    if (info.padding === 1) {
      api.removeTrailingPadding(bits);
    }
    info.sourceCount = bits.read_bits(5);
    info.payloadType = bits.read_byte();  // == 202
    if (info.payloadType !== api.RTCP_PACKET_TYPE_SOURCE_DESCRIPTION) {
      throw new Error(`payload type must be ${api.RTCP_PACKET_TYPE_SOURCE_DESCRIPTION}`);
    }
    info.wordsMinusOne = bits.read_bits(16);
    info.totalBytes = (info.wordsMinusOne + 1) * 4;
    info.chunks = [];
    for (let i = 0, end = info.sourceCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let chunk = {};
      chunk.ssrc_csrc = bits.read_bits(32);
      chunk.sdesItems = [];
      chunk.sdes = {};
      while (true) {
        let sdesItem = {};
        sdesItem.type = bits.read_byte();
        if (sdesItem.type === 0) {  // terminate the list
          // skip until the next 32-bit boundary
          let bytesPastBoundary = (bits.current_position().byte - startBytePos) % 4;
          if (bytesPastBoundary > 0) {
            while (bytesPastBoundary < 4) {
              let nullOctet = bits.read_byte();
              if (nullOctet !== 0x00) {
                throw new Error(`padding octet must be 0x00: ${nullOctet}`);
              }
              bytesPastBoundary++;
            }
          }
          break;
        }

        sdesItem.octetCount = bits.read_byte();
        if (sdesItem.octetCount > 255) {
          throw new Error(`octet count too large: ${sdesItem.octetCount} <= 255`);
        }
        sdesItem.text = bits.read_bytes(sdesItem.octetCount).toString('utf8');
        switch (sdesItem.type) {
          case 1:  // Canonical End-Point Identifier
            chunk.sdes.cname = sdesItem.text;
            break;
          case 2:  // User Name
            chunk.sdes.name = sdesItem.text;
            break;
          case 3:  // Electronic Mail Address
            chunk.sdes.email = sdesItem.text;
            break;
          case 4:  // Phone Number
            chunk.sdes.phone = sdesItem.text;
            break;
          case 5:  // Geographic User Location
            chunk.sdes.loc = sdesItem.text;
            break;
          case 6:  // Application or Tool Name
            chunk.sdes.tool = sdesItem.text;
            break;
          case 7:  // Notice/Status
            chunk.sdes.note = sdesItem.text;
            break;
          case 8:  // Private Extensions
            chunk.sdes.priv = sdesItem.text;
            break;
          default:
            throw new Error("unknown SDES item type in source description " +
              `RTCP packet: ${chunk.type} (maybe not implemented yet)`
            );
        }
        chunk.sdesItems.push(sdesItem);
      }
      info.chunks.push(chunk);
    }

    // skip padding bytes
    let readBytes = bits.current_position().byte - startBytePos;
    if (readBytes < info.totalBytes) {
      bits.skip_bytes(info.totalBytes - readBytes);
    }

    return info;
  },

  readRTCPGoodbye(bits) {
    // RFC 3550 - 6.6 BYE: Goodbye RTCP Packet
    let startBytePos = bits.current_position().byte;
    let info = {};
    info.version = bits.read_bits(2);
    info.padding = bits.read_bit();
    if (info.padding === 1) {
      api.removeTrailingPadding(bits);
    }
    info.sourceCount = bits.read_bits(5);
    info.payloadType = bits.read_byte();  // == 203
    if (info.payloadType !== api.RTCP_PACKET_TYPE_GOODBYE) {
      throw new Error(`payload type must be ${api.RTCP_PACKET_TYPE_GOODBYE}`);
    }
    info.wordsMinusOne = bits.read_bits(16);
    info.totalBytes = (info.wordsMinusOne + 1) * 4;
    info.ssrc = bits.read_bits(32);

    if (bits.has_more_data()) {
      info.reasonOctetCount = bits.read_byte();
      let reason = bits.read_bytes(info.reasonOctetCount);
    }

    // skip padding bytes
    let readBytes = bits.current_position().byte - startBytePos;
    if (readBytes < info.totalBytes) {
      bits.skip_bytes(info.totalBytes - readBytes);
    }

    return info;
  },

  readRTCPApplicationDefined(bits) {
    // RFC 3550 - 6.7 APP: Application-Defined RTCP Packet
    let startBytePos = bits.current_position().byte;
    let info = {};
    info.version = bits.read_bits(2);
    info.padding = bits.read_bit();
    if (info.padding === 1) {
      api.removeTrailingPadding(bits);
    }
    info.subtype = bits.read_bits(5);
    info.payloadType = bits.read_byte();  // == 204
    if (info.payloadType !== api.RTCP_PACKET_TYPE_APPLICATION_DEFINED) {
      throw new Error(`payload type must be ${api.RTCP_PACKET_TYPE_APPLICATION_DEFINED}`);
    }
    info.wordsMinusOne = bits.read_bits(16);
    info.totalBytes = (info.wordsMinusOne + 1) * 4;
    info.ssrc_csrc = bits.read_bits(32);
    info.name = bits.read_bytes(4).toString('ascii');

    // read the application-dependent data (remaining bytes)
    let readBytes = bits.current_position().byte - startBytePos;
    if (readBytes < info.totalBytes) {
      info.applicationData = bits.read_bytes(info.totalBytes - readBytes);
    } else {
      info.applicationData = null;
    }

    return info;
  },

  readRTPFixedHeader(bits) {
    // RFC 3550 - 5.1 RTP Fixed Header Fields
    let info = {};
    info.version = bits.read_bits(2);
    info.padding = bits.read_bit();
    if (info.padding === 1) {
      api.removeTrailingPadding(bits);
    }
    info.extension = bits.read_bit();
    info.csrcCount = bits.read_bits(4);
    info.marker = bits.read_bit();
    info.payloadType = bits.read_bits(7);
    info.sequenceNumber = bits.read_bits(16);
    info.timestamp = bits.read_bits(32);
    info.ssrc = bits.read_bits(32);
    info.csrc = [];
    for (let i = 0, end = info.csrcCount, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      info.csrc.push(bits.read_bits(32));
    }
    return info;
  },

  parseAACPacket(buf, params) {
    let bits = new Bits(buf);
    let packet = {};
    packet.rtpHeader = api.readRTPFixedHeader(bits);
    packet.aac = api.readAACPayload(bits, params);
    return packet;
  },

  parseH264Packet(buf) {
    let bits = new Bits(buf);
    let packet = {};
    packet.rtpHeader = api.readRTPFixedHeader(bits);
    packet.h264 = api.readH264Payload(bits);
    return packet;
  },

  readH264Payload(bits) {
    let info = {};
    info.forbidden_zero_bit = bits.read_bit();  // 1 indicates error
    if (info.forbidden_zero_bit !== 0) {
      throw new Error(`forbidden_zero_bit must be 0 (got ${info.forbidden_zero_bit})`);
    }
    info.nal_ref_idc = bits.read_bits(2);  // == 00: not important, > 00: important
    info.nal_unit_type = bits.read_bits(5);
    if (1 <= info.nal_unit_type && info.nal_unit_type <= 23) {  // Single NAL unit packet
      bits.push_back_byte();
      info.nal_unit = bits.remaining_buffer();
    } else if (24 <= info.nal_unit_type && info.nal_unit_type <= 29) {
      switch (info.nal_unit_type) {
        case api.H264_NAL_UNIT_TYPE_STAP_A:  // STAP-A (24)
          info.stap_a = api.readH264STAP_A(bits);
          break;
        case api.H264_NAL_UNIT_TYPE_FU_A:  // FU-A (28)
          info.fu_a = api.readH264FragmentationUnitA(bits);
          break;
        default:
          throw new Error(`Not implemented: nal_unit_type=${info.nal_unit_type} (please report this bug)`);
      }
    } else {
      throw new Error(`Invalid nal_unit_type=${info.nal_unit_type}`);
    }
    return info;
  },

  // Read Single-Time Aggregation Packet type A (STAP-A)
  readH264STAP_A(bits) {
    let info =
      {nalUnits: []};
    while (bits.get_remaining_bytes() >= 2) {
      let nalUnitSize = bits.read_bits(16);
      info.nalUnits.push(bits.read_bytes(nalUnitSize));
    }
    if (info.nalUnits.length < 1) {
      logger.error("rtp: error: STAP-A does not contain a NAL unit");
    }
    return info;
  },

  readH264FragmentationUnitA(bits) {
    let info = {};
    info.fuHeader = api.readH264FragmentationUnitHeader(bits);
    info.nal_unit_fragment = bits.remaining_buffer();
    return info;
  },

  // FU header
  readH264FragmentationUnitHeader(bits) {
    let info = {};
    info.startBit = bits.read_bit();
    info.endBit = bits.read_bit();
    let reservedBit = bits.read_bit();
    if (reservedBit !== 0) {
      throw new Error(`reserved bit must be 0 (got ${reservedBit})`);
    }
    info.nal_unit_payload_type = bits.read_bits(5);
    return info;
  },

  parsePacket(buf) {
    let bits = new Bits(buf);
    let packet = {};
    let payloadValue = bits.get_byte_at(1);  // including marker bit
    switch (payloadValue) {
      case api.RTCP_PACKET_TYPE_SENDER_REPORT:
        packet.rtcpSenderReport = api.readRTCPSenderReport(bits);
        break;
      case api.RTCP_PACKET_TYPE_RECEIVER_REPORT:
        packet.rtcpReceiverReport = api.readRTCPReceiverReport(bits);
        break;
      case api.RTCP_PACKET_TYPE_SOURCE_DESCRIPTION:
        packet.rtcpSourceDescription = api.readRTCPSourceDescription(bits);
        break;
      case api.RTCP_PACKET_TYPE_GOODBYE:
        packet.rtcpGoodbye = api.readRTCPGoodbye(bits);
        break;
      case api.RTCP_PACKET_TYPE_APPLICATION_DEFINED:
        packet.rtcpApplicationDefined = api.readRTCPApplicationDefined(bits);
        break;
      default:  // RTP data transfer protocol - fixed header
        packet.rtpHeader = api.readRTPFixedHeader(bits);
    }
    return packet;
  },

  parsePackets(buf) {
    let bits = new Bits(buf);

    let packets = [];
    while (bits.has_more_data()) {
      let packet = {};
      let payloadValue = bits.get_byte_at(1);  // including marker bit
      switch (payloadValue) {
        case api.RTCP_PACKET_TYPE_SENDER_REPORT:
          packet.rtcpSenderReport = api.readRTCPSenderReport(bits);
          break;
        case api.RTCP_PACKET_TYPE_RECEIVER_REPORT:
          packet.rtcpReceiverReport = api.readRTCPReceiverReport(bits);
          break;
        case api.RTCP_PACKET_TYPE_SOURCE_DESCRIPTION:
          packet.rtcpSourceDescription = api.readRTCPSourceDescription(bits);
          break;
        case api.RTCP_PACKET_TYPE_GOODBYE:
          packet.rtcpGoodbye = api.readRTCPGoodbye(bits);
          break;
        case api.RTCP_PACKET_TYPE_APPLICATION_DEFINED:
          packet.rtcpApplicationDefined = api.readRTCPApplicationDefined(bits);
          break;
        default:  // RTP data transfer protocol - fixed header
          packet.rtpHeader = api.readRTPFixedHeader(bits);
      }
      packets.push(packet);
    }

    return packets;
  },

  // Replace SSRC in-place in the given RTP header
  replaceSSRCInRTP(buf, ssrc) {
    buf[8]  = (ssrc >>> 24) & 0xff;
    buf[9]  = (ssrc >>> 16) & 0xff;
    buf[10] = (ssrc >>> 8) & 0xff;
    buf[11] = ssrc & 0xff;
  },

  // ntpTimestamp: [ <32-bit second part>, <32-bit fractional second part> ]
  ntpTimestampToTime(ntpTimestamp) {
    let sec = ntpTimestamp[0] - EPOCH;
    let ms = ntpTimestamp[1] / NTP_SCALE_FRAC / 1000;
    return (sec * 1000) + ms;
  },

  // Get NTP timestamp for a time
  // time is expressed the same as Date.now()
  getNTPTimestamp(time) {
    let sec = parseInt(time / 1000);
    let ms = time - (sec * 1000);
    let ntp_sec = sec + EPOCH;
    let ntp_usec = Math.round(ms * 1000 * NTP_SCALE_FRAC);
    return [ntp_sec, ntp_usec];
  },

  readAACPayload(bits, params) {
    let info = {};
    info.auHeadersLengthBits = bits.read_bits(16);  // in bits
    info.numAUHeaders = info.auHeadersLengthBits / 16;
    let auHeaders = [];
    for (let i = 0, end = info.numAUHeaders, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      params.index = i;
      auHeaders.push(api.readAACAUHeader(bits, params));
    }
    info.auHeaders = auHeaders;
    info.accessUnits = [];
    for (let auHeader of Array.from(auHeaders)) {
      info.accessUnits.push(bits.read_bytes(auHeader.auSize));
      let accessUnit = info.accessUnits[info.accessUnits.length-1];
    }
    return info;
  },

  readAACAUHeader(bits, params) {
    if ((params.sizelength == null)) {
      throw new Error("sizelength is not defined in params");
    }
    let info = {};
    // size in octets of the associated Access Unit in the
    // Access Unit Data Section in the same RTP packet
    info.auSize = bits.read_bits(params.sizelength);
    // serial number of the associated Access Unit (fragment).
    if ((params.index == null)) {
      throw new Error("index is not defined in params");
    }
    if (params.index > 0) {
      if ((params.indexdeltalength == null)) {
        throw new Error("indexdeltalength is not defined in params");
      }
      info.auIndexDelta = bits.read_bits(params.indexdeltalength);
    } else {
      if ((params.indexlength == null)) {
        throw new Error("indexlength is not defined in params");
      }
      info.auIndex = bits.read_bits(params.indexlength);
    }
    return info;
  },

  // Used for encapsulating AAC audio data
  // opts:
  //   accessUnitLength (number): number of bytes in the access unit
  createAudioHeader(opts) {
    if (opts.accessUnits.length > 4095) {
      throw new Error(`too many audio access units: ${opts.accessUnits.length} (must be <= 4095)`);
    }
    let numBits = opts.accessUnits.length * 16;  // 2 bytes per access unit
    let header = [
      //# payload
      //# See section 3.2.1 and 3.3.6 of RFC 3640 for details
      //# AU Header Section
      // AU-headers-length(16) for AAC-hbr
      // Number of bits in the AU-headers
      (numBits >> 8) & 0xff,
      numBits & 0xff,
    ];
    for (let accessUnit of Array.from(opts.accessUnits)) {
      header = header.concat(api.createAudioAUHeader(accessUnit.length));
    }
    return header;
  },

  groupAudioFrames(adtsFrames) {
    let packetSize = RTP_HEADER_LEN;
    let groups = [];
    let currentGroup = [];
    for (let i = 0; i < adtsFrames.length; i++) {
      let adtsFrame = adtsFrames[i];
      packetSize += adtsFrame.length + 2;  // 2 bytes for AU-Header
      if (packetSize > MAX_PAYLOAD_SIZE) {
        groups.push(currentGroup);
        currentGroup = [];
        packetSize = RTP_HEADER_LEN + adtsFrame.length + 2;
      }
      currentGroup.push(adtsFrame);
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    return groups;
  },

  createAudioAUHeader(accessUnitLength) {
    return [
      // AU Header
      // AU-size(13) by SDP
      // AU-Index(3) or AU-Index-Delta(3)
      // AU-Index is used for the first access unit, and the value must be 0.
      // AU-Index-Delta is used for the consecutive access units.
      // When interleaving is not applied, AU-Index-Delta is 0.
      accessUnitLength >> 5,
      (accessUnitLength & 0b11111) << 3,
      // There is no Auxiliary Section for AAC-hbr
    ];
  },

  // Used for encapsulating H.264 video data
  createFragmentationUnitHeader(opts) {
    return [
      // Fragmentation Unit
      // See section 5.8 of RFC 6184 for details
      //
      // FU indicator
      // forbidden_zero_bit(1), nal_ref_idc(2), type(5)
      // type is 28 for FU-A
      opts.nal_ref_idc | 28,
      // FU header
      // start bit(1) == 0, end bit(1) == 1, reserved bit(1), type(5)
      (opts.isStart << 7) | (opts.isEnd << 6) | opts.nal_unit_type
    ];
  },

  // Create RTP header
  // opts:
  //   marker (boolean): true if this is the last packet of the
  //                     access unit indicated by the RTP timestamp
  //   payloadType (number): payload type
  //   sequenceNumber (number): sequence number
  //   timestamp (number): timestamp in 90 kHz clock rate
  //   ssrc (number): SSRC (can be null)
  createRTPHeader(opts) {
    let seqNum = opts.sequenceNumber;
    let ts = opts.timestamp;
    let ssrc = opts.ssrc != null ? opts.ssrc : 0;
    return [
      // version(2): 2
      // padding(1): 0
      // extension(1): 0
      // CSRC count(4): 0
      0b10000000,

      // marker(1)
      // payload type(7)
      (opts.marker << 7) | opts.payloadType,

      // sequence number(16)
      seqNum >>> 8,
      seqNum & 0xff,

      // timestamp(32) in 90 kHz clock rate
      (ts >>> 24) & 0xff,
      (ts >>> 16) & 0xff,
      (ts >>> 8) & 0xff,
      ts & 0xff,

      // SSRC(32)
      (ssrc >>> 24) & 0xff,
      (ssrc >>> 16) & 0xff,
      (ssrc >>> 8) & 0xff,
      ssrc & 0xff,
    ];
  },

  // Create RTCP BYE (Goodbye) packet
  createGoodbye(opts) {
    if (((opts != null ? opts.ssrcs : undefined) == null)) {
      throw new Error("createGoodbye: ssrcs is required");
    }
    let { ssrcs } = opts;
    if (ssrcs.length > 0b11111) {
      throw new Error(`createGoodbye: too many ssrcs: ${ssrcs.length} (must be <= 31)`);
    }

    // Reason for leaving
    let reason = [...(new Buffer('End of stream', 'utf8'))];  // Convert Buffer to array
    let reasonLen = reason.length;
    // Number of bytes until the next 32-bit boundary
    let padLen = 4 - ((1 + reasonLen) % 4);

    if (reason.length > 0xff) {
      throw new Error(`createGoodbye: reason is too long: ${reason.length} (must be <= 255)`);
    }

    // Length of this RTCP packet in 32-bit words minus one
    // including the header and any padding
    let length = ((4 + (ssrcs.length * 4) + 1 + reasonLen + padLen) / 4) - 1;

    let data = [
      // See section 6.6 for details

      // version(2): 2 (RTP version 2)
      // padding(1): 0 (padding doesn't exist)
      // source count(5): number of SSRC/CSRC identifiers
      0b10000000 | ssrcs.length,

      // packet type(8): 203 (RTCP BYE)
      203,

      // length(16)
      length >> 8, length & 0xff,
    ];

    for (let ssrc of Array.from(ssrcs)) {
      // Append SSRC
      data.push((ssrc >>> 24) & 0xff, (ssrc >>> 16) & 0xff, (ssrc >>> 8) & 0xff, ssrc & 0xff);
    }

    data.push(reason.length);
    data = data.concat(reason);
    while (padLen-- > 0) {
      data.push(0x00);
    }

    return data;
  },

  // Create RTCP Sender Report packet
  // opts:
  //   time: timestamp of the packet
  //   rtpTime: timestamp relative to the start point of media
  //   ssrc: SSRC
  //   packetCount: packet count
  //   octetCount: octetCount
  createSenderReport(opts) {
    if (((opts != null ? opts.ssrc : undefined) == null)) {
      throw new Error("createSenderReport: ssrc is required");
    }
    let { ssrc } = opts;
    if (((opts != null ? opts.packetCount : undefined) == null)) {
      throw new Error("createSenderReport: packetCount is required");
    }
    let { packetCount } = opts;
    if (((opts != null ? opts.octetCount : undefined) == null)) {
      throw new Error("createSenderReport: octetCount is required");
    }
    let { octetCount } = opts;
    if (((opts != null ? opts.time : undefined) == null)) {
      throw new Error("createSenderReport: time is required");
    }
    let ntp_ts = api.getNTPTimestamp(opts.time);
    if (((opts != null ? opts.rtpTime : undefined) == null)) {
      throw new Error("createSenderReport: rtpTime is required");
    }
    let rtp_ts = opts.rtpTime;

    let length = 6;  // 28 (packet bytes) / 4 (32-bit word) - 1
    return [
      // See section 6.4.1 for details

      // version(2): 2 (RTP version 2)
      // padding(1): 0 (padding doesn't exist)
      // reception report count(5): 0 (no reception report blocks)
      0b10000000,

      // packet type(8): 200 (RTCP Sender Report)
      200,

      // length(16)
      length >> 8, length & 0xff,

      // SSRC of sender(32)
      (ssrc >>> 24) & 0xff,
      (ssrc >>> 16) & 0xff,
      (ssrc >>> 8) & 0xff,
      ssrc & 0xff,

      // [sender info]
      // NTP timestamp(64)
      (ntp_ts[0] >>> 24) & 0xff,
      (ntp_ts[0] >>> 16) & 0xff,
      (ntp_ts[0] >>> 8) & 0xff,
      ntp_ts[0] & 0xff,
      (ntp_ts[1] >>> 24) & 0xff,
      (ntp_ts[1] >>> 16) & 0xff,
      (ntp_ts[1] >>> 8) & 0xff,
      ntp_ts[1] & 0xff,

      // RTP timestamp(32)
      (rtp_ts >>> 24) & 0xff,
      (rtp_ts >>> 16) & 0xff,
      (rtp_ts >>> 8) & 0xff,
      rtp_ts & 0xff,

      // sender's packet count(32)
      (packetCount >>> 24) & 0xff,
      (packetCount >>> 16) & 0xff,
      (packetCount >>> 8) & 0xff,
      packetCount & 0xff,

      // sender's octet count(32)
      (octetCount >>> 24) & 0xff,
      (octetCount >>> 16) & 0xff,
      (octetCount >>> 8) & 0xff,
      octetCount & 0xff,
    ];
  },

  // Parse config parameter for AAC
  // see: RFC 3640, 4.1. MIME Type Registration
  parseAACConfig(str) {
    if (str === '""') {  // empty string
      return null;
    }
    let buf = new Buffer(str, 'hex');
    return aac.parseAudioSpecificConfig(buf);
  }
};

export default api;
