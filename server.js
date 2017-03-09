import url from 'url';

import config from './config';
import StreamServer from './stream_server';
import Bits from './bits';
import logger from './logger';

Bits.set_warning_fatal(true);
logger.setLevel(logger.LEVEL_INFO);

let streamServer = new StreamServer;
streamServer.setLivePathConsumer(function(uri, callback) {
  let pathname = url.parse(uri).pathname.slice(1);

  let isAuthorized = true;

  if (isAuthorized) {
    return callback(null); // Accept access
  } else {
    return callback(new Error('Unauthorized access'));
  }
}); // Deny access

if (config.recordedDir != null) {
  streamServer.attachRecordedDir(config.recordedDir);
}

process.on('SIGINT', () => {
  console.log('Got SIGINT');
  return streamServer.stop(() => process.kill(process.pid, 'SIGTERM'));
}
);

process.on('uncaughtException', function(err) {
  streamServer.stop();
  throw err;
});

streamServer.start();
