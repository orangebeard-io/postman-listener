const Reporter = require('./postmanListener');

module.exports = function (newman, options, collectionRunOptions) {
  return new Reporter(newman, options, collectionRunOptions);
};
