const Reporter = require('./postmanOrangebeardListener');

module.exports = function (newman, options, collectionRunOptions) {
  return new Reporter(newman, options, collectionRunOptions);
};
