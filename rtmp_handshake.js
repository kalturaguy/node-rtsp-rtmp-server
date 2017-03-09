// RTMP handshake

import crypto from 'crypto';
import codec_utils from './codec_utils';
import logger from './logger';

let MESSAGE_FORMAT_1       =  1;
let MESSAGE_FORMAT_2       =  2;
let MESSAGE_FORMAT_UNKNOWN = -1;

let RTMP_SIG_SIZE = 1536;
let SHA256DL = 32;  // SHA256 digest length (bytes)

let KEY_LENGTH = 128;

let RandomCrud = new Buffer([
    0xf0, 0xee, 0xc2, 0x4a,
    0x80, 0x68, 0xbe, 0xe8, 0x2e, 0x00, 0xd0, 0xd1,
    0x02, 0x9e, 0x7e, 0x57, 0x6e, 0xec, 0x5d, 0x2d,
    0x29, 0x80, 0x6f, 0xab, 0x93, 0xb8, 0xe6, 0x36,
    0xcf, 0xeb, 0x31, 0xae
]);

let GenuineFMSConst = "Genuine Adobe Flash Media Server 001";
let GenuineFMSConstCrud = Buffer.concat([new Buffer(GenuineFMSConst, "utf8"), RandomCrud]);

let GenuineFPConst  = "Genuine Adobe Flash Player 001";
let GenuineFPConstCrud = Buffer.concat([new Buffer(GenuineFPConst, "utf8"), RandomCrud]);

let GetClientGenuineConstDigestOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 728) + 12;
  return offset;
};

let GetServerGenuineConstDigestOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 728) + 776;
  return offset;
};

let GetClientDHOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 632) + 772;
  return offset;
};

let GetServerDHOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 632) + 8;
  return offset;
};

let hasSameBytes = function(buf1, buf2) {
  for (let i = 0, end = buf1.length, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
    if (buf1[i] !== buf2[i]) {
      return false;
    }
  }
  return true;
};

let detectClientMessageFormat = function(clientsig) {
  let sdl = GetServerGenuineConstDigestOffset(clientsig.slice(772, 776));
  let msg = Buffer.concat([clientsig.slice(0, sdl), clientsig.slice(sdl+SHA256DL)], 1504);
  let computedSignature = codec_utils.calcHmac(msg, GenuineFPConst);
  let providedSignature = clientsig.slice(sdl, sdl+SHA256DL);
  if (hasSameBytes(computedSignature, providedSignature)) {
    return MESSAGE_FORMAT_2;
  }

  sdl = GetClientGenuineConstDigestOffset(clientsig.slice(8, 12));
  msg = Buffer.concat([clientsig.slice(0, sdl), clientsig.slice(sdl+SHA256DL)], 1504);
  computedSignature = codec_utils.calcHmac(msg, GenuineFPConst);
  providedSignature = clientsig.slice(sdl, sdl+SHA256DL);
  if (hasSameBytes(computedSignature, providedSignature)) {
    return MESSAGE_FORMAT_1;
  }

  return MESSAGE_FORMAT_UNKNOWN;
};

let DHKeyGenerate = function(bits) {
  let dh = crypto.getDiffieHellman('modp2');
  dh.generateKeys();
  return dh;
};

let generateS1 = (messageFormat, dh, callback) =>
  crypto.pseudoRandomBytes(RTMP_SIG_SIZE - 8, function(err, randomBytes) {
    let serverDHOffset, serverDigestOffset;
    let handshakeBytes = Buffer.concat([
      new Buffer([ 0, 0, 0, 0, 1, 2, 3, 4 ]),
      randomBytes
    ], RTMP_SIG_SIZE);
    if (messageFormat === 1) {
      serverDHOffset = GetClientDHOffset(handshakeBytes.slice(1532, 1536));
    } else {
      serverDHOffset = GetServerDHOffset(handshakeBytes.slice(768, 772));
    }

    let publicKey = dh.getPublicKey();
    publicKey.copy(handshakeBytes, serverDHOffset, 0, publicKey.length);

    if (messageFormat === 1) {
      serverDigestOffset = GetClientGenuineConstDigestOffset(handshakeBytes.slice(8, 12));
    } else {
      serverDigestOffset = GetServerGenuineConstDigestOffset(handshakeBytes.slice(772, 776));
    }
    let msg = Buffer.concat([
      handshakeBytes.slice(0, serverDigestOffset),
      handshakeBytes.slice(serverDigestOffset+SHA256DL)
    ], RTMP_SIG_SIZE - SHA256DL);
    let hash = codec_utils.calcHmac(msg, GenuineFMSConst);
    hash.copy(handshakeBytes, serverDigestOffset, 0, 32);
    return callback(null, handshakeBytes);
  })
;

let generateS2 = function(messageFormat, clientsig, callback) {
  let challengeKeyOffset, keyOffset;
  if (messageFormat === 1) {
    challengeKeyOffset = GetClientGenuineConstDigestOffset(clientsig.slice(8, 12));
  } else {
    challengeKeyOffset = GetServerGenuineConstDigestOffset(clientsig.slice(772, 776));
  }
  let challengeKey = clientsig.slice(challengeKeyOffset, +challengeKeyOffset+31 + 1 || undefined);

  if (messageFormat === 1) {
    keyOffset = GetClientDHOffset(clientsig.slice(1532, 1536));
  } else {
    keyOffset = GetServerDHOffset(clientsig.slice(768, 772));
  }
  let key = clientsig.slice(keyOffset, keyOffset+KEY_LENGTH);

  let hash = codec_utils.calcHmac(challengeKey, GenuineFMSConstCrud);
  return crypto.pseudoRandomBytes(RTMP_SIG_SIZE - 32, function(err, randomBytes) {
    let signature = codec_utils.calcHmac(randomBytes, hash);
    let s2Bytes = Buffer.concat([
      randomBytes, signature
    ], RTMP_SIG_SIZE);
    return callback(null, s2Bytes,
      {clientPublicKey: key});
  });
};

// Generate S0/S1/S2 combined message
let generateS0S1S2 = function(clientsig, callback) {
  let clientType = clientsig[0];
  clientsig = clientsig.slice(1);

  let dh = DHKeyGenerate(KEY_LENGTH * 8);

  let messageFormat = detectClientMessageFormat(clientsig);
  if (messageFormat === MESSAGE_FORMAT_UNKNOWN) {
    logger.warn("[rtmp:handshake] warning: unknown message format, assuming format 1");
    messageFormat = 1;
  }
  return generateS1(messageFormat, dh, (err, s1Bytes) =>
    generateS2(messageFormat, clientsig, function(err, s2Bytes, keys) {
      let allBytes = Buffer.concat([
        new Buffer([ clientType ]),  // version (S0)
        s1Bytes,  // S1
        s2Bytes   // S2
      ], 3073);
      keys.dh = dh;
      return callback(null, allBytes, keys);
    })
  );
};

export { generateS0S1S2 };
