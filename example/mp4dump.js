import mp4 from '../mp4';

let getCurrentTime = function () {
  let time = process.hrtime();
  return time[0] + (time[1] / 1e9);
};

if (process.argv.length < 3) {
  console.log("Error: specify an mp4 filename");
} else {
  let mp4file = new mp4.MP4File(process.argv[2]);
  mp4file.parse();
  mp4file.dump();
}
