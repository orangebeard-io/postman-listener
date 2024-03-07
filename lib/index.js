const Reporter = require('./orangebeardReporter');

module.exports = function (newman, options, collectionRunOptions) {
  return new Reporter(newman, options, collectionRunOptions);
};
