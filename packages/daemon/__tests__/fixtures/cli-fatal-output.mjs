// Force a real dispatch rejection after imports, without a model/daemon call.
const write = process.stdout.write;
process.stdout.write = function () {
  process.stdout.write = write;
  throw new Error('fixture fatal ä🙂 '.repeat(20_000) + 'FATAL-END');
};
